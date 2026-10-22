// Flightdeck in a terminal window of its own. It runs the mod's own `ui.render` hook from
// `hooks/register.tsx`, unchanged, against the snapshot the bridge writes, and draws the tree it
// answers with Ink. Upstream changes to the panels reach this window with no change here.
import { watch } from 'node:fs'
import { homedir } from 'node:os'

import { Box as InkBox, Text as InkText, render, renderToString, useInput } from 'ink'
import type { Key } from 'ink'
import React from 'react'
import type { ReactNode } from 'react'

import { register } from '../../hooks/register'
import type { ViewerState } from './claude-code-shim'
import { DIR, listSessions } from './sessions'
import type { Session, Snapshot } from './sessions'
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

const tilde = (p: string) => (p.startsWith(homedir()) ? `~${p.slice(homedir().length)}` : p)

const ago = (ms: number) => {
  const s = Math.round(ms / 1000)
  return s < 60 ? `${s}s` : s < 3600 ? `${Math.floor(s / 60)}m` : `${Math.floor(s / 3600)}h`
}

const header = (s: Session, now: number) => (
  <InkText wrap="truncate">
    <InkText color={s.isLive ? 'green' : 'gray'}>{s.isLive ? '● live' : `○ ended ${ago(now - s.snap.updatedAt)} ago`}</InkText>
    <InkText bold>{`  ${tilde(s.snap.cwd)}`}</InkText>
    <InkText dimColor>{`  ${s.id.slice(0, 8)}`}</InkText>
    {sessions.length > 1 ? (
      <InkText dimColor>{`  ${sessions.indexOf(s) + 1}/${sessions.length} · tab ${pinned ? '· a follow' : '(following)'}`}</InkText>
    ) : null}
  </InkText>
)

async function frame(): Promise<ReactNode> {
  const now = Date.now()
  sessions = listSessions(now)
  const s = sessions.find(x => x.id === pinned) ?? sessions[0]
  const columns = process.stdout.columns || Number(process.env.COLUMNS) || 80
  const rows = process.stdout.rows || Number(process.env.LINES) || 40
  if (!s) {
    hotkeys = new Map()
    return <InkText dimColor>{`Waiting for a Claude Code session with the flightdeck mod… (${tilde(DIR)})`}</InkText>
  }
  if (pinned && s.id !== pinned) pinned = null
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
  const e = {
    surface: 'terminal',
    props: { bodyColumns: columns - 1, placement: 'docked', scroll: { bodyRows: rows - 1 }, view: null },
    viewport: { rows: rows - 1, columns },
  }
  const tree = draw ? await draw($, e) : null
  hotkeys = hotkeysOf(tree)
  return (
    <InkBox flexDirection="column">
      {header(s, now)}
      {tree}
    </InkBox>
  )
}

// ---------------------------------------------------------------- the loop

const onKey = (input: string, key: Key) => {
  if (input === 'q') return quit()
  if (key.tab && sessions.length > 0) {
    const at = sessions.findIndex(x => x.id === (pinned ?? sessions[0]?.id))
    pinned = sessions[(at + 1) % sessions.length]?.id ?? null
    for (const k of Object.keys(local)) delete local[k]
    return void refresh()
  }
  if (input === 'a') {
    pinned = null
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
    app.rerender(<Root body={<InkText color="red">{`flightdeck viewer: ${(err as Error).message}`}</InkText>} />)
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

let pending: NodeJS.Timeout | null = null
listSessions(Date.now())
watch(DIR, () => {
  pending ??= setTimeout(() => {
    pending = null
    void refresh()
  }, 50)
})
// The clocks on the cards and the turn tick once a second.
setInterval(() => void refresh(), 1000)
process.stdout.on('resize', () => void refresh())
void refresh()
