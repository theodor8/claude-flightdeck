// The hooks module: upstream Flightdeck's `register`, untouched, plus the bridge that mirrors its
// state to a file for the standalone viewer. Kept separate so upstream updates merge cleanly.
import type { Register } from 'claude-code'

import { bridge } from './bridge'
import { register as flightdeck } from './register'

export const register: Register = (on, options) => {
  flightdeck(on, options)
  bridge(on, options)
}
