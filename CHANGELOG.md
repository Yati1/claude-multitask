# Changelog

Notable changes to the thread-chat and multitask mods. The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/). Both mods share one version.

## Unreleased

### Added

- Added a picker to thread-chat's tags and `+ thread` to move a message or part to another thread.
- Added a thread view to thread-chat (`/thread-view` or `view`) with every message of picked threads.
- Added a hover highlight to thread-chat's thread tags and pills in the desktop app.
- Added the `voiceEffort` setting to multitask to set how hard the voice thinks (`low` by default).

### Changed

- Changed thread-chat to send unheaded messages to the sole picked thread, marked with an arrow.
- Changed thread-chat to put a reply to selected text in that text's thread.
- Changed thread-chat to send a heading that runs on past a thread's name to it, the rest as text.
- Changed thread-chat's band to stay on one row in the desktop app and not shift on hover.
- Changed multitask's band to show counts of running thoughts and queued messages.
- Changed multitask to give the voice thoughts' latest progress with your messages, not note by note.
- Changed multitask's Thoughts pane to list running thoughts first and fold the rest to one line.
- Changed the voice in multitask to speak as one mind and keep acknowledgements to a few words.

### Fixed

- Fixed issue where filtering in thread-chat hid every section of a reply after the first.
- Fixed issue where thread-chat's filter hid the latest reply's unthreaded text in the desktop app.
- Fixed issue where thread-chat lost its threads when a session was rewound or forked.
- Fixed issue where thread-chat's agent missed merges and agent-threads switch changes mid-session.
- Fixed issue where multitask's voice kept its old role when Multitask was switched mid-session.
- Fixed issue where multitask's thoughts were refused at start in auto mode.
- Fixed issue where a second interrupt to a multitask thought did not cut its current work.
- Fixed issue where multitask left stray chat rows when the voice stayed quiet or a thought finished.
- Fixed issue where hidden background agents could start multitask thoughts or thread-chat threads.
