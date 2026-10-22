// Flightdeck in a terminal window of its own. It runs the mod's own `ui.render` hook from
// `hooks/register.tsx`, unchanged, against the snapshot the bridge writes, and draws the trees it
// answers with Ink, side by side when the window is wide. Upstream changes to the panels reach this
// window with no change here.
import { appendFileSync, watch } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'

import { Box as InkBox, Text as InkText, render, renderToString, useInput } from 'ink'
import type { Key } from 'ink'
import React from 'react'
import type { ReactNode } from 'react'

import { PALETTES, fmtClock, normalizeLog, parseConfig, shorten } from '../../hooks/core'
import type { Panel } from '../../hooks/core'
import { register } from '../../hooks/register'
import type { LogLine } from '../../types'
import type { ViewerState } from './claude-code-shim'
import { modeOf } from './modes'
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

/** The pane without its title and legend, the centred rows at its top: the session lines name it here. */
const withoutTitle = (tree: ReactNode) => {
  if (!React.isValidElement<Props>(tree)) return tree
  const rest = React.Children.toArray(tree.props.children).filter(
    n => !(React.isValidElement<Props>(n) && n.type === Box && n.props.justifyContent === 'center'),
  )
  return React.cloneElement(tree, undefined, ...rest)
}

// ---------------------------------------------------------------- the mod's draw hook

type Draw = ($: unknown, e: unknown) => Promise<ReactNode>

const draws = new Map<string, Draw>()

/** Runs the mod's `register` once per set of options, keeping only its Pane draw hook. */
const drawFor = (options: Record<string, unknown>): Draw | null => {
  const key = JSON.stringify(options)
  const found: { draw?: Draw } = { draw: draws.get(key) }
  if (found.draw) return found.draw
  const on = (event: string, a: unknown, b?: unknown) => {
    const matcher = typeof a === 'function' ? null : (a as Record<string, unknown>)
    if (event === 'ui.render' && matcher?.component === 'Pane') found.draw = (typeof a === 'function' ? a : b) as Draw
    return { catch: () => undefined }
  }
  register(on as never, options)
  if (found.draw) draws.set(key, found.draw)
  return found.draw ?? null
}

// ---------------------------------------------------------------- the layout of this window

/** Under this width the pane is one column as the mod draws it; from it, its panels sit side by side. */
const SIDE_BY_SIDE_FROM = 110
/** From this width the session log is a column of its own, as tall as the window. */
const LOG_BESIDE_FROM = 170
/**
 * A column of panels beside the log takes about a third of the window, from 56 cells (where the main
 * box still fits both usage limits with their resets) to 72 (wider, its boxes are mostly empty); the
 * log, whose lines are long, takes the rest.
 */
const MIN_COLUMN = 56
const MAX_COLUMN = 72
const GAP = 2
/** The panels of each column, in the order the session's `panels` option gives them. */
const LEFT: readonly Panel[] = ['main', 'architect', 'gate']
const MIDDLE: readonly Panel[] = ['agents', 'loops', 'receipt']

/** Rows a tree takes at `width`, or 0 when it draws nothing (a column whose panels are all empty). */
const heightOf = (node: ReactNode, width: number) => {
  const out = node ? renderToString(<InkBox flexDirection="column">{node}</InkBox>, { columns: width }) : ''
  return out.trim() === '' ? 0 : out.split('\n').length
}

/**
 * The session log as the mod draws it, but `rows` tall: the mod keeps it to 8 lines under the other
 * panels, and here it fills the window. The store keeps the last 60 lines.
 */
