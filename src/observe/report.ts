import type { Phase } from "../migrate/run-migration.ts"
import type { WorkerId } from "../migrate/workers.ts"

export type ObservedEvent = {
  bootId: string
  pid: number
  counter: number
  receivedAt: number
}

export type PhaseSpan = {
  label: "Pause" | "Copy" | "Restore"
  ms: number
}

export type ObservedMigration = {
  id: string
  source: WorkerId
  destination: WorkerId
  phases: Phase[]
  startedAt: number
  pausedAt: number
  resumedAt: number
  finishedAt: number
  bytesTransferred: number
  spans: PhaseSpan[]
}

export type Report = {
  pauseMs: number
  totalMs: number
  longestGapMs: number
  bytesTransferred: number
  bootIdContinuous: boolean
  pidContinuous: boolean
  counterContinuous: boolean
}

export type FenceLamps = {
  live: WorkerId
  stopped: WorkerId | null
}

// Times are milliseconds. Continuity needs two events so a single line
// cannot be called a successful move.
export function buildReport(input: {
  events: ObservedEvent[]
  migration: ObservedMigration
}): Report {
  return {
    pauseMs: input.migration.resumedAt - input.migration.pausedAt,
    totalMs: input.migration.finishedAt - input.migration.startedAt,
    longestGapMs: longestGap(input.events),
    bytesTransferred: input.migration.bytesTransferred,
    bootIdContinuous: sameValue(input.events, (event) => event.bootId),
    pidContinuous: sameValue(input.events, (event) => event.pid),
    counterContinuous: counterStepsByOne(input.events),
  }
}

// The source lamp goes out only after cutover. health_check is recorded
// when the check starts, so a failed check still leaves the source running.
export function fenceLamps(migration: ObservedMigration): FenceLamps {
  const moved =
    migration.phases.includes("cutting_over") ||
    migration.phases.includes("succeeded")
  if (!moved) {
    return { live: migration.source, stopped: null }
  }
  return { live: migration.destination, stopped: migration.source }
}

function longestGap(events: ObservedEvent[]): number {
  let longest = 0
  for (let index = 1; index < events.length; index += 1) {
    const previous = events[index - 1]
    const current = events[index]
    if (!previous || !current) {
      continue
    }
    const gap = current.receivedAt - previous.receivedAt
    if (gap > longest) {
      longest = gap
    }
  }
  return longest
}

function sameValue<T>(events: ObservedEvent[], read: (event: ObservedEvent) => T): boolean {
  const first = events[0]
  if (!first || events.length < 2) {
    return false
  }
  const expected = read(first)
  return events.every((event) => read(event) === expected)
}

function counterStepsByOne(events: ObservedEvent[]): boolean {
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
