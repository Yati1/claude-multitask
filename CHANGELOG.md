# Changelog

Notable changes to the thread-chat, multitask and react mods. The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/). All the mods share one version.

## Unreleased

### Added

- Added a warning to thread-chat, multitask and react when an older Claude Code hides their controls.
- Added a note to the chat, on turning threads off from thread-chat's menu, that `/threads` turns them on.
- Added `/threads default` to thread-chat to choose whether new chats start with threads on.
- Added `/multitask default` to multitask to choose whether new chats start with it on, off at first.
- Added `/multitask mode` to multitask to pick Multitask or Focus, also in the mobile app.
- Added a `▽` button beside each thread tag in thread-chat to open the thread view on that thread alone.
- Added `on`, `off`, `toggle`, `status` and `default on|off` to `/threads`, `/multitask` and `/react`.
- Added a dialog to `/threads`, `/multitask` and `/react`: alone for this chat, with `default` for new chats.
- Added the current setting to the command menu's lines for `/threads`, `/multitask` and `/react`.

### Changed

- Changed thread-chat to show nothing above the prompt, and close its thread view, while threads are off.
- Changed `/multitask` to turn multitask on or off in a chat, starting in Multitask mode.
- Changed `/threads`, `/multitask` and `/react`, alone or with `default`, to ask instead of switching.
- Changed multitask to show nothing while off, its thoughts included, and close its Thoughts pane.

### Removed

- Removed `/react place` from react: the desktop reaction always sits on your message's corner.

## 0.4.0 - 2026-10-11

### Added

- Added thread summaries to thread-chat: writing in a thread long left gives the agent a summary of it.
- Added a `read_thread` tool to thread-chat for the agent to read a thread's summary and latest messages.
- Added `Thread summaries` to thread-chat's threads menu, on at first, to stop summary calls in a chat.
- Added `catchUpAfter` and `summaryModel` settings to thread-chat for when and how threads are summarised.
- Added `Show thread summary` to thread-chat's threads menu for a thread's one-line summary above the prompt.
- Added a thread's one-line summary to thread-chat's thread view, shown on hovering its tag in the desktop app.

### Changed

- Changed multitask's `thoughts` button to sit left of the dropdown and hold the dots, not a running count.
- Changed multitask's dots to blink as their thought works and swell at each note.

## 0.3.0 - 2026-10-10

### Added

- Added thread tag switches, outlined when on, to thread-chat's thread view to show only those, or all.
- Added react's reactions to your messages in thread-chat's thread view, as the chat shows them.
- Added a dot per running thought above the prompt to multitask, pulsing at each note and fading as it ends.

### Changed

- Changed thread-chat's pills above the prompt to a thread picker for unheaded messages, set by headings.
- Changed thread-chat's `Threads` menu to a cog after the picker, to also start and manage threads.
- Changed thread-chat's `Filter the chat` to filter to the thread picked above the prompt, off at first.
- Changed multitask's thoughts to take four main colours in turn, dimming an ended thought's when reused.
- Changed a done thought's mark in multitask's Thoughts pane to a solid dot in its colour.
- Changed multitask's Thoughts pane to list the 16 latest ended thoughts, the rest behind `N more`.
- Changed react's desktop reaction to sit on your message's corner, or under it with `/react place`.
- Changed react's reactions to be on by default, with `/react default` to change it for new chats.

### Fixed

- Fixed issue where thread-chat left a reply quote unthreaded when a thread heading followed it.
- Fixed issue where thread-chat's thread view grouped several reply quotes above all your words.
- Fixed issue where multitask's Thoughts pane lost its thoughts when the chat was restarted.

### Removed

- Removed the count of queued messages from multitask's `thoughts` button.

## 0.2.0 - 2026-10-10

### Added

