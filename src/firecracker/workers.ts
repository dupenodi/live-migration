import { execFile } from "node:child_process"
import { existsSync, readFileSync } from "node:fs"
import { copyFile, mkdir, rm, stat } from "node:fs/promises"
import path from "node:path"
import { promisify } from "node:util"
import type { GuestEvent, Snapshot, WorkerId, WorkerSet } from "../migrate/workers.ts"
import type { Proxy } from "../proxy/stream-proxy.ts"
import {
  callFirecracker,
  reachHost,
  startFirecracker,
  stopFirecracker,
} from "./machine.ts"

const exec = promisify(execFile)
const repoRoot = path.resolve(import.meta.dirname, "../..")
const counterPort = 8080

type Sandbox = {
  id: string
  workerId: WorkerId
  paused: boolean
}

type Machine = {
  socketPath: string
  workDir: string
}

// Real workers. The guest was already booted; addSandbox records where it is.
// cutOver points the proxy at the destination and then stops the source.
export class FirecrackerWorkers implements WorkerSet {
  private sandboxes = new Map<string, Sandbox>()
  private machines = new Map<WorkerId, Machine>()
  private proxy: Proxy

  constructor(proxy: Proxy) {
    this.proxy = proxy
  }

  async addSandbox(id: string, workerId: WorkerId, _guest: GuestEvent): Promise<void> {
    const workDir = path.join(repoRoot, "run", workerId)
    this.sandboxes.set(id, { id, workerId, paused: false })
    this.machines.set(workerId, {
      socketPath: path.join(workDir, "firecracker.sock"),
      workDir,
    })
  }

  async isUp(workerId: WorkerId): Promise<boolean> {
    const listed = await exec("sudo", ["-n", "ip", "netns", "list"])
    return listed.stdout.split("\n").some((line) => line.split(/\s+/)[0] === workerId)
  }

  async where(sandboxId: string): Promise<WorkerId> {
    return this.require(sandboxId).workerId
  }

  async guest(sandboxId: string): Promise<GuestEvent> {
    const sandbox = this.require(sandboxId)
    return readHealth(reachHost[sandbox.workerId])
  }

  async isRunning(sandboxId: string, workerId: WorkerId): Promise<boolean> {
    const sandbox = this.require(sandboxId)
    return sandbox.workerId === workerId && !sandbox.paused
  }

  async pause(sandboxId: string): Promise<void> {
    const sandbox = this.require(sandboxId)
    const machine = this.machine(sandbox.workerId)
    await callFirecracker(machine.socketPath, "PATCH", "/vm", { state: "Paused" })
    sandbox.paused = true
  }

  async snapshot(sandboxId: string): Promise<Snapshot> {
    const machine = this.machine(this.require(sandboxId).workerId)
    await callFirecracker(machine.socketPath, "PUT", "/snapshot/create", {
      snapshot_type: "Full",
      snapshot_path: "vm.snap",
      mem_file_path: "vm.mem",
    })
    const mem = await stat(path.join(machine.workDir, "vm.mem"))
    const state = await stat(path.join(machine.workDir, "vm.snap"))
    const disk = await stat(path.join(machine.workDir, "rootfs.ext4"))
    return { memBytes: mem.size, stateBytes: state.size, diskBytes: disk.size }
  }

  async copy(sandboxId: string, destination: WorkerId, _snapshot: Snapshot): Promise<void> {
    const source = this.machine(this.require(sandboxId).workerId)
    const destDir = path.join(repoRoot, "run", destination)
    if (existsSync(destDir) && !(await stat(destDir)).isDirectory()) {
      throw new Error("copy interrupted")
    }
    await rm(destDir, { recursive: true, force: true })
    await mkdir(destDir)
    await copyFile(path.join(source.workDir, "vm.mem"), path.join(destDir, "vm.mem"))
    await copyFile(path.join(source.workDir, "vm.snap"), path.join(destDir, "vm.snap"))
    await copyFile(path.join(source.workDir, "rootfs.ext4"), path.join(destDir, "rootfs.ext4"))
  }

  async restore(sandboxId: string, destination: WorkerId, _snapshot: Snapshot): Promise<void> {
    const destDir = path.join(repoRoot, "run", destination)
    const started = await startFirecracker(destination, destDir)
    try {
      await callFirecracker(started.socketPath, "PUT", "/snapshot/load", {
        snapshot_path: "vm.snap",
        mem_backend: { backend_path: "vm.mem", backend_type: "File" },
        resume_vm: true,
      })
      await waitForHealth(reachHost[destination])
    } catch (error) {
      await started.stop()
      const detail = error instanceof Error ? error.message : String(error)
      throw new Error(`${detail}\n${tail(started.logPath)}`)
    }
    this.machines.set(destination, { socketPath: started.socketPath, workDir: destDir })
  }

  async readEvent(sandboxId: string, workerId: WorkerId): Promise<GuestEvent> {
    this.require(sandboxId)
    return readHealth(reachHost[workerId])
  }

  async discard(sandboxId: string, destination: WorkerId): Promise<void> {
    const sandbox = this.require(sandboxId)
    if (destination === sandbox.workerId) {
      return
    }
    const machine = this.machines.get(destination)
    if (machine) {
      await stopFirecracker(machine.socketPath)
      this.machines.delete(destination)
    }
    const destDir = path.join(repoRoot, "run", destination)
    if (existsSync(destDir) && (await stat(destDir)).isDirectory()) {
      await rm(destDir, { recursive: true, force: true })
    }
  }

  async resume(sandboxId: string): Promise<void> {
    const sandbox = this.require(sandboxId)
    const machine = this.machine(sandbox.workerId)
    await callFirecracker(machine.socketPath, "PATCH", "/vm", { state: "Resumed" })
    sandbox.paused = false
  }

  async cutOver(sandboxId: string, destination: WorkerId): Promise<void> {
    const sandbox = this.require(sandboxId)
    const source = sandbox.workerId
    this.proxy.switchBackend({ host: reachHost[destination], port: counterPort })
    const sourceMachine = this.machines.get(source)
    if (sourceMachine) {
      await stopFirecracker(sourceMachine.socketPath)
      this.machines.delete(source)
    }
    sandbox.workerId = destination
    sandbox.paused = false
  }

  private require(sandboxId: string): Sandbox {
    const sandbox = this.sandboxes.get(sandboxId)
    if (!sandbox) {
      throw new Error(`unknown sandbox ${sandboxId}`)
    }
    return sandbox
  }

  private machine(workerId: WorkerId): Machine {
    const machine = this.machines.get(workerId)
    if (!machine) {
      throw new Error(`no firecracker process on ${workerId}`)
    }
    return machine
  }
}

async function readHealth(host: string): Promise<GuestEvent> {
  const response = await fetch(`http://${host}:${counterPort}/health`, {
    signal: AbortSignal.timeout(5000),
  })
  if (!response.ok) {
    throw new Error(`health ${response.status}`)
  }
  const body = (await response.json()) as { boot_id: string; pid: number; counter: number }
  return { bootId: body.boot_id, pid: body.pid, counter: body.counter }
}

async function waitForHealth(host: string): Promise<void> {
  const started = Date.now()
  let lastError = "restored guest did not answer"
  while (Date.now() - started < 20000) {
    try {
      await readHealth(host)
      return
    } catch (error) {
      lastError = error instanceof Error ? error.message : String(error)
      await new Promise((resolve) => setTimeout(resolve, 200))
    }
  }
  throw new Error(lastError)
}

function tail(logPath: string): string {
  if (!existsSync(logPath)) {
    return ""
  }
  return readFileSync(logPath, "utf8").slice(-2000)
}
