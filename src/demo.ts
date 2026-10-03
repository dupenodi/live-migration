import { execFile } from "node:child_process"
import { mkdir, writeFile } from "node:fs/promises"
import path from "node:path"
import { promisify } from "node:util"
import { bootGuest } from "./firecracker/machine.ts"
import { FirecrackerWorkers } from "./firecracker/workers.ts"
import { MigrationStore, runMigration } from "./migrate/run-migration.ts"
import { buildReport, type ObservedEvent } from "./observe/report.ts"
import { startProxy } from "./proxy/stream-proxy.ts"

const exec = promisify(execFile)
const repoRoot = path.resolve(import.meta.dirname, "..")

// Boot a guest on VM A, move it to VM B, and write the assignment report.
const workersScript = path.join(repoRoot, "scripts/workers.sh")
await exec("bash", [workersScript, "up"])

const running = await bootGuest("worker-a")
const proxy = await startProxy({ host: running.host, port: running.port })
const workers = new FirecrackerWorkers(proxy)
await workers.addSandbox("sb-1", "worker-a", { bootId: "", pid: 0, counter: 0 })
const store = new MigrationStore()
const events: ObservedEvent[] = []
const response = await fetch(`http://127.0.0.1:${proxy.port}/events`)
if (!response.ok || response.body === null) {
  throw new Error(`proxy status ${response.status}`)
}

const reader = response.body.getReader()
const decoder = new TextDecoder()
let buffer = ""
const pending: Array<() => void> = []

function note(line: string): void {
  const parsed = JSON.parse(line) as { boot_id: string; pid: number; counter: number }
  events.push({
    bootId: parsed.boot_id,
    pid: parsed.pid,
    counter: parsed.counter,
    receivedAt: Date.now(),
  })
  for (const wake of pending.splice(0)) {
    wake()
  }
}

void (async () => {
  while (true) {
    const chunk = await reader.read()
    if (chunk.done) {
      return
    }
    buffer += decoder.decode(chunk.value, { stream: true })
    const lines = buffer.split("\n")
    buffer = lines.pop() ?? ""
    for (const line of lines) {
      if (line.length > 0) {
        note(line)
      }
    }
  }
})()

try {
  await waitForCount(3)
  const migration = await runMigration(
    workers,
    { sandboxId: "sb-1", destination: "worker-b", idempotencyKey: "demo" },
    store,
  )
  if (migration.phase !== "succeeded") {
    throw new Error(migration.error ?? `migration ${migration.phase}`)
  }
  const before = events.length
  await waitForCount(before + 3)

  const report = buildReport({
    events,
    migration: {
      id: migration.id,
      source: migration.source,
      destination: migration.destination,
      phases: migration.phases,
      startedAt: migration.startedAt,
      pausedAt: migration.pausedAt,
      resumedAt: migration.resumedAt,
      finishedAt: migration.finishedAt,
      bytesTransferred: migration.bytesTransferred,
      spans: [],
    },
  })

  const demoDir = path.join(repoRoot, "demo")
  await mkdir(demoDir, { recursive: true })
  await writeFile(path.join(demoDir, "last-report.json"), `${JSON.stringify(report, null, 2)}\n`)
  console.log(JSON.stringify(report, null, 2))
  if (!report.bootIdContinuous || !report.pidContinuous || !report.counterContinuous) {
    throw new Error("continuity flags are not all true")
  }
} finally {
  await reader.cancel().catch(() => undefined)
  await proxy.close()
  await running.stop()
  await exec("bash", [workersScript, "down"])
}

function waitForCount(count: number): Promise<void> {
  if (events.length >= count) {
    return Promise.resolve()
  }
  return new Promise((resolve) => {
    const wake = () => {
      if (events.length >= count) {
        resolve()
      } else {
        pending.push(wake)
      }
    }
    pending.push(wake)
  })
}
