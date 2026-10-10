# The README demo

`../demo.gif` is drawn from `scene.html`, a recreation of the Claude desktop app's Code tab (dark theme) showing the three mods: thread-chat's sections, picker, threads menu and thread view, multitask's thought dot, and react's reaction. All its content is made up.

## Regenerate

Needs Node 18 or later and a local Chrome or Edge (set `CHROME_PATH` if it is somewhere unusual).

```
cd docs/demo
npm ci
npm run build
```

`build` runs three steps, which also run alone:

- `npm run fonts` copies the desktop app's font, Anthropic Sans, from its install into `fonts/` (set `CLAUDE_APP_DIR` to the app's folder if it is not found). The font is optional and stays local: it is the app's, so `fonts/` is git-ignored and never committed. Without it a system font stands in and the text sets a little differently.
- `npm run frames` renders every 50 ms of the scene to `frames/` at 880x560.
- `npm run encode` writes `../demo.gif`: one palette, unchanged pixels transparent, and identical frames merged into one longer frame.

`frames/`, `snaps/` and `node_modules/` are generated and git-ignored too.

## Change it

The storyboard is the data at the top of the script in `scene.html`: the messages and when they appear (`MSGS`), the picked thread (`PICKS`), the picker's menu (`MENU`), the threads menu (`COG`), when the thread view's pane is open (`PANE`), its filter (`FILTER`), the thought's notes and end, and the cursor's path. Every state is a function of the time, so to check a moment without rendering it all, open `scene.html?t=6800` in a browser, open `scene.html?play` to watch it loop, or run `npm run snap -- 6800 12000` for stills in `snaps/`.
