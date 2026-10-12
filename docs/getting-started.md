# Getting started

A quick start for each mod; every detail is in [the README](../README.md#use).

## thread-chat: one thread per topic

1. `/threads on`.
2. Start a message with `# name` to put it in that thread.
3. `☰` above the prompt, or `/thread-view`, to read one thread at a time.

Also:

- The thread picker above the prompt picks the thread for messages without a heading; `+` after it starts a new thread.
- Hover a message for `+ thread` to put it in a thread (desktop app). Beside its thread tag, `▾` moves it to another and `ᯤ` opens the thread view on that thread alone.
- `/threads agent`, `filter` and `summaries`, with `on` or `off`: let the agent start threads, show only the picked thread in the chat, and show its one-line summary above the prompt.
- `/threads manage` lists your threads in the chat to merge, archive or delete them; `/merge-threads <thread> into <thread>` merges two.
- When you come back to a thread after a long gap, the agent gets a short summary of it.
- Automatically fixes minor typos in thread names. Use `#+name` to skip that and start a new thread.

## multitask: talk while it works

1. `/multitask on`.
2. Ask for something, then keep talking: the work runs as thoughts, one dot each on the `thoughts` button.
3. Click `thoughts`, or `/thoughts`, to see, `tell` or `stop` them.

Also:

- The chat becomes the voice: it talks with you and hands the work to thoughts. The dropdown above the prompt switches to `Focus`, where you work with the agent as usual; `/multitask mode` does the same.
- `voiceEffort`, in `/config`, sets how hard the voice thinks.

## react: emoji instead of "done" replies

On already. A reply with nothing to say comes as an emoji on your message; `/react off` stops it.

## Turning mods on and off

`/threads`, `/multitask` and `/react` all take `on`, `off`, `toggle`, `status` and `default on|off`. On their own they ask whether the mod is on in this chat; `default` asks about new chats.

Each chat keeps its own choice; the default covers new chats and chats you haven't switched.

## Add another mod

Install it in a terminal, then start a new session:

```
claude plugin install thread-chat@claude-multitask
claude plugin install multitask@claude-multitask
claude plugin install react@claude-multitask
```

`Dismiss` hides the welcome line until you install another mod.
