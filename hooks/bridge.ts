// Mirrors Flightdeck's session state to a JSON file outside Claude Code, so the standalone viewer
// (`viewer/`) can draw the same panels in a terminal window of its own. Like the rest of the mod it
// only watches: it reads the `flightdeck` state and writes one file per session, nothing else.
import type { EngineInterface, Register } from 'claude-code'

type On = Parameters<Register>[0]
type Options = Parameters<Register>[1]

export const SNAPSHOT_VERSION = 1
/** Under `$HOME`; one `<sessionId>.json` per session. */
export const SNAPSHOT_DIR = '.claude/flightdeck/sessions'
/** Writes fold together this long after the first state change, so a burst costs one write. */
const DEBOUNCE_MS = 150
/** Rewritten this often while the session lives, so the viewer can tell a live session from a gone one. */
export const HEARTBEAT_MS = 5000

let options: Options = {}
let isPending = false
let heartbeat: { cancel: () => void } | null = null

async function snapshotOf($: EngineInterface) {
  const [id, cwd, turns, now] = await Promise.all([$.session.id(), $.session.cwd(), $.session.turns(), $.clock.now()])
  // `plugin` and `key` must be literals for the engine, so each value is read by name.
  const [meta, main, usage, architect, gate, agents, loops, log, turn, receipt, view, roster] = await Promise.all([
    $.state.get({ plugin: 'flightdeck', key: 'meta' }),
    $.state.get({ plugin: 'flightdeck', key: 'main' }),
    $.state.get({ plugin: 'flightdeck', key: 'usage' }),
    $.state.get({ plugin: 'flightdeck', key: 'architect' }),
    $.state.get({ plugin: 'flightdeck', key: 'gate' }),
    $.state.get({ plugin: 'flightdeck', key: 'agents' }),
    $.state.get({ plugin: 'flightdeck', key: 'loops' }),
    $.state.get({ plugin: 'flightdeck', key: 'log' }),
    $.state.get({ plugin: 'flightdeck', key: 'turn' }),
    $.state.get({ plugin: 'flightdeck', key: 'receipt' }),
    $.state.get({ plugin: 'flightdeck', key: 'view' }),
    $.state.get({ plugin: 'flightdeck', key: 'roster' }),
  ])
  return {
    version: SNAPSHOT_VERSION,
    sessionId: id,
    cwd,
    turns,
    updatedAt: now,
    options,
    state: {
      meta: meta.value,
      main: main.value,
      usage: usage.value,
      architect: architect.value,
      gate: gate.value,
      agents: agents.value,
      loops: loops.value,
      log: log.value,
      turn: turn.value,
      receipt: receipt.value,
      view: view.value,
      roster: roster.value,
    },
  }
}

async function flush($: EngineInterface) {
  isPending = false
  const home = await $.env.get('HOME')
  if (!home) return
  const snap = await snapshotOf($)
  // A session nobody has prompted yet writes nothing: `claude agents` keeps pre-warmed spare sessions
  // that load the mod too, and the viewer should list only the sessions in use.
  if (snap.turns === 0) return
  await $.fs.write(`${home}/${SNAPSHOT_DIR}/${snap.sessionId}.json`, JSON.stringify(snap))
}

function schedule($: EngineInterface) {
  if (isPending) return
  isPending = true
  $.clock.after(DEBOUNCE_MS, () => void flush($).catch(() => undefined))
}

export function bridge(on: On, opts: Options) {
  options = opts
  // Flightdeck writes its state at session start and on every event it tracks; each write is a
  // reason to mirror. The heartbeat starts with the first one and lasts as long as the process.
  on('state.set', async ($, e, next) => {
    const set = await next(e)
    if (e.plugin === 'flightdeck') {
      schedule($)
      heartbeat ??= $.clock.every(HEARTBEAT_MS, () => schedule($))
    }
    return set
  }).catch(($, e, next) => next(e))
}
