# Changelog rules

`CHANGELOG.md` at the repository root tells the people who use the thread-chat and multitask mods what changed. It follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/).

## When to update it

- A commit that changes anything a user of a mod would notice (behaviour, commands, settings, controls, what the agent is briefed to do) updates `CHANGELOG.md` in that same commit.
- A commit with no user-visible change (refactors, tests, tooling, developer docs) leaves it alone.

## What an entry says

- One line per change, in plain language, saying what a user notices.
- It goes under `## Unreleased`, then the mod (`### thread-chat` or `### multitask`), then the category: `#### Added`, `#### Changed`, `#### Fixed` or `#### Removed`. Add a heading only when it gets its first line; keep the categories in that order.
- State it as fact that is true of the code being committed. No plans, work in progress, known gaps or speculation.
- No internal details: no file, function, hook or variable names and no implementation reasons. Name only what a user sees or types, such as commands, settings and controls.
- The repository is public: nothing about any particular machine, person, account, path, organisation or private project. Keep examples generic.
- When a change makes an existing Unreleased line untrue, correct that line in the same commit.

## Releasing

- Both mods share one version, kept the same in `thread-chat/.claude-plugin/plugin.json` and `multitask/.claude-plugin/plugin.json`.
- To release: set the new version in both `plugin.json` files (the first release may keep 0.1.0), rename `## Unreleased` to `## x.y.z - YYYY-MM-DD` with that version and the release date, and start a new, empty `## Unreleased` above it. On the first release, also remove the preamble line saying nothing has been released yet.
- Released sections are history: edit them only to correct an error.
