# claude-multitask

Three Claude Code mods, each a plugin in its own folder: `thread-chat`, `multitask` and `react`. The repository root is their plugin marketplace (`.claude-plugin/marketplace.json`). `README.md` has the install and test commands.

## Editing the mods

The mod folders in this checkout are loaded live, so in auto mode edits to them here are blocked. Make every change in a git worktree on its own branch, then merge it into main.

## Cleaning up worktrees

Once a worktree's branch is merged into main, remove the worktree and delete its branch in the same step. Leave nothing behind: no stray worktrees or branches, and no ignored copies such as `node_modules`. Delete an unmerged branch only when the user says so; otherwise list it for them.

## Quick fixes

For a small, clear fix: no advisor, read only the code the fix touches, add no new tests, run `npm run typecheck` once, then commit. Edits to the mod folders still go through a worktree and a merge into main. For an urgent bug, fix it first and gather evidence afterwards.

## Type-check

Run `npm install` once, then `npm run typecheck` checks all three mods against the engine's plugin API types in `engine-types/claude-code/index.d.ts`; its first line names the Claude Code version they came from. That file is not committed. To make it, load the mods in Claude Code, which writes the types into each `<mod>/.claude-plugin/types/`, then run `npm run types:refresh` (from the main checkout or a worktree; it also reads the main checkout's mods) to copy the newest of them into `engine-types/`, never an older one over a newer. Do this in a new clone or worktree, where the typecheck otherwise fails with "Cannot find type definition file for 'claude-code'", and again after upgrading Claude Code. The typecheck doesn't read `<mod>/.claude-plugin/types/` itself: those copies come from whichever version loaded the mod last, and older sessions keep rewriting them. The built-in and MCP tool types are left out, as they vary by build and list the connected servers, so tool inputs and every `mcp__*` tool are loosely typed.

## Running the tests

What works: run each mod's tests with the session's own engine and GrowthBook off, from the checkout or a worktree:

```
DISABLE_GROWTHBOOK=1 "$CLAUDE_CODE_EXECPATH" plugin test multitask
DISABLE_GROWTHBOOK=1 "$CLAUDE_CODE_EXECPATH" plugin test thread-chat
DISABLE_GROWTHBOOK=1 "$CLAUDE_CODE_EXECPATH" plugin test react
```

In PowerShell: `$env:DISABLE_GROWTHBOOK='1'; & $env:CLAUDE_CODE_EXECPATH plugin test multitask`.

Why:

- `plugin test` needs hooks modules, which sit behind the rollout flag `tengu_plugin_hooks_modules`. Every signed-in Claude Code process fetches its flags from Anthropic when it starts (and every 6 hours), sending its version and entrypoint, and overwrites the one cached copy in `~/.claude.json` (`cachedGrowthBookFeatures`). `plugin test` reads that cache.
- Recent engines are served the flag on; an older one (2.1.284, as bundled in an Agent SDK app that runs it in the background) is served it off. The last to start wins, so the cache can flip to off within minutes, and `plugin test` then stops with "hooks modules are turned off in this process: the rollout switch was saved off by an earlier session".
- `DISABLE_GROWTHBOOK=1` makes that one command skip the fetch and the cache, so the flag takes its built-in default, on since 2.1.289. It does the same to every other flag, so set it per command, not in settings.
- Use `$CLAUDE_CODE_EXECPATH`, not the `claude` on PATH, which may be another version: the test kit's rules change between versions. The tests follow the kit of the version named in `engine-types/claude-code/index.d.ts`: the test's hooks are registered before its first call on `$`, one hook per event unless it has a matcher, and the kit itself stores every `session.append` row (a test's hook calls `next`, and may refuse only a plugin's own row).

What doesn't work: running `claude` (or `claude -p`) once turns the cached flag on only until an older engine refreshes it; `CLAUDE_INTERNAL_FC_OVERRIDES` works only in internal builds; `CLAUDE_CODE_ENABLE_FUNCTION_HOOKS` was removed after 2.1.284; no setting or CLI flag turns the flag on.

## Changelog

Update `CHANGELOG.md` in the same commit as any user-visible change to a mod. The rules for it are in `.claude/rules/changelog.md`, which Claude Code loads automatically.

## Pushing and releasing

Push, tag and release only as `.claude/rules/release.md` says, which Claude Code loads automatically.
