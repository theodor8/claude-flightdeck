// The permission mode (`auto`, `plan`, ...) as the session's transcript records it on each prompt.
// Flightdeck learns it in its UserPromptSubmit hook, which Claude Code's bundled security plugin
// keeps from the plugins a person installs (on a machine with managed settings, or in a Team or
// Enterprise organization), so the snapshot's is often empty. The transcript has it either way.
import { closeSync, existsSync, openSync, readSync, readdirSync, statSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

const PROJECTS = join(homedir(), '.claude', 'projects')
/** Read back from the end this much at a time until the latest prompt's mode is found. */
const CHUNK = 1 << 20
/** Bytes read again before the old end, so a value written across it is read whole. */
const OVERLAP = 64
/** An entry's own field; in a tool's output the quotes are escaped, so it does not match. */
const MODE = /"permissionMode":"([A-Za-z]+)"/g

type Seen = { file: string; size: number; mode: string | null }

/** What was read of each session's transcript, by session id: only what is appended is read again. */
const seen = new Map<string, Seen>()

/** `~/.claude/projects/<cwd with every other character a dash>/<id>.jsonl`, or wherever it is. */
const fileOf = (sessionId: string, cwd: string) => {
  const name = `${sessionId}.jsonl`
  const guess = join(PROJECTS, cwd.replace(/[^A-Za-z0-9]/g, '-'), name)
  if (existsSync(guess)) return guess
  try {
    for (const dir of readdirSync(PROJECTS)) if (existsSync(join(PROJECTS, dir, name))) return join(PROJECTS, dir, name)
  } catch {
    // No projects folder: no transcript.
  }
  return null
}

const lastMode = (text: string) => {
  let mode: string | null = null
  for (const m of text.matchAll(MODE)) mode = m[1] ?? mode
  return mode
}

const slice = (fd: number, from: number, to: number) => {
  const buf = Buffer.alloc(to - from)
  readSync(fd, buf, 0, buf.length, from)
  return buf.toString('utf8')
}

/** The mode the session's latest prompt was sent in, or null when its transcript does not say. */
export function modeOf(sessionId: string, cwd: string): string | null {
  const known = seen.get(sessionId)
  const file = known?.file ?? fileOf(sessionId, cwd)
  if (!file) return null
  const size = statSync(file, { throwIfNoEntry: false })?.size
  if (size === undefined || size === known?.size) return known?.mode ?? null
  const fd = openSync(file, 'r')
  try {
    let mode: string | null = null
    if (known && size > known.size) mode = lastMode(slice(fd, Math.max(0, known.size - OVERLAP), size)) ?? known.mode
    else for (let end = size; end > 0 && mode === null; end -= CHUNK) mode = lastMode(slice(fd, Math.max(0, end - CHUNK - OVERLAP), end))
    seen.set(sessionId, { file, size, mode })
    return mode
  } finally {
    closeSync(fd)
  }
}
