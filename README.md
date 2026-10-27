# shop-kanban

Durable source checkout for the BB Kanban Board plugin.

The installed BB plugin id is still `kanban-board` so existing tools, CLI commands,
storage, and thread metadata continue to work. This repository is named
`shop-kanban` to make the source stable and easy to find.

## Build

```sh
bb plugin build .
```

## Install / reload from this durable path

```sh
bb plugin install --yes .
# or, after source-only edits:
bb plugin reload kanban-board
```

## Verify

```sh
bb plugin source kanban-board
bb plugin run kanban-board list --json
```

Expected UI surfaces:

- Bottom Kanban overlay registered via `experimental_appOverlay`.
- Floating reopen button when hidden.
- Draggable/keyboard resizable top handle.
- Nav panel fallback titled `Kanban Board`.
