import { readFile } from "node:fs/promises"
import http from "node:http"
import type { IncomingMessage, ServerResponse } from "node:http"
import path from "node:path"
import type { WorkerSet } from "../migrate/workers.ts"
import type { Proxy } from "../proxy/stream-proxy.ts"
import { demoPayload } from "../observe/fixture.ts"
import {
  IdempotencyConflict,
  MigrationStore,
  runMigration,
  type Migration,
} from "../migrate/run-migration.ts"
import type { WorkerId } from "../migrate/workers.ts"

type Live = {
  proxy: Proxy
  sandboxId: string
}

type FileRecord = { path: string; content: string }
type CommandRecord = { command: string; background: boolean }
type PortRecord = { guestPort: number; hostPort: number }

type SandboxRecord = {
  id: string
  cpu: number
  memoryMb: number
  files: FileRecord[]
  commands: CommandRecord[]
  ports: PortRecord[]
}

export type Api = {
  port: number
  close(): Promise<void>
}

// Control API.
// The guest image already runs the counter. File and command calls are
// remembered here so the SDK can show what it asked for.
export function startApi(workers: WorkerSet, live?: Live): Promise<Api> {
  const state = new ControlState(workers, live)
  const server = http.createServer((request, response) => {
    void handle(state, request, response)
  })

  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      const address = server.address()
      if (address === null || typeof address === "string") {
        throw new Error("api did not receive a port")
      }
      resolve({
        port: address.port,
        close() {
          server.closeAllConnections()
          return new Promise((done, reject) => {
            server.close((error) => (error ? reject(error) : done()))
          })
        },
      })
    })
  })
}

class ControlState {
  readonly store = new MigrationStore()
  readonly migrations = new Map<string, Migration>()
  private readonly sandboxes = new Map<string, SandboxRecord>()
  private nextSandbox = 1
  private nextHostPort = 20000

  readonly workers: WorkerSet
  readonly live: Live | undefined

  constructor(workers: WorkerSet, live?: Live) {
    this.workers = workers
    this.live = live
    if (live) {
      this.sandboxes.set(live.sandboxId, {
        id: live.sandboxId,
        cpu: 1,
        memoryMb: 256,
        files: [],
        commands: [],
        ports: [],
      })
    }
  }

  async create(region: WorkerId, cpu: number, memoryMb: number): Promise<SandboxRecord> {
    const id = `sb-${this.nextSandbox++}`
    const record: SandboxRecord = {
      id,
      cpu,
      memoryMb,
      files: [],
      commands: [],
      ports: [],
    }
    this.sandboxes.set(id, record)
    await this.workers.addSandbox(id, region, {
      bootId: `boot-${id}`,
      pid: 417,
      counter: 0,
    })
    return record
  }

  find(id: string): SandboxRecord | undefined {
    return this.sandboxes.get(id)
  }

  expose(record: SandboxRecord, guestPort: number): PortRecord {
    const port = { guestPort, hostPort: this.nextHostPort++ }
    record.ports.push(port)
    return port
  }

  async view(record: SandboxRecord) {
    return {
      id: record.id,
      region: await this.workers.where(record.id),
      cpu: record.cpu,
      memoryMb: record.memoryMb,
      files: record.files,
      commands: record.commands,
      ports: record.ports,
    }
  }
}

async function handle(
  state: ControlState,
  request: IncomingMessage,
  response: ServerResponse,
): Promise<void> {
  try {
    await dispatch(state, request, response)
  } catch (error) {
    if (response.headersSent) {
      return
    }
    const message = error instanceof Error ? error.message : "request failed"
    sendJson(response, 500, { error: message })
  }
}

async function dispatch(
  state: ControlState,
  request: IncomingMessage,
  response: ServerResponse,
): Promise<void> {
  const url = new URL(request.url ?? "/", "http://127.0.0.1")
  const parts = url.pathname.split("/").filter((part) => part.length > 0)

  if (request.method === "GET" && url.pathname === "/events" && state.live) {
    pipeEvents(state.live.proxy.port, request, response)
    return
  }

  if (request.method === "GET" && url.pathname === "/v1/demo") {
    if (state.live) {
      sendJson(response, 200, {
        live: true,
        sandboxId: state.live.sandboxId,
        runningOn: await state.workers.where(state.live.sandboxId),
        vms: ["worker-a", "worker-b", "worker-c"],
      })
      return
    }
    sendJson(response, 200, demoPayload())
    return
  }

  if (request.method === "GET" && (await servePage(url.pathname, response))) {
    return
  }

  if (parts[0] !== "v1" || parts[1] !== "sandboxes") {
    sendJson(response, 404, { error: "not found" })
    return
  }

  if (parts.length === 2 && request.method === "POST") {
    await createSandbox(state, request, response)
    return
  }

  const id = parts[2]
  if (!id) {
    sendJson(response, 404, { error: "not found" })
    return
  }
  const record = state.find(id)
  if (!record) {
    sendJson(response, 404, { error: "sandbox not found" })
    return
  }

  if (parts.length === 3 && request.method === "GET") {
    sendJson(response, 200, await state.view(record))
    return
  }

  if (parts[3] === "files" && parts.length === 4 && request.method === "PUT") {
    await writeFile(record, request, response)
    return
  }

  if (parts[3] === "commands" && parts.length === 4 && request.method === "POST") {
    await runCommand(record, request, response)
    return
  }

  if (parts[3] === "ports" && parts.length === 4 && request.method === "POST") {
    await exposePort(state, record, request, response)
    return
  }

  if (parts[3] === "migrations" && parts.length === 4 && request.method === "POST") {
    await startMigration(state, record, request, response)
    return
  }

  if (parts[3] === "migrations" && parts.length === 5 && request.method === "GET") {
    readMigration(state, record.id, parts[4] ?? "", response)
    return
  }

  sendJson(response, 404, { error: "not found" })
}

