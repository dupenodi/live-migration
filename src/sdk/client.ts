import type { Phase } from "../migrate/run-migration.ts"
import type { WorkerId } from "../migrate/workers.ts"

export class ApiError extends Error {
  readonly status: number

  constructor(status: number, message: string) {
    super(message)
    this.name = "ApiError"
    this.status = status
  }
}

export type SandboxView = {
  id: string
  region: WorkerId
  cpu: number
  memoryMb: number
  files: Array<{ path: string; content: string }>
  commands: Array<{ command: string; background: boolean }>
  ports: Array<{ guestPort: number; hostPort: number }>
}

export type MigrationProgress = {
  phase: Phase
  bytesTransferred: number
}

export type MigrationHandle = {
  id: string
  watch(): AsyncIterable<MigrationProgress>
}

export type SandboxClient = {
  id: string
  files: {
    write(path: string, content: string): Promise<void>
  }
  commands: {
    run(input: { command: string; background: boolean }): Promise<void>
  }
  ports: {
    expose(input: { guestPort: number }): Promise<{ guestPort: number; hostPort: number }>
  }
  migrate(input: { destination: WorkerId; idempotencyKey: string }): Promise<MigrationHandle>
  inspect(): Promise<SandboxView>
}

type MigrationBody = {
  id: string
  phases: Phase[]
  bytesTransferred: number
  phase: Phase
}

// The demo script uses this client. It does not talk to Firecracker itself.
export function createClient(baseUrl: string) {
  return {
    sandboxes: {
      async create(input: { region: WorkerId; cpu: number; memoryMb: number }) {
        const view = await send<SandboxView>(baseUrl, "/v1/sandboxes", {
          method: "POST",
          body: input,
        })
        return sandboxClient(baseUrl, view.id)
      },
    },
  }
}

function sandboxClient(baseUrl: string, id: string): SandboxClient {
  const root = `/v1/sandboxes/${id}`
  return {
    id,
    files: {
      async write(path, content) {
        await send(baseUrl, `${root}/files`, {
          method: "PUT",
          body: { path, content },
        })
      },
    },
    commands: {
      async run(input) {
        await send(baseUrl, `${root}/commands`, {
          method: "POST",
          body: input,
        })
      },
    },
    ports: {
      expose(input) {
        return send(baseUrl, `${root}/ports`, {
          method: "POST",
          body: input,
        })
      },
    },
    async migrate(input) {
      const migration = await send<MigrationBody>(baseUrl, `${root}/migrations`, {
        method: "POST",
        body: { destination: input.destination },
        idempotencyKey: input.idempotencyKey,
      })
      return {
        id: migration.id,
        async *watch() {
          const current = await send<MigrationBody>(
            baseUrl,
            `${root}/migrations/${migration.id}`,
          )
          for (let index = 0; index < current.phases.length; index += 1) {
            const phase = current.phases[index]
            if (!phase) {
              continue
            }
            const last = index === current.phases.length - 1
            yield {
              phase,
              bytesTransferred: last ? current.bytesTransferred : 0,
            }
          }
        },
      }
    },
    inspect() {
      return send<SandboxView>(baseUrl, root)
    },
  }
}

async function send<T>(
  baseUrl: string,
  path: string,
  init: {
    method?: string
    body?: unknown
    idempotencyKey?: string
  } = {},
): Promise<T> {
  const headers: Record<string, string> = {}
  if (init.body !== undefined) {
    headers["content-type"] = "application/json"
  }
  if (init.idempotencyKey) {
    headers["idempotency-key"] = init.idempotencyKey
  }
  const response = await fetch(new URL(path, baseUrl), {
    method: init.method ?? "GET",
    headers,
    body: init.body === undefined ? undefined : JSON.stringify(init.body),
  })
  const payload = (await response.json()) as { error?: string }
  if (!response.ok) {
    throw new ApiError(response.status, payload.error ?? response.statusText)
  }
  return payload as T
}
