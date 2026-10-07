# claude-multitask

Claude Code mods (hooks-module plugins), made primarily for the desktop app's Code tab.

- **thread-chat**: conversation threads. Start or reply to a thread with a `# name` heading in a message. The agent replies under the same headings, and each thread's sections are colour-coded. Pills above the prompt filter the chat by thread. A switch lets the agent start threads itself.
- **multitask**: when switched on, the main session becomes the "voice" that talks with you. It hands all work to background "thoughts", watches their updates and steers them.

Mods need a recent Claude Code build with hooks modules available.

## Install

This repo is a plugin marketplace:

```
claude plugin marketplace add <path or git URL of this repo>
claude plugin install thread-chat@claude-multitask
claude plugin install multitask@claude-multitask
```

When the marketplace is added from a local folder, the plugins are read from that folder: after editing, run `/reload-plugins`.

## Develop

```
claude plugin validate thread-chat
claude plugin test thread-chat
```
