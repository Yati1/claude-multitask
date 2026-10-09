# claude-multitask

Talk to Claude while it works, and keep every topic in its own thread. Two Claude Code mods: **multitask** and **thread-chat**.

## Why

- **Talk while it works.** With multitask you talk to one **voice**, and its **thoughts** (background agents) do the work. The voice is always free to talk.
- **No waiting, nothing held back.** Ask something new, add a detail or change your mind whenever it occurs to you. The voice passes it to the right piece of work.
- **Questions come straight away.** Your message isn't queued behind work in progress, so clarifying questions come at once and the right work starts sooner.
- **Topics stay apart.** With thread-chat, a `# heading` puts a message in its topic's thread: colour-coded, readable on its own and easy to find later.

Examples: [docs/why.md](docs/why.md).

## Install

Requires Claude Code 2.1.290 or later. Made for the Code tab in the Claude desktop app.

```
claude plugin marketplace add othrayte/claude-multitask
claude plugin install multitask@claude-multitask
claude plugin install thread-chat@claude-multitask
```

Install either or both.

## Use

The `mods` button at the right end of the band above the prompt opens a menu of switches for the chat, one for each installed mod. In the desktop app it opens as you point at or click it.

### Multitask

- `/multitask`, or Multitask in the `mods` menu, turns Multitask on in a chat (run it again to turn it off). The chat becomes the voice and hands all work to thoughts.
- `/thoughts`, or the `thoughts` button above the prompt, opens the Thoughts pane: what each thought is doing, its report, and `stop`.
- The `voiceEffort` setting (Voice effort, in `/config`) sets how hard the voice thinks: `low` (default), `medium`, `high`, or `session` to match the session. Thoughts keep the session's setting.

### Threads

- `/threads`, or Threads in the `mods` menu, turns threads on in a chat (run it again to turn them off).
- A `# name` heading in a message starts a thread, or replies to it if it exists. Close or abbreviated names find the existing thread. The agent replies under the same headings.
- `#+name` starts a new thread even when an existing one is close.
- To put a message in a thread, hover it for `+ thread` (desktop app); to move it to another, press `▾` beside its thread tag.
- The thread picker above the prompt shows the picked thread: messages without a heading go to it. A heading still wins. Its menu (point at or click it in the desktop app) picks another thread or none, starts a new one by name, and under `manage` merges, archives or deletes threads.
- Archived threads leave the pickers but keep their messages; `manage` brings them back, as does a heading naming one. Deleting a thread takes its tag off its messages.
- The chat always shows every message. `view` above the prompt, or `/thread-view`, opens the thread view: the picked thread's messages on their own, in a pane (all threads when none is picked).
- `/merge-threads <thread> into <thread>` also merges two threads.
- Agent may start threads, in the `mods` menu, lets the agent start threads itself.
