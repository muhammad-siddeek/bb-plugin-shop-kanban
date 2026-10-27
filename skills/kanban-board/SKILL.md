---
name: kanban-board
description: Use the Kanban Board plugin to track BB thread cards, spawn theory tasks, and mark independent attempts as success or failure.
---

# Kanban Board workflow

Use the Kanban Board plugin when a user wants tasks tracked as cards or asks you to investigate, make theories, and have independent agents try solutions.

## Core rules

- Each card is a BB thread.
- Move your card as work progresses with `kanban_move_card`.
- When an investigation yields theories, call `kanban_create_theory_tasks` so each theory gets its own independent BB thread/card.
- Child tasks are hidden from the board by default. Only show them when the user explicitly asks to see child cards for the parent.
- When you finish, call `kanban_mark_result` with success or failure and a concise summary.
- Do not spawn raw `pi` processes for board work. Spawn BB threads/cards through the plugin tools so the board can track them.

## Naming rule

Give every task a short title that describes the **whole conversation goal**, not just the latest implementation step.

Use the task description/note to say **how far the work has gotten** and what changed most recently.

Look at all tasks on the board holistically and group related tasks with a 1-2 word bracketed category prefix, for example `[kanban extension]`. The board also auto-adds this prefix for new tasks when it is missing.

When one BB session spawns another, the child title is:

`parent > child`

Keep each segment short, usually 2-5 words and under 40 characters, for example:

- `[auth race] auth race > [auth race] cache theory`
- `[checkout] checkout bug > [checkout] retry fix`
- `[kanban extension] board UI > [kanban extension] task tools`

## Tools

- `kanban_move_card`: move the current or specified card to `queue`, `wip`, `blocked`, or `done`.
- `kanban_spawn_task`: spawn one child BB thread/card. New root tasks start in Queue.
- `kanban_create_theory_tasks`: spawn one independent child BB thread/card per theory.
- `kanban_mark_result`: mark a card done on success or blocked on failure.
