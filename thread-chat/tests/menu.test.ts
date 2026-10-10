import type { On } from 'claude-code'
import { expect, mock, test } from 'claude-code/testing'
import type { Engine } from 'claude-code/testing'

// The test stands in for the engine beneath the plugin.
function engine(on: On) {
  mock.store(on, {})
  on('session.id', () => ({ value: 'session-1' }))
  on('session.start', ($, e) => ({ cwd: e.cwd }))
  on('prompt.submit', ($, e) => ({ text: e.text }))
  on('tool.register', ($, e) => ({ value: { tool: `mcp__thread-chat__${e.name}` } }))
  on('command.register', ($, e) => ({ value: { command: e.name } }))
  on('ui.render', () => ({ type: 'engine', ref: 0 }))
  on('ui.message', () => ({}))
  on('turn.complete', () => ({ text: '' }))
}

const BAND = {
  component: 'AbovePrompt',
  props: {
    hasSurvey: false,
    isWorking: false,
    maxRows: 10,
    bodyColumns: 100,
    scroll: { offset: 0, bodyRows: 10 },
    view: {},
  },
} as const

// The row below the input that holds the mode and model.
const MODE = { component: 'SessionMode', props: { modes: [] } } as const

// Thread-chat's menu in the band, and its switches: threads on in this chat, whether
// the agent may start them, and whether the chat is filtered to the picked thread.
const MENU = 'threads'
const THREADS_SWITCH = 'threads-on'
const AGENT_SWITCH = 'agent-threads'
const FILTER_SWITCH = 'filter-chat'
// The menu's row that opens the thread view, while threads are on.
const VIEW = 'thread-view'

const TOOL = 'mcp__thread-chat__create_thread'

const say = (text: string) => ({ text, origin: { kind: 'composer' as const }, wait: false })

const flipThreads = ($: Engine) =>
  $.command.run({ command: 'threads', args: '', origin: { kind: 'composer' }, presentation: {} as never })

type Drawn = { type?: string; props?: Record<string, unknown>; hover?: unknown; children?: unknown[] }

// The first element of a drawn tree keyed `key`, outermost first.
function keyedIn(node: unknown, key: string): Drawn | undefined {
  if (typeof node !== 'object' || node === null) return undefined
  const n = node as Drawn
  if (n.props?.key === key) return n
  for (const child of n.children ?? []) {
    const hit = keyedIn(child, key)
    if (hit !== undefined) return hit
  }
  return undefined
}

// The pictures under `node`, by alt.
function picturesIn(node: unknown): string[] {
  if (typeof node !== 'object' || node === null) return []
  const n = node as Drawn
  return n.type === 'Svg' ? [String(n.props?.alt)] : (n.children ?? []).flatMap(picturesIn)
}

// The desktop menu's switches as drawn: each one's slide switch, by its picture's alt,
// in the menu after its caret.
const switchesOf = async (band: { drawn: () => Promise<unknown> }) =>
  picturesIn(keyedIn(await band.drawn(), MENU)).filter(alt => alt !== 'menu')

// A press on a slide switch's hit area, as a click on it.
const clickSwitch = (band: { pointer: (p: never) => Promise<unknown> }, key: string) =>
  band.pointer({ type: 'down', x: 1, y: 0, button: 'left', in: `switch:${key}` } as never)