async function createSandbox(
  state: ControlState,
  request: IncomingMessage,
  response: ServerResponse,
): Promise<void> {
  const body = await readJson(request)
  if (!isWorkerId(body.region)) {
    sendJson(response, 400, { error: "region must be worker-a, worker-b, or worker-c" })
    return
  }
  if (typeof body.cpu !== "number" || typeof body.memoryMb !== "number") {
    sendJson(response, 400, { error: "cpu and memoryMb are required" })
    return
  }
  const record = await state.create(body.region, body.cpu, body.memoryMb)
  sendJson(response, 200, await state.view(record))
}

async function writeFile(
  record: SandboxRecord,
  request: IncomingMessage,
  response: ServerResponse,
): Promise<void> {
  const body = await readJson(request)
  if (typeof body.path !== "string" || typeof body.content !== "string") {
    sendJson(response, 400, { error: "path and content are required" })
    return
  }
  record.files.push({ path: body.path, content: body.content })
  sendJson(response, 200, { path: body.path })
}

async function runCommand(
  record: SandboxRecord,
  request: IncomingMessage,
  response: ServerResponse,
): Promise<void> {
  const body = await readJson(request)
  if (typeof body.command !== "string" || typeof body.background !== "boolean") {
    sendJson(response, 400, { error: "command and background are required" })
    return
  }
  const command = { command: body.command, background: body.background }
  record.commands.push(command)
  sendJson(response, 200, command)
}

async function exposePort(
  state: ControlState,
  record: SandboxRecord,
  request: IncomingMessage,
  response: ServerResponse,
): Promise<void> {
  const body = await readJson(request)
  if (typeof body.guestPort !== "number") {
    sendJson(response, 400, { error: "guestPort is required" })
    return
  }
  sendJson(response, 200, state.expose(record, body.guestPort))
}

async function startMigration(
  state: ControlState,
  record: SandboxRecord,
  request: IncomingMessage,
  response: ServerResponse,
): Promise<void> {
  const body = await readJson(request)
  const idempotencyKey = header(request, "idempotency-key")
  if (!idempotencyKey) {
    sendJson(response, 400, { error: "Idempotency-Key header is required" })
    return
  }
  if (!isWorkerId(body.destination)) {
    sendJson(response, 400, { error: "destination must be worker-a, worker-b, or worker-c" })
    return
  }

  try {
    const migration = await runMigration(
      state.workers,
      {
        sandboxId: record.id,
        destination: body.destination,
        idempotencyKey,
      },
      state.store,
    )
    state.migrations.set(migration.id, migration)
    sendJson(response, 200, migration)
  } catch (error) {
    if (error instanceof IdempotencyConflict) {
      sendJson(response, 409, { error: error.message })
      return
    }
    const message = error instanceof Error ? error.message : "migration failed"
    sendJson(response, 400, { error: message })
  }
}

function readMigration(
  state: ControlState,
  sandboxId: string,
  migrationId: string,
  response: ServerResponse,
): void {
  const migration = state.migrations.get(migrationId)
  if (!migration || migration.sandboxId !== sandboxId) {
    sendJson(response, 404, { error: "migration not found" })
    return
  }
  sendJson(response, 200, migration)
}

function header(request: IncomingMessage, name: string): string | undefined {
  const value = request.headers[name]
  if (Array.isArray(value)) {
    return value[0]
  }
  return value
}

function isWorkerId(value: unknown): value is WorkerId {
  return value === "worker-a" || value === "worker-b" || value === "worker-c"
}

async function readJson(request: IncomingMessage): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = []
  for await (const chunk of request) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk))
  }
  const text = Buffer.concat(chunks).toString("utf8")
  if (text.length === 0) {
    return {}
  }
  const parsed: unknown = JSON.parse(text)
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new Error("json body must be an object")
  }
  return parsed as Record<string, unknown>
}

const pages: Record<string, { file: string; type: string }> = {
  "/": { file: "index.html", type: "text/html; charset=utf-8" },
  "/app.js": { file: "app.js", type: "text/javascript; charset=utf-8" },
  "/chip.js": { file: "chip.js", type: "text/javascript; charset=utf-8" },
  "/style.css": { file: "style.css", type: "text/css; charset=utf-8" },
  "/geist-sans.woff2": { file: "geist-sans.woff2", type: "font/woff2" },
  "/geist-sans-600.woff2": { file: "geist-sans-600.woff2", type: "font/woff2" },
}

async function servePage(pathname: string, response: ServerResponse): Promise<boolean> {
  const page = pages[pathname]
  if (!page) {
    return false
  }
  const file = await readFile(path.join(import.meta.dirname, "../../ui", page.file))
  response.writeHead(200, {
    "content-type": page.type,
    "cache-control": "no-cache",
  })
  response.end(file)
  return true
}

function pipeEvents(port: number, request: IncomingMessage, response: ServerResponse): void {
  const upstream = http.request(
    { host: "127.0.0.1", port, path: "/events", method: "GET" },
    (incoming) => {
      response.writeHead(incoming.statusCode ?? 200, {
        "content-type": "application/x-ndjson",
        "cache-control": "no-cache",
      })
      incoming.pipe(response)
    },
  )
  upstream.on("error", () => {
    if (!response.headersSent) {
      response.writeHead(502)
    }
    response.end()
  })
  request.on("close", () => upstream.destroy())
  upstream.end()
}

function sendJson(response: ServerResponse, status: number, body: unknown): void {
  const payload = JSON.stringify(body)
  response.writeHead(status, { "content-type": "application/json" })
  response.end(payload)
}
