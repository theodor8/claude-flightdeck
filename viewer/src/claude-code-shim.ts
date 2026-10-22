// Stands in for the engine's `claude-code` module when the viewer bundles Flightdeck's own
// `hooks/register.tsx`: an atom is read from the bridge's snapshot instead of the session's state,
// and an update (a card or gate toggle) stays in this window.

export type Atom<T> = { plugin: string; key: string; initial: T }

/** The one part of `$` the atoms reach in the viewer. */
export type ViewerState = { state: { read: (key: string) => unknown; write: (key: string, value: unknown) => void } }

export const atom = <T>(ref: { plugin: string; key: string }, initial: T): Atom<T> => ({ ...ref, initial })

export const read = async <T>($: ViewerState, a: Atom<T>): Promise<T> => {
  const v = $.state.read(a.key)
  return v === undefined ? a.initial : (v as T)
}

export const update = async <T>($: ViewerState, a: Atom<T>, fn: (v: T) => T) => {
  $.state.write(a.key, fn(await read($, a)))
}
