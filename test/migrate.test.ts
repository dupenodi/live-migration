import assert from "node:assert/strict"
import { test } from "node:test"
import { MemoryWorkers } from "../src/migrate/memory-workers.ts"
import {
  IdempotencyConflict,
  MigrationStore,
  runMigration,
} from "../src/migrate/run-migration.ts"
import type { GuestEvent } from "../src/migrate/workers.ts"

const GUEST: GuestEvent = { bootId: "boot-1", pid: 417, counter: 38 }

function setup() {
  const workers = new MemoryWorkers()
  workers.addSandbox("sb-1", "worker-a", GUEST)
  const store = new MigrationStore()
  return { workers, store }
}

test("moves the sandbox to the destination and stops the source", async () => {
  const { workers, store } = setup()

  const migration = await runMigration(
    workers,
    { sandboxId: "sb-1", destination: "worker-b", idempotencyKey: "move-1" },
    store,
  )

  assert.equal(migration.phase, "succeeded")
  assert.deepEqual(migration.phases, [
    "pending",
    "pausing",
    "snapshotting",
    "transferring",
    "restoring",
    "health_check",
    "cutting_over",
    "succeeded",
  ])
  assert.equal(migration.bytesTransferred, 170)
  assert.equal(migration.source, "worker-a")
  assert.equal(await workers.where("sb-1"), "worker-b")
  assert.equal(await workers.isRunning("sb-1", "worker-b"), true)
  assert.equal(await workers.isRunning("sb-1", "worker-a"), false)
  assert.deepEqual(await workers.guest("sb-1"), GUEST)
})

test("leaves the source running when the destination is down", async () => {
  const { workers, store } = setup()
  workers.setDown("worker-b")

  const migration = await runMigration(
    workers,
    { sandboxId: "sb-1", destination: "worker-b", idempotencyKey: "move-1" },
    store,
  )

  assert.equal(migration.phase, "failed")
  assert.equal(migration.error, "destination worker is down")
  assert.equal(workers.pauseCount.get("sb-1"), undefined)
  assert.equal(await workers.isRunning("sb-1", "worker-a"), true)
  assert.equal(await workers.isRunning("sb-1", "worker-b"), false)
})

test("resumes the source when the copy is interrupted", async () => {
  const { workers, store } = setup()
  workers.failCopy = true

  const migration = await runMigration(
    workers,
    { sandboxId: "sb-1", destination: "worker-b", idempotencyKey: "move-1" },
    store,
  )

  assert.equal(migration.phase, "rolled_back")
  assert.equal(migration.error, "copy interrupted")
  assert.equal(await workers.isRunning("sb-1", "worker-a"), true)
  assert.equal(await workers.isRunning("sb-1", "worker-b"), false)

  const again = await runMigration(
    workers,
    { sandboxId: "sb-1", destination: "worker-b", idempotencyKey: "move-1" },
    store,
  )
  assert.equal(again.id, migration.id)
  assert.equal(workers.pauseCount.get("sb-1"), 1)
})

test("returns the same migration when the request is repeated", async () => {
  const { workers, store } = setup()
  const request = {
    sandboxId: "sb-1",
    destination: "worker-b" as const,
    idempotencyKey: "move-1",
  }

  const first = await runMigration(workers, request, store)
  const second = await runMigration(workers, request, store)

  assert.equal(second.id, first.id)
  assert.equal(second.phase, "succeeded")
  assert.equal(workers.pauseCount.get("sb-1"), 1)
})

test("rejects a repeated key that names a different destination", async () => {
  const { workers, store } = setup()
  await runMigration(
    workers,
    { sandboxId: "sb-1", destination: "worker-b", idempotencyKey: "move-1" },
    store,
  )

  await assert.rejects(
    () =>
      runMigration(
        workers,
        {
          sandboxId: "sb-1",
          destination: "worker-a",
          idempotencyKey: "move-1",
        },
        store,
      ),
    IdempotencyConflict,
  )
  assert.equal(await workers.where("sb-1"), "worker-b")
})

test("moves back to the original worker on a second migration", async () => {
  const { workers, store } = setup()

  const toB = await runMigration(
    workers,
    { sandboxId: "sb-1", destination: "worker-b", idempotencyKey: "to-b" },
    store,
  )
  const toA = await runMigration(
    workers,
    { sandboxId: "sb-1", destination: "worker-a", idempotencyKey: "to-a" },
    store,
  )

  assert.equal(toB.phase, "succeeded")
  assert.equal(toB.source, "worker-a")
  assert.equal(toA.phase, "succeeded")
  assert.equal(toA.source, "worker-b")
  assert.notEqual(toA.id, toB.id)
  assert.equal(await workers.where("sb-1"), "worker-a")
  assert.equal(await workers.isRunning("sb-1", "worker-a"), true)
  assert.equal(await workers.isRunning("sb-1", "worker-b"), false)
  assert.deepEqual(await workers.guest("sb-1"), GUEST)
})

test("moves the sandbox from A to B to C", async () => {
  const { workers, store } = setup()

  const toB = await runMigration(
    workers,
    { sandboxId: "sb-1", destination: "worker-b", idempotencyKey: "to-b" },
    store,
  )
  const toC = await runMigration(
    workers,
    { sandboxId: "sb-1", destination: "worker-c", idempotencyKey: "to-c" },
    store,
  )

  assert.equal(toB.phase, "succeeded")
  assert.equal(toC.phase, "succeeded")
  assert.equal(toC.source, "worker-b")
  assert.notEqual(toC.id, toB.id)
  assert.equal(await workers.where("sb-1"), "worker-c")
  assert.equal(await workers.isRunning("sb-1", "worker-c"), true)
  assert.equal(await workers.isRunning("sb-1", "worker-a"), false)
  assert.equal(await workers.isRunning("sb-1", "worker-b"), false)
  assert.deepEqual(await workers.guest("sb-1"), GUEST)
})

test("resumes the source when the restored guest does not match", async () => {
  const { workers, store } = setup()
  workers.reportGuestOnRestore("sb-1", { bootId: "other", pid: 1, counter: 0 })

  const migration = await runMigration(
    workers,
    { sandboxId: "sb-1", destination: "worker-b", idempotencyKey: "move-1" },
    store,
  )

  assert.equal(migration.phase, "rolled_back")
  assert.equal(migration.error, "restored boot id does not match")
  assert.equal(await workers.isRunning("sb-1", "worker-a"), true)
  assert.equal(await workers.isRunning("sb-1", "worker-b"), false)
  assert.deepEqual(await workers.guest("sb-1"), GUEST)
})