test('the desktop draws a Threads button like its Select, its switches in a card the pointer reveals; nothing below the input', async ($, on) => {
  engine(on)
  await $.session.start({ cwd: '.', surface: 'desktop', isInteractive: true })
  const band = await $.ui.mount({ plugin: 'thread-chat', surface: 'desktop', ...BAND })

  // the button: a keyed Box, one line high, with the Select's ring (stronger under the
  // pointer), fill, padding and caret, reading Threads
  const button = keyedIn(await band.drawn(), MENU)
  expect(button?.type).toBe('Box')
  expect(button?.props).toMatchObject({
    height: 1,
    paddingX: 0.7,
    paddingY: 0,
    borderStyle: 'single',
    backgroundColor: 'rgba(255,255,255,0.05)',
  })
  expect(button?.hover).toEqual({ borderColor: 'promptBorder' })
  expect(await band.find({ type: 'Text', text: 'Threads' })).toBeDefined()
  const caret = await band.find({ type: 'Svg' })
  expect(caret?.props).toMatchObject({ alt: 'menu', width: 20, height: 14 })
  expect(String(caret?.props.source)).toContain('d="M4 6l4 4 4-4"')

  // the card: out of the flow, shown only under the pointer, so the desktop lifts it;
  // a row per switch, its label a Button and its slide switch a picture with a hit area,
  // the rows a quarter line apart, so they sit as close as the Select's options
  const card = (button?.children as Drawn[]).find(n => n.type === 'Box' && n.props?.display === 'none')
  expect(card?.props).toMatchObject({ position: 'absolute', display: 'none', flexDirection: 'column', rowGap: 0.5 })
  expect(card?.hover).toEqual({ display: 'flex' })
  expect((await band.find({ key: THREADS_SWITCH }))?.props).toMatchObject({ label: 'On in this chat', plain: true })
  expect(await switchesOf(band)).toEqual(['On in this chat: off'])
  const hit = await band.find({ key: `switch:${THREADS_SWITCH}` })
  expect(hit?.type).toBe('Client')
  expect(String(hit?.props.module)).toEndWith('switch.tsx')
  expect(hit?.props.props).toEqual({ isOn: false })
  expect(await band.find({ key: AGENT_SWITCH })).toBeUndefined()
  expect(await band.find({ key: FILTER_SWITCH })).toBeUndefined()
  expect(await band.find({ key: VIEW })).toBeUndefined()

  const mode = await $.ui.mount({ plugin: 'thread-chat', surface: 'desktop', ...MODE })
  expect(await mode.drawn()).toEqual({ type: 'engine', ref: 0 })
})

