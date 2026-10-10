# Changelog rules

`CHANGELOG.md` tells people who use the thread-chat, multitask and react mods what changed. It follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/).

## What goes in

- Only user-visible changes made after the first commit (5c2a542), which added both mods; their original features are not listed as new.
- In: changes a user would notice (new or changed behaviour, controls, commands, settings) and fixes to bugs a user could hit.
- Out: refactors, tests, tooling, docs, changes to how the agent is briefed unless the user sees a different result, and anything not on main.
- Several changes to one feature in the same period make one entry describing the end state.

## How an entry reads

- Under `## Unreleased`, in `### Added`, `### Changed`, `### Fixed` or `### Removed`, in that order and only those with entries. No per-mod sections.
- One line, aiming under ~100 characters, starting with a past-tense verb:
  - Added <what> to <where>[ when/so <condition>]
  - Changed <what> to <new behaviour>[ when <condition>]
  - Fixed issue where <what> did <wrong thing>[ when <condition>]
  - Removed <what> from <where>
- The mod is named inside the line as the <where> ("to thread-chat's move picker", "in multitask"), with no prefix tag.
- Backticks only for commands, settings and controls. No implementation details, file or function names, or reasons.
- Generic, public-safe wording: nothing about a particular machine, person, account, path, organisation or private project.

## When

- Update the line in the same commit as the change; when a later change makes a line untrue, fix that line in the same commit.
- To release, rename `## Unreleased` to `## x.y.z - YYYY-MM-DD` and start a new, empty `## Unreleased` above it. All the mods share one version, set the same in `thread-chat/.claude-plugin/plugin.json`, `multitask/.claude-plugin/plugin.json` and `react/.claude-plugin/plugin.json`.
