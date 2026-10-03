import assert from "node:assert/strict"
import { execFile } from "node:child_process"
import { existsSync } from "node:fs"
import path from "node:path"
import { test } from "node:test"
import { promisify } from "node:util"
import { bootGuest } from "../src/firecracker/machine.ts"
import { startProxy } from "../src/proxy/stream-proxy.ts"

const exec = promisify(execFile)
const workersScript = path.resolve(import.meta.dirname, "../scripts/workers.sh")

type GuestLine = {
  boot_id: string
  pid: number
  counter: number
}

test(
  "boots one guest and reads three events through the proxy",
  { skip: existsSync("/dev/kvm") ? false : "needs Linux /dev/kvm", timeout: 120_000 },
  async () => {
    await exec("bash", [workersScript, "up"])
    const guest = await bootGuest("worker-a")
    const proxy = await startProxy({ host: guest.host, port: guest.port })

    try {
      const events = await readEvents(proxy.port, 3)
      assert.equal(events[0].boot_id, events[1].boot_id)
      assert.equal(events[1].boot_id, events[2].boot_id)
      assert.equal(events[0].pid, events[1].pid)
      assert.equal(events[1].pid, events[2].pid)
      assert.equal(events[1].counter, events[0].counter + 1)
      assert.equal(events[2].counter, events[1].counter + 1)
    } finally {
      await proxy.close()
      await guest.stop()
      await exec("bash", [workersScript, "down"])
    }
  },
)

async function readEvents(port: number, count: number): Promise<GuestLine[]> {
  const response = await fetch(`http://127.0.0.1:${port}/events`)
  if (!response.ok || response.body === null) {
    throw new Error(`proxy status ${response.status}`)
  }
  const reader = response.body.getReader()
  const decoder = new TextDecoder()
  let buffer = ""
  const events: GuestLine[] = []
  while (events.length < count) {
    const chunk = await reader.read()
    if (chunk.done) {
      break
    }
    buffer += decoder.decode(chunk.value, { stream: true })
    const lines = buffer.split("\n")
    buffer = lines.pop() ?? ""
    for (const line of lines) {
      if (line.length === 0) {
        continue
      }
      events.push(JSON.parse(line) as GuestLine)
    }
  }
  await reader.cancel()
  return events.slice(0, count)
}
