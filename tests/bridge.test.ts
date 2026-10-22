// The fork's bridge (hooks/bridge.ts): what it writes for the viewer. Upstream's tests are in
// flightdeck.test.ts; these are kept apart so an upstream merge never touches them.
import type { On } from 'claude-code'
import { expect, mock, test } from 'claude-code/testing'

type Written = { path: string; snap: { sessionId: string; endedAt: number | null; waiting: { tool: string; detail: string } | null } }

/** The session `s1`, prompted `turns()` times, under `/h`; every snapshot the bridge writes lands in the list. */
const session = (on: On, turns = () => 1) => {
  const clock = mock.clock(on)
  const writes: Written[] = []
  on('ui.status', () => ({ value: undefined }))
  on('turn.start', (_$, e) => ({ turnId: e.turnId }))
  on('turn.complete', () => ({ text: '' }))
  on('env.get', () => ({ value: '/h' }))
  on('session.id', () => ({ value: 's1' }))
  on('session.cwd', () => ({ value: '/work' }))
  on('session.turns', () => ({ value: turns() }))
  on('fs.write', (_$, e) => {
    writes.push({ path: e.path, snap: JSON.parse(e.text) })
    return { value: undefined }
  })
  const last = () => writes[writes.length - 1]?.snap
  return { clock, writes, last }
}

test('a question waits on the person while its call runs, and not after', async ($, on) => {
  const { clock, last } = session(on)
  let during: ReturnType<typeof last>
  on('tool.call', async () => {
    await clock.advance(200)
    during = last()
    return { result: { answers: {} } }
  })
  await $.tool.call({ tool: 'AskUserQuestion', questions: [{ question: 'Which library?', header: 'Lib', options: [], multiSelect: false }] } as never)
  expect(during?.waiting).toMatchObject({ tool: 'AskUserQuestion', detail: 'Which library?' })
  await clock.advance(200)
  expect(last()?.waiting).toBeNull()
})

test('a session that ends is written as ended, and nothing after', async ($, on) => {
  const { clock, writes, last } = session(on)
  on('session.end', (_$, e) => ({ sessionId: e.sessionId }))
  await $.turn.start({ text: 'hello', turnId: 'T1' })
  await clock.advance(200)
  expect(last()?.endedAt).toBeNull()
  await $.session.end({ reason: 'prompt_input_exit', sessionId: 's1', resume: { id: 's1' } })
  expect(last()?.endedAt).toBeDefined()
  expect(last()?.endedAt).not.toBeNull()
  const n = writes.length
  await clock.advance(6000) // a heartbeat
  expect(writes.length).toBe(n)
  expect(writes.every(w => w.path === '/h/.claude/flightdeck/sessions/s1.json')).toBe(true)
})

test('a session resumed after it ended is written again once prompted', async ($, on) => {
  let turns = 1
  const { clock, last } = session(on, () => turns)
  on('session.end', (_$, e) => ({ sessionId: e.sessionId }))
  await $.turn.start({ text: 'hello', turnId: 'T1' })
  await clock.advance(200)
  await $.session.end({ reason: 'clear', sessionId: 's1', resume: { id: 's1' } })
  expect(last()?.endedAt).not.toBeNull()
  turns = 2
  await $.turn.start({ text: 'back again', turnId: 'T2' })
  await clock.advance(200)
  expect(last()?.endedAt).toBeNull()
})
