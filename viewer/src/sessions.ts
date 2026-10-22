// The snapshots the bridge writes, one file per session, and which of them to show.
import { mkdirSync, readFileSync, readdirSync, statSync, unlinkSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

import { HEARTBEAT_MS, SNAPSHOT_DIR } from '../../hooks/bridge'
import type { AgentCard, Check, Main, Receipt, Turn, Usage } from '../../types'

export const DIR = join(homedir(), SNAPSHOT_DIR)
/** A session whose snapshot is older than this has ended (or its process is gone). */
export const LIVE_MS = HEARTBEAT_MS * 3
/** Ended sessions stay listed this long; their files are removed after a week. */
const LIST_MS = 24 * 3600_000
const KEEP_MS = 7 * 24 * 3600_000

export type Snapshot = {
  version: number
  sessionId: string
  cwd: string
  /** Prompts sent in the session; absent from snapshots written before it was kept. */
  turns?: number
  updatedAt: number
  options: Record<string, unknown>
  state: Record<string, unknown>
}

/**
 * What a session is doing, for the strip: `needs-you` while a permission check waits on the person,
 * `working` while a turn runs, `done` once one has finished, `idle` before any.
 */
export type Status = { kind: 'needs-you' | 'working' | 'done' | 'idle'; detail: string; since: number | null }

export type Session = {
  id: string
  snap: Snapshot
  isLive: boolean
  activeAt: number
  status: Status
  ctxPct: number | null
  agentsRunning: number
}

/**
 * A pending check counts as waiting on the person only once it has waited this long: in auto mode
 * every check is pending while the classifier decides, which takes a moment, and a person's answer
 * takes longer.
 */
const NEEDS_YOU_AFTER_MS = 5000

const statusOf = (s: Snapshot, now: number): Status => {
  const main = (s.state.main ?? {}) as Partial<Main>
  const turn = (s.state.turn ?? {}) as Partial<Turn>
  const receipt = s.state.receipt as Receipt | null | undefined
  const recent = ((s.state.gate as { recent?: Check[] } | undefined)?.recent ?? []).filter(c => c.verdict === 'ask')
  const pending = recent[recent.length - 1]
  if (pending && now - pending.at >= NEEDS_YOU_AFTER_MS) return { kind: 'needs-you', detail: pending.detail, since: pending.at }
  if (main.isRunning) return { kind: 'working', detail: '', since: turn.startedAt || null }
  if (receipt && turn.startedAt) return { kind: 'done', detail: '', since: turn.startedAt + receipt.durationMs }
  return { kind: 'idle', detail: '', since: null }
}

const parse = (file: string): Snapshot | null => {
  try {
    const s = JSON.parse(readFileSync(file, 'utf8')) as Snapshot
    return s && typeof s === 'object' && s.state ? s : null
  } catch {
    // A file caught mid-write: the next change event reads it whole.
    return null
  }
}

/** When the person last did something there: the latest turn or log line. */
const activityOf = (s: Snapshot) => {
  const turn = s.state.turn as { startedAt?: number } | undefined
  const log = s.state.log as { at?: number }[] | undefined
  return Math.max(turn?.startedAt ?? 0, log?.[log.length - 1]?.at ?? 0, 0)
}

/** Sessions seen in the last day: live ones first, each group by latest activity. */
export function listSessions(now: number): Session[] {
  mkdirSync(DIR, { recursive: true })
  const out: Session[] = []
  for (const name of readdirSync(DIR)) {
    if (!name.endsWith('.json')) continue
    const file = join(DIR, name)
    const age = now - statSync(file).mtimeMs
    if (age > KEEP_MS) {
      unlinkSync(file)
      continue
    }
    if (age > LIST_MS) continue
    const snap = parse(file)
    // Older bridges wrote pre-warmed spare sessions too; those files have no `turns`.
    if (!snap || (snap.turns ?? 0) === 0) continue
    const usage = (snap.state.usage ?? {}) as Partial<Usage>
    const agents = (snap.state.agents ?? []) as AgentCard[]
    out.push({
      id: snap.sessionId,
      snap,
      isLive: now - snap.updatedAt < LIVE_MS,
      activeAt: activityOf(snap),
      status: statusOf(snap, now),
      ctxPct: usage.pct ?? null,
      agentsRunning: agents.filter(a => a.status === 'running').length,
    })
  }
  return out.sort((a, b) => Number(b.isLive) - Number(a.isLive) || b.activeAt - a.activeAt)
}
