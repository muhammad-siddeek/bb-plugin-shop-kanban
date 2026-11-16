---
name: shop-kanban
description: Spawn BB threads on the Shop Kanban board (one per theory, or a child thread) or inspect the board, when the user asks for it. The board follows live thread state; never report progress to it.
---

# Shop Kanban

The Shop Kanban board shows every non-archived top-level BB thread, placed by its live state: not started → Queue, working (a turn in progress) → Working, waiting on the user or errored → a red Blocked card in Working, finished → Done. Parked is the user's own later pile. Child threads roll up into their parent.

Nothing needs reporting: the board reads bb's thread state and a model-written title and summary. Use the plugin only when the user asks to spawn board threads or to look at the board.

## Tools

- `shop_kanban_spawn_task`: spawn one child BB thread of the current (or a given) thread.
- `shop_kanban_create_theory_tasks`: spawn one independent child BB thread per theory (at most 12), for an investigation the user wants split up.

Give each thread a short name (2-5 words, at most 40 characters) for the whole thread's goal. The board adds a 1-2 word bracketed category prefix such as `[docs site]` and titles a child thread `parent > child`.

## CLI

`bb shop-kanban list [--json]` shows every thread on the board with its column and why. `add` spawns a thread, `park` and `unpark` move an idle thread in and out of Parked, and `remove` archives one; `bb shop-kanban --help` prints their usage.

## Radar

The Radar tab holds discovered Shopify opportunities and AI techniques. Opening
an opportunity only drafts an implementation request; submission creates its
thread and marks it read. Dismiss removes it; techniques archive when their
Slack source opens. Do not implement discoveries without the user's submission.

`bb shop-kanban radar list --json` reads the inbox. `scan` (also the Radar refresh
button) looks for new recommendations without Slack delivery. Results append by
stable key; existing/read/dismissed items never reset or duplicate. Other engine
commands are `run` (`--force`, `--dry-run`), `refresh` (context only), `backfill
--days N`, `feedback --id ID --vote up|down [--note TEXT]`, and `webhook --url URL`. `import /absolute/data/path`
copies existing Radar caches to plugin-owned host storage without overwriting.
Settings `radarHostId` and `radarEnabled` select the persistent data host and
enable daily 08:00 America/Toronto discovery. Retire old scheduled invocations
before enabling it. No old checkout is needed after import.