- Added a react mod (`/react`) so the agent can acknowledge a message with just an emoji reaction.
- Added a `Threads` menu above the prompt to thread-chat with its switches and `Open thread view`.
- Added `Filter the chat` to thread-chat's `Threads` menu to pick threads without hiding the rest.
- Added ages to multitask's Thoughts pane, in the warning colour once a running thought goes quiet.
- Added `tell` to each card in multitask's Thoughts pane to send that thought your own message.

### Changed

- Changed thread-chat's agent to pick the right threads for its reply, even for unheaded messages.
- Changed multitask's switch to a dropdown above the prompt that reads `Multitask` or `Focus`.
- Changed thread-chat's thread view to look like the chat, with only your messages and final replies.
- Changed thread-chat's thread view to open at the bottom, keep your place and load more on scroll.
- Changed multitask's Thoughts pane to label each card's task, notes, report and queued messages.
- Changed multitask's Thoughts pane to list ended thoughts failed first, with each report's start.

### Fixed

- Fixed issue where a finished multitask thought could still show a "Message from subagent" row.
- Fixed issue where multitask's voice could post a message to a thought it meant to queue or interrupt.
- Fixed issue where multitask's `tell` showed as a success when its message did not reach the thought.
- Fixed issue where multitask's messages to thoughts, queued ones too, never arrived in auto mode.
- Fixed issue where multitask's messages to a thought were refused once it had finished its turn.
- Fixed issue where thread-chat's thread view went blank, without saying why, when it failed to draw.
- Fixed issue where multitask's Thoughts pane showed only the end of a long report when opened.
- Fixed issue where thread-chat's `Agent may start threads` switch turned off when a chat restarted.

## 0.1.0 - 2026-10-09

### Added

- Added a picker to thread-chat's tags, and `+ thread` once threads are on, to move messages.
- Added a thread view to thread-chat (`/thread-view` or `view`) with every message of picked threads.
- Added a hover highlight to thread-chat's thread tags and pills in the desktop app.
- Added the `voiceEffort` setting to multitask to set how hard the voice thinks (`low` by default).

### Changed

- Changed thread-chat to stay out of a chat until `/threads` turns it on; `/threads` again turns it off.
- Changed thread-chat to send unheaded messages to the sole picked thread, marked with an arrow.
- Changed thread-chat to put a reply to selected text in that text's thread.
- Changed thread-chat to send a heading that runs on past a thread's name to it, the rest as text.
- Changed thread-chat's band to stay on one row in the desktop app and not shift on hover.
- Changed multitask's band to show counts of running thoughts and queued messages.
- Changed multitask's band to show only while Multitask is on or has thoughts left.
- Changed multitask to give the voice thoughts' latest progress with your messages, not note by note.
- Changed multitask to hand thought updates to the voice without leaving rows in the desktop chat.
- Changed multitask's Thoughts pane to list running thoughts first and fold the rest and reports.
- Changed multitask's Thoughts pane to open only from `/thoughts` or the band's `thoughts` button.
- Changed the voice in multitask to speak as one mind and keep acknowledgements to a few words.

### Fixed

- Fixed issue where filtering in thread-chat hid every section of a reply after the first.
- Fixed issue where thread-chat's filter hid the latest reply's unthreaded text in the desktop app.
- Fixed issue where thread-chat lost its threads when a session was rewound or forked.
- Fixed issue where thread-chat's agent missed merges and agent-threads switch changes mid-session.
- Fixed issue where multitask's voice kept its old role when Multitask was switched mid-session.
- Fixed issue where multitask's thoughts were refused at start in auto mode.
- Fixed issue where a second interrupt to a multitask thought did not cut its current work.
- Fixed issue where messages to a busy or interrupted multitask thought were silently lost.
- Fixed issue where multitask left stray chat rows when the voice stayed quiet or a thought finished.
- Fixed issue where Multitask switched off after a session was rewound, forked or restarted.
- Fixed issue where hidden background agents could start multitask thoughts or thread-chat threads.
- Fixed issue where thread-chat and multitask added empty rows to chats that did not use them.
