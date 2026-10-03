import assert from "node:assert/strict"
import { execFile } from "node:child_process"
import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs"
import path from "node:path"
import { test } from "node:test"
import { promisify } from "node:util"
import { bootGuest } from "../src/firecracker/machine.ts"
import { FirecrackerWorkers } from "../src/firecracker/workers.ts"
import { MigrationStore, runMigration } from "../src/migrate/run-migration.ts"
import { startProxy } from "../src/proxy/stream-proxy.ts"

const exec = promisify(execFile)
const repoRoot = path.resolve(import.meta.dirname, "..")
const workersScript = path.join(repoRoot, "scripts/workers.sh")

test(
  "leaves the real guest running when VM B is down",
  { skip: existsSync("/dev/kvm") ? false : "needs Linux /dev/kvm", timeout: 120_000 },
  async () => {
    await exec("bash", [workersScript, "up"])
    const running = await bootGuest("worker-a")
    const proxy = await startProxy({ host: running.host, port: running.port })
    const workers = new FirecrackerWorkers(proxy)
    await workers.addSandbox("sb-1", "worker-a", { bootId: "", pid: 0, counter: 0 })
    await readOneLine(proxy.port)
    const before = await workers.guest("sb-1")

    try {
      await exec("sudo", ["-n", "ip", "netns", "del", "worker-b"])
      const migration = await runMigration(
        workers,
        { sandboxId: "sb-1", destination: "worker-b", idempotencyKey: "down" },
        new MigrationStore(),
      )
      assert.equal(migration.phase, "failed")
      assert.equal(migration.error, "destination worker is down")
      assert.equal(migration.pausedAt, 0)
      const after = await workers.guest("sb-1")
      assert.equal(after.bootId, before.bootId)
      assert.equal(after.pid, before.pid)
      assert.ok(after.counter >= before.counter)
    } finally {
      await proxy.close()
      await running.stop()
      await exec("bash", [workersScript, "down"])
    }
  },
)

test(
  "resumes the real guest when the copy is interrupted",
  { skip: existsSync("/dev/kvm") ? false : "needs Linux /dev/kvm", timeout: 180_000 },
  async () => {
    await exec("bash", [workersScript, "up"])
    const running = await bootGuest("worker-a")
    const proxy = await startProxy({ host: running.host, port: running.port })
    const workers = new FirecrackerWorkers(proxy)
    await workers.addSandbox("sb-1", "worker-a", { bootId: "", pid: 0, counter: 0 })
    const blocked = path.join(repoRoot, "run", "worker-b")
    rmSync(blocked, { recursive: true, force: true })
    mkdirSync(path.dirname(blocked), { recursive: true })
    writeFileSync(blocked, "not a directory")
    await readOneLine(proxy.port)

    try {
      const before = await workers.guest("sb-1")
      const migration = await runMigration(
        workers,
        { sandboxId: "sb-1", destination: "worker-b", idempotencyKey: "copy" },
        new MigrationStore(),
      )
      assert.equal(migration.phase, "rolled_back")
      assert.equal(await workers.where("sb-1"), "worker-a")
      const after = await workers.guest("sb-1")
      assert.equal(after.bootId, before.bootId)
      assert.equal(after.pid, before.pid)
      assert.ok(after.counter >= before.counter)
    } finally {
      rmSync(blocked, { force: true })
      await proxy.close()
      await running.stop()
      await exec("bash", [workersScript, "down"])
    }
  },
)

async function readOneLine(port: number): Promise<void> {
  const response = await fetch(`http://127.0.0.1:${port}/events`)
  if (!response.ok || response.body === null) {
    throw new Error(`proxy status ${response.status}`)
  }
  const reader = response.body.getReader()
  const decoder = new TextDecoder()
  let buffer = ""
  while (!buffer.includes("\n")) {
    const chunk = await reader.read()
    if (chunk.done) {
      break
    }
    buffer += decoder.decode(chunk.value, { stream: true })
  }
  await reader.cancel()
}
