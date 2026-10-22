// Flightdeck in a terminal window of its own. It runs the mod's own `ui.render` hook from
// `hooks/register.tsx`, unchanged, against the snapshot the bridge writes, and draws the tree it
// answers with Ink. Upstream changes to the panels reach this window with no change here.
import { appendFileSync, watch } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'

import { Box as InkBox, Text as InkText, render, renderToString, useInput } from 'ink'
import type { Key } from 'ink'
import React from 'react'
import type { ReactNode } from 'react'

import { shorten } from '../../hooks/core'
import { register } from '../../hooks/register'
import type { ViewerState } from './claude-code-shim'
import { NAMES_EVERY_MS, nameOf, readNames } from './names'
import { DIR, listSessions } from './sessions'
import type { Session, Snapshot, Status } from './sessions'
import { DIMMED, paint } from './theme'

declare global {
  // The JSX factory the mod's drawing compiles against.
  var h: typeof React.createElement
}
globalThis.h = React.createElement

// ---------------------------------------------------------------- the surface's elements

type Props = Record<string, unknown> & { children?: ReactNode }

const Text = ({ color, dimColor, ...p }: Props) => (
  <InkText {...p} color={paint(color as string | undefined)} dimColor={Boolean(dimColor) || DIMMED.has(color as string)} />
)

const Box = ({ borderColor, ...p }: Props) => <InkBox {...p} borderColor={paint(borderColor as string | undefined)} />

/** A plain Button draws its label; its hotkey is read off the tree (hotkeysOf) and pressed here. */
const Button = ({ label, dimColor }: Props) => <InkText dimColor={Boolean(dimColor)}>{String(label ?? '')}</InkText>

const hotkeysOf = (node: ReactNode, out = new Map<string, () => unknown>()) => {
  if (Array.isArray(node)) for (const n of node) hotkeysOf(n, out)
  else if (React.isValidElement<Props>(node)) {
    const { hotkey, onPress, children } = node.props
    if (node.type === Button && typeof hotkey === 'string' && typeof onPress === 'function') out.set(hotkey, onPress as () => unknown)
    hotkeysOf(children, out)
  }
  return out
}

// ---------------------------------------------------------------- the mod's draw hook

type Draw = ($: unknown, e: unknown) => Promise<ReactNode>

let draw: Draw | null = null
let drawnFor = ''

/** Runs the mod's `register` with the session's options, keeping only its Pane draw hook. */
const loadDraw = (options: Record<string, unknown>) => {
  const key = JSON.stringify(options)
  if (draw && key === drawnFor) return
  const on = (event: string, a: unknown, b?: unknown) => {
    const matcher = typeof a === 'function' ? null : (a as Record<string, unknown>)
    if (event === 'ui.render' && matcher?.component === 'Pane') draw = (typeof a === 'function' ? a : b) as Draw
    return { catch: () => undefined }
  }
  register(on as never, options)
  drawnFor = key
}

// ---------------------------------------------------------------- state of this window

/** Toggles made here (an expanded card, an open gate row); never written back to the session. */
const local: Record<string, unknown> = {}
/** The session picked with tab; null follows the one most recently active. */
let pinned: string | null = null
let sessions: Session[] = []
let hotkeys = new Map<string, () => unknown>()
/** The session drawn last, so the window's own toggles reset when another takes its place. */
let shownId: string | null = null
/** Rows the pane is scrolled down by, and the most it can be: how much taller it is than its room. */
let scrollTop = 0
let maxScroll = 0
/** The pane's room in rows, for a page of scrolling. */
let pageRows = 1

const tilde = (p: string) => (p.startsWith(homedir()) ? `~${p.slice(homedir().length)}` : p)

const ago = (ms: number) => {
  const s = Math.round(ms / 1000)
  return s < 60 ? `${s}s` : s < 3600 ? `${Math.floor(s / 60)}m` : `${Math.floor(s / 3600)}h`
}

const STATUS: Record<Status['kind'], { glyph: string; label: string; color: string }> = {
  'needs-you': { glyph: '◆', label: 'needs you', color: 'yellowBright' },
  working: { glyph: '●', label: 'working', color: 'green' },
  done: { glyph: '✓', label: 'done', color: 'blue' },
  idle: { glyph: '○', label: 'idle', color: 'gray' },
}

/** The sessions tab moves through: the live ones, or every one when none is live. */
const listed = () => (sessions.some(x => x.isLive) ? sessions.filter(x => x.isLive) : sessions)

