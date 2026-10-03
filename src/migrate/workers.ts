export type WorkerId = "worker-a" | "worker-b" | "worker-c"

export type Snapshot = {
  memBytes: number
  stateBytes: number
  diskBytes: number
}

export type GuestEvent = {
  bootId: string
  pid: number
  counter: number
}

// What a move asks a worker to do.
// MemoryWorkers is the in-memory stand-in. FirecrackerWorkers drives the real processes.
export interface WorkerSet {
  addSandbox(id: string, workerId: WorkerId, guest: GuestEvent): Promise<void>
  isUp(workerId: WorkerId): Promise<boolean>
  where(sandboxId: string): Promise<WorkerId>
  guest(sandboxId: string): Promise<GuestEvent>
  isRunning(sandboxId: string, workerId: WorkerId): Promise<boolean>
  pause(sandboxId: string): Promise<void>
  snapshot(sandboxId: string): Promise<Snapshot>
  copy(sandboxId: string, destination: WorkerId, snapshot: Snapshot): Promise<void>
  restore(sandboxId: string, destination: WorkerId, snapshot: Snapshot): Promise<void>
  readEvent(sandboxId: string, workerId: WorkerId): Promise<GuestEvent>
  discard(sandboxId: string, destination: WorkerId): Promise<void>
  resume(sandboxId: string): Promise<void>
  cutOver(sandboxId: string, destination: WorkerId): Promise<void>
}
