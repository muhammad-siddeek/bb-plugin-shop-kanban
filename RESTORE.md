# Restore notes

Stable source path:

`~/world/bb-plugins/shop-kanban`

The plugin package name is `bb-plugin-shop-kanban`, producing plugin id
`shop-kanban`.

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
