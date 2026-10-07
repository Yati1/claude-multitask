# Changelog

Notable changes to the thread-chat and multitask mods, for the people who use them. The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/).

Both mods are at version 0.1.0 in their `plugin.json` and have not had a release yet, so every change so far is listed under Unreleased.

## Unreleased

### thread-chat

#### Added

- Start or reply to a conversation thread with a level-1 heading in a message (`# name` or `#name`); the agent replies under the same headings.
- Each thread's sections are colour-coded and tagged with the thread's name.
- A heading that closely matches an existing thread (a typo, another spelling or the start of its name) goes to that thread; `#+name` always starts a new one.
- Thread pills above the prompt filter the chat to the picked threads.
- A switch above the prompt lets the agent start threads of its own.
- `/merge-threads <thread> into <thread>` merges one thread into another; headings with the old name then go to the merged thread.
- Threads are kept with the session and come back when it is resumed or restarted.
- While exactly one thread is picked, a message sent with no heading goes to that thread, and that thread's pill shows an arrow.
- Move a message, or one part of a reply, to another thread or to no thread after sending, from the tag above it; a part with no thread offers "+ thread".
- The move picker has a "+" to name a new thread and move the part there in one step.
- A thread view pane (`/thread-view`, or "view" in the band) shows the picked threads alone, without tool rows.
- A message that replies to a quoted part of a reply goes to that part's thread.
- A heading that starts with an existing thread's name and runs on into more words, such as `#Design fix the header` when a thread "Design" exists, goes to that thread, with the rest of the line as the first line of its section.

#### Changed

- The thread band stays on one row, and hovering over it no longer shifts it.
- The move picker opens beside the tag at the top of the part, and its "none" (no thread) choice has a dashed outline.

#### Fixed

- Filtering by thread shows every matching section of a reply, not only the first.
- In the desktop app, filtering by thread no longer hides the parts of the latest reply that belong to no thread.
- Threads are no longer lost when a session is rewound or forked.
- The agent now hears of new threads, merges and the agent-threads switch during a session, not only at its start.
- In the desktop app, thread controls no longer stop drawing in long chats with many thread tags.
- Prompts sent by other plugins no longer get thread controls.
- Thread sections in a reply are evenly spaced.
- Empty rows no longer offer "+ thread".
- The "▾" after a thread tag sits right after the name in messages and replies alike.

### multitask

#### Added

- Multitask: when on, the main session becomes the "voice" that talks with you and hands all work to background "thoughts" it starts, steers and stops; the voice does no reading, searching, running or editing itself.
- A switch above the prompt and `/multitask` turn Multitask on or off.
- The voice stays quiet unless an update from its thoughts needs your attention.
- A Thoughts pane (`/thoughts`, or "thoughts" in the band) shows each thought's status, task and latest progress, with a button to stop it.
- `voiceEffort` setting: how hard the voice thinks while Multitask is on (`low` by default, `medium`, `high`, or `session` to keep the session's setting); thoughts keep the session's setting.

#### Changed

- The band above the prompt shows a count of running thoughts and queued messages instead of listing every thought.
- Only a thought's final report and errors are passed to the voice; its progress notes appear in the Thoughts pane instead, which keeps the chat free of empty gaps.
- The Thoughts pane collapses finished and stopped thoughts, and shows only the first line of a running thought's task until it is opened.
- The voice speaks to you as one mind rather than describing its thoughts as separate workers.
- The voice and its thoughts are briefed to keep thoughts that edit files apart (their own files, or their own git worktree and branch), and not to merge into your checkout or commit to main unless you ask.

#### Fixed

- Turning Multitask on or off between messages now reaches the voice with your next message.
- Thoughts are no longer refused at start in auto mode.
- Interrupting a thought again after an earlier interruption now cuts its current work as the first one did.
