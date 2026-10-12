# Getting started

Three Claude Code mods, each a plugin you install on its own:

- **thread-chat**: keep each topic in its own thread. A `# heading` in a message puts it in that topic's thread, colour-coded, with a thread picker above the prompt and a thread view to read one thread at a time.
- **multitask**: talk to Claude while it works. The chat becomes the **voice**, and background **thoughts** do the work, so you can ask, add or change things at any time.
- **react**: emoji reactions instead of "done" replies. When a reply would add nothing, the agent puts one emoji on your message instead.

Why you might want them, with examples: [why.md](why.md).

## Install

Requires Claude Code 2.1.290 or later. Made for the Code tab in the Claude desktop app; they work in the terminal too.

In a terminal, add the marketplace once, then install the mods you want:

```
claude plugin marketplace add othrayte/claude-multitask
claude plugin install thread-chat@claude-multitask
claude plugin install multitask@claude-multitask
claude plugin install react@claude-multitask
```

Start a new session to load them.

## The welcome line

After you install a mod, a line above the prompt names its command, and suggests the mods you don't have yet, with what each is for. `Docs` opens this page. `Dismiss` hides the line until you install another of the mods.

## Turning a mod on and off

Each mod has one command that switches it, in the chat and by default:

| Mod | Command | In a new chat |
| --- | --- | --- |
| thread-chat | `/threads` | off |
| multitask | `/multitask` | off |
| react | `/react` | on |

The command on its own asks whether the mod is on in this chat. Or say it straight away (shown for `/threads`; `/multitask` and `/react` take the same words):

- `/threads on` (or `enable`), `/threads off` (or `disable`): this chat.
- `/threads toggle`: the other way in this chat.
- `/threads status`: whether it is on here, and by default.
- `/threads default`: asks whether it is on in new chats; `/threads default on` or `/threads default off` sets it.

A chat keeps its own choice, also when it is restarted. The default applies to new chats, and to chats where you haven't switched the mod; it is kept across restarts. A mod that is off shows nothing above the prompt, and keeps what it had, such as your threads, for when you turn it on again.

## thread-chat

- Start a message with `# name` to put it in that thread, creating it if needed; close or abbreviated names find the existing thread. `#+name` always starts a new one. The agent replies under the same headings.
- The thread picker above the prompt picks the thread for messages without a heading.
- After the picker, `+` starts a thread and `☰` opens the thread view (also `/thread-view`): a pane showing the threads you switch on.
- `/threads manage` lists your threads in the chat, with buttons to merge, archive or delete each.
- `/threads filter`, `/threads agent` and `/threads summaries`, each with `on` or `off` (alone, it asks): show only the picked thread's messages, let the agent start threads, and show the picked thread's one-line summary above the prompt. `/threads status` lists them.
- `/merge-threads <thread> into <thread>` merges two threads.
- Settings, in `/config`: `catchUpAfter`, how much other conversation (in tokens) passes before the agent gets a summary of a thread you write in again; `summaryModel`, the model that writes those summaries.

## multitask

- While it is on, the chat is in `Multitask` mode (the chat is the voice and hands work to thoughts) or `Focus` (you work with the agent as usual). Switch with the dropdown above the prompt, or `/multitask mode` (asks), `/multitask mode multitask` or `/multitask mode focus`.
- The `thoughts` button above the prompt has a dot for each running thought. `/thoughts`, or a click on the button, opens the Thoughts pane: what each thought is doing, its report, `tell` to message it, and `stop`.
- Setting, in `/config`: `voiceEffort`, how hard the voice thinks (`low` by default, `medium`, `high`, or `session` to match the session).

## react

- While it is on, a reply of a single emoji shows as a reaction on your message instead of as a reply. With thread-chat, reactions show in its thread view too.

More detail on each mod: [the README](../README.md#use).
