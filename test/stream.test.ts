import assert from "node:assert/strict"
import { spawn, type ChildProcess } from "node:child_process"
import { mkdtempSync } from "node:fs"
import http from "node:http"
import { tmpdir } from "node:os"
import path from "node:path"
import { test } from "node:test"
import { startProxy } from "../src/proxy/stream-proxy.ts"

type GuestLine = {
  boot_id: string
  pid: number
  counter: number
  time: string
}

type Running = {
  port: number
  stop(): void
}

function startScript(
  script: string,
  env: Record<string, string> = {},
): Promise<Running> {
  const child = spawn("python3", [script, "0"], {
    env: { ...process.env, ...env },
    stdio: ["ignore", "pipe", "pipe"],
  })
  return waitForListen(child)
}

function waitForListen(child: ChildProcess): Promise<Running> {
  return new Promise((resolve, reject) => {
    let stderr = ""
    let settled = false
    child.stderr?.setEncoding("utf8")
    child.stderr?.on("data", (chunk: string) => {
      stderr += chunk
    })
    child.stdout?.setEncoding("utf8")
    let buffer = ""
    child.stdout?.on("data", (chunk: string) => {
      buffer += chunk
      const match = buffer.match(/listening (\d+)/)
      if (!match || settled) {
        return
      }
      settled = true
      resolve({
        port: Number(match[1]),
        stop() {
          child.kill("SIGKILL")
        },
      })
    })
    child.on("exit", (code) => {
      if (!settled) {
        reject(new Error(`process exited ${code}: ${stderr}`))
      }
    })
  })
}

function openEvents(port: number): Promise<http.IncomingMessage> {
  return new Promise((resolve, reject) => {
    const request = http.get(
      { host: "127.0.0.1", port, path: "/events" },
      resolve,
    )
    request.on("error", reject)
  })
}

function collectLines(response: http.IncomingMessage) {
  const events: GuestLine[] = []
  let buffer = ""
  const waiters: Array<() => void> = []

  response.setEncoding("utf8")
  response.on("data", (chunk: string) => {
    buffer += chunk
    const lines = buffer.split("\n")
    buffer = lines.pop() ?? ""
    for (const line of lines) {
      if (line.length === 0) {
        continue
      }
      events.push(JSON.parse(line) as GuestLine)
    }
    for (const wake of waiters.splice(0)) {
      wake()
    }
  })

  function take(count: number): Promise<GuestLine[]> {
    const start = events.length
    const ready = () => events.length >= start + count
    if (ready()) {
      return Promise.resolve(events.slice(start, start + count))
    }
    return new Promise((resolve) => {
      const wake = () => {
        if (ready()) {
          resolve(events.slice(start, start + count))
        } else {
          waiters.push(wake)
        }
      }
      waiters.push(wake)
    })
  }

  return { take, all: () => events }
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

test("keeps one client connection and a continuous counter across a switch", async () => {
  const shared = { BOOT_ID: "boot-1", GUEST_PID: "417", INTERVAL_SEC: "0.05" }
  const first = await startScript("guest/server.py", {
    ...shared,
    COUNTER_START: "1",
  })
  const proxy = await startProxy({ host: "127.0.0.1", port: first.port })
  const response = await openEvents(proxy.port)
  const lines = collectLines(response)

  try {
    assert.equal(response.statusCode, 200)
    await lines.take(2)
    first.stop()
    await delay(80)

    const seen = lines.all()
    const nextCounter = seen[seen.length - 1].counter + 1
    const second = await startScript("guest/server.py", {
      ...shared,
      COUNTER_START: String(nextCounter),
    })
    try {
      proxy.switchBackend({ host: "127.0.0.1", port: second.port })
      await lines.take(2)

      const counters = lines.all().map((event) => event.counter)
      assert.ok(counters.length >= 4)
      for (let index = 1; index < counters.length; index += 1) {
        assert.equal(counters[index], counters[index - 1] + 1)
      }
      assert.deepEqual(
        lines.all().map((event) => event.boot_id),
        lines.all().map(() => "boot-1"),
      )
      assert.deepEqual(
        lines.all().map((event) => event.pid),
        lines.all().map(() => 417),
      )
      assert.equal(response.complete, false)
    } finally {
      second.stop()
    }
  } finally {
    first.stop()
    response.destroy()
    await proxy.close()
  }
})

test("agent writes a file and runs a command", async () => {
  const agent = await startScript("guest/agent.py")
  const directory = mkdtempSync(path.join(tmpdir(), "guest-agent-"))
  const filePath = path.join(directory, "note.txt")

  try {
    const write = await fetch(`http://127.0.0.1:${agent.port}/files`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ path: filePath, content: "hello\n" }),
    })
    assert.equal(write.status, 204)

    const foreground = await fetch(`http://127.0.0.1:${agent.port}/commands`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        command: `cat ${JSON.stringify(filePath)}`,
        background: false,
      }),
    })
    const foregroundBody = (await foreground.json()) as {
      exitCode: number
      stdout: string
    }
    assert.equal(foregroundBody.exitCode, 0)
    assert.equal(foregroundBody.stdout, "hello\n")

    const started = Date.now()
    const background = await fetch(`http://127.0.0.1:${agent.port}/commands`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ command: "sleep 30", background: true }),
    })
    const backgroundBody = (await background.json()) as { pid: number }
    assert.ok(Date.now() - started < 2000)
    assert.equal(typeof backgroundBody.pid, "number")
    process.kill(backgroundBody.pid, 0)
    process.kill(-backgroundBody.pid, "SIGKILL")
  } finally {
    agent.stop()
  }
})
