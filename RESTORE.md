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

## Known-good releases

Releases are git tags. `v0.2.0` is the stable redesigned board: live
thread-status columns, model-written `[category] intent` titles and summaries,
open-at-latest, archive button.

Experiment on a branch, never on `main`:

```sh
git switch -c experiments v0.2.0   # or: git switch experiments
```

The plugin is installed from this directory (`path:`), so bb runs whatever is
checked out here after a build + reload. To go back to the release:

```sh
cd ~/world/bb-plugins/shop-kanban
git stash -u                # only if you have uncommitted experiments to keep
git switch main             # or: git switch --detach v0.2.0
bb plugin build . && bb plugin reload shop-kanban
```

To mark a new release: commit on `main`, bump `version` in `package.json`, then
`git tag -a vX.Y.Z -m "..."`.
