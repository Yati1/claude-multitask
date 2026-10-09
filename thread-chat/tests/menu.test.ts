import type { On, RenderElement } from 'claude-code'
import { expect, mock, test } from 'claude-code/testing'
import type { Engine } from 'claude-code/testing'

import { MENU, MENU_BUTTON, SWITCHES, drawBand, drawMenuButton } from '../hooks/menu'

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

// The other two mods, multitask and react, drawn beneath through the same band and
// button as they draw them: each its switch and its name, multitask its `thoughts` too,
// their menu open as `isOpen` says.
function otherMods(on: On, isOpen: boolean) {
  on('ui.render', { component: 'AbovePrompt' }, async ($, e) => {
    const ui = $.ui.resolve(e)
    const parts = (name: string, rank: number, word: string, label: string, control?: RenderElement) => ({
      ui,
      surface: e.surface,
      name: { rank, word },
      controls: control === undefined ? undefined : { rank, name, element: control },
      switches: [{ rank, key: `mods-menu:${name}`, label, isOn: false, onPress: () => undefined }],
      isOpen: async () => isOpen,
    })
    const react = await drawBand({ type: 'engine', ref: 0 }, parts('react', 30, 'emoji', 'Reactions'))
    return drawBand(
      react,
      parts('multitask', 20, 'tasks', 'Multitask', ui.Button({ key: 'open-thoughts', label: 'thoughts', onPress: () => undefined })),
    )
  })
  on('ui.render', { component: 'SessionMode' }, async ($, e, next) => {
    if (e.surface !== 'desktop') return next(e)
    const ui = $.ui.resolve(e)
    const react = drawMenuButton({ type: 'engine', ref: 0 }, ui, { rank: 30, word: 'emoji' }, isOpen)
    return drawMenuButton(react, ui, { rank: 20, word: 'tasks' }, isOpen)
  })
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

// The row below the input that holds the mode labels, and on the desktop the button.
const MODE = { component: 'SessionMode', props: { modes: [] } } as const

const say = (text: string) => ({ text, origin: { kind: 'composer' as const }, wait: false })

type Drawn = { type: string; props?: Record<string, unknown>; hover?: Record<string, unknown>; children?: unknown[] }

// The path from the root to the first element `is` holds, outermost first.
function pathTo(node: unknown, is: (n: Drawn) => boolean): Drawn[] | undefined {
  if (typeof node !== 'object' || node === null) return undefined
  const n = node as Drawn
  if (is(n)) return [n]
  for (const child of n.children ?? []) {
    const below = pathTo(child, is)
    if (below !== undefined) return [n, ...below]
  }
  return undefined
}

// The keys of the menu's switches, in the order drawn.
async function switchKeys(band: { findAll: (query: { type: string }) => Promise<{ key: string | undefined }[]> }) {
  return (await band.findAll({ type: 'Button' })).map(b => b.key ?? '').filter(key => key.startsWith('mods-menu:'))
}

// The button below the input on the desktop, pressed.
async function pressButton($: Engine) {
  const mode = await $.ui.mount({ plugin: 'thread-chat', surface: 'desktop', ...MODE })
  await mode.press({ key: MENU_BUTTON })
  await mode.unmount()
}

test('alone on the desktop, thread-chat draws one button below the input, named for it, and the band has none', async ($, on) => {
  engine(on)
  const mode = await $.ui.mount({ plugin: 'thread-chat', surface: 'desktop', ...MODE })
  const buttons = await mode.findAll({ key: MENU_BUTTON })
  expect(buttons).toHaveLength(1)
  expect(buttons[0]?.props.label).toBe('Threads')
  const band = await $.ui.mount({ plugin: 'thread-chat', surface: 'desktop', ...BAND })
  expect(await band.findAll({ key: MENU_BUTTON })).toHaveLength(0)
  expect(await band.findAll({ key: MENU })).toHaveLength(0)
  expect(await switchKeys(band)).toEqual([])
})

test('on the desktop the button opens the menu at the right end of the band, and a second press closes it', async ($, on) => {
  engine(on)
  const mode = await $.ui.mount({ plugin: 'thread-chat', surface: 'desktop', ...MODE })
  const band = await $.ui.mount({ plugin: 'thread-chat', surface: 'desktop', ...BAND })

  await mode.press({ key: MENU_BUTTON })
  await band.redraw()
  const tree = await band.drawn()
  const menu = pathTo(tree, n => n.props?.key === MENU)
  expect(menu?.length).toBe(2)
  expect((tree as Drawn).children?.at(-1)).toBe(menu?.[1])
  // a card in the band, there for as long as it is open: no pointer reveals it
  expect(menu?.[1]?.props?.position).toBeUndefined()
  expect(menu?.[1]?.hover).toBeUndefined()
  expect(await switchKeys(band)).toEqual(['mods-menu:threads'])
  await mode.redraw()
  expect((await mode.find({ key: MENU_BUTTON }))?.props.variant).toBe('primary')

  await mode.press({ key: MENU_BUTTON })
  await band.redraw()
  expect(await band.findAll({ key: MENU })).toHaveLength(0)
  await mode.redraw()
  expect((await mode.find({ key: MENU_BUTTON }))?.props.variant).toBe('secondary')
})

test('on the desktop, picking a switch closes the menu', async ($, on) => {
  engine(on)
  await $.session.start({ cwd: '.', surface: 'desktop', isInteractive: true })
  await pressButton($)
  const band = await $.ui.mount({ plugin: 'thread-chat', surface: 'desktop', ...BAND })
  await band.press({ key: 'mods-menu:threads' })
  await band.redraw()
  expect(await band.findAll({ key: MENU })).toHaveLength(0)
  expect(await band.find({ text: /start a thread with # name/ })).toBeDefined()
  await pressButton($)
  await band.redraw()
  expect((await band.find({ key: 'mods-menu:threads' }))?.props.label).toBe('on')
})

test('with the other mods drawn beneath, the button shows once, naming each mod, and the menu holds every switch', async ($, on) => {
  otherMods(on, true)
  engine(on)
  await $.command.run({ command: 'threads', args: '', origin: { kind: 'composer' }, presentation: {} as never })
  await $.prompt.submit(say('# design\na'))
  const all = ['mods-menu:threads', 'mods-menu:agent-threads', 'mods-menu:multitask', 'mods-menu:react']

  const mode = await $.ui.mount({ plugin: 'thread-chat', surface: 'desktop', ...MODE })
  const buttons = await mode.findAll({ key: MENU_BUTTON })
  expect(buttons).toHaveLength(1)
  expect(buttons[0]?.props.label).toBe('Threads, tasks & emoji')
  await mode.unmount()
  const terminalMode = await $.ui.mount({ plugin: 'thread-chat', surface: 'terminal', ...MODE })
  expect(await terminalMode.findAll({ key: MENU_BUTTON })).toHaveLength(0)
  await terminalMode.unmount()

  for (const surface of ['desktop', 'terminal'] as const) {
    const band = await $.ui.mount({ plugin: 'thread-chat', surface, ...BAND })
    const tree = await band.drawn()
    expect(await band.findAll({ key: MENU })).toHaveLength(1)
    // the button is in the band off the desktop alone
    const inBand = await band.findAll({ key: MENU_BUTTON })
    expect(inBand).toHaveLength(surface === 'desktop' ? 0 : 1)
    if (surface === 'terminal') expect(inBand[0]?.props.label).toBe('Threads, tasks & emoji')
    expect(await switchKeys(band)).toEqual(all)
    // the controls in one row, the threads first, the menu at the row's end
    const pill = pathTo(tree, n => n.props?.key === 'thread:design')
    const thoughts = pathTo(tree, n => n.props?.key === 'open-thoughts')
    const menu = pathTo(tree, n => n.props?.key === MENU)
    expect(pill?.[0]).toBe(tree as unknown as Drawn)
    expect(thoughts?.[1]).toBe(pill?.[1])
    expect(menu?.length).toBe(2)
    expect((tree as Drawn).children?.at(-1)).toBe(menu?.[1])
    await band.unmount()
  }
})

test('off the desktop, the button opens and closes the menu in the band', async ($, on) => {
  engine(on)
  const band = await $.ui.mount({ plugin: 'thread-chat', surface: 'terminal', ...BAND })
  expect((await band.find({ key: MENU_BUTTON }))?.props.label).toBe('Threads')
  const shown = async () => (await band.find({ key: SWITCHES }))?.props.display
  expect(await shown()).toBe('none')
  await band.press({ key: MENU_BUTTON })
  await band.redraw()
  expect(await shown()).toBe('flex')
  await band.press({ key: MENU_BUTTON })
  await band.redraw()
  expect(await shown()).toBe('none')
})

test('the threads switch in the menu turns threads on and off, as /threads does', async ($, on) => {
  engine(on)
  await $.session.start({ cwd: '.', surface: 'desktop', isInteractive: true })
  for (const surface of ['desktop', 'terminal'] as const) {
    // on the desktop the menu is drawn while open, and a switch picked closes it
    const open = async () => {
      if (surface === 'desktop') await pressButton($)
    }
    await open()
    const band = await $.ui.mount({ plugin: 'thread-chat', surface, ...BAND })
    expect(await band.find({ text: /start a thread/ })).toBeUndefined()
    await band.press({ key: 'mods-menu:threads' })
    await open()
    await band.redraw()
    expect((await band.find({ key: 'mods-menu:threads' }))?.props.label).toBe('on')
    expect(await band.find({ text: /start a thread with # name/ })).toBeDefined()
    expect((await band.find({ key: 'mods-menu:agent-threads' }))?.props.label).toBe('off')
    await band.press({ key: 'mods-menu:threads' })
    await open()
    await band.redraw()
    expect((await band.find({ key: 'mods-menu:threads' }))?.props.label).toBe('off')
    expect(await band.find({ text: /start a thread/ })).toBeUndefined()
    expect(await band.find({ key: 'mods-menu:agent-threads' })).toBeUndefined()
    await band.unmount()
  }
  const reply = await $.command.run({ command: 'merge-threads', args: 'a into b', origin: { kind: 'composer' }, presentation: {} as never })
  expect(reply.text).toBe('Threads are off in this chat; /threads turns them on.')
})
