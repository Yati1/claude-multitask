import type { On, Register } from 'claude-code'
import { expect, test } from 'claude-code/testing'
import type { Engine, Plugin } from 'claude-code/testing'

import { DISMISS, DOCS } from '../hooks/welcome'

// thread-chat's tests/welcome.test.ts covers the shared welcome line in full; these show
// this mod carries it: alone it draws the line, and with another of the mods outside it in
// the band it leaves the line to that one, and keeps a press on that one's Dismiss.

const SURFACES = ['terminal', 'desktop'] as const

// thread-chat as its copy stands to this one, outside it in the band: it publishes its
// value as the session starts, and its band hook draws the line's Dismiss over the rest.
const threadChatOutside: Register = on => {
  on('session.start', async ($, e, next) => {
    const result = await next(e)
    await $.state.set({ plugin: 'thread-chat', key: 'welcome' } as const, { seen: [] })
    return result
  })
  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    const below = await next(e)
    const { Box, Button } = $.ui.resolve(e)
    return Box({ flexDirection: 'column', children: [Button({ key: 'claude-multitask-welcome-dismiss', label: 'Dismiss', onPress: () => {} }), below] })
  })
}
const THREAD_CHAT: Plugin = { name: 'thread-chat', tier: 'prepend', register: threadChatOutside }

// Each plugin's store, by name, as the engine keeps one a plugin.
type Stores = Record<string, Record<string, unknown>>

// The test stands in for the engine beneath the plugins: a store for each, what the mod
// asks of the session as it starts, and a band of its own with nothing in it.
function engine(on: On): Stores {
  const stores: Stores = {}
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
  on('command.register', ($, e) => ({ value: { command: e.name } }))
  on('ui.render', () => ({ type: 'engine', ref: 0 }))
  on('ui.press', ($, e) => ({ element: e.element }))
  return stores
}

const start = ($: Engine) => $.session.start({ cwd: '.', surface: 'terminal', isInteractive: true })

const BAND = {
  component: 'AbovePrompt',
  props: { hasSurvey: false, isWorking: false, maxRows: 10, bodyColumns: 200, scroll: { offset: 0, bodyRows: 10 }, view: {} },
} as const

type Drawn = { type?: string; props?: Record<string, unknown>; children?: unknown[]; press?: { plugin: string } }
const isDrawn = (node: unknown): node is Drawn => typeof node === 'object' && node !== null
const elementsOf = (node: unknown): Drawn[] => (isDrawn(node) ? [node, ...(node.children ?? []).flatMap(elementsOf)] : [])
const textOf = (node: Drawn): string => (node.children ?? []).filter(child => typeof child === 'string').join('')

test('alone and new, react draws the line: /react, the other mods to try, Docs and Dismiss', async ($, on) => {
  engine(on)
  await start($)
  for (const surface of SURFACES) {
    const all = elementsOf(await (await $.ui.mount({ plugin: 'react', surface, ...BAND })).drawn())
    expect({
      surface,
      lines: all.filter(el => el.type === 'Text').map(textOf),
      links: all.filter(el => el.type === 'Link').map(el => el.props?.href),
      dismiss: all.filter(el => el.props?.key === DISMISS).length,
    }).toEqual({
      surface,
      lines: [
        'New mod: /react for emoji reactions.',
        'Also try thread-chat (keep each topic in its own thread) and multitask (talk to Claude while it works).',
      ],
      links: [DOCS],
      dismiss: 1,
    })
  }
})

test('with thread-chat outside it in the band, react leaves the line to it, and keeps a press on its Dismiss', { plugins: [THREAD_CHAT] }, async ($, on) => {
  const stores = engine(on)
  await start($)
  const drawing = await $.ui.mount({ plugin: 'react', surface: 'terminal', ...BAND })
  const buttons = elementsOf(await drawing.drawn()).filter(el => el.props?.key === DISMISS)
  expect(buttons.map(el => el.press?.plugin)).toEqual(['thread-chat'])
  await drawing.press({ key: DISMISS, plugin: 'thread-chat' })
  expect(stores.react?.welcome).toEqual(['thread-chat', 'react'])
})
