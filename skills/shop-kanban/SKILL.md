---
name: shop-kanban
description: Use the Shop Kanban plugin to track BB threads on a Kanban board, spawn one thread per theory, and mark independent attempts as success or failure.
---

# Shop Kanban workflow

Use the Shop Kanban plugin when a user wants work tracked as threads on a Kanban board or asks you to investigate, make theories, and have independent agents try solutions.

## Core rules

- Every item on the board is a BB thread.
- Report progress with `shop_kanban_move_card`; its note says how far the work has gotten. The board places threads by live state (running → WIP, waiting on the user → Blocked, finished → Done), and moving to Blocked or Done notifies the user.
- When an investigation yields theories, call `shop_kanban_create_theory_tasks` so each theory gets its own independent BB thread.
- Only top-level threads appear on the board; child threads roll up into their parent thread.
- When you finish, call `shop_kanban_mark_result` with success or failure and a concise summary.
- Do not spawn raw `pi` processes for board work. Spawn BB threads through the plugin tools so the board can track them.

## Naming rule

Give every thread a short title that describes the **whole thread's goal**, not just the latest implementation step.

Use the thread description/note to say **how far the work has gotten** and what changed most recently.

Look at all threads on the board holistically and group related threads with a 1-2 word bracketed category prefix, for example `[docs site]`. The board also auto-adds this prefix for new threads when it is missing.

When one BB thread spawns another, the child title is:

`parent > child`

Keep each segment short, usually 2-5 words and under 40 characters, for example:

- `[auth race] auth race > [auth race] cache theory`
- `[checkout] checkout bug > [checkout] retry fix`
- `[docs site] search page > [docs site] result ranking`

## Tools

- `shop_kanban_move_card`: move the current or specified thread to `queue`, `wip`, `blocked`, or `done`, optionally with a note and a new short title.
- `shop_kanban_spawn_task`: spawn one child BB thread of the current (or a given) thread. It starts in WIP unless `column` says otherwise.
- `shop_kanban_create_theory_tasks`: spawn one independent child BB thread per theory (at most 12).
- `shop_kanban_mark_result`: mark a thread done on success or blocked on failure.

## CLI

`bb shop-kanban list [--json]` shows every thread on the board with its column; use it to see the board before naming or grouping threads. `add`, `move`, `success`, `fail` and `remove` spawn, move, mark and archive threads; `bb shop-kanban --help` prints their usage.
