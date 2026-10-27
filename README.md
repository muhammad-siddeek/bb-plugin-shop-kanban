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

Expected UI surfaces:

- Bottom Shop Kanban overlay registered via `experimental_appOverlay` (the only
  surface; no nav-rail entry is registered).
- Plugin icon: `ListTodo` (checklist).
- Floating reopen pill when hidden (shows WIP/blocked counts).
- Draggable/keyboard resizable top handle.
- Uppercase, color-coded column headers with counts.
- Cards show title (click to open the thread), note, and a relative
  "updated" timestamp; move/archive actions appear on hover/focus.
- Queue `+` button opens an inline add-task form (Enter adds, Esc cancels).
