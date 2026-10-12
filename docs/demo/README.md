# The README demo

`../demo.gif` is drawn from `scene.html`, a recreation of the Claude desktop app's Code tab (dark theme) showing the three mods: thread-chat's tagged sections, its band (thread picker, `+`, `☰` and the summary line) and its thread view, opened from a tag's `ᯤ`, multitask's `thoughts` button with a thought's dot, and react's reaction. All its content is made up.

## Regenerate

Needs Node 18 or later and a local Chrome or Edge (set `CHROME_PATH` if it is somewhere unusual).

```
cd docs/demo
npm ci
npm run build
```

`build` runs three steps, which also run alone:

- `npm run fonts` copies the desktop app's font, Anthropic Sans, from its install into `fonts/` (set `CLAUDE_APP_DIR` to the app's folder if it is not found). The font is optional and stays local: it is the app's, so `fonts/` is git-ignored and never committed. Without it a system font stands in and the text sets a little differently.
- `npm run frames` renders every 50 ms of the scene to `frames/` at the size `scene.html` sets, 880x580.
- `npm run encode` writes `../demo.gif` with no tool beyond its npm packages: one 128-colour palette, written once; each frame after the first only the rectangle that changed, its unchanged pixels transparent; and identical frames merged into one longer frame.

`frames/`, `snaps/` and `node_modules/` are generated and git-ignored too.

## Change it

The storyboard is the data at the top of the script in `scene.html`: the messages and when they appear (`MSGS`), the picked thread (`PICKS`), the picker's menu (`MENU`), each thread's summary line (`SUMMARIES`), the tag whose `ᯤ` opens the thread view, with when it is hovered and clicked (`OPEN`), when the thread view's pane is open (`PANE`), its filter (`FILTER`), the thought's blinks, notes and end, and the cursor's path. Every state is a function of the time, so to check a moment without rendering it all, open `scene.html?t=12000` in a browser, open `scene.html?play` to watch it loop, or run `npm run snap -- 12000 21000` for stills in `snaps/`.