/** One line per live session (and the shown one, live or not), ▶ on the one drawn below, then a gap. */
const strip = (shown: Session, now: number, columns: number) => {
  const listed = sessions.filter(x => x.isLive || x === shown)
  // The name from `claude agents`, or the short id for a session it does not name.
  const labels = listed.map(x => nameOf(x.id) ?? x.id.slice(0, 8))
  const folders = listed.map(x => tilde(x.snap.cwd))
  // Status and ctx keep their width (with the gaps, 30 cells); the folder gives way first, then the name.
  const room = columns - 1 - 30
  const lw = Math.max(8, Math.min(24, Math.max(...labels.map(n => n.length)), room - 8))
  const fw = Math.max(0, Math.min(28, Math.max(...folders.map(n => n.length)), room - lw))
  return listed.map((x, i) => {
    const isShown = x === shown
    const st = x.isLive ? STATUS[x.status.kind] : { glyph: '○', label: `ended ${ago(now - x.snap.updatedAt)} ago`, color: 'gray' }
    const when = x.isLive && x.status.kind === 'done' && x.status.since ? ` ${ago(now - x.status.since)} ago` : ''
    return (
      <InkText key={x.id} wrap="truncate">
        <InkText bold={isShown} dimColor={!nameOf(x.id)}>{`${isShown ? '▶' : ' '} ${shorten(labels[i] ?? '', lw).padEnd(lw)}`}</InkText>
        <InkText dimColor>{`  ${shorten(folders[i] ?? '', fw).padEnd(fw)}  `}</InkText>
        <InkText color={st.color} bold={x.status.kind === 'needs-you'}>{`${st.glyph} ${st.label}${when}`.padEnd(15)}</InkText>
        {x.ctxPct !== null ? <InkText dimColor>{`  ctx ${String(Math.round(x.ctxPct)).padStart(2)}%`}</InkText> : null}
        {x.agentsRunning > 0 ? <InkText color={paint('suggestion')}>{`  ${x.agentsRunning} agent${x.agentsRunning === 1 ? '' : 's'}`}</InkText> : null}
        {x.isLive && x.status.kind === 'needs-you' ? <InkText color="yellowBright">{`  ${x.status.detail}`}</InkText> : null}
      </InkText>
    )
  }).concat(<InkText key="gap"> </InkText>)
}

/** The keys that do something in this frame: a key that would do nothing is not offered. */
const footer = () => {
  const digits = [...hotkeys.keys()].filter(k => /^\d$/.test(k)).sort()
  const gate = ['f', 's', 'o'].filter(k => hotkeys.has(k))
  const parts = [
    digits.length > 1 ? `${digits[0]}-${digits[digits.length - 1]} agent` : digits.length === 1 ? '1 agent' : null,
    gate.length > 0 ? `${gate.join(' ')} gate` : null,
    maxScroll > 0 ? '↑↓ scroll' : null,
    listed().length > 1 ? 'tab ⇧tab session' : null,
    pinned ? 'a follow latest' : null,
    'q quit',
  ]
  return <InkText dimColor wrap="truncate">{parts.filter(Boolean).join(' · ')}</InkText>
}

async function frame(): Promise<ReactNode> {
  const now = Date.now()
  sessions = listSessions(now)
  // Following, a session waiting on the person comes first: the latest to start waiting.
  const waiting = sessions.filter(x => x.isLive && x.status.kind === 'needs-you').sort((a, b) => (b.status.since ?? 0) - (a.status.since ?? 0))
  const s = sessions.find(x => x.id === pinned) ?? waiting[0] ?? sessions[0]
  const columns = process.stdout.columns || Number(process.env.COLUMNS) || 80
  const rows = process.stdout.rows || Number(process.env.LINES) || 40
  if (!s) {
    hotkeys = new Map()
    return <InkText dimColor>{`Waiting for a Claude Code session with the flightdeck mod… (${tilde(DIR)})`}</InkText>
  }
  if (pinned && s.id !== pinned) pinned = null
  if (s.id !== shownId) {
    for (const k of Object.keys(local)) delete local[k]
    shownId = s.id
    scrollTop = 0
  }
  const lines = strip(s, now, columns)
  loadDraw(s.snap.options)
  const snap: Snapshot = s.snap
  const $: ViewerState & Record<string, unknown> = {
    state: {
      read: key => (key in local ? local[key] : snap.state[key]),
      write: (key, value) => {
        local[key] = value
        void refresh()
      },
    },
    clock: { now: async () => now },
    ui: { resolve: () => ({ Box, Text, Button }) },
  }
  // What is left for the pane under the session lines and above the footer.
  const bodyRows = Math.max(1, rows - lines.length - 1)
  const e = {
    surface: 'terminal',
    props: { bodyColumns: columns - 1, placement: 'docked', scroll: { bodyRows }, view: null },
    viewport: { rows: bodyRows, columns },
  }
  const tree = draw ? await draw($, e) : null
  hotkeys = hotkeysOf(tree)
  // The pane draws at its own height, and in Claude Code its body scrolls. Here it scrolls too, with
  // the arrow keys, inside the rows the session lines and the footer leave: a frame taller than the
  // window would scroll the session lines off its top. The inner box keeps the pane's height, since
  // squeezed the panels would draw over each other; drawing it once more measures that height.
  const height = tree ? renderToString(<InkBox flexDirection="column">{tree}</InkBox>, { columns }).split('\n').length : 0
  pageRows = bodyRows
  maxScroll = Math.max(0, height - bodyRows)
  scrollTop = Math.min(scrollTop, maxScroll)
  return (
    <InkBox flexDirection="column">
      {lines}
      <InkBox flexDirection="column" flexShrink={0} maxHeight={bodyRows} overflow="hidden">
        <InkBox flexDirection="column" flexShrink={0} marginTop={-scrollTop}>
          {tree}
        </InkBox>
      </InkBox>
      {footer()}
    </InkBox>
  )
}

