# Restore notes

This source was moved out of BB's thread workspace storage to avoid losing it
when an old thread workspace is archived or destroyed.

Stable source path:

`~/world/bb-plugins/shop-kanban`

The plugin package name remains `bb-plugin-kanban-board`, producing plugin id
`kanban-board`. Do not rename the package unless you intentionally want a new
plugin id and are prepared to migrate storage/metadata and tool names.

To restore after accidental changes:

```sh
cd ~/world/bb-plugins/shop-kanban
git status
git log --oneline --decorate -5
git restore .             # discard uncommitted edits
# or: git reset --hard <known-good-commit>
bb plugin build .
bb plugin install --yes .
```
