// Flightdeck's `theme` palette names Claude Code theme colours; outside Claude Code they become the
// terminal's own ANSI colours, so the window follows whatever terminal theme is set. No background
// colour is ever drawn: the terminal's own (transparency included) shows through.
export const THEME: Record<string, string | undefined> = {
  claude: 'yellow',
  suggestion: 'blue',
  success: 'green',
  permission: 'cyan',
  merged: 'magenta',
  warning: 'yellowBright',
  error: 'red',
  inactive: 'gray',
  subtle: 'gray',
  text: undefined,
}

/** Colours drawn dimmed as well, so `subtle` reads fainter than `inactive`. */
export const DIMMED = new Set(['subtle'])

/** A colour as Ink takes it: a theme name mapped, anything else (a hex from `pastel`) as given. */
export const paint = (c: string | undefined) => (c !== undefined && c in THEME ? THEME[c] : c)

/**
 * Glyphs swapped for ones every terminal draws exactly one cell wide: the gauges' ▰▱ and the effort
 * bar's ▮▯ come from fonts that may draw them wider, running into their neighbours. Block
 * elements are drawn by the terminal itself.
 */
const GLYPHS: Record<string, string> = { '▰': '█', '▱': '░', '▮': '█', '▯': '░' }
const GLYPH = new RegExp(`[${Object.keys(GLYPHS).join('')}]`, 'g')

export const glyphs = (s: string) => s.replace(GLYPH, g => GLYPHS[g] ?? g)
