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

- Bottom Shop Kanban overlay registered via `experimental_appOverlay`.
- Floating reopen button when hidden.
- Draggable/keyboard resizable top handle.
- Nav panel fallback titled `Shop Kanban`.
