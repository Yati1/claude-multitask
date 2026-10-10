# claude-multitask

Talk to Claude while it works, keep every topic in its own thread, and get a quick emoji when a reply would be overkill. Three Claude Code mods: **multitask**, **thread-chat** and **react**.

## Why

- **Talk while it works.** With multitask you talk to one **voice**, and its **thoughts** (background agents) do the work. The voice is always free to talk.
- **No waiting, nothing held back.** Ask something new, add a detail or change your mind whenever it occurs to you. The voice passes it to the right piece of work.
- **Questions come straight away.** Your message isn't queued behind work in progress, so clarifying questions come at once and the right work starts sooner.
- **Topics stay apart.** With thread-chat, a `# heading` puts a message in its topic's thread: colour-coded, readable on its own and easy to find later.
- **Emoji reactions.** With react, the agent can acknowledge a message with an emoji reaction instead of a reply.

Examples: [docs/why.md](docs/why.md).

## Install

Requires Claude Code 2.1.290 or later. Made for the Code tab in the Claude desktop app.

```
claude plugin marketplace add othrayte/claude-multitask
claude plugin install multitask@claude-multitask
claude plugin install thread-chat@claude-multitask
claude plugin install react@claude-multitask
```

Install any or all of them.

## Use

Multitask has a dropdown, and thread-chat a `Threads` menu, in the band above the prompt with their switches for the chat; thread-chat's thread picker sits beside its menu. The mobile app shows only the thread picker: use the commands there. React has no control in the band: `/react` is its switch.

### Multitask

- `/multitask` turns Multitask on in a chat (run it again to turn it off). The chat becomes the voice and hands all work to thoughts.
- Multitask's dropdown reads `Multitask` while it is on and `Focus` while it is off; pick the other to switch.
- `/thoughts`, or the `thoughts` button above the prompt, opens the Thoughts pane: what each thought is doing and how long since its last note, its report, `tell` to send it a message yourself, and `stop`.
- The `voiceEffort` setting (Voice effort, in `/config`) sets how hard the voice thinks: `low` (default), `medium`, `high`, or `session` to match the session. Thoughts keep the session's setting.

### Threads

- `/threads`, or the `On in this chat` switch in the `Threads` menu, turns threads on in a chat (again to turn them off). The menu opens while the pointer is on `Threads` or it has the focus in the desktop app, and with a press on it in the terminal.
- A `# name` heading in a message starts a thread, or replies to it if it exists. Close or abbreviated names find the existing thread. The agent replies under the same headings.
- `#+name` starts a new thread even when an existing one is close.
- To put a message in a thread, hover it for `+ thread` (desktop app); to move it to another, press `▾` beside its thread tag.
- The thread picker above the prompt, a dropdown named for the picked thread, picks the thread messages without a heading go to, or `No thread`. A heading still wins.
- `New thread` in the `Threads` menu starts a thread by name and picks it; `Manage threads` there merges, archives or deletes threads.
- Archived threads leave the pickers but keep their messages; `Manage threads` brings them back, as does a heading naming one. Deleting a thread takes its tag off its messages.
- `Filter the chat`, in the `Threads` menu while threads are on, is off at first, so the chat shows every message. On, with a thread picked, the chat shows only that thread's messages, and those since your last message that are in no thread. It is per chat, and kept when the chat is restarted.
- `/thread-view`, or `Open thread view` in the `Threads` menu, opens the thread view: a pane with a switch for each thread below its newest message. With none on it shows every message; with some on, only those threads' messages, and those since your last message that are in no thread, as `Filter the chat` does. The thread picker above the prompt and `Filter the chat` do not change it.
- `/merge-threads <thread> into <thread>` also merges two threads.
- `Agent may start threads`, in the `Threads` menu while threads are on, lets the agent start threads itself. It is per chat, and kept when the chat is restarted.

### Reactions

- `/react` turns reactions on in a chat (again to turn them off). It is per chat, and kept when the chat is restarted.
- While they are on, a reply of a single emoji shows as a reaction on your message, not as a reply.
