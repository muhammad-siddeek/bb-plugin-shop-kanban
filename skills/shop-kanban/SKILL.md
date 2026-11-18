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
button) discovers recommendations, then runs three ranker/reviewer rounds over
the complete visible inbox, prioritizing demonstrated impact and availability to
own the work. The reviewed order persists; ranking never drops items. Results
append by stable key; existing/read/dismissed items never reset or duplicate.
Other commands are `refresh` (context only), `backfill --days N`, and
`feedback --id ID --vote up|down [--note TEXT]`. `import /absolute/data/path`
copies existing caches to plugin-owned host storage without overwriting.
Every scan checks the same Slack channels, repository PRs and Vault teams.
Durable per-source checkpoints have no rolling lookback/catch-up cap; sources
without incremental APIs use saved snapshots. Imported stores without
checkpoints resume where the old engine last ran. PR discovery reads titles and
descriptions, not full codebases. No Slack delivery or daily digest remains.
Settings `radarHostId` and `radarEnabled` select the persistent data host and
enable hourly refreshes 07:00–15:00 inclusive, Monday–Friday, America/Toronto.
Retire old scheduled invocations before enabling it. No old checkout is needed
after import.
