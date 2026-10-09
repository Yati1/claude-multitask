import type { On, RenderElement } from 'claude-code'
import { expect, mock, test } from 'claude-code/testing'

import { MENU, MENU_BUTTON, SWITCHES, drawBand } from '../hooks/menu'

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

// The other two mods, multitask and react, drawn beneath through the same band as they
// draw it: each its switch, multitask its `thoughts` too.
function otherMods(on: On) {
  on('ui.render', { component: 'AbovePrompt' }, async ($, e) => {
    const ui = $.ui.resolve(e)
    const parts = (name: string, rank: number, label: string, control?: RenderElement) => ({
      ui,
      surface: e.surface,
      controls: control === undefined ? undefined : { rank, name, element: control },
      switches: [{ rank, key: `mods-menu:${name}`, label, isOn: false, onPress: () => undefined }],
      isOpen: async () => false,
      onToggle: () => undefined,
    })
    const react = await drawBand({ type: 'engine', ref: 0 }, parts('react', 30, 'Reactions'))
    return drawBand(
      react,
      parts('multitask', 20, 'Multitask', ui.Button({ key: 'open-thoughts', label: 'thoughts', onPress: () => undefined })),
    )
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

// The keys of the mods menu's switches, in the order drawn.
async function switchKeys(band: { findAll: (query: { type: string }) => Promise<{ key: string | undefined }[]> }) {
  return (await band.findAll({ type: 'Button' })).map(b => b.key ?? '').filter(key => key.startsWith('mods-menu:'))
}

test('alone, thread-chat draws the band with one mods menu holding its switch', async ($, on) => {
  engine(on)
  for (const surface of ['desktop', 'terminal'] as const) {
    const band = await $.ui.mount({ plugin: 'thread-chat', surface, ...BAND })
    expect(await band.findAll({ key: MENU })).toHaveLength(1)
    expect(await band.findAll({ key: MENU_BUTTON })).toHaveLength(1)
    expect(await switchKeys(band)).toEqual(['mods-menu:threads'])
    expect((await band.find({ key: 'mods-menu:threads' }))?.props.label).toBe('off')
    await band.unmount()
  }
})

test('with the other mods drawn beneath, the band still holds one mods menu, every mod its switches in it', async ($, on) => {
  otherMods(on)
  engine(on)
  await $.command.run({ command: 'threads', args: '', origin: { kind: 'composer' }, presentation: {} as never })
  await $.prompt.submit(say('# design\na'))

  for (const surface of ['desktop', 'terminal'] as const) {
    const band = await $.ui.mount({ plugin: 'thread-chat', surface, ...BAND })
    const tree = await band.drawn()
    expect(await band.findAll({ key: MENU })).toHaveLength(1)
    expect(await band.findAll({ key: MENU_BUTTON })).toHaveLength(1)
    expect(await switchKeys(band)).toEqual(['mods-menu:threads', 'mods-menu:agent-threads', 'mods-menu:multitask', 'mods-menu:react'])
    // the controls in one row, the threads first, the menu at the row's end
    const pill = pathTo(tree, n => n.props?.key === 'thread-picker')
    const thoughts = pathTo(tree, n => n.props?.key === 'open-thoughts')
    const menu = pathTo(tree, n => n.props?.key === MENU)
    expect(pill?.[0]).toBe(tree as unknown as Drawn)
    expect(thoughts?.[1]).toBe(pill?.[1])
    expect(menu?.length).toBe(2)
    expect((tree as Drawn).children?.at(-1)).toBe(menu?.[1])
    await band.unmount()
  }
})

test('the mods menu is a card on the desktop the pointer reveals over the band', async ($, on) => {
  engine(on)
  const band = await $.ui.mount({ plugin: 'thread-chat', surface: 'desktop', ...BAND })
  const path = pathTo(await band.drawn(), n => n.props?.key === SWITCHES)
  const [card, list] = (path ?? []).slice(-2)
  expect(path?.at(-3)?.props?.key).toBe(MENU)
  expect(card?.props).toMatchObject({ position: 'absolute', display: 'none' })
  expect(card?.hover).toEqual({ display: 'flex' })
  expect(list?.props?.display).toBeUndefined()
})

test('off the desktop, mods opens and closes the menu in the band', async ($, on) => {
  engine(on)
  const band = await $.ui.mount({ plugin: 'thread-chat', surface: 'terminal', ...BAND })
  const shown = async () => (await band.find({ key: SWITCHES }))?.props.display
  expect(await shown()).toBe('none')
  await band.press({ key: MENU_BUTTON })
  await band.redraw()
  expect(await shown()).toBe('flex')
  await band.press({ key: MENU_BUTTON })
  await band.redraw()
  expect(await shown()).toBe('none')
})

test('the threads switch in the mods menu turns threads on and off, as /threads does', async ($, on) => {
  engine(on)
  await $.session.start({ cwd: '.', surface: 'desktop', isInteractive: true })
  for (const surface of ['desktop', 'terminal'] as const) {
    const band = await $.ui.mount({ plugin: 'thread-chat', surface, ...BAND })
    expect(await band.find({ text: /start a thread/ })).toBeUndefined()
    await band.press({ key: 'mods-menu:threads' })
    await band.redraw()
    expect((await band.find({ key: 'mods-menu:threads' }))?.props.label).toBe('on')
    expect(await band.find({ text: /start a thread with # name/ })).toBeDefined()
    expect((await band.find({ key: 'mods-menu:agent-threads' }))?.props.label).toBe('off')
    await band.press({ key: 'mods-menu:threads' })
    await band.redraw()
    expect((await band.find({ key: 'mods-menu:threads' }))?.props.label).toBe('off')
    expect(await band.find({ text: /start a thread/ })).toBeUndefined()
    expect(await band.find({ key: 'mods-menu:agent-threads' })).toBeUndefined()
    await band.unmount()
  }
  const reply = await $.command.run({ command: 'merge-threads', args: 'a into b', origin: { kind: 'composer' }, presentation: {} as never })
  expect(reply.text).toBe('Threads are off in this chat; /threads turns them on.')
})
