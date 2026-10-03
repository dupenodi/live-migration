import { vmChip } from "/chip.js"

const place = document.querySelector("#place")
const output = document.querySelector("#output")
const actions = document.querySelector("#actions")
const steps = document.querySelector("#steps")
const metrics = document.querySelector("#metrics")
const moveNote = document.querySelector("#move-note")
const metricTotal = document.querySelector("#metric-total")
const metricPause = document.querySelector("#metric-pause")
const metricGap = document.querySelector("#metric-gap")
const metricBytes = document.querySelector("#metric-bytes")
const metricContinuity = document.querySelector("#metric-continuity")

const stepLabels = [
  (move) => ["Pause ", vmChip(move.source), " so the server stops changing"],
  "Save its memory and CPU state",
  (move) => ["Copy that save and the disk to ", vmChip(move.destination)],
  (move) => ["Start the same server on ", vmChip(move.destination)],
  "Check boot id, pid, and counter still match",
  (move) => ["Send the next lines from ", vmChip(move.destination)],
]

const reduceMotion = window.matchMedia("(prefers-reduced-motion: reduce)").matches
const demo = await fetch("/v1/demo").then((response) => response.json())

let here = demo.runningOn
let bootId = demo.bootId ?? ""
let pid = demo.pid ?? 0
let counter = demo.live ? 0 : demo.events[demo.events.length - 1].counter
let moving = false
const logEvents = []

if (demo.live) {
  showPlace()
  showButtons()
  void readLiveEvents()
} else {
  render(demo.events)
  showPlace()
  showButtons()
}

async function play(destination, button) {
  if (moving || destination === here) {
    return
  }
  if (demo.live) {
    await playLive(destination, button)
    return
  }
  moving = true
  const source = here
  for (const node of actions.querySelectorAll("button")) {
    node.disabled = true
  }
  button.textContent = "Moving this server"
  button.setAttribute("aria-busy", "true")

  const move = { source, destination }
  steps.hidden = false
  steps.replaceChildren(
    ...stepLabels.map((step) => {
      const parts = typeof step === "function" ? step(move) : [step]
      const item = document.createElement("li")
      item.className = "pending"
      const mark = document.createElement("span")
      mark.className = "mark"
      mark.setAttribute("aria-hidden", "true")
      const label = document.createElement("span")
      label.append(...parts)
      item.append(mark, label)
      return item
    }),
  )

  for (const item of steps.children) {
    await wait(reduceMotion ? 0 : 380)
    item.className = "done"
  }

  appendLog(el("div", "gap", "Server was paused, so it sent nothing here"))
  for (let count = 0; count < 2; count += 1) {
    await wait(reduceMotion ? 0 : 180)
    counter += 1
    appendLog(
      el(
        "div",
        "line",
        formatLine({ bootId, pid, counter }),
      ),
    )
  }

  here = destination
  showPlace()
  const trip = (demo.trips ?? []).find(
    (item) => item.source === source && item.destination === destination,
  )
  if (trip) {
    showReport(trip.report)
  } else {
    hideReport()
  }
  moving = false
  showButtons()
}

async function playLive(destination, button) {
  moving = true
  const source = here
  for (const node of actions.querySelectorAll("button")) {
    node.disabled = true
  }
  button.textContent = "Moving this server"
  button.setAttribute("aria-busy", "true")

  const move = { source, destination }
  steps.hidden = false
  steps.replaceChildren(
    ...stepLabels.map((step) => {
      const parts = typeof step === "function" ? step(move) : [step]
      const item = document.createElement("li")
      item.className = "pending"
      const mark = document.createElement("span")
      mark.className = "mark"
      mark.setAttribute("aria-hidden", "true")
      const label = document.createElement("span")
      label.append(...parts)
      item.append(mark, label)
      return item
    }),
  )
  appendLog(el("div", "gap", "Server was paused, so it sent nothing here"))

  const response = await fetch(`/v1/sandboxes/${demo.sandboxId}/migrations`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "idempotency-key": `move-${Date.now()}`,
    },
    body: JSON.stringify({ destination }),
  })
  const migration = await response.json()
  const succeeded = response.ok && migration.phase === "succeeded"
  for (const item of steps.children) {
    item.className = succeeded ? "done" : "pending"
  }
  if (succeeded) {
    here = destination
    const seenAtReturn = logEvents.length
    await waitForNextEvent(seenAtReturn)
    showReport(reportFrom(migration, logEvents))
  } else {
    hideReport()
    moveNote.hidden = false
    moveNote.textContent = migration.error
      ? `${migration.error}. This server is still here.`
      : "This move did not finish. This server is still here."
  }
  showPlace()
  moving = false
  showButtons()
}

async function readLiveEvents() {
  const response = await fetch("/events")
  const reader = response.body.getReader()
  const decoder = new TextDecoder()
  let buffer = ""
  while (true) {
    const chunk = await reader.read()
    if (chunk.done) {
      return
    }
    buffer += decoder.decode(chunk.value, { stream: true })
    const lines = buffer.split("\n")
    buffer = lines.pop() ?? ""
    for (const line of lines) {
      if (line.length === 0) {
        continue
      }
      remember(line)
      appendLog(el("div", "line", line))
    }
  }
}

