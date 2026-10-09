# claude-multitask

Talk to Claude while it works, and keep every topic in its own thread. Two Claude Code mods: **multitask** and **thread-chat**.

## Why

- **Talk while it works.** With multitask you talk to one **voice**, and its **thoughts** (background agents) do the work. The voice is always free to talk.
- **No waiting, nothing held back.** Ask something new, add a detail or change your mind whenever it occurs to you. The voice passes it to the right piece of work.
- **Questions come straight away.** Your message isn't queued behind work in progress, so clarifying questions come at once and the right work starts sooner.
- **Topics stay apart.** With thread-chat, a `# heading` puts a message in its topic's thread: colour-coded, filterable and easy to find later.

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

### Multitask

- `/multitask` turns Multitask on in a chat (run it again to turn it off). The chat becomes the voice and hands all work to thoughts.
- `/thoughts`, or the `thoughts` button above the prompt, opens the Thoughts pane: what each thought is doing, its report, and `stop`.
- The `voiceEffort` setting (Voice effort, in `/config`) sets how hard the voice thinks: `low` (default), `medium`, `high`, or `session` to match the session. Thoughts keep the session's setting.

### Threads

- `/threads` turns threads on in a chat (run it again to turn them off).
- A `# name` heading in a message starts a thread, or replies to it if it exists. Close or abbreviated names find the existing thread. The agent replies under the same headings.
- `#+name` starts a new thread even when an existing one is close.
- To put a message in a thread, hover it for `+ thread` (desktop app); to move it to another, press `▾` beside its thread tag.
- Pills above the prompt filter the chat to the threads you pick. With one picked, messages without a heading go to it.
- `view` above the prompt, or `/thread-view`, opens the thread view: the picked threads' messages on their own, in a pane (all threads when none is picked).
- `/merge-threads <thread> into <thread>` merges two threads.
- The switch after the pills lets the agent start threads itself.
