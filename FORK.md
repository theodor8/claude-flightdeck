# Flightdeck in its own window

A personal fork of [scasella/claude-flightdeck](https://github.com/scasella/claude-flightdeck) that shows the
dashboard in a separate terminal window (tile it next to Claude Code) instead of a pane inside Claude Code. It draws no
background colour, so the terminal's own (transparency included) shows through, and its colours are the terminal's
ANSI colours, so it follows the terminal theme.

## How it works

| Part | What it does |
| --- | --- |
| `hooks/bridge.ts` | Mirrors Flightdeck's session state to `~/.claude/flightdeck/sessions/<session>.json` on every change, and every 5s as a heartbeat, with the question or plan waiting on you, if any. A session that ends is rewritten as ended. A session with no prompt yet (such as a pre-warmed `claude agents` spare) writes nothing. |
| `hooks/main.ts` | The hooks module: upstream's `register` plus the bridge. `hooks/hooks.json` points here. |
| `viewer/` | The `flightdeck` command: runs upstream's own Pane drawing from `hooks/register.tsx` against the snapshot and draws it with [Ink](https://github.com/vadimdemedes/ink). |
| `tests/bridge.test.ts` | The bridge's tests, run with upstream's by `claude plugin test .`. |

### Changes to upstream's files

Everything else is in files of the fork's own, so upstream's panel changes show up in the viewer as they are, and a
merge from upstream conflicts only where it touches these lines:

| File | Change | Why |
| --- | --- | --- |
| `hooks/hooks.json` | the module is `./main.ts`, not `./register.tsx` | loads the bridge alongside upstream's `register` |

## Setup

Needs Node 22 or later, Claude Code 2.1.287 or later (mods), and `~/.local/bin` on your `PATH`.

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

To remove it: `claude plugin uninstall flightdeck@claude-flightdeck`, `rm ~/.local/bin/flightdeck`, and
`rm -r ~/.claude/flightdeck`.

## Use

Open a terminal window and run `flightdeck`. A session shows up after its first prompt (a resumed one at once).

### Session lines

The top lines list the live sessions, one each: its name in `claude agents` (or its short id, dimmed, when it has
none), folder, status, context and running agents; `▶` marks the one drawn below. Names are read with
`claude agents --json` every 10s.

| Status | When |
| --- | --- |
| `◆ needs you` | a question or a plan to approve waits on you, or the main loop's permission check has waited 5s or more (a subagent's never counts); the question or check is shown after it |
| `● working` | a turn is running |
| `✓ done 2m ago` | the last turn finished |
| `○ idle` | no turn has finished since the session's process started: Claude Code restarts a background session's process when you attach or reply after it was stopped, and `/clear` or `/flightdeck reset` empties it too |
| `○ ended 3m ago` | the session has ended; shown only when it is the one drawn |

An idle or ended session has no line unless it is the one drawn. An idle one gets its line back with its next prompt.

The viewer draws the session that needs you (the latest to start waiting), else the active one you last used, else the
most recent idle one, else the most recent ended one.

A session is live when its process runs the mod (started after the plugin was installed, or `/reload-plugins` since)
and has had a prompt. It is live until it ends (exits, or `/clear` starts another) or its snapshot has not been
rewritten for 15s (the heartbeat is every 5s). Finished `claude agents` sessions have no process, so they are not
listed until resumed. Ended sessions can still be drawn for a day; their snapshots are deleted after a week.

### Keys

| Key | Does |
| --- | --- |
| `tab` / `shift+tab` | next / previous session (pins it): through the sessions with a line, or every live one when all are idle; never an ended one |
| `a` | follow the most recently active session again |
| `1`–`6` | expand an agent card or lane |
| `f` `s` `o` | the gate's file / shell / other drill-down |
| `↑` `↓`, `pgup` `pgdn`, `home` `end` | scroll the panels when they are taller than the window |
| `q` | quit |

The bottom line lists the keys that do something right now: `1`–`6` only when there are agent cards to expand,
`f s o` only when the gate panel is shown.

### Panels

The panels and options are upstream's, described in the [README](README.md#what-you-see). The options are read from
each session's snapshot, so a change in `/config` reaches the viewer after `/reload-plugins`; `motion` has no effect
here.

In the session log, a row is red for an error: a tool call that failed (`✗`), one refused by a hook (`denied`) or by
a gate rule (`denied by rule`), an agent that `stopped` or `failed`, or a request that `hit max_tokens`. Other rows
take the colour of who wrote them.

### Other

`flightdeck --once` prints a single frame and exits. `flightdeck --build` (or `npm run build` in `viewer/`) only
builds; `flightdeck` rebuilds itself on start when any source in `viewer/src`, `hooks` or `types` is newer than its
build. Colours are in `viewer/src/theme.ts`. Errors are logged in `~/.claude/flightdeck/viewer.log`; one that stops the
viewer is also printed in the terminal after it closes.

If a session does not show up: it needs a prompt after the plugin loaded (`/reload-plugins` in a session that was
already running), and its snapshot should be in `~/.claude/flightdeck/sessions/`.

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
- **Layout** follows the window's width, not the `layout` option or `/flightdeck layout`. Under 110 columns the
  panels are one column, as upstream draws them. From 110 they sit side by side (main, architect and gate; agents,
  loops and the last turn), each group drawn by upstream at its column's width. The session log goes under them,
  filling the rows left, or from 170 columns is a third column as tall as the window. The viewer draws the log itself,
  in upstream's style, since upstream keeps it to 8 lines (the store holds the last 60), and its name column only as
  wide as the names in it, so the text gets the rest.
- **Permission mode** is read from the session's transcript (`~/.claude/projects/…/<session>.jsonl`), which records
  it on each prompt. Upstream learns it in a `UserPromptSubmit` hook, which Claude Code's bundled security plugin
  (`cc-plugin-sec-default`) skips for installed plugins on a managed machine or a Team or Enterprise plan. Without
  the mode, the gate counted the auto-mode classifier's decisions as `you`. A change of mode shows from the next
  prompt.
- **No title.** The `FLIGHTDECK · <MODEL>` line and its legend are left out; the session lines name the session.
- **Scrolling.** Panels taller than the window scroll under the session lines, which stay put.
- **Connectors and clocks** are drawn still and redraw once a second (the pane's animated rails need Claude Code).
- **Hotkeys** are plain keys in the window, not `ctrl+x tab` focus.
- **Top row.** Ink enters the alternate screen without homing the cursor; the viewer homes it so the frame starts on
  the window's top row.

## Updating from upstream

```sh
git fetch upstream && git merge upstream/main
```

then `/reload-plugins` in Claude Code. The viewer rebuilds itself on its next start. If the merge conflicts in
`hooks/hooks.json`, keep upstream's version and point the module at `./main.ts` again.
