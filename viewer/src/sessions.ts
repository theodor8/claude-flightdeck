// The snapshots the bridge writes, one file per session, and which of them to show.
import { mkdirSync, readFileSync, readdirSync, statSync, unlinkSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

import { HEARTBEAT_MS, SNAPSHOT_DIR } from '../../hooks/bridge'

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

export type Session = { id: string; snap: Snapshot; isLive: boolean; activeAt: number }

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
    if (snap && (snap.turns ?? 0) > 0) out.push({ id: snap.sessionId, snap, isLive: now - snap.updatedAt < LIVE_MS, activeAt: activityOf(snap) })
  }
  return out.sort((a, b) => Number(b.isLive) - Number(a.isLive) || b.activeAt - a.activeAt)
}
