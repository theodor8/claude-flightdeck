# Flightdeck in its own window

A personal fork of [scasella/claude-flightdeck](https://github.com/scasella/claude-flightdeck) that shows the
dashboard in a separate terminal window (tile it next to Claude Code) instead of a pane inside Claude Code. It draws no
background colour, so the terminal's own (transparency included) shows through, and its colours are the terminal's
ANSI colours, so it follows the terminal theme.

## How it works

| Part | What it does |
| --- | --- |
| `hooks/bridge.ts` | Mirrors Flightdeck's session state to `~/.claude/flightdeck/sessions/<session>.json` on every change, and every 5s as a heartbeat. |
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
echo '{"openOnStart":"false"}' | claude plugin configure flightdeck@claude-flightdeck --values-stdin
```

The plugin is read from this folder, so an edit or a pull reaches Claude Code with `/reload-plugins`.

## Use

Open a terminal window and run `flightdeck`. It follows the Claude Code session you last used; with several open:

| Key | Does |
| --- | --- |
| `tab` | next session (pins it) |
| `a` | follow the most recently active session again |
| `1`–`6` | expand an agent card or lane |
| `f` `s` `o` | the gate's file / shell / other drill-down |
| `q` | quit |

`flightdeck --once` prints a single frame and exits. Colours are in `viewer/src/theme.ts`.

## Updating from upstream

```sh
git fetch upstream && git merge upstream/main
```

then `/reload-plugins` in Claude Code. The viewer rebuilds itself on its next start when any source is newer than its
build.
