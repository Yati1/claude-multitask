import type { On } from 'claude-code'
import { expect, mock, test } from 'claude-code/testing'
import type { Engine } from 'claude-code/testing'

import { SWITCH_MARK, SWITCH_NOTE, SWITCH_TOAST } from '../hooks/ui-switch'

// thread-chat's tests/ui-switch.test.ts covers the shared check in full; these show this
// mod carries it.

type World = { config: string; mtimeMs: number; prompts: (readonly string[])[]; toasts: string[] }

// the engine hands a path on resolved (on Windows, `C:\profile\.claude.json`)
const pathOf = (path: string) => path.replace(/\\/g, '/').replace(/^[A-Za-z]:/, '')
const CONFIG = '/profile/.claude.json'

// The test stands in for the engine beneath the plugin: a home folder holding the global
// config, a session drawn on the desktop, and what reaches the model and the toasts.
function engine(on: On): World {
  const world: World = { config: '', mtimeMs: 1000, prompts: [], toasts: [] }
  mock.store(on, {})
  mock.env(on, { USERPROFILE: 'C:\\profile' })
  on('session.id', () => ({ value: 'session-1' }))
  on('session.surfaces', () => ({ value: ['desktop' as const] }))
  on('fs.stat', ($, e) => {
    if (pathOf(e.path) !== CONFIG) throw new Error(`ENOENT: ${e.path}`)
    return { value: { kind: 'file' as const, size: world.config.length, mtimeMs: world.mtimeMs, isLink: false } }
  })
  on('fs.read', ($, e) => {
    if (pathOf(e.path) !== CONFIG) throw new Error(`ENOENT: ${e.path}`)
    return { value: world.config }
  })
  on('ui.toast', ($, e) => {
    world.toasts.push(e.text)
    return { value: undefined }
  })
  on('prompt.submit', ($, e) => {
    world.prompts.push(e.context ?? [])
    return { text: e.text }
  })
  return world
}

// The engine saving the global config anew, the hooks-modules switch on or off.
function save(world: World, isOn: boolean) {
  world.config = JSON.stringify({ cachedGrowthBookFeatures: { tengu_plugin_hooks_modules: isOn } })
  world.mtimeMs += 1000
}

const sayInApp = ($: Engine, text: string, context?: string[]) =>
  $.prompt.submit({ text, origin: { kind: 'sdk' }, wait: false, ...(context !== undefined && { context }) })
const switchNotes = (world: World) => world.prompts.map(context => context.filter(note => note.includes(SWITCH_MARK)).length)

test('the model and the person are told once while the saved switch turns the controls off', async ($, on) => {
  const world = engine(on)
  save(world, false)
  await sayInApp($, 'one')
  await sayInApp($, 'two')
  save(world, true)
  await sayInApp($, 'three')
  save(world, false)
  await sayInApp($, 'four')
  expect(switchNotes(world)).toEqual([1, 0, 0, 1])
  expect(world.prompts[0]).toContain(SWITCH_NOTE)
  expect(world.toasts).toEqual([SWITCH_TOAST, SWITCH_TOAST])
})

test("another mod's note beside the message tells for all: this one stays quiet", async ($, on) => {
  const world = engine(on)
  save(world, false)
  await sayInApp($, 'one', [SWITCH_NOTE])
  await sayInApp($, 'two')
  expect(switchNotes(world)).toEqual([1, 0])
  expect(world.toasts).toEqual([])
})
