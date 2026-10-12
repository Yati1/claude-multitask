import type { On, Register } from 'claude-code'
import { expect, test } from 'claude-code/testing'
import type { Engine, Plugin } from 'claude-code/testing'

import { DISMISS, DOCS } from '../hooks/welcome'

// The welcome line the three mods share (hooks/welcome.tsx), in full, as thread-chat's
// copy draws it. multitask's and react's tests show those mods carry it, and stand aside
// for a mod outside them in the band.

const SURFACES = ['terminal', 'desktop'] as const

// multitask and react as their copies stand to thread-chat's, beneath it in the band: each
// publishes its value as the session starts, from what its store kept, and its band hook
// passes. (A test loads a plugin beside the one under test from a function of its own,
// which names nothing outside it: not another mod's module.)
const multitaskBeneath: Register = on => {
  on('session.start', async ($, e, next) => {
    const result = await next(e)
    const kept = await $.store.get('welcome')
    await $.state.set({ plugin: 'multitask', key: 'welcome' } as const, { seen: Array.isArray(kept) ? kept : [] })
    return result
  })
  on('ui.render', { component: 'AbovePrompt' }, ($, e, next) => next(e))
}
const reactBeneath: Register = on => {
  on('session.start', async ($, e, next) => {
    const result = await next(e)
    const kept = await $.store.get('welcome')
    await $.state.set({ plugin: 'react', key: 'welcome' } as const, { seen: Array.isArray(kept) ? kept : [] })
    return result
  })
  on('ui.render', { component: 'AbovePrompt' }, ($, e, next) => next(e))
}
const MULTITASK: Plugin = { name: 'multitask', tier: 'append', register: multitaskBeneath }
const REACT: Plugin = { name: 'react', tier: 'append', register: reactBeneath }

// Another mod's controls in the band, beneath every mod installed by the person.
const otherControls: Register = on => {
  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    await next(e)
    const { Text } = $.ui.resolve(e)
    return Text({ children: ['other controls'] })
  })
}
const OTHER: Plugin = { name: 'other-mod', tier: 'append', register: otherControls }

// Each plugin's store, by name, as the engine keeps one a plugin.
type Stores = Record<string, Record<string, unknown>>

// The test stands in for the engine beneath the plugins: a store for each, what thread-chat
// asks of the session as it starts, and a band of its own with nothing in it.
function engine(on: On, seed: Stores = {}): Stores {
  const stores: Stores = JSON.parse(JSON.stringify(seed))
  const storeOf = (plugin: string) => (stores[plugin] ??= {})
  on('store.get', ($, e, next) => ({ value: storeOf(next.origin.plugin)[e.key] }))
  on('store.set', ($, e, next) => {
    storeOf(next.origin.plugin)[e.key] = e.value
    return { value: undefined }
  })
  on('store.keys', ($, e, next) => ({ value: Object.keys(storeOf(next.origin.plugin)) }))
  on('session.id', () => ({ value: 'session-1' }))
  on('session.start', ($, e) => ({ cwd: e.cwd }))
  on('session.messages', () => ({ value: [] }))
  on('tool.register', ($, e) => ({ value: { tool: `mcp__thread-chat__${e.name}` } }))
  on('command.register', ($, e) => ({ value: { command: e.name } }))
  on('ui.render', () => ({ type: 'engine', ref: 0 }))
  on('ui.press', ($, e) => ({ element: e.element }))
  return stores
}

const start = ($: Engine) => $.session.start({ cwd: '.', surface: 'terminal', isInteractive: true })

const band = (bodyColumns = 200, hasSurvey = false) =>
  ({
    component: 'AbovePrompt',
    props: { hasSurvey, isWorking: false, maxRows: 10, bodyColumns, scroll: { offset: 0, bodyRows: 10 }, view: {} },
  }) as const

