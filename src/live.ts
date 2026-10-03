import { execFile } from "node:child_process"
import path from "node:path"
import { promisify } from "node:util"
import { startApi } from "./api/server.ts"
import { bootGuest } from "./firecracker/machine.ts"
import { FirecrackerWorkers } from "./firecracker/workers.ts"
import { startProxy } from "./proxy/stream-proxy.ts"

const exec = promisify(execFile)
const workersScript = path.resolve(import.meta.dirname, "../scripts/workers.sh")

await exec("bash", [workersScript, "up"])
const running = await bootGuest("worker-a")
const proxy = await startProxy({ host: running.host, port: running.port })
const workers = new FirecrackerWorkers(proxy)
await workers.addSandbox("sb-1", "worker-a", { bootId: "", pid: 0, counter: 0 })
const api = await startApi(workers, { proxy, sandboxId: "sb-1" })
console.log(`http://127.0.0.1:${api.port}/`)