// ---------------------------------------------------------------- the loop

const onKey = (input: string, key: Key) => {
  if (input === 'q') return quit()
  const ring = listed()
  if (key.tab && ring.length > 0) {
    // tab goes down the list, shift+tab up; ended sessions are not in it.
    const at = Math.max(0, ring.findIndex(x => x.id === shownId))
    const step = key.shift ? ring.length - 1 : 1
    pinned = ring[(at + step) % ring.length]?.id ?? null
    return void refresh()
  }
  if (input === 'a') {
    pinned = null
    return void refresh()
  }
  const step = key.upArrow ? -1 : key.downArrow ? 1 : key.pageUp ? -pageRows : key.pageDown ? pageRows : key.home ? -maxScroll : key.end ? maxScroll : 0
  if (step !== 0) {
    scrollTop = Math.max(0, Math.min(maxScroll, scrollTop + step))
    return void refresh()
  }
  hotkeys.get(input)?.()
}

const Root = ({ body }: { body: ReactNode }) => {
  useInput(onKey)
  return <InkBox flexDirection="column">{body}</InkBox>
}

// `--once` prints one frame and exits: for a look without a window, or a script.
if (process.argv.includes('--once')) {
  await readNames(() => undefined)
  process.stdout.write(`${renderToString(<InkBox flexDirection="column">{await frame()}</InkBox>, { columns: process.stdout.columns || Number(process.env.COLUMNS) || 80 })}\n`)
  process.exit(0)
}

const app = render(<Root body={null} />, { alternateScreen: true, incrementalRendering: true, patchConsole: false })
// Entering the alternate screen keeps the cursor where the shell's prompt left it, and Ink draws
// from there: home it so the window starts on its top row.
process.stdout.write('\u001B[H')

let isDrawing = false
let isDirty = false
async function refresh() {
  if (isDrawing) {
    isDirty = true
    return
  }
  isDrawing = true
  try {
    app.rerender(<Root body={await frame()} />)
  } catch (err) {
    note(err)
    app.rerender(<Root body={<InkText color="red">{`flightdeck viewer: ${(err as Error).message} (${tilde(LOG)})`}</InkText>} />)
  } finally {
    isDrawing = false
    if (isDirty) {
      isDirty = false
      void refresh()
    }
  }
}

function quit() {
  app.unmount()
  process.exit(0)
}

// Errors go to a log, since the alternate screen drops whatever is printed while it closes; one
// that would end the process is printed again once the shell's screen is back.
const LOG = join(dirname(DIR), 'viewer.log')
const textOf = (err: unknown) => (err instanceof Error ? (err.stack ?? err.message) : String(err))

function note(err: unknown) {
  try {
    appendFileSync(LOG, `${new Date().toISOString()} ${textOf(err)}\n`)
  } catch {
    // Nowhere to note it; the frame still says what went wrong.
  }
}

function crash(err: unknown) {
  note(err)
  try {
    app.unmount()
  } finally {
    process.stderr.write(`flightdeck viewer stopped: ${textOf(err)}\n(logged in ${tilde(LOG)})\n`)
    process.exit(1)
  }
}
process.on('uncaughtException', crash)
process.on('unhandledRejection', crash)

let pending: NodeJS.Timeout | null = null
listSessions(Date.now())
watch(DIR, () => {
  pending ??= setTimeout(() => {
    pending = null
    void refresh()
  }, 50)
})
void readNames(() => void refresh())
setInterval(() => void readNames(() => void refresh()), NAMES_EVERY_MS)
// The clocks on the cards and the turn tick once a second.
setInterval(() => void refresh(), 1000)
process.stdout.on('resize', () => void refresh())
void refresh()