test("the desktop menu's labels and slide switches flip threads, the agent switch and the filter", async ($, on) => {
  engine(on)
  await $.session.start({ cwd: '.', surface: 'desktop', isInteractive: true })
  const band = await $.ui.mount({ plugin: 'thread-chat', surface: 'desktop', ...BAND })
  expect((await $.tool.call({ tool: TOOL, tool_use_id: 't1', name: 'ideas' })).deny).toContain('off')

  // On in this chat's label turns threads on, as /threads does, and the agent's switch
  // and the filter's (off) join it, then the row that opens the thread view, in the card
  await band.press({ key: THREADS_SWITCH })
  await band.redraw()
  expect(await switchesOf(band)).toEqual(['On in this chat: on', 'Agent may start threads: off', 'Filter the chat: off'])
  expect(keyedIn(keyedIn(await band.drawn(), MENU), VIEW)).toMatchObject({ type: 'Button', props: { label: 'Open thread view', plain: true } })
  expect(await band.find({ text: /start a thread with # name/ })).toBeDefined()
  expect((await $.tool.call({ tool: TOOL, tool_use_id: 't2', name: 'ideas' })).deny).toBeDefined()

  // the agent's slide switch lets the agent start threads, and back
  await clickSwitch(band, AGENT_SWITCH)
  await band.redraw()
  expect(await switchesOf(band)).toEqual(['On in this chat: on', 'Agent may start threads: on', 'Filter the chat: off'])
  expect((await $.tool.call({ tool: TOOL, tool_use_id: 't3', name: 'ideas' })).deny).toBeUndefined()
  await band.press({ key: AGENT_SWITCH })
  await band.redraw()
  expect(await switchesOf(band)).toEqual(['On in this chat: on', 'Agent may start threads: off', 'Filter the chat: off'])

  // the filter's label and slide switch flip it, a plain Button as the others are
  expect((await band.find({ key: FILTER_SWITCH }))?.props).toMatchObject({ label: 'Filter the chat', plain: true })
  await clickSwitch(band, FILTER_SWITCH)
  await band.redraw()
  expect(await switchesOf(band)).toEqual(['On in this chat: on', 'Agent may start threads: off', 'Filter the chat: on'])
  await band.press({ key: FILTER_SWITCH })
  await band.redraw()
  expect(await switchesOf(band)).toEqual(['On in this chat: on', 'Agent may start threads: off', 'Filter the chat: off'])

  // On in this chat's slide switch turns them off, and the view's row goes
  await clickSwitch(band, THREADS_SWITCH)
  await band.redraw()
  expect(await switchesOf(band)).toEqual(['On in this chat: off'])
  expect(await band.find({ key: VIEW })).toBeUndefined()
  const reply = await $.command.run({ command: 'merge-threads', args: 'a into b', origin: { kind: 'composer' }, presentation: {} as never })
  expect(reply.text).toBe('Threads are off in this chat; /threads turns them on.')
})

test('the terminal opens and shuts the menu with a press on Threads, its switches beside it', async ($, on) => {
  engine(on)
  await $.session.start({ cwd: '.', surface: 'terminal', isInteractive: true })
  const band = await $.ui.mount({ plugin: 'thread-chat', surface: 'terminal', ...BAND })
  const labelOf = async (key: string) => (await band.find({ key }))?.props.label

  // shut, the button alone
  expect(await band.find({ key: MENU })).toMatchObject({ type: 'Button', props: { label: 'Threads ▾' } })
  expect(await band.find({ key: THREADS_SWITCH })).toBeUndefined()

  // open, a switch per row beside it, off
  await band.press({ key: MENU })
  await band.redraw()
  expect(await labelOf(MENU)).toBe('Threads ▴')
  expect(await band.find({ text: 'On in this chat' })).toBeDefined()
  expect(await labelOf(THREADS_SWITCH)).toBe('(● )')
  expect(await band.find({ key: VIEW })).toBeUndefined()

  // a press flips one, and threads on bring the agent's and the filter's (off), then the
  // thread view's row
  await band.press({ key: THREADS_SWITCH })
  await band.redraw()
  expect(await labelOf(THREADS_SWITCH)).toBe('( ●)')
  expect(await labelOf(AGENT_SWITCH)).toBe('(● )')
  expect(await band.find({ text: 'Filter the chat' })).toBeDefined()
  expect(await labelOf(FILTER_SWITCH)).toBe('(● )')
  expect(await labelOf(VIEW)).toBe('Open thread view')
  await band.press({ key: FILTER_SWITCH })
  await band.redraw()
  expect(await labelOf(FILTER_SWITCH)).toBe('( ●)')
  await band.press({ key: AGENT_SWITCH })
  await band.redraw()
  expect(await labelOf(AGENT_SWITCH)).toBe('( ●)')
  expect((await $.tool.call({ tool: TOOL, tool_use_id: 't1', name: 'ideas' })).deny).toBeUndefined()

  // Threads again shuts it
  await band.press({ key: MENU })
  await band.redraw()
  expect(await labelOf(MENU)).toBe('Threads ▾')
  expect(await band.find({ key: THREADS_SWITCH })).toBeUndefined()
  expect(await band.find({ key: FILTER_SWITCH })).toBeUndefined()
  expect(await band.find({ key: VIEW })).toBeUndefined()
})

test('the mobile app, which draws no menu, shows the thread picker alone while threads are on', async ($, on) => {
  engine(on)
  await $.session.start({ cwd: '.', surface: 'mobile', isInteractive: true })
  const band = await $.ui.mount({ plugin: 'thread-chat', surface: 'mobile', ...BAND })
  expect(await band.drawn()).toEqual({ type: 'engine', ref: 0 })
  await flipThreads($)
  await $.prompt.submit(say('# design\na'))
  await band.redraw()
  expect(await band.find({ key: MENU })).toBeUndefined()
  expect(await band.find({ key: FILTER_SWITCH })).toBeUndefined()
  expect(await band.find({ key: VIEW })).toBeUndefined()
  expect(await band.find({ key: 'thread-picker' })).toBeDefined()
})