type Drawn = { type?: string; props?: Record<string, unknown>; children?: unknown[]; press?: { plugin: string } }
const isDrawn = (node: unknown): node is Drawn => typeof node === 'object' && node !== null

// Every element of a drawing, depth first.
function elementsOf(node: unknown): Drawn[] {
  if (!isDrawn(node)) return []
  return [node, ...(node.children ?? []).flatMap(elementsOf)]
}

const textOf = (node: Drawn): string => (node.children ?? []).filter(child => typeof child === 'string').join('')

// What the band shows of the welcome line: its texts, and the Dismiss buttons and links.
async function welcomeOf(drawing: { drawn: () => Promise<unknown> }) {
  const all = elementsOf(await drawing.drawn())
  return {
    lines: all.filter(el => el.type === 'Text').map(textOf).filter(text => /^(New mods?|Also try)/.test(text)),
    dismiss: all.filter(el => el.type === 'Button' && el.props?.key === DISMISS),
    links: all.filter(el => el.type === 'Link').map(el => el.props?.href),
  }
}

test('alone and new: /threads, the other mods to try with what each is for, Docs and Dismiss', async ($, on) => {
  engine(on)
  await start($)
  for (const surface of SURFACES) {
    const shown = await welcomeOf(await $.ui.mount({ plugin: 'thread-chat', surface, ...band() }))
    expect({ surface, lines: shown.lines, dismiss: shown.dismiss.length, links: shown.links }).toEqual({
      surface,
      lines: [
        'New mod: /threads for topic threads.',
        "Also try multitask (talk to Claude while it works) and react (emoji reactions instead of 'done' replies).",
      ],
      dismiss: 1,
      links: [DOCS],
    })
  }
})

test('where the long reasons do not fit the band, the short ones show', async ($, on) => {
  engine(on)
  await start($)
  const narrow = await welcomeOf(await $.ui.mount({ plugin: 'thread-chat', surface: 'terminal', ...band(80) }))
  expect(narrow.lines).toEqual(['New mod: /threads for topic threads.', 'Also try multitask (talk while it works) and react (emoji reactions).'])
})

test('with all three installed, one line is drawn, by one mod, naming each command and nothing to try', { plugins: [MULTITASK, REACT] }, async ($, on) => {
  engine(on)
  await start($)
  for (const surface of SURFACES) {
    const shown = await welcomeOf(await $.ui.mount({ plugin: 'thread-chat', surface, ...band() }))
    expect({ surface, lines: shown.lines, dismiss: shown.dismiss.length }).toEqual({
      surface,
      lines: ['New mods: /threads for topic threads, /multitask for multitasking and /react for emoji reactions.'],
      dismiss: 1,
    })
  }
})

test('with react installed, the mod to try is multitask', { plugins: [REACT] }, async ($, on) => {
  engine(on)
  await start($)
  const wide = await welcomeOf(await $.ui.mount({ plugin: 'thread-chat', surface: 'desktop', ...band(110) }))
  expect(wide.lines).toEqual([
    'New mods: /threads for topic threads and /react for emoji reactions.',
    'Also try multitask (talk to Claude while it works).',
  ])
})

test("what other mods draw in the band sits under the line, a gap between; with nothing there, the line alone", { plugins: [REACT, OTHER] }, async ($, on) => {
  engine(on)
  await start($)
  for (const surface of SURFACES) {
    const tree = (await (await $.ui.mount({ plugin: 'thread-chat', surface, ...band() })).drawn()) as Drawn
    const [line, rest] = (tree.children ?? []).filter(isDrawn)
    expect({
      surface,
      gap: tree.props?.rowGap,
      lineHasDismiss: elementsOf(line).some(el => el.props?.key === DISMISS),
      rest: elementsOf(rest).map(textOf).filter(Boolean),
    }).toEqual({ surface, gap: 1, lineHasDismiss: true, rest: ['other controls'] })
  }
})

