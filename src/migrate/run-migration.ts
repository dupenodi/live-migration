import type { GuestEvent, WorkerId, WorkerSet } from "./workers.ts"

export type Phase =
  | "pending"
  | "pausing"
  | "snapshotting"
  | "transferring"
  | "restoring"
  | "health_check"
  | "cutting_over"
  | "succeeded"
  | "failed"
  | "rolled_back"

export type Migration = {
  id: string
  sandboxId: string
  source: WorkerId
  destination: WorkerId
  idempotencyKey: string
  phase: Phase
  phases: Phase[]
  bytesTransferred: number
  startedAt: number
  pausedAt: number
  resumedAt: number
  finishedAt: number
  error?: string
}

export type MigrationRequest = {
  sandboxId: string
  destination: WorkerId
  idempotencyKey: string
}

export class IdempotencyConflict extends Error {
  readonly status = 409

  constructor(message: string) {
    super(message)
    this.name = "IdempotencyConflict"
  }
}

// Remembers migrations so the same request does not run twice.
export class MigrationStore {
  private byKey = new Map<string, Migration>()
  private nextId = 1

  find(request: MigrationRequest): Migration | undefined {
    return this.byKey.get(this.key(request))
  }

  create(input: {
    sandboxId: string
    source: WorkerId
    destination: WorkerId
    idempotencyKey: string
  }): Migration {
    const migration: Migration = {
      id: `move-${this.nextId++}`,
      sandboxId: input.sandboxId,
      source: input.source,
      destination: input.destination,
      idempotencyKey: input.idempotencyKey,
      phase: "pending",
      phases: ["pending"],
      bytesTransferred: 0,
      startedAt: Date.now(),
      pausedAt: 0,
      resumedAt: 0,
      finishedAt: 0,
    }
    this.byKey.set(this.key(input), migration)
    return migration
  }

  mark(migration: Migration, phase: Phase, error?: string): void {
    migration.phase = phase
    migration.phases.push(phase)
    if (error) {
      migration.error = error
    }
  }

  private key(input: { sandboxId: string; idempotencyKey: string }): string {
    return `${input.sandboxId}:${input.idempotencyKey}`
  }
}

// Move one sandbox. On any failure after the pause, throw away the destination
// copy and resume the source so only one copy is left running.
export async function runMigration(
  workers: WorkerSet,
  request: MigrationRequest,
  store: MigrationStore,
): Promise<Migration> {
  const existing = store.find(request)
  if (existing) {
    if (existing.destination !== request.destination) {
      throw new IdempotencyConflict(
        "This idempotency key was already used for a different destination",
      )
    }
    return existing
  }

  const source = await workers.where(request.sandboxId)
  if (request.destination === source) {
    throw new Error("sandbox is already on the destination worker")
  }

  const guest = await workers.guest(request.sandboxId)
  const migration = store.create({
    sandboxId: request.sandboxId,
    source,
    destination: request.destination,
    idempotencyKey: request.idempotencyKey,
  })

  if (!(await workers.isUp(request.destination))) {
    store.mark(migration, "failed", "destination worker is down")
    migration.finishedAt = Date.now()
    return migration
  }

  try {
    store.mark(migration, "pausing")
    migration.pausedAt = Date.now()
    await workers.pause(request.sandboxId)

    store.mark(migration, "snapshotting")
    const snapshot = await workers.snapshot(request.sandboxId)

    store.mark(migration, "transferring")
    await workers.copy(request.sandboxId, request.destination, snapshot)
    migration.bytesTransferred =
      snapshot.memBytes + snapshot.stateBytes + snapshot.diskBytes

    store.mark(migration, "restoring")
    await workers.restore(request.sandboxId, request.destination, snapshot)

    store.mark(migration, "health_check")
    const restored = await workers.readEvent(request.sandboxId, request.destination)
    assertGuestContinued(guest, restored)

    store.mark(migration, "cutting_over")
    await workers.cutOver(request.sandboxId, request.destination)
    migration.resumedAt = Date.now()

    store.mark(migration, "succeeded")
  } catch (error) {
    await workers.discard(request.sandboxId, request.destination)
    await workers.resume(request.sandboxId)
    migration.resumedAt = Date.now()
    const message = error instanceof Error ? error.message : "migration failed"
    store.mark(migration, "rolled_back", message)
  }

  migration.finishedAt = Date.now()
  return migration
}

function assertGuestContinued(before: GuestEvent, after: GuestEvent): void {
  if (after.bootId !== before.bootId) {
    throw new Error("restored boot id does not match")
  }
  if (after.pid !== before.pid) {
    throw new Error("restored pid does not match")
  }
  if (after.counter < before.counter) {
    throw new Error("restored counter went backwards")
  }
}
