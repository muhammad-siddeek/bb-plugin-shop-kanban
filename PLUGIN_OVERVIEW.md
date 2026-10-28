## What you get

- A board docked at the bottom of bb with Queue, WIP, Blocked and Done columns. Every non-archived top-level thread is on it, and child threads roll up into their parent thread.
- Columns follow live thread state, so you never drag a thread. Queue means not started. WIP means the thread or one of its children is running, background work included. Blocked means idle and waiting on you: a pending interaction, an error, a failed result, or a last reply that asks a question. Done means idle with a last reply that reports completion; unread Done threads come first.
- Each thread shows a `[category] intent` title, a two-line summary of the latest exchange, the update time and status, what the thread has spent together with its child threads and subagents (archived ones included; `~` when part of it is estimated), a ring with the share of the context window in use (amber at 70%, red at 90%), and the icon of the harness running the thread. Hover the cost, ring or icon for model, thinking level, tokens, access mode and service tier.
- Clicking a thread opens it at the latest message. The Queue + button starts a new thread. The thread open in bb is highlighted on the board and kept in view.
- The search bar in the board's title bar finds any thread by what was said in it, archived threads included. Picking a result opens the thread in bb and leaves the board as it is.

## For agents

Agents get four tools to track their own work: move their thread, spawn a child thread, spawn one independent thread per theory for an investigation, and mark a result as success (Done) or failure (Blocked). A bundled skill tells agents when to use them. The same actions are available from the terminal as `bb shop-kanban`.

## Model-written labels

Titles, summaries, and the Blocked-or-Done call for finished replies come from a small model. The plugin runs a pi-compatible CLI on the thread's host, by default `pi` with `anthropic/claude-haiku-4-5`, so labels are billed to that CLI's account. Board titles are written back to the bb thread title unless you rename the thread yourself. Set `labelerCommand` to empty to turn labels off; threads then use heuristic titles and an excerpt of the latest message.

## Requirements

- bb 0.47 or later.
- For model-written labels: a pi-compatible CLI on each host that runs threads.
- For thread search: [qmd](https://github.com/tobi/qmd) (`npm install -g @tobilu/qmd`) on a connected persistent host.

If you replace bb's omp agent with a custom ACP agent entry, bb draws it with a generic toolbox glyph. The plugin draws bb's omp mark for it instead, in bb's sidebar and pickers as well as on the board.
