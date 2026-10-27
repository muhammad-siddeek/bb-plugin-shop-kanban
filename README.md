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
- **Done**: not running and the last message reports completion. Unread done
  cards (bb's unread state) show a solid green check and sit above read ones;
  opening a card marks its thread read and drops it to the read group. Both
  groups are in timestamp order.
- **Queue**: not started yet (pending/queued, or no output).

Expected UI surfaces:

- Bottom Shop Kanban overlay registered via `experimental_appOverlay` (the only
  surface; no nav-rail entry is registered).
- Plugin icon: `ListTodo` (checklist).
- Floating reopen pill when hidden (shows blocked/done counts).
- Draggable/keyboard resizable top handle.
- Uppercase, color-coded column headers with counts.
- Compact cards titled `[category] user intent` (e.g. `[shop kanban] refine
  UI`), a two-line summary of the most recent interaction, a relative
  "updated" timestamp, and an archive button at the bottom right (archives the
  BB thread). Clicking a card opens the thread scrolled to the latest message.

Card labels are written by a small model: the `bb.host` entry (`host.ts`) runs
`pi -p` with `anthropic/claude-haiku-5-5` (fallback `claude-haiku-4-5`). Labels
are cached in plugin kv (`labels-v2`) and refreshed only when a thread gets a
new user message or a new final reply. The title is re-derived from all of the
user's messages, so it follows the overall intent as the conversation moves on.
The board also writes the card title to the bb thread title (sidebar). If you
rename a thread yourself, the board stops syncing it and shows your title. The model also decides whether a
finished reply is actually waiting on the user (Blocked) or done. Until a label
exists — or if `pi` is unavailable — the card falls back to the thread title
and an excerpt of the latest message.
- Queue `+` button opens an inline add-task form (Enter adds, Esc cancels).
