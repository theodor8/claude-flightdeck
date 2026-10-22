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
/** The snapshot written last, rewritten as ended when its session ends. */
let last: Snapshot | null = null
/**
 * Sessions that have ended in this process, with their prompt count then: a write already scheduled
 * for one is dropped, until a `/resume` back to it brings a new prompt.
 */
const ended = new Map<string, number>()

/** Tools that wait on the person while they run: a question to answer, a plan to approve. */
const PERSON_TOOLS = ['AskUserQuestion', 'ExitPlanMode'] as const
/**
 * Every reason a session ends. Flightdeck hooks `session.end` and `tool.call` too, and a module may
 * hook an event twice only with a matcher; a reason missing here falls back to the stale heartbeat.
 */
const END_REASONS = ['clear', 'resume', 'logout', 'prompt_input_exit', 'other'] as const
/** Calls of those tools under way, by call id. Flightdeck's gate does not show them as waiting. */
const waiting = new Map<string, Waiting>()

/** A call that waits on the person, for the viewer's `needs you`. */
export type Waiting = { tool: string; detail: string; since: number }

type Snapshot = Awaited<ReturnType<typeof snapshotOf>>

/** A call's arguments are on the call itself (`e.questions`), as Flightdeck reads them. */
const waitingOf = (tool: string, input: unknown, since: number): Waiting => {
  const questions = (input as { questions?: { question?: unknown }[] } | null)?.questions
  const question = Array.isArray(questions) ? questions[0]?.question : undefined
  return { tool, detail: typeof question === 'string' ? question : tool === 'ExitPlanMode' ? 'a plan to approve' : tool, since }
}

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
    /** Set once the session has ended (its process exited, or a `/clear` started another). */
    endedAt: null as number | null,
    /** The latest call waiting on the person, if any. */
    waiting: [...waiting.values()].at(-1) ?? null,
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
  if (snap.turns === 0 || ended.get(snap.sessionId) === snap.turns) return
  ended.delete(snap.sessionId)
  last = snap
  await $.fs.write(`${home}/${SNAPSHOT_DIR}/${snap.sessionId}.json`, JSON.stringify(snap))
}

/**
 * Rewrites the session's last snapshot as ended, so the viewer stops listing it as live at once
 * instead of when its heartbeat goes stale. After a `/clear` the process goes on under a new id
 * and Flightdeck has reset its state, so the last snapshot is the old session's final one.
 */
async function end($: EngineInterface, sessionId: string) {
  ended.set(sessionId, last?.sessionId === sessionId ? last.turns : await $.session.turns())
  const home = await $.env.get('HOME')
  if (!home || last?.sessionId !== sessionId) return
  const snap = { ...last, endedAt: await $.clock.now(), waiting: null }
  await $.fs.write(`${home}/${SNAPSHOT_DIR}/${sessionId}.json`, JSON.stringify(snap))
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

  // A question or a plan waits on the person inside its call: noted as the call starts, cleared
  // as it returns, answered or not.
  on('tool.call', { tool: PERSON_TOOLS }, async ($, e, next) => {
    waiting.set(e.tool_use_id, waitingOf(e.tool, e, await $.clock.now()))
    schedule($)
    try {
      return await next(e)
    } finally {
      waiting.delete(e.tool_use_id)
      schedule($)
    }
  }).catch(($, e, next) => next(e))

  on('session.end', { reason: END_REASONS }, async ($, e, next) => {
    await end($, e.sessionId).catch(() => undefined)
    return next(e)
  }).catch(($, e, next) => next(e))
}
