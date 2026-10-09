# claude-multitask

Two Claude Code mods, each a plugin in its own folder: `thread-chat` and `multitask`. The repository root is their plugin marketplace (`.claude-plugin/marketplace.json`). `README.md` has the install and test commands.

## Editing the mods

The mod folders in this checkout are loaded live, so in auto mode edits to them here are blocked. Make every change in a git worktree on its own branch, then merge it into main.

## Cleaning up worktrees

Once a worktree's branch is merged into main, remove the worktree and delete its branch in the same step. Leave nothing behind: no stray worktrees or branches, and no ignored copies such as `node_modules`. Delete an unmerged branch only when the user says so; otherwise list it for them.

## Quick fixes

For a small, clear fix: no advisor, read only the code the fix touches, add no new tests, run `npm run typecheck` once, then commit. Edits to the mod folders still go through a worktree and a merge into main. For an urgent bug, fix it first and gather evidence afterwards.

## Type-check

Run `npm install` once, then `npm run typecheck` checks both mods against the engine's plugin API types committed in `engine-types/claude-code/index.d.ts`; its first line names the Claude Code version they came from. The types Claude Code writes into `<mod>/.claude-plugin/types/` when it loads a mod are not used: they come from whichever version loaded the mod last, and older sessions keep rewriting them. After upgrading Claude Code and reloading the mods, `npm run types:refresh` (from the main checkout or a worktree) copies the newest generated copy over the committed one, never an older one. The built-in and MCP tool types are not committed, as they vary by build and list the connected servers, so tool inputs and every `mcp__*` tool are loosely typed.

## Changelog

Update `CHANGELOG.md` in the same commit as any user-visible change to a mod. The rules for it are in `.claude/rules/changelog.md`, which Claude Code loads automatically.
