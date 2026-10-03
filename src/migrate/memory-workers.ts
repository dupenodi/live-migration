import type { GuestEvent, Snapshot, WorkerId, WorkerSet } from "./workers.ts"

type Sandbox = {
  id: string
  workerId: WorkerId
  paused: boolean
  bootId: string
  pid: number
  counter: number
  copiedTo?: WorkerId
  restored?: { workerId: WorkerId; guest: GuestEvent }
  guestOnRestore?: GuestEvent
}

const SNAPSHOT: Snapshot = {
  memBytes: 100,
  stateBytes: 20,
  diskBytes: 50,
}

// Two workers and their sandboxes, held in memory so tests can run without KVM.
export class MemoryWorkers implements WorkerSet {
  pauseCount = new Map<string, number>()
  failCopy = false
  failRestore = false

  private up = new Map<WorkerId, boolean>([
    ["worker-a", true],
    ["worker-b", true],
    ["worker-c", true],
  ])
  private sandboxes = new Map<string, Sandbox>()

  async addSandbox(id: string, workerId: WorkerId, guest: GuestEvent): Promise<void> {
    this.sandboxes.set(id, {
      id,
      workerId,
      paused: false,
      bootId: guest.bootId,
      pid: guest.pid,
      counter: guest.counter,
    })
  }

  setDown(workerId: WorkerId): void {
    this.up.set(workerId, false)
  }

  // The destination health check will see this guest instead of the real one.
  reportGuestOnRestore(sandboxId: string, guest: GuestEvent): void {
    this.require(sandboxId).guestOnRestore = guest
  }

  async isUp(workerId: WorkerId): Promise<boolean> {
    return this.up.get(workerId) === true
  }

  async where(sandboxId: string): Promise<WorkerId> {
    return this.require(sandboxId).workerId
  }

  async guest(sandboxId: string): Promise<GuestEvent> {
    const sandbox = this.require(sandboxId)
    return {
      bootId: sandbox.bootId,
      pid: sandbox.pid,
      counter: sandbox.counter,
    }
  }

  async isRunning(sandboxId: string, workerId: WorkerId): Promise<boolean> {
    const sandbox = this.require(sandboxId)
    return sandbox.workerId === workerId && !sandbox.paused
  }

  async pause(sandboxId: string): Promise<void> {
    const sandbox = this.require(sandboxId)
    if (sandbox.paused) {
      throw new Error("sandbox is already paused")
    }
    sandbox.paused = true
    this.pauseCount.set(sandboxId, (this.pauseCount.get(sandboxId) ?? 0) + 1)
  }

  async snapshot(sandboxId: string): Promise<Snapshot> {
    const sandbox = this.require(sandboxId)
    if (!sandbox.paused) {
      throw new Error("sandbox must be paused before a snapshot")
    }
    return { ...SNAPSHOT }
  }

  async copy(sandboxId: string, destination: WorkerId, _snapshot: Snapshot): Promise<void> {
    if (this.failCopy) {
      throw new Error("copy interrupted")
    }
    const sandbox = this.require(sandboxId)
    sandbox.copiedTo = destination
  }

  async restore(sandboxId: string, destination: WorkerId, _snapshot: Snapshot): Promise<void> {
    if (this.failRestore) {
      throw new Error("restore failed")
    }
    const sandbox = this.require(sandboxId)
    if (sandbox.copiedTo !== destination) {
      throw new Error("snapshot was not copied to this worker")
    }
    sandbox.restored = {
      workerId: destination,
      guest: sandbox.guestOnRestore ?? (await this.guest(sandboxId)),
    }
  }

  async readEvent(sandboxId: string, workerId: WorkerId): Promise<GuestEvent> {
    const sandbox = this.require(sandboxId)
    if (sandbox.restored?.workerId === workerId) {
      return sandbox.restored.guest
    }
    throw new Error("no restored guest on this worker")
  }

  async discard(sandboxId: string, destination: WorkerId): Promise<void> {
    const sandbox = this.require(sandboxId)
    if (sandbox.copiedTo === destination) {
      sandbox.copiedTo = undefined
    }
    if (sandbox.restored?.workerId === destination) {
      sandbox.restored = undefined
    }
  }

  async resume(sandboxId: string): Promise<void> {
    const sandbox = this.require(sandboxId)
    sandbox.paused = false
    sandbox.copiedTo = undefined
    sandbox.restored = undefined
  }

  async cutOver(sandboxId: string, destination: WorkerId): Promise<void> {
    const sandbox = this.require(sandboxId)
    if (sandbox.restored?.workerId !== destination) {
      throw new Error("destination is not restored")
    }
    sandbox.workerId = destination
    sandbox.paused = false
    sandbox.copiedTo = undefined
    sandbox.restored = undefined
  }

  private require(sandboxId: string): Sandbox {
    const sandbox = this.sandboxes.get(sandboxId)
    if (!sandbox) {
      throw new Error(`unknown sandbox ${sandboxId}`)
    }
    return sandbox
  }
}
