# Shop Kanban

A Kanban board for [bb](https://getbb.app) threads. It opens as an overlay at
the bottom of the bb app and shows every non-archived top-level thread as a
card. Child threads roll up into their parent card.

## Columns

Columns are derived from live thread state; you never drag cards around.

- **Queue**: the thread has not started yet (pending, queued, or no output).
- **WIP**: the thread or one of its descendants is running, including
  background work.
- **Blocked**: the thread is idle and needs you: a pending interaction, an
  error, a failed result, or a last reply that asks a question.
- **Done**: the thread is idle and its last reply reports completion. Unread
  Done cards come first with a solid check; opening a card marks it read.

## Cards

- A `[category] intent` title, e.g. `[docs site] search page`. The title is
  written back to the bb sidebar thread title unless you rename the thread
  yourself.
- A two-line summary of the latest exchange.
- A relative "updated" time and an archive button.
- The harness the thread runs on (omp, Pi, Codex, …; the same icon as the bb
  sidebar), what the session has spent when the harness reports cost, and how
  full its context window is. Hover the icon for the model, thinking level,
  service tier, access mode, and exact token counts. Running threads refresh
  these every 5 seconds, idle threads every minute.
- Clicking a card opens the thread at its latest message. The Queue `+` button
  starts a new task thread.

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

With labels off, or when the CLI is unavailable, cards use heuristic titles
and an excerpt of the latest message.

## Agent tools

Agents get four tools for tracking their own work on the board:

- `shop_kanban_move_card`: move the current or a given card.
- `shop_kanban_spawn_task`: spawn a child thread/card.
- `shop_kanban_create_theory_tasks`: spawn one independent thread per theory.
- `shop_kanban_mark_result`: mark a card done (success) or blocked (failure).

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

```sh
bb plugin install <path-or-git-url> --yes
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
