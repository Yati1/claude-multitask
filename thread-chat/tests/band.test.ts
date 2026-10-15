import type { On } from 'claude-code'
import { expect, mock, test } from 'claude-code/testing'
import type { Engine } from 'claude-code/testing'

// The test stands in for the engine beneath the plugin, and records the panes opened.
function engine(on: On) {
  const opened: string[] = []
  // the welcome line dismissed: welcome.test.ts covers it
  mock.store(on, { welcome: ['thread-chat'] })
  on('session.id', () => ({ value: 'session-1' }))
  on('session.start', ($, e) => ({ cwd: e.cwd }))
  on('prompt.submit', ($, e) => ({ text: e.text }))
  on('tool.register', ($, e) => ({ value: { tool: `mcp__thread-chat__${e.name}` } }))
  on('command.register', ($, e) => ({ value: { command: e.name } }))
  on('ui.render', () => ({ type: 'engine', ref: 0 }))
  on('ui.message', () => ({}))
  on('ui.open', ($, e) => {
    opened.push(e.id)
    return { value: { isPlaced: true } }
  })
  on('ui.close', () => ({ value: undefined }))
  on('turn.complete', () => ({ text: '' }))
  return { opened }
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

// Thread-chat's buttons in the band, after the thread picker: `+` starts a thread, `☰`
// opens the thread view. On the desktop each has a hit area keyed `band:` and its key.
const NEW = 'threads:new'
const VIEW = 'thread-view'
const NAME_FIELD = 'threads:name'
const NAME_CANCEL = 'threads:name-cancel'

const say = (text: string) => ({ text, origin: { kind: 'composer' as const }, wait: false })

const threads = ($: Engine, args: string) =>
  $.command.run({ command: 'threads', args, origin: { kind: 'composer' }, presentation: {} as never })

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

// A click on a desktop band button's hit area.
const click = (band: { pointer: (p: never) => Promise<unknown> }, key: string) =>
  band.pointer({ type: 'down', x: 1, y: 0, button: 'left', in: `band:${key}` } as never)

test('the desktop draws `+` and `☰` after the picker, each like its Select with a hit area; no menu; nothing below the input', async ($, on) => {
  engine(on)
  await $.session.start({ cwd: '.', surface: 'desktop', isInteractive: true })
  const band = await $.ui.mount({ plugin: 'thread-chat', surface: 'desktop', ...BAND })
  expect(await band.drawn()).toEqual({ type: 'engine', ref: 0 })
  await threads($, 'on')
  await band.redraw()

  for (const [key, label, path] of [
    [NEW, 'New thread', 'M8 3v10M3 8h10'],
    [VIEW, 'Open thread view', 'M2.5 4h11M2.5 8h11M2.5 12h11'],
  ] as const) {
    // a keyed Box, one line high, with the Select's ring (stronger under the pointer) and
    // fill; its icon in a Box that pads it, under a hit area; its label in a card the
    // pointer reveals
    const button = keyedIn(await band.drawn(), key)
    expect(button?.type).toBe('Box')
    expect(button?.props).toMatchObject({
      height: 1,
      paddingY: 0,
      paddingLeft: 0,
      paddingRight: 0,
      borderStyle: 'single',
      backgroundColor: 'rgba(255,255,255,0.05)',
    })
    expect(button?.hover).toEqual({ borderColor: 'promptBorder' })
    expect(picturesIn(button)).toEqual([label])
    const icon = (await band.findAll({ type: 'Svg' })).find(svg => svg.props.alt === label)
    expect(icon?.props).toMatchObject({ width: 14, height: 14 })
    expect(String(icon?.props.source)).toContain(`d="${path}"`)
    const hit = await band.find({ key: `band:${key}` })
    expect(hit?.type).toBe('Client')
    expect(String(hit?.props.module)).toEndWith('switch.tsx')
    const card = (button?.children as Drawn[]).find(n => n.type === 'Box' && n.props?.display === 'none')
    expect(card?.props).toMatchObject({ position: 'absolute', display: 'none' })
    expect(card?.hover).toEqual({ display: 'flex' })
    expect(await band.find({ type: 'Text', text: label })).toBeDefined()
  }

  // no cog, no menu, no switches
  expect(await band.find({ key: 'threads' })).toBeUndefined()
  expect(picturesIn(await band.drawn())).toEqual(['New thread', 'Open thread view'])

  const mode = await $.ui.mount({ plugin: 'thread-chat', surface: 'desktop', ...MODE })
  expect(await mode.drawn()).toEqual({ type: 'engine', ref: 0 })
})

test("the desktop's `+` swaps for a field that starts a thread and picks it; its `☰` opens the thread view", async ($, on) => {
  const { opened } = engine(on)
  await $.session.start({ cwd: '.', surface: 'desktop', isInteractive: true })
  await threads($, 'on')
  const band = await $.ui.mount({ plugin: 'thread-chat', surface: 'desktop', ...BAND })

  await click(band, VIEW)
  expect(opened).toEqual([VIEW])

  await click(band, NEW)
  await band.redraw()
  expect((await band.find({ key: NAME_FIELD }))?.props.autoFocus).toBe(true)
  expect(await band.find({ key: NEW })).toBeUndefined()
  expect(await band.find({ key: VIEW })).toBeDefined()
  await band.input({ key: NAME_FIELD, text: 'ideas' })
  await band.redraw()
  expect(await band.find({ key: NAME_FIELD })).toBeUndefined()
  expect(await band.find({ key: NEW })).toBeDefined()
  expect((await band.find({ key: 'thread-picker' }))?.props.value).toBe('thread:ideas')
})

test('the terminal draws `+` and `☰` as Buttons; `+` swaps for a field, `×` goes back, `☰` opens the view', async ($, on) => {
  const { opened } = engine(on)
  await $.session.start({ cwd: '.', surface: 'terminal', isInteractive: true })
  const band = await $.ui.mount({ plugin: 'thread-chat', surface: 'terminal', ...BAND })

  // off, nothing: the band is the engine's alone
  expect(await band.drawn()).toEqual({ type: 'engine', ref: 0 })
  await threads($, 'on')
  await band.redraw()
  expect(await band.find({ key: NEW })).toMatchObject({ type: 'Button', props: { label: '+', variant: 'secondary' } })
  expect(await band.find({ key: VIEW })).toMatchObject({ type: 'Button', props: { label: '☰', variant: 'secondary' } })
  expect(await band.find({ key: 'threads' })).toBeUndefined()

  await band.press({ key: VIEW })
  expect(opened).toEqual([VIEW])

  await band.press({ key: NEW })
  await band.redraw()
  expect((await band.find({ key: NAME_FIELD }))?.props.autoFocus).toBe(true)
  expect(await band.find({ key: NEW })).toBeUndefined()
  await band.press({ key: NAME_CANCEL })
  await band.redraw()
  expect(await band.find({ key: NAME_FIELD })).toBeUndefined()
  expect(await band.find({ key: NEW })).toBeDefined()

  // threads off shut the field: on again, the `+` is back
  await band.press({ key: NEW })
  await threads($, 'off')
  await band.redraw()
  expect(await band.drawn()).toEqual({ type: 'engine', ref: 0 })
  await threads($, 'on')
  await band.redraw()
  expect(await band.find({ key: NAME_FIELD })).toBeUndefined()
  expect(await band.find({ key: NEW })).toBeDefined()
})

test('ctrl+x tab lands on the thread picker, ahead of what another mod drew before it, save while the field for a new name is open', async ($, on) => {
  // another mod's line drawn before thread-chat's controls, as a welcome line with its Dismiss is
  on('ui.render', { component: 'AbovePrompt' }, ($, e) => {
    const { Button } = $.ui.resolve(e)
    return Button({ key: 'dismiss', label: 'Dismiss', onPress: () => {} })
  })
  engine(on)
  await $.session.start({ cwd: '.', surface: 'terminal', isInteractive: true })
  await threads($, 'on')
  const band = await $.ui.mount({ plugin: 'thread-chat', surface: 'terminal', ...BAND })
  await band.press({ key: NEW })
  await band.input({ key: NAME_FIELD, text: 'ideas' })
  await band.redraw()
  const autoFocused = async () => (await band.findAll({})).filter(n => n.props.autoFocus === true).map(n => n.key)

  // at rest, the picker alone takes the focus, the other mod's Dismiss drawn before it
  expect(await band.find({ key: 'dismiss' })).toBeDefined()
  expect(await autoFocused()).toEqual(['thread-picker'])
  // the field for a new name takes it while open, the picker giving it up
  await band.press({ key: NEW })
  await band.redraw()
  expect(await autoFocused()).toEqual([NAME_FIELD])
  // and the picker takes it back once the field shuts
  await band.press({ key: NAME_CANCEL })
  await band.redraw()
  expect(await autoFocused()).toEqual(['thread-picker'])
})

test('the mobile app, which draws no field or pane, shows the thread picker alone while threads are on', async ($, on) => {
  engine(on)
  await $.session.start({ cwd: '.', surface: 'mobile', isInteractive: true })
  const band = await $.ui.mount({ plugin: 'thread-chat', surface: 'mobile', ...BAND })
  expect(await band.drawn()).toEqual({ type: 'engine', ref: 0 })
  await threads($, 'on')
  await $.prompt.submit(say('# design\na'))
  await band.redraw()
  expect(await band.find({ key: NEW })).toBeUndefined()
  expect(await band.find({ key: VIEW })).toBeUndefined()
  expect(await band.find({ key: 'thread-picker' })).toBeDefined()
  // its list holds the threads and No thread; managing them is /threads manage's
  await band.press({ key: 'picker:open' })
  await band.redraw()
  expect(await band.find({ key: 'picker:thread:design' })).toBeDefined()
  expect(await band.find({ key: 'picker:none' })).toBeDefined()
  expect(await band.find({ key: 'threads:manage' })).toBeUndefined()
})
