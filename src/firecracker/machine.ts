import { execFile, spawn } from "node:child_process"
import { closeSync, existsSync, mkdirSync, openSync, readFileSync, rmSync, symlinkSync, copyFileSync } from "node:fs"
import http from "node:http"
import path from "node:path"
import { promisify } from "node:util"
import type { WorkerId } from "../migrate/workers.ts"

const exec = promisify(execFile)
const repoRoot = path.resolve(import.meta.dirname, "../..")

// Matches the veth addresses in scripts/workers.sh.
// The guest itself is always 172.16.0.2. The proxy uses this address.
export const reachHost: Record<WorkerId, string> = {
  "worker-a": "10.0.1.2",
  "worker-b": "10.0.2.2",
  "worker-c": "10.0.3.2",
}

const counterPort = 8080

export type RunningGuest = {
  host: string
  port: number
  stop(): Promise<void>
}

export async function bootGuest(workerId: WorkerId): Promise<RunningGuest> {
  const assets = path.join(repoRoot, "assets")
  const firecracker = path.join(assets, "firecracker")
  const kernel = path.join(assets, "vmlinux")
  const baseRootfs = path.join(assets, "rootfs.ext4")
  for (const file of [firecracker, kernel, baseRootfs]) {
    if (!existsSync(file)) {
      throw new Error(`missing ${file}. Run make setup`)
    }
  }

  const workDir = path.join(repoRoot, "run", workerId)
  rmSync(workDir, { recursive: true, force: true })
  mkdirSync(workDir, { recursive: true })
  symlinkSync(kernel, path.join(workDir, "vmlinux"))
  copyFileSync(baseRootfs, path.join(workDir, "rootfs.ext4"))

  const started = await startFirecracker(workerId, workDir)
  const guest: RunningGuest = {
    host: reachHost[workerId],
    port: counterPort,
    stop: started.stop,
  }

  try {
    await configure(started.socketPath)
    await waitForCounter(guest.host, guest.port, started.logPath)
    return guest
  } catch (error) {
    await guest.stop()
    const detail = error instanceof Error ? error.message : String(error)
    throw new Error(`${detail}\n${tail(started.logPath)}`)
  }
}

export async function startFirecracker(
  workerId: WorkerId,
  workDir: string,
): Promise<{ socketPath: string; logPath: string; stop(): Promise<void> }> {
  const firecracker = path.join(repoRoot, "assets", "firecracker")
  const socketPath = path.join(workDir, "firecracker.sock")
  const logPath = path.join(workDir, "console.log")
  const logFd = openSync(logPath, "a")
  // cd in the namespace so the kernel and disk paths stay relative.
  const child = spawn(
    "sudo",
    [
      "-n",
      "ip",
      "netns",
      "exec",
      workerId,
      "sh",
      "-c",
      'cd "$1" && exec "$2" --api-sock "$3"',
      "sh",
      workDir,
      firecracker,
      socketPath,
    ],
    { detached: true, stdio: ["ignore", logFd, logFd] },
  )
  closeSync(logFd)
  child.unref()
  try {
    await waitForSocket(socketPath)
    await exec("sudo", ["-n", "chmod", "666", socketPath])
  } catch (error) {
    await stopFirecracker(socketPath)
    const detail = error instanceof Error ? error.message : String(error)
    throw new Error(`${detail}\n${tail(logPath)}`)
  }
  return {
    socketPath,
    logPath,
    stop() {
      return stopFirecracker(socketPath)
    },
  }
}

export function stopFirecracker(socketPath: string): Promise<void> {
  return exec("sudo", ["-n", "pkill", "-f", socketPath]).then(
    () => undefined,
    () => undefined,
  )
}

async function configure(socketPath: string): Promise<void> {
  await callFirecracker(socketPath, "PUT", "/boot-source", {
    kernel_image_path: "vmlinux",
    boot_args:
      "console=ttyS0 reboot=k panic=1 pci=off root=/dev/vda rw ip=172.16.0.2::172.16.0.1:255.255.255.252::eth0:off init=/opt/demo/init",
  })
  await callFirecracker(socketPath, "PUT", "/drives/rootfs", {
    drive_id: "rootfs",
    path_on_host: "rootfs.ext4",
    is_root_device: true,
    is_read_only: false,
  })
  await callFirecracker(socketPath, "PUT", "/machine-config", {
    vcpu_count: 1,
    mem_size_mib: 256,
  })
  await callFirecracker(socketPath, "PUT", "/network-interfaces/eth0", {
    iface_id: "eth0",
    guest_mac: "06:00:AC:10:00:02",
    host_dev_name: "tap0",
  })
  await callFirecracker(socketPath, "PUT", "/actions", { action_type: "InstanceStart" })
}

export function callFirecracker(
  socketPath: string,
  method: string,
  apiPath: string,
  body: unknown,
): Promise<void> {
  const payload = JSON.stringify(body)
  return new Promise((resolve, reject) => {
    const request = http.request(
      {
        socketPath,
        method,
        path: apiPath,
        headers: {
          "content-type": "application/json",
          "content-length": Buffer.byteLength(payload),
        },
      },
      (response) => {
        const chunks: Buffer[] = []
        response.on("data", (chunk: Buffer) => chunks.push(chunk))
        response.on("end", () => {
          const text = Buffer.concat(chunks).toString("utf8")
          if ((response.statusCode ?? 500) >= 300) {
            reject(new Error(`${method} ${apiPath} ${response.statusCode}: ${text}`))
            return
          }
          resolve()
        })
      },
    )
    request.on("error", reject)
    request.write(payload)
    request.end()
  })
}

async function waitForSocket(socketPath: string): Promise<void> {
  const started = Date.now()
  while (!existsSync(socketPath)) {
    if (Date.now() - started > 5000) {
      throw new Error("firecracker did not open its socket")
    }
    await delay(50)
  }
}

async function waitForCounter(host: string, port: number, logPath: string): Promise<void> {
  const started = Date.now()
  let lastError = "counter did not answer"
  while (Date.now() - started < 30000) {
    try {
      await probe(host, port)
      return
    } catch (error) {
      lastError = error instanceof Error ? error.message : String(error)
      await delay(200)
    }
  }
  throw new Error(`${lastError}\n${tail(logPath)}`)
}

function probe(host: string, port: number): Promise<void> {
  return new Promise((resolve, reject) => {
    const request = http.get({ host, port, path: "/events", timeout: 1000 }, (response) => {
      response.resume()
      request.destroy()
      if ((response.statusCode ?? 500) >= 300) {
        reject(new Error(`counter status ${response.statusCode}`))
        return
      }
      resolve()
    })
    request.on("error", reject)
    request.on("timeout", () => {
      request.destroy()
      reject(new Error("counter timed out"))
    })
  })
}

function tail(logPath: string): string {
  if (!existsSync(logPath)) {
    return ""
  }
  return readFileSync(logPath, "utf8").slice(-2000)
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}
