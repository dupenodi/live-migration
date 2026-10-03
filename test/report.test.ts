import assert from "node:assert/strict"
import { test } from "node:test"
import { startApi } from "../src/api/server.ts"
import { MemoryWorkers } from "../src/migrate/memory-workers.ts"
import { demoPayload, fixtureTrips } from "../src/observe/fixture.ts"
import { buildReport, fenceLamps, type ObservedMigration } from "../src/observe/report.ts"

test("report measures pause, gap, bytes, and continuity", () => {
  const trip = fixtureTrips[0]
  if (!trip) {
    throw new Error("missing fixture trip")
  }
  const report = buildReport(trip)

  assert.equal(report.pauseMs, 400)
  assert.equal(report.totalMs, 700)
  assert.equal(report.longestGapMs, 2_500)
  assert.equal(report.bytesTransferred, 170)
  assert.equal(report.bootIdContinuous, true)
  assert.equal(report.pidContinuous, true)
  assert.equal(report.counterContinuous, true)

  const spanTotal = trip.migration.spans.reduce((sum, span) => sum + span.ms, 0)
  assert.equal(spanTotal, report.pauseMs)
})

test("continuity fails when the guest restarts", () => {
  const trip = fixtureTrips[0]
  if (!trip) {
    throw new Error("missing fixture trip")
  }
  const restarted = buildReport({
    migration: trip.migration,
    events: [
      trip.events[0]!,
      { bootId: "other", pid: 1, counter: 0, receivedAt: 1_000 },
    ],
  })
  assert.equal(restarted.bootIdContinuous, false)
  assert.equal(restarted.pidContinuous, false)
  assert.equal(restarted.counterContinuous, false)
})

test("a skipped counter is not continuous", () => {
  const trip = fixtureTrips[0]
  if (!trip) {
    throw new Error("missing fixture trip")
  }
  const report = buildReport({
    migration: trip.migration,
    events: [
      { bootId: "boot-1", pid: 417, counter: 38, receivedAt: 0 },
      { bootId: "boot-1", pid: 417, counter: 40, receivedAt: 1_000 },
    ],
  })
  assert.equal(report.bootIdContinuous, true)
  assert.equal(report.pidContinuous, true)
  assert.equal(report.counterContinuous, false)
})

test("the source stays live until cutover", () => {
  const trip = fixtureTrips[0]
  if (!trip) {
    throw new Error("missing fixture trip")
  }
  const rolledBack: ObservedMigration = {
    ...trip.migration,
    phases: ["pending", "pausing", "transferring", "rolled_back"],
  }
  assert.deepEqual(fenceLamps(rolledBack), { live: "worker-a", stopped: null })
  assert.deepEqual(fenceLamps(trip.migration), {
    live: "worker-b",
    stopped: "worker-a",
  })
})

test("the return trip is a new migration id", () => {
  const [toB, toA] = fixtureTrips
  if (!toB || !toA) {
    throw new Error("missing fixture trips")
  }
  assert.equal(toB.migration.id, "move-1")
  assert.equal(toA.migration.id, "move-2")
  assert.notEqual(toA.migration.id, toB.migration.id)
  assert.equal(buildReport(toA).pauseMs, 120)
  assert.equal(buildReport(toA).longestGapMs, 1_000)
})

test("GET / serves the fixture page", async () => {
  const api = await startApi(new MemoryWorkers())
  try {
    const page = await fetch(`http://127.0.0.1:${api.port}/`)
    const html = await page.text()
    assert.equal(page.status, 200)
    assert.match(html, /Running inside <span class="chip chip-a">.*VM A<\/span>/)
    assert.match(html, /Move this server to <span class="chip chip-b">.*VM B<\/span>/)
    assert.match(html, /Move this server to <span class="chip chip-c">.*VM C<\/span>/)
    assert.match(html, /id="metric-total"/)
    assert.match(html, /id="metric-pause"/)
    assert.match(html, /id="metric-gap"/)
    assert.match(html, /id="metric-bytes"/)
    assert.match(html, /id="metric-continuity"/)

    const chip = await fetch(`http://127.0.0.1:${api.port}/chip.js`)
    assert.equal(chip.status, 200)
    assert.match(await chip.text(), /export function vmChip/)

    const demo = await fetch(`http://127.0.0.1:${api.port}/v1/demo`)
    const body = (await demo.json()) as ReturnType<typeof demoPayload>
    assert.equal(body.trips[0]?.report.bootIdContinuous, true)
    assert.equal(body.trips[0]?.lamps.live, "worker-b")
    assert.equal(body.trips[1]?.id, "move-2")
    assert.equal(body.trips[1]?.lamps.live, "worker-a")
  } finally {
    await api.close()
  }
})
