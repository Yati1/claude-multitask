# claude-multitask

Talk to Claude while it works, keep every topic in its own thread, and get a quick emoji when a reply would be overkill. Three Claude Code mods: **multitask**, **thread-chat** and **react**.

![Demo: replies sorted into colour-coded threads, the thread view filtered to one thread, a background task running as a dot while the chat carries on, and an emoji reaction](docs/demo.gif)

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

Install any or all of them. Once installed, a line above the prompt names each new mod's command, until you dismiss it. Getting started: a quick start for each mod, in [docs/getting-started.md](docs/getting-started.md).

## Use

In the band above the prompt, Multitask, while it is on, has a mode control (a button in the terminal, a dropdown in the desktop app and VS Code), and thread-chat, while threads are on, a thread picker followed by `+`, which starts a thread, and `☰`, which opens the thread view. The mobile app shows only the thread picker: use the commands there. React has no control in the band: `/react` is its switch.

In the terminal, `ctrl+x tab` moves from the prompt to the band, onto the thread picker when there are threads. `Tab` moves along the band. From any band button, `m` presses Multitask's mode button, as does `Enter` on that button. `Esc` goes back to the prompt.

The three commands, `/multitask`, `/threads` and `/react`, work alike:

- Alone, the command asks whether the mod is on in this chat, with its current value marked. Dismissing the question changes nothing.
- `on` or `off` (or `enable`, `disable`) sets this chat, `toggle` switches it, and `status` says how it is set, here and in new chats.
- `default` asks whether it is on in new chats (the default); `default on` or `default off` sets it.
- In the command menu, each command's line shows how it is set, here and in new chats.

### Multitask

- Multitask is off in a new chat, unless you change the default (below). `/multitask on` turns it on in that chat, and `/multitask off` turns it off. The choice is per chat, and kept when the chat is restarted.
- While it is on, the chat is in one of two modes. It starts in `Multitask` mode, where the chat becomes the voice and hands all work to thoughts. In `Focus` you work with the agent as usual. Multitask's mode control shows the mode. In the terminal it is a button: press it, or `m` (keys above), to switch to the other mode. In the desktop app and VS Code it is a dropdown: pick the other mode to switch. `/multitask mode` asks which mode, and `/multitask mode multitask` or `/multitask mode focus` switches to it: the way to switch in the mobile app, which has no mode control.
- While it is off, Multitask shows nothing above the prompt and closes its Thoughts pane, and the chat stays in Focus. Thoughts it started run on unseen. Turning it off in Multitask mode switches to Focus.
- `/multitask default on` or `off` sets whether Multitask is on by default: in new chats, and in chats where you have not used `/multitask`. A chat's own `/multitask` choice wins over the default. A new chat it is on in starts in Multitask mode; a chat already open that it turns on starts in Focus. The default applies to every chat and is kept across restarts.
- Left of the mode control, the `thoughts` button holds a dot in its colour for each running thought, which blinks as the thought works, swells a little at each of its notes, and fades out as it ends, as a check, or a cross if it failed. In the desktop app, hover a dot for the thought's name, latest note and its age.
- `/thoughts`, or a click anywhere on the `thoughts` button (a dot included), opens the Thoughts pane: what each thought is doing and how long since its last note, its report, `tell` to send it a message yourself, and `stop`. It lists the 16 most recently ended thoughts (`N more` shows the rest). The thoughts are per chat, and kept when the chat is restarted.
- The `voiceEffort` setting (Voice effort, in `/config`) sets how hard the voice thinks: `low` (default), `medium`, `high`, or `session` to match the session. Thoughts keep the session's setting.

### Threads

- Threads are off in a new chat. `/threads on` turns them on in that chat, and `/threads off` turns them off. The choice is per chat, and kept when the chat is restarted.
- `/threads default on` or `off` sets whether threads are on by default: in new chats, and in chats where you have not turned them on or off. A chat's own choice wins over the default. The default applies to every chat and is kept across restarts.
- While threads are off, thread-chat shows nothing: no picker or buttons above the prompt, no thread tags, no thread view. Your threads are kept for when `/threads on` turns them on again.
- A `# name` heading in a message starts a thread, or replies to it if it exists. Close or abbreviated names find the existing thread. The agent replies under the same headings.
- `#+name` starts a new thread even when an existing one is close.
- To put a message in a thread, hover it for `+ thread` (desktop app); to move it to another, press `▾` beside its thread tag. Press `ᯤ`, at the other end of the tag's line, to open the thread view on that thread alone.
- The thread picker above the prompt, a dropdown named for the picked thread and tinted in its colour, picks the thread messages without a heading go to, or `No thread`. A heading still wins, and moves the picker to its thread.
- A message is sent with its thread's exact `# name` heading on a line of its own, however its heading was typed, and also when the picker or a reply to a part of a thread chose the thread.
- `+`, after the thread picker, starts a thread by name and picks it.
- `/threads manage` shows your threads in the chat, each with buttons to merge, archive or delete it (click them; `done` closes the list).
- Archived threads leave the pickers but keep their messages; `/threads manage` brings them back, as does a heading naming one. Deleting a thread takes its tag off its messages.
- `/threads filter on` filters the chat, which is off at first, so the chat shows every message. On, with a thread picked, the chat shows only that thread's messages, and those since your last message that are in no thread. `/threads filter off` turns it off; `/threads filter` alone asks. It is per chat, and kept when the chat is restarted.
- `/thread-view`, or `☰` above the prompt, opens the thread view: a pane with a switch for each thread below its newest message. With none on it shows every message; with some on, only those threads' messages, and those since your last message that are in no thread, as the chat's filter does. The thread picker above the prompt and the chat's filter do not change it.
- `/merge-threads <thread> into <thread>` also merges two threads.
- `/threads agent on` lets the agent start threads itself, and `/threads agent off` stops it; `/threads agent` alone asks. It is off at first, per chat, and kept when the chat is restarted.
- Thread summaries: when you write in a thread after a long gap (75k tokens of other conversation by default), or after the chat was compacted, the agent gets a short summary of the thread with your message. A small model (Haiku) writes the summaries ahead, in the background, whenever threads are on. The agent can also read a thread's summary and latest messages itself, with its `read_thread` tool.
- `/threads summaries on` shows a one-line summary of the picked thread above the prompt (of the latest thread, with none picked), and `/threads summaries off` hides it; `/threads summaries` alone asks. It is off at first, per chat, and kept when the chat is restarted. In the desktop app, hover a thread's switch in the thread view for its one-line summary.
- `/threads status` lists these settings, `agent`, `filter` and `summaries`, after whether threads are on. They work while threads are on.
- The `catchUpAfter` setting (Catch up after, in `/config`) sets that gap in tokens, `75000` by default; `summaryModel` sets the model that writes the summaries, `claude-haiku-5-5` by default.

### Reactions

- Reactions are on in a new chat. `/react off` turns them off in that chat, and `/react on` back on. The choice is per chat, and kept when the chat is restarted.
- `/react default on` or `off` sets whether reactions are on by default: in new chats, and in chats where you have not used `/react`. A chat's own `/react` choice wins over the default. The default applies to every chat and is kept across restarts.
- While they are on, a reply of a single emoji shows as a reaction on your message, not as a reply. With thread-chat, reactions show in its thread view too.
- On the desktop the reaction sits on your message's bottom-right corner.
