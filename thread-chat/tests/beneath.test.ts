import type { On } from 'claude-code'
import { expect, mock, test } from 'claude-code/testing'
import type { Engine } from 'claude-code/testing'

// What a mod beneath thread-chat draws for the person's message stays whole round its
// tags: react floats its reaction over the message's row, beside the message, so its
// reaction and thread-chat's tags never stack as two rows above the bubble.

// The test stands in for what is beneath the plugin: another mod that draws the person's
// message (the engine's drawing, here its text) with a mark floating over the row's
// bottom-right corner, as react does on the desktop.
function engine(on: On) {
  mock.store(on, {})
  on('session.id', () => ({ value: 'session-1' }))
  on('session.start', ($, e) => ({ cwd: e.cwd }))
  on('prompt.submit', ($, e) => ({ text: e.text }))
  on('tool.register', ($, e) => ({ value: { tool: `mcp__thread-chat__${e.name}` } }))
  on('command.register', ($, e) => ({ value: { command: e.name } }))
  on('ui.render', ($, e) => {
    if (e.component !== 'UserMessage') return { type: 'engine', ref: 0 }
    const { Box, Text } = $.ui.resolve(e)
    const mark = Box({ position: 'absolute', right: 1, bottom: 1, children: [Text({ children: ['👍'] })] })
    return Box({ flexDirection: 'column', children: [Text({ children: [e.props.text] }), mark] })
  })
  on('ui.message', () => ({}))
  on('turn.complete', () => ({ text: '' }))
  on('session.messages', () => ({ value: [] }))
}

const say = (text: string) => ({ text, origin: { kind: 'composer' as const }, wait: false })
const flipThreads = ($: Engine) =>
  $.command.run({ command: 'threads', args: '', origin: { kind: 'composer' }, presentation: {} as never })
const userRow = (text: string) =>
  ({ component: 'UserMessage', props: { text, origin: { kind: 'composer' }, isExpanded: false } }) as const

// The props the engine refuses on a box that holds its drawing of the message: a
// drawing with one is refused whole, and the engine's drawn alone.
const CONCEALING = ['display', 'overflow', 'position', 'width', 'height', 'minWidth', 'minHeight', 'top', 'left', 'right', 'bottom']

type Drawn = { type: string; props?: Record<string, unknown>; children?: unknown[] }
const isDrawn = (node: unknown): node is Drawn => typeof node === 'object' && node !== null

test("a mark a mod beneath floats over the person's message stays with it, thread tags above, nothing refused round it", async ($, on) => {
  engine(on)
  await flipThreads($)
  await $.prompt.submit(say('# design\nthe pills are tall'))

  // A message in a thread (tags above it) and one in none (a row kept for "+ thread").
  for (const text of ['# design\nthe pills are tall', 'and one more thing']) {
    const row = await $.ui.mount({ plugin: 'thread-chat', surface: 'desktop', ...userRow(text) })
    const tree = (await row.drawn()) as Drawn
    const parts = (tree.children ?? []).filter(isDrawn)
    // the drawing beneath comes last, the message then the floating mark, as it was drawn
    const beneath = parts.at(-1)
    const [message, mark] = (beneath?.children ?? []).filter(isDrawn)
    expect({ text, message: message?.type, mark: mark?.props }).toEqual({
      text,
      message: 'Text',
      mark: { position: 'absolute', right: 1, bottom: 1 },
    })
    // thread-chat's row (tags, or the room for "+ thread") is the one row above it
    expect({ text, rowsAbove: parts.length - 1 }).toEqual({ text, rowsAbove: 1 })
    // and no box from the top down to that drawing carries a prop the engine refuses
    expect([tree, beneath].flatMap(box => CONCEALING.filter(prop => box?.props?.[prop] !== undefined))).toEqual([])
    await row.unmount()
  }
})
