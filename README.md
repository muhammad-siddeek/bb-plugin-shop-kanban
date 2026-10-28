# Shop Kanban

A Kanban board for [bb](https://getbb.app) threads. It opens as an overlay at
the bottom of the bb app and shows every non-archived top-level thread. Child
threads roll up into their parent thread.

## Columns

Columns are derived from live thread state; you never drag threads around.

- **Queue**: the thread has not started yet (pending, queued, or no output).
- **WIP**: the thread or one of its descendants is running, including
  background work.
- **Blocked**: the thread is idle and needs you: a pending interaction, an
  error, a failed result, or a last reply that asks a question.
- **Done**: the thread is idle and its last reply reports completion. Unread
  Done threads come first with a solid check; opening a thread marks it read.

## Threads on the board

- A `[category] intent` title, e.g. `[docs site] search page`. The title is
  written back to the bb sidebar thread title unless you rename the thread
  yourself.
- A two-line summary of the latest exchange.
- The updated time and status on the left of the footer. On the right: what
  the thread's whole tree has spent, how full its context window is, and the
  icon of the harness the thread runs on (omp, Pi, Codex, …; the same icon as
  the bb sidebar). Hover any of them for a three-line tooltip: model and
  thinking level, token counts and cost, then access mode, service tier and
  model id. Running threads refresh these every 5 seconds, idle threads every
  minute.
- The cost adds up the thread, every descendant thread (hidden and archived
  ones included) and their harness subagents; the tooltip says how many
  threads it spans. omp and Pi threads are read from their transcripts on
  the thread's host (`~/.omp/agent/sessions`, and bb's Pi bridge sessions in
  `~/.bb/pi-bridge-sessions`). For omp, subagents at every depth (nested
  tasks, background tasks, eval agents, advisors) count; omp itself reports
  only a session's own replies and its direct tasks, and Pi reports nothing.
  Other harnesses count what they report to bb. A fork doesn't count the
  entries it copied from its source while the source's transcript is still
  there.
- A `~` in front of the cost means part of it is estimated; the tooltip says
  how much. Replies a harness saved with tokens but no price are priced at
  the average rate, per token bucket, that the same provider and model
  charged across the host's other transcripts. Since omp 18.13 every Shopify
  Auto (`shopify/auto`) reply is saved at $0 without the model that served
  it, so its estimate follows the mix of models the router served before. A
  provider and model never priced on the host stays at $0.
- An archive button in the top-right corner, shown on hover or focus.
- Clicking a thread opens it at its latest message. The Queue `+` button
  starts a new thread.

### omp icon

An ACP providers `customAgents` entry with id `omp` replaces bb's shipped omp
agent, and bb gives custom agents a generic toolbox glyph. The plugin
registers bb's omp mark for the `acp-omp` provider, drawn in the surrounding
text color. The registration is app-wide, so bb's sidebar and pickers show
the mark too, but only while this plugin is loaded.

## Model-written labels

Titles, summaries, and the Blocked-vs-Done call for finished replies are
written by a small model. The plugin runs a pi-compatible CLI
(`-p --model --system-prompt`) on the thread's host. Labels are cached and
refreshed only when a thread gets a new user message or a new final reply.

| Setting          | Default                      | Meaning                                         |
| ---------------- | ---------------------------- | ----------------------------------------------- |
| `labelerCommand` | `pi`                         | CLI to run. Leave empty to turn model labels off. |
| `labelerModels`  | `anthropic/claude-haiku-4-5` | Comma-separated models to try in order.         |

```sh
bb plugin config shop-kanban set labelerCommand pi
bb plugin config shop-kanban set labelerModels anthropic/claude-haiku-4-5
```

With labels off, or when the CLI is unavailable, threads use heuristic titles
and an excerpt of the latest message.

## Thread search

The search bar in the board's title bar finds past threads, archived
ones included, by what was said in them. Results show the thread title, a
matching excerpt, an Archived badge and when the thread last changed.
Picking a result (click, or arrow keys and Enter) opens the thread in bb and
nothing else: the board is not touched, nothing is unarchived or marked read.

Search runs [qmd](https://github.com/tobi/qmd) on one connected persistent
host: the one already holding the index while it stays connected, otherwise
the first persistent host bb lists. Ephemeral hosts are skipped, because the
index would go away with them. Every visible thread is exported as one
markdown file (title, then each user turn and assistant reply) under the
plugin's host data directory and indexed by qmd's BM25 full-text search in a
dedicated `shop-kanban` index, collection `threads`. The index syncs about 15
seconds after the plugin loads, a few seconds after a thread goes idle, is
archived, unarchived or deleted, and every 10 minutes. An idle thread is
re-exported only when it changed; a running thread at most every 5 minutes,
then once more when it settles, so long-running threads are searchable. Each sync
checks which files the host actually has, so a wiped qmd index, a cleared data
directory or a switch to another host rebuilds itself.

The host needs qmd on the bb host daemon's `PATH`, and qmd needs Node.js 22 or
newer (its README also asks for Homebrew's SQLite on macOS, for SQLite
extensions). Search uses only qmd's keyword index, so qmd never downloads its
embedding models. If the daemon's `PATH` lacks qmd (common with nvm or a
GUI-launched daemon), set `searchCommand` to qmd's absolute path. Search shows
qmd's errors, such as a missing CLI, under the search bar.

```sh
npm install -g @tobilu/qmd                       # once, on the host
bb plugin config shop-kanban set searchCommand "$(command -v qmd)"   # only if bb cannot find qmd
qmd --index shop-kanban search "redis timeout"   # same index from a terminal
```

| Setting         | Default | Meaning                                                |
| --------------- | ------- | ------------------------------------------------------ |
| `searchCommand` | `qmd`   | qmd CLI to run. Leave empty to turn thread search off. |

## Agent tools

Agents get four tools for tracking their own work on the board:

- `shop_kanban_move_card`: move the current or a given thread to another column.
- `shop_kanban_spawn_task`: spawn a child thread.
- `shop_kanban_create_theory_tasks`: spawn one independent thread per theory.
- `shop_kanban_mark_result`: mark a thread done (success) or blocked (failure).

The bundled `shop-kanban` skill explains when to use them.

## CLI

```sh
bb shop-kanban list [--json]
bb shop-kanban add <short-name> -- <prompt> [--json]
bb shop-kanban move <thread-id> <column> [note] [--json]
bb shop-kanban success <thread-id> <summary> [--json]
bb shop-kanban fail <thread-id> <summary> [--json]
bb shop-kanban children <parent-thread-id> <show|hide> [--json]
bb shop-kanban remove <thread-id> [--json]
```

## Install

From the bb plugin store, or from this repository:

```sh
bb plugin install git:https://github.com/muhammad-siddeek/bb-plugin-shop-kanban.git@^0.8.0
```

## Development

```sh
npm install
npm run typecheck
bb plugin build .
bb plugin reload shop-kanban
```

## Requirements

bb >= 0.47.

## License

MIT
