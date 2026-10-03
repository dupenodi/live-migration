import { buildReport, fenceLamps, type ObservedEvent, type ObservedMigration } from "./report.ts"

const moved: ObservedMigration["phases"] = [
  "pending",
  "pausing",
  "snapshotting",
  "transferring",
  "restoring",
  "health_check",
  "cutting_over",
  "succeeded",
]

function guest(bootId: string, pid: number, counter: number, receivedAt: number): ObservedEvent {
  return { bootId, pid, counter, receivedAt }
}

// A recorded A→B move and the trip back. The page renders these as-is.
const toWorkerB: { events: ObservedEvent[]; migration: ObservedMigration } = {
  events: [
    guest("boot-1", 417, 38, 0),
    guest("boot-1", 417, 39, 1_000),
    guest("boot-1", 417, 40, 2_000),
    guest("boot-1", 417, 41, 4_500),
    guest("boot-1", 417, 42, 5_500),
  ],
  migration: {
    id: "move-1",
    source: "worker-a",
    destination: "worker-b",
    phases: moved,
    startedAt: 2_000,
    pausedAt: 2_100,
    resumedAt: 2_500,
    finishedAt: 2_700,
    bytesTransferred: 170,
    spans: [
      { label: "Pause", ms: 80 },
      { label: "Copy", ms: 220 },
      { label: "Restore", ms: 100 },
    ],
  },
}

const backToWorkerA: { events: ObservedEvent[]; migration: ObservedMigration } = {
  events: [
    guest("boot-1", 417, 43, 6_000),
    guest("boot-1", 417, 44, 7_000),
    guest("boot-1", 417, 45, 8_000),
    guest("boot-1", 417, 46, 9_000),
  ],
  migration: {
    id: "move-2",
    source: "worker-b",
    destination: "worker-a",
    phases: moved,
    startedAt: 6_000,
    pausedAt: 6_050,
    resumedAt: 6_170,
    finishedAt: 6_300,
    bytesTransferred: 170,
    spans: [
      { label: "Pause", ms: 20 },
      { label: "Copy", ms: 70 },
      { label: "Restore", ms: 30 },
    ],
  },
}

export const fixtureTrips = [toWorkerB, backToWorkerA]

export function demoPayload() {
  const opening = toWorkerB.events.slice(0, 3)
  return {
    runningOn: "worker-a" as const,
    bootId: "boot-1",
    pid: 417,
    vms: ["worker-a", "worker-b", "worker-c"] as const,
    events: opening,
    trips: fixtureTrips.map((trip) => ({
      id: trip.migration.id,
      source: trip.migration.source,
      destination: trip.migration.destination,
      spans: trip.migration.spans,
      events: trip.events,
      report: buildReport(trip),
      lamps: fenceLamps(trip.migration),
    })),
  }
}
