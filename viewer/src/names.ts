// Session names as `claude agents` shows them ("flightdeck fork"), by session id. The snapshot has
// none: the name belongs to Claude Code's session list, read here every few seconds off the main
// loop. A session that list does not name (one started outside `claude agents`) has no entry.
import { execFile } from 'node:child_process'

/** How often the list is read; one read takes about 0.2s, in a child process. */
export const NAMES_EVERY_MS = 10_000

let names = new Map<string, string>()
let isReading = false

export const nameOf = (sessionId: string) => names.get(sessionId)

/** Reads the list again and calls `onChange` when a name was added, changed or dropped. */
export function readNames(onChange: () => void): Promise<void> {
  if (isReading) return Promise.resolve()
  isReading = true
  return new Promise(done => execFile('claude', ['agents', '--json'], { timeout: 5000 }, (err, stdout) => {
    isReading = false
    done()
    if (err) return
    try {
      const list = JSON.parse(stdout) as { sessionId?: unknown; name?: unknown }[]
      const next = new Map<string, string>()
      for (const s of list) {
        if (typeof s.sessionId === 'string' && typeof s.name === 'string' && s.name) next.set(s.sessionId, s.name)
      }
      const isSame = next.size === names.size && [...next].every(([k, v]) => names.get(k) === v)
      names = next
      if (!isSame) onChange()
    } catch {
      // A list that does not parse leaves the names as they were.
    }
  }))
}
