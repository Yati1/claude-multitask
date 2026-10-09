# Changelog

Notable changes to the thread-chat, multitask and react mods. The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/). All the mods share one version.

## Unreleased

### Added

- Added a react mod (`/react`) so the agent can acknowledge a message with an emoji reaction, not a reply.
- Added a `mods` menu above the prompt to thread-chat, multitask and react, with their switches for the chat.

### Changed

- Changed thread-chat's agent to pick the right threads for its reply, even for unheaded messages.
- Changed thread-chat's agent-threads switch and multitask's switch to sit in the `mods` menu.
- Changed thread-chat's thread view to match the chat, with its bubbles, images, thread tags and borders.
- Changed thread-chat's thread view to show only your messages and each turn's final reply.
- Changed thread-chat's thread view to stay at the bottom as messages arrive, unless scrolled up.

### Fixed

- Fixed issue where a finished multitask thought could still show a "Message from subagent" row.
- Fixed issue where multitask's voice could post a message to a thought it meant to queue or interrupt.
- Fixed issue where multitask's `tell` showed as a success when its message did not reach the thought.
- Fixed issue where multitask's messages to thoughts were never delivered in auto mode.

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