const logPanel = (options: Record<string, unknown>, stored: unknown, width: number, rows: number) => {
  const C = PALETTES[parseConfig(options).palette]
  const shown = normalizeLog(stored).slice(-Math.max(1, rows - 3))
  // The names (`you`, `main`, an agent's) take what the longest needs, up to the mod's 13 cells.
  const whoW = Math.min(13, Math.max(4, ...shown.map(l => l.who.length)) + 2)
  const colorOf = (l: LogLine) =>
    l.kind === 'error' ? C.warn : l.kind === 'consult' ? C.arch : l.who === 'main' ? C.main : l.who === 'gate' ? C.gate : l.who === 'you' ? C.text : C.agent
  return (
    <Box flexDirection="column" borderStyle="round" borderColor={C.faint} paddingX={1} width={width} height={rows} flexShrink={0}>
      <Text dimColor>session log</Text>
      {shown.length === 0 ? <Text color={C.faint}>nothing yet</Text> : null}
      {shown.map((l, i) => (
        <Box key={i}>
          <Box width={9} flexShrink={0}>
            <Text color={C.faint}>{fmtClock(l.at)}</Text>
          </Box>
          <Box width={whoW} flexShrink={0}>
            <Text color={colorOf(l)} bold wrap="truncate">
              {l.who}
            </Text>
          </Box>
          <Text color={l.kind === 'error' ? C.warn : C.text} wrap="truncate">
            {l.text}
          </Text>
        </Box>
      ))}
    </Box>
  )
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

/**
 * A live session that has done something since its process started. An idle one has not: Claude Code
 * restarted it (a reply, an attach, an update) and nobody has prompted it since, or it was reset.
 */
const isActive = (x: Session) => x.isLive && x.status.kind !== 'idle'

/** The sessions tab moves through: the active ones, else the live ones, else every one. */
const listed = () => {
  const active = sessions.filter(isActive)
  const live = sessions.filter(x => x.isLive)
  return active.length > 0 ? active : live.length > 0 ? live : sessions
}

/** One line per active session (and the shown one, whatever it is), ▶ on the one drawn below, then a gap. */
const strip = (shown: Session, now: number, columns: number) => {
  const listed = sessions.filter(x => isActive(x) || x === shown)
  // The name from `claude agents`, or the short id for a session it does not name.
  const labels = listed.map(x => nameOf(x.id) ?? x.id.slice(0, 8))
  const folders = listed.map(x => tilde(x.snap.cwd))
  // Status and ctx keep their width (with the gaps, 30 cells); the folder gives way first, then the name.
  const room = columns - 1 - 30
  const lw = Math.max(8, Math.min(24, Math.max(...labels.map(n => n.length)), room - 8))
  const fw = Math.max(0, Math.min(28, Math.max(...folders.map(n => n.length)), room - lw))
  return listed.map((x, i) => {
    const isShown = x === shown
    const st = x.isLive ? STATUS[x.status.kind] : { glyph: '○', label: `ended ${ago(now - (x.snap.endedAt ?? x.snap.updatedAt))} ago`, color: 'gray' }
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
  const s = sessions.find(x => x.id === pinned) ?? waiting[0] ?? sessions.find(isActive) ?? sessions[0]
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
  const snap: Snapshot = s.snap
  const cfg = parseConfig(snap.options)
  const mode = modeOf(s.id, snap.cwd)
  const $: ViewerState & Record<string, unknown> = {
    state: {
      read: key => {
        const v = key in local ? local[key] : snap.state[key]
        // The window picks the layout from its width, so a layout set in the session does not apply.
        if (key === 'view' && v && typeof v === 'object') return { ...v, layout: null }
        // The mode from the transcript, where the session's own hook for it may never run (modes.ts).
        if (key === 'main' && mode && v && typeof v === 'object') return { ...v, mode }
        return v
      },
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
  const W = columns - 1
  /** The mod's own drawing of just these panels, one column `width` wide. */
  const drawn = async (panels: Panel[], width: number) => {
    const d = panels.length > 0 ? drawFor({ ...snap.options, panels: panels.join(','), layout: 'compact' }) : null
    const e = {
      surface: 'terminal',
      props: { bodyColumns: width, placement: 'docked', scroll: { bodyRows }, view: null },
      viewport: { rows: bodyRows, columns: width },
    }
    return d ? withoutTitle(await d($, e)) : null
  }
  const hasLog = cfg.panels.includes('log')
  // One column of the mod's panels in a narrow window; side by side from 110 columns, the model and
  // the gate, then the agents and the last turn. The session log, the viewer's own, goes under them,
  // or beside them when the window is wide enough for three.
  const isSideBySide = W >= SIDE_BY_SIDE_FROM
  const isLogBeside = hasLog && W >= LOG_BESIDE_FROM
  const colW = !isSideBySide ? W : isLogBeside ? Math.min(MAX_COLUMN, Math.max(MIN_COLUMN, Math.floor((W - 2 * GAP) * 0.3))) : Math.floor((W - GAP) / 2)
  const sets = isSideBySide ? [LEFT, MIDDLE] : [cfg.panels]
  const groups = await Promise.all(sets.map(g => drawn(cfg.panels.filter(p => p !== 'log' && g.includes(p)), colW)))
  const cols = groups.filter(c => heightOf(c, colW) > 0)
  const colsH = Math.max(0, ...cols.map(c => heightOf(c, colW)))
  const row = cols.map((c, i) => (
    <InkBox key={i} flexDirection="column" width={colW} flexShrink={0}>
      {c}
    </InkBox>
  ))
  const tree: ReactNode = isLogBeside ? (
    <InkBox columnGap={GAP}>
      {row}
      {logPanel(snap.options, snap.state.log, W - cols.length * (colW + GAP), Math.max(bodyRows, colsH))}
    </InkBox>
  ) : (
    <InkBox flexDirection="column">
      <InkBox columnGap={GAP}>{row}</InkBox>
      {hasLog ? <InkBox marginTop={cols.length > 0 ? 1 : 0}>{logPanel(snap.options, snap.state.log, W, Math.max(5, bodyRows - colsH - 1))}</InkBox> : null}
    </InkBox>
  )
  hotkeys = hotkeysOf(tree)
  // The pane draws at its own height, and in Claude Code its body scrolls. Here it scrolls too, with
  // the arrow keys, inside the rows the session lines and the footer leave: a frame taller than the
  // window would scroll the session lines off its top. The inner box keeps the pane's height, since
  // squeezed the panels would draw over each other; drawing it once more measures that height.
  const height = heightOf(tree, columns)
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
