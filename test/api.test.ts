import assert from "node:assert/strict"
import { test } from "node:test"
import { startApi } from "../src/api/server.ts"
import { MemoryWorkers } from "../src/migrate/memory-workers.ts"
import { ApiError, createClient } from "../src/sdk/client.ts"

test("migrates through the SDK", async () => {
  const workers = new MemoryWorkers()
  const api = await startApi(workers)
  const client = createClient(`http://127.0.0.1:${api.port}`)

  try {
    const sandbox = await client.sandboxes.create({
      region: "worker-a",
      cpu: 2,
      memoryMb: 2048,
    })
    await sandbox.files.write("/opt/demo/server.py", "print('hi')\n")
    await sandbox.commands.run({
      command: "python3 /opt/demo/server.py",
      background: true,
    })
    const port = await sandbox.ports.expose({ guestPort: 8080 })
    assert.equal(port.guestPort, 8080)

    const migration = await sandbox.migrate({
      destination: "worker-b",
      idempotencyKey: "move-1",
    })
    const progress = []
    for await (const event of migration.watch()) {
      progress.push(event)
    }

    assert.deepEqual(
      progress.map((event) => event.phase),
      [
        "pending",
        "pausing",
        "snapshotting",
        "transferring",
        "restoring",
        "health_check",
        "cutting_over",
        "succeeded",
      ],
    )
    // 100 + 20 + 50 bytes from the fake snapshot.
    assert.equal(progress.at(-1)?.bytesTransferred, 170)

    const repeated = await sandbox.migrate({
      destination: "worker-b",
      idempotencyKey: "move-1",
    })
    assert.equal(repeated.id, migration.id)
    assert.equal(workers.pauseCount.get(sandbox.id), 1)

    const view = await sandbox.inspect()
    assert.equal(view.region, "worker-b")
    assert.equal(view.cpu, 2)
    assert.equal(view.memoryMb, 2048)
    assert.equal(view.files[0]?.path, "/opt/demo/server.py")
    assert.equal(view.files[0]?.content, "print('hi')\n")
    assert.equal(view.commands[0]?.command, "python3 /opt/demo/server.py")
    assert.equal(view.commands[0]?.background, true)
    assert.equal(view.ports[0]?.guestPort, 8080)

    await assert.rejects(
      () =>
        sandbox.migrate({
          destination: "worker-a",
          idempotencyKey: "move-1",
        }),
      (error: unknown) => error instanceof ApiError && error.status === 409,
    )
  } finally {
    await api.close()
  }
})

test("live mode moves the sandbox that is already running", async () => {
  const workers = new MemoryWorkers()
  await workers.addSandbox("sb-1", "worker-a", { bootId: "boot-1", pid: 417, counter: 1 })
  const api = await startApi(workers, {
    sandboxId: "sb-1",
    proxy: {
      port: 0,
      switchBackend() {},
      async close() {},
    },
  })

  try {
    const response = await fetch(`http://127.0.0.1:${api.port}/v1/sandboxes/sb-1/migrations`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "idempotency-key": "move-1",
      },
      body: JSON.stringify({ destination: "worker-b" }),
    })
    const migration = await response.json()
    assert.equal(response.status, 200)
    assert.equal(migration.phase, "succeeded")
    assert.equal(await workers.where("sb-1"), "worker-b")
  } finally {
    await api.close()
  }
})