test('with nothing else in the band the line stands alone, no gap', { plugins: [REACT] }, async ($, on) => {
  engine(on)
  await start($)
  const tree = (await (await $.ui.mount({ plugin: 'thread-chat', surface: 'terminal', ...band() })).drawn()) as Drawn
  expect({ gap: tree.props?.rowGap, isLine: tree.children?.some(child => elementsOf(child).some(el => el.props?.key === DISMISS)) }).toEqual({
    gap: undefined,
    isLine: true,
  })
})

test('Dismiss keeps the mods installed then, with those another mod kept, and the line goes', { plugins: [MULTITASK, REACT] }, async ($, on) => {
  const stores = engine(on, { react: { welcome: ['react'] } })
  await start($)
  const drawing = await $.ui.mount({ plugin: 'thread-chat', surface: 'terminal', ...band() })
  expect((await welcomeOf(drawing)).lines).toEqual(['New mods: /threads for topic threads and /multitask for multitasking.'])
  await drawing.press({ key: DISMISS })
  expect({ kept: stores['thread-chat']?.welcome, shown: await welcomeOf(drawing) }).toEqual({
    kept: ['thread-chat', 'multitask', 'react'],
    shown: { lines: [], dismiss: [], links: [] },
  })
})

test('a later session, every installed mod seen, shows no line', async ($, on) => {
  engine(on, { 'thread-chat': { welcome: ['thread-chat'] } })
  await start($)
  for (const surface of SURFACES) {
    const shown = await welcomeOf(await $.ui.mount({ plugin: 'thread-chat', surface, ...band() }))
    expect({ surface, ...shown }).toEqual({ surface, lines: [], dismiss: [], links: [] })
  }
})

test('it comes back for a mod installed since: only its command, and a mod seen before and since removed is not suggested', { plugins: [REACT] }, async ($, on) => {
  engine(on, { 'thread-chat': { welcome: ['thread-chat', 'multitask'] } })
  await start($)
  const shown = await welcomeOf(await $.ui.mount({ plugin: 'thread-chat', surface: 'desktop', ...band() }))
  expect(shown.lines).toEqual(['New mod: /react for emoji reactions.'])
})

test('a dismissal another installed mod kept counts, though this mod kept none', { plugins: [REACT] }, async ($, on) => {
  engine(on, { react: { welcome: ['thread-chat', 'react'] } })
  await start($)
  const shown = await welcomeOf(await $.ui.mount({ plugin: 'thread-chat', surface: 'terminal', ...band() }))
  expect(shown.lines).toEqual([])
})

test('a survey holds the band: no line', async ($, on) => {
  engine(on)
  await start($)
  const shown = await welcomeOf(await $.ui.mount({ plugin: 'thread-chat', surface: 'terminal', ...band(200, true) }))
  expect(shown.dismiss.length).toBe(0)
})

test("with threads on, the line sits above thread-chat's own controls, a gap between", async ($, on) => {
  engine(on)
  on('prompt.submit', ($, e) => ({ text: e.text }))
  on('session.append', ($, e, next) => next(e))
  await start($)
  await $.command.run({ command: 'threads', args: 'on', origin: { kind: 'composer' }, presentation: {} as never })
  for (const surface of SURFACES) {
    const tree = (await (await $.ui.mount({ plugin: 'thread-chat', surface, ...band() })).drawn()) as Drawn
    const [line, rest] = (tree.children ?? []).filter(isDrawn)
    expect({
      surface,
      gap: tree.props?.rowGap,
      lineHasDismiss: elementsOf(line).some(el => el.props?.key === DISMISS),
      restHasDismiss: elementsOf(rest).some(el => el.props?.key === DISMISS),
      restHasControls: elementsOf(rest).some(el => el.type === 'Select' || el.type === 'Button' || el.type === 'Client'),
    }).toEqual({ surface, gap: 1, lineHasDismiss: true, restHasDismiss: false, restHasControls: true })
  }
})
