# claude-multitask

Two Claude Code mods, each a plugin in its own folder: `thread-chat` and `multitask`. The repository root is their plugin marketplace (`.claude-plugin/marketplace.json`). `README.md` has the install and test commands.

## Editing the mods

The mod folders in this checkout are loaded live, so in auto mode edits to them here are blocked. Make every change in a git worktree on its own branch, then merge it into main.

## Quick fixes

For a small, clear fix: no advisor, read only the code the fix touches, add no new tests, run `npm run typecheck` once, then commit. Edits to the mod folders still go through a worktree and a merge into main. For an urgent bug, fix it first and gather evidence afterwards.

## Type-check

Run `npm install` once, then `npm run typecheck` checks both mods. Each mod's `tsconfig.json` extends the types Claude Code writes into `<mod>/.claude-plugin/types/` when it loads the mod; they are not committed, so in a new worktree copy both folders from the main checkout first. They come from whichever Claude Code version loaded the mod last (the first line of `claude-code/index.d.ts` names it): if the check fails on the engine's own types, load the mods from the current version and copy again. The tsconfigs leave out the generated MCP tool types, which list only the servers the last session had connected, so every `mcp__*` tool is loosely typed.

## Changelog

Update `CHANGELOG.md` in the same commit as any user-visible change to a mod. The rules for it are in `.claude/rules/changelog.md`, which Claude Code loads automatically.
