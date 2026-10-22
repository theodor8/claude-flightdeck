# Flightdeck in its own window

A personal fork of [scasella/claude-flightdeck](https://github.com/scasella/claude-flightdeck) that shows the
dashboard in a separate terminal window (tile it next to Claude Code) instead of a pane inside Claude Code. It draws no
background colour, so the terminal's own (transparency included) shows through, and its colours are the terminal's
ANSI colours, so it follows the terminal theme.

## How it works

| Part | What it does |
| --- | --- |
| `hooks/bridge.ts` | Mirrors Flightdeck's session state to `~/.claude/flightdeck/sessions/<session>.json` on every change, and every 5s as a heartbeat. A session with no prompt yet (such as a pre-warmed `claude agents` spare) writes nothing. |
| `hooks/main.ts` | The hooks module: upstream's `register`, untouched, plus the bridge. `hooks/hooks.json` points here. |
| `viewer/` | The `flightdeck` command: runs upstream's own Pane drawing from `hooks/register.tsx` against the snapshot and draws it with [Ink](https://github.com/vadimdemedes/ink). |

Upstream files are not edited (only `hooks/hooks.json`'s one line), so upstream updates merge cleanly and their panel
changes show up in the viewer as they are.

## Setup

```sh
cd ~/dev/claude-flightdeck/viewer && npm install
ln -s ~/dev/claude-flightdeck/viewer/bin/flightdeck.mjs ~/.local/bin/flightdeck

claude plugin marketplace add ~/dev/claude-flightdeck
claude plugin install flightdeck@claude-flightdeck --scope user
echo '{"openOnStart":"false","statusLine":"false"}' | claude plugin configure flightdeck@claude-flightdeck --values-stdin
```

`openOnStart` and `statusLine` off: no pane inside Claude Code and no entry on its status bar; the viewer needs neither.

The plugin is read from this folder, so an edit or a pull reaches Claude Code with `/reload-plugins`. A session that was
already running when the plugin was installed loads it the same way; it only sees events from then on.

## Use

Open a terminal window and run `flightdeck`. A session shows up after its first prompt (a resumed one at once).

The top lines list every live session, one each: its name in `claude agents` (or its short id when it has none),
folder, status, context and running agents; `▶` marks the one drawn below. Names are read with
`claude agents --json` every 10s. Status is `◆ needs you` (a permission check has waited on you for 5s or more; the check is
shown), `● working`, `✓ done 2m ago` or `○ idle`. The viewer follows the session that needs you, else the one you
last used.

A session is listed when its process runs the mod (started after the plugin was installed, or `/reload-plugins` since)
and has had a prompt; it is live while its snapshot is fresh (rewritten every 5s). Finished `claude agents` sessions
have no process, so they are not listed until resumed. With several open:

| Key | Does |
| --- | --- |
| `tab` / `shift+tab` | next / previous session (pins it) |
| `a` | follow the most recently active session again |
| `1`–`6` | expand an agent card or lane |
| `f` `s` `o` | the gate's file / shell / other drill-down |
| `q` | quit |

The bottom line lists the keys that do something right now: `1`–`6` only when there are agent cards to expand,
`f s o` only when the gate panel is shown.

`flightdeck --once` prints a single frame and exits. Colours are in `viewer/src/theme.ts`. Errors are logged in
`~/.claude/flightdeck/viewer.log`; one that stops the viewer is also printed in the terminal after it closes.

The panels and options are upstream's, described in the [README](README.md#what-you-see). The options are read from
each session's snapshot, so a change in `/config` reaches the viewer after `/reload-plugins`; `motion` has no effect
here (connectors are drawn still, clocks redraw once a second).

## How the viewer's drawing differs from the pane

- **Gauges** (`▰▱`, effort `▮▯`) are drawn as upstream draws them; how they look is up to the terminal's font. Many
  monospace fonts lack them (JetBrains Mono does), and fallbacks such as Hack Nerd Font and Menlo fill the whole cell,
  so the segments run together and into the percentage. In Ghostty, list a backup font whose glyphs fit, after the
  main font (installed, so Ghostty finds it by name):

  ```
  font-family = JetBrains Mono
  font-family = Arial Unicode MS
  ```

  `ghostty +show-face --string='▰▱▮▯◐↻'` shows which font draws each one.
- **Connectors and clocks** are drawn still and redraw once a second (the pane's animated rails need Claude Code).
- **Hotkeys** are plain keys in the window, not `ctrl+x tab` focus.
- **Top row.** Ink enters the alternate screen without homing the cursor; the viewer homes it so the frame starts on
  the window's top row.

## Updating from upstream

```sh
git fetch upstream && git merge upstream/main
```

then `/reload-plugins` in Claude Code. The viewer rebuilds itself on its next start when any source is newer than its
build.
