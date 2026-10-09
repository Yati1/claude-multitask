# claude-multitask

Two Claude Code mods, each a plugin in its own folder: `thread-chat` and `multitask`. The repository root is their plugin marketplace (`.claude-plugin/marketplace.json`). `README.md` has the install and test commands.

## Editing the mods

The mod folders in this checkout are loaded live, so in auto mode edits to them here are blocked. Make every change in a git worktree on its own branch, then merge it into main.

## Changelog

Update `CHANGELOG.md` in the same commit as any user-visible change to a mod. The rules for it are in `.claude/rules/changelog.md`, which Claude Code loads automatically.
