# Why use multitasking and threads

## Why multitasking

The biggest win: working with an agent becomes more like working with a person who can multitask.

In a plain chat the agent does one thing at a time. While it reads, edits and tests, you either wait or interrupt it, so you hold back the next question or idea until it is free.

With multitasking you talk to one **voice**, and its **thoughts** do the work in the background. The voice stays free to talk, so the conversation is more fluid. You don't wait for it to finish working before you say the next thing, or hold messages back while it is busy.

Because your message isn't queued behind work in progress, the agent can ask clarifying questions straight away, so the right work starts sooner. You can ask something new, add a detail or change your mind whenever it occurs to you. The voice passes it to the right piece of work and tells you when something needs you.

## Why threads

A real working session wanders: a bug, a question about something else, an idea for later. In one chat these get mixed up, and an hour later it is hard to find what was said about any one of them.

Threads keep mixed topics apart in one conversation. Start a message with a heading such as `# Deployment` and it goes to that topic's thread. Each thread is colour-coded, you can read one on its own in the thread view, and you can move a message to another thread if it landed in the wrong place. The agent still sees the whole conversation and answers under the same headings.

## Examples

### Multitasking

- **Ask while it works.** You ask for a fix to a failing test. While it is still reading code, you ask what a config option does and get an answer straight away. The fix carries on.
- **Steer mid-task.** Halfway through a rename you remember a constraint: "keep the old name working as an alias." You say it now, and the work changes course. No redo after it finishes.
- **Queue the next job.** While one change runs, you ask for the docs to be updated to match. The agent asks straight away whether that includes the README; you answer, and the docs work starts right then. Both run, and you hear back as each finishes.
- **Hold.** "Don't start anything new until I've tested this." Work already running continues; new work waits for your go.

### Threads

- **One message, two topics.** You write `# Bug` with a bug report, then `# Release` with a question about timing, in the same message. Each gets its own answer in its own section.
- **Find it later.** After an hour across several topics, pick `# Deployment` and open the thread view to see only what was said about deployment.
- **Tidy up.** A question about testing went into the wrong thread. You move it to `# Testing`, where it belongs.

### Both together

- **Fix, question, steer.** You write `# Login bug`: "The login page hangs after a wrong password, please fix it." Work starts. While it runs you write `# Docs`: "What's the quickest way to add a diagram to the README?" The answer comes straight away, in its own thread. Then the fix reports what it found, and you reply under `# Login bug`: "Leave the timeout alone, fix the retry loop instead." The fix changes course. Two topics, no waiting, and each stays readable on its own.
- **Where are we?** With work running in several threads, you ask for a status update. The reply goes thread by thread: what is in progress, what is done, what is waiting on you.