function showPlace() {
  place.replaceChildren("Running inside ", vmChip(here))
}

function showButtons() {
  actions.replaceChildren()
  for (const vm of demo.vms) {
    if (vm === here) {
      continue
    }
    const button = document.createElement("button")
    button.type = "button"
    button.append("Move this server to ", vmChip(vm))
    button.addEventListener("click", () => {
      void play(vm, button)
    })
    actions.append(button)
  }
}

function render(events) {
  output.replaceChildren()
  for (const event of events) {
    const line = formatLine(event)
    remember(line)
    output.append(el("div", "line", line))
  }
  output.scrollTop = output.scrollHeight
}

function remember(line) {
  try {
    const parsed = JSON.parse(line)
    logEvents.push({
      bootId: parsed.boot_id,
      pid: parsed.pid,
      counter: parsed.counter,
      receivedAt: Date.now(),
    })
  } catch {
    // Gap notes are not guest events.
  }
}

function showReport(report) {
  moveNote.hidden = true
  metricTotal.textContent = formatDuration(report.totalMs)
  metricPause.textContent = formatDuration(report.pauseMs)
  metricGap.textContent = formatDuration(report.longestGapMs)
  metricBytes.textContent = formatBytes(report.bytesTransferred)
  metricContinuity.textContent = continuityText(report)
  metrics.hidden = false
}

function hideReport() {
  metrics.hidden = true
}

function reportFrom(migration, events) {
  return {
    pauseMs: migration.resumedAt - migration.pausedAt,
    totalMs: migration.finishedAt - migration.startedAt,
    longestGapMs: longestGap(events),
    bytesTransferred: migration.bytesTransferred,
    bootIdContinuous: sameValue(events, (event) => event.bootId),
    pidContinuous: sameValue(events, (event) => event.pid),
    counterContinuous: counterStepsByOne(events),
  }
}

function longestGap(events) {
  let longest = 0
  for (let index = 1; index < events.length; index += 1) {
    const previous = events[index - 1]
    const current = events[index]
    const gap = current.receivedAt - previous.receivedAt
    if (gap > longest) {
      longest = gap
    }
  }
  return longest
}

function sameValue(events, read) {
  const first = events[0]
  if (!first || events.length < 2) {
    return false
  }
  const expected = read(first)
  return events.every((event) => read(event) === expected)
}

function counterStepsByOne(events) {
  if (events.length < 2) {
    return false
  }
  for (let index = 1; index < events.length; index += 1) {
    const previous = events[index - 1]
    const current = events[index]
    if (!previous || !current || current.counter !== previous.counter + 1) {
      return false
    }
  }
  return true
}

function continuityText(report) {
  const changed = []
  if (!report.bootIdContinuous) {
    changed.push("boot id")
  }
  if (!report.pidContinuous) {
    changed.push("pid")
  }
  if (!report.counterContinuous) {
    changed.push("counter")
  }
  if (changed.length === 0) {
    return "Boot id, pid, and counter continued"
  }
  if (changed.length === 1) {
    return `${changed[0]} changed`
  }
  const last = changed[changed.length - 1]
  return `${changed.slice(0, -1).join(", ")} and ${last} changed`
}

function formatDuration(ms) {
  const rounded = Math.max(0, Math.round(ms))
  if (rounded < 1000) {
    return `${rounded} ms`
  }
  const seconds = rounded / 1000
  return `${seconds.toFixed(seconds >= 10 ? 1 : 2)} s`
}

function formatBytes(bytes) {
  const exact = `${new Intl.NumberFormat("en-US").format(bytes)} bytes`
  if (bytes < 1024 * 1024) {
    return exact
  }
  const gb = bytes / (1024 * 1024 * 1024)
  if (gb >= 1) {
    return `${gb.toFixed(2)} GB · ${exact}`
  }
  const mb = bytes / (1024 * 1024)
  return `${mb.toFixed(1)} MB · ${exact}`
}

function appendLog(node) {
  const atBottom = output.scrollHeight - output.scrollTop - output.clientHeight < 24
  output.append(node)
  if (atBottom) {
    output.scrollTop = output.scrollHeight
  }
}

function formatLine(event) {
  return JSON.stringify({
    boot_id: event.bootId,
    pid: event.pid,
    counter: event.counter,
  })
}

function el(tag, className, text) {
  const node = document.createElement(tag)
  node.className = className
  node.textContent = text
  return node
}

function waitForNextEvent(mark) {
  if (logEvents.length > mark) {
    return Promise.resolve()
  }
  return new Promise((resolve) => {
    const started = Date.now()
    const timer = setInterval(() => {
      if (logEvents.length > mark || Date.now() - started > 5000) {
        clearInterval(timer)
        resolve()
      }
    }, 50)
  })
}

function wait(ms) {
  if (ms === 0) {
    return Promise.resolve()
  }
  return new Promise((resolve) => setTimeout(resolve, ms))
}
