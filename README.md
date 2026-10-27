# shop-kanban

Durable source checkout for the BB Shop Kanban plugin.

The installed BB plugin id is `shop-kanban`.

## Build

```sh
bb plugin build .
```

## Install / reload from this durable path

```sh
bb plugin install --yes .
# or, after source-only edits:
bb plugin reload shop-kanban
```

## Verify

```sh
bb plugin source shop-kanban
bb plugin run shop-kanban list --json
```

Board contents and status (derived from live thread state in `server.ts`):

- Every non-archived, visible, top-level BB thread is a card; child threads
  roll up into their parent.
- **WIP**: the thread or any descendant is running (incl. background work).
- **Blocked**: not running and needs the user: pending interaction, error,
  reported failure, or the last message asks a question / requests input.
- **Done**: not running and the last message reports completion.
- **Queue**: not started yet (pending/queued, or no output).

Expected UI surfaces:

- Bottom Shop Kanban overlay registered via `experimental_appOverlay` (the only
  surface; no nav-rail entry is registered).
- Plugin icon: `ListTodo` (checklist).
- Floating reopen pill when hidden (shows WIP/blocked counts).
- Draggable/keyboard resizable top handle.
- Uppercase, color-coded column headers with counts.
- Compact cards: one-line title (click to open the thread), two-line
  description, relative "updated" timestamp, and an archive button at the
  bottom right (archives the BB thread).
- Queue `+` button opens an inline add-task form (Enter adds, Esc cancels).
