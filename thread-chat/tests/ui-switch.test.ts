import type { On, RenderSurface } from 'claude-code'
import { expect, mock, test } from 'claude-code/testing'
import type { Engine } from 'claude-code/testing'

import { SWITCH_MARK, SWITCH_NOTE, SWITCH_TOAST } from '../hooks/ui-switch'

// The global config as the engine saved it, by the hooks-modules switch it holds.
const configWith = (isOn: boolean) => JSON.stringify({ numStartups: 3, cachedGrowthBookFeatures: { tengu_plugin_hooks_modules: isOn, other_flag: true } })

type World = {
  // the global config's text, by path; a missing path is not there
  files: Record<string, string>
  // the global config's change time, moved on by `save`
  mtimeMs: number
  // each prompt that reached the engine, with the notes beside it
  prompts: { text: string; context: readonly string[] }[]
  toasts: string[]
  reads: string[]
  surfaces: readonly RenderSurface[]
}

// The test stands in for the engine beneath the plugin: a home folder holding the global
// config, the surfaces the session draws on, and what reaches the model and the toasts.
function engine(on: On, env: Record<string, string> = { USERPROFILE: 'C:\\profile' }): World {
  const world: World = { files: {}, mtimeMs: 1000, prompts: [], toasts: [], reads: [], surfaces: ['desktop'] }
  mock.store(on, {})
  mock.env(on, env)
  on('session.id', () => ({ value: 'session-1' }))
  on('session.start', ($, e) => ({ cwd: e.cwd }))
  on('session.surfaces', () => ({ value: world.surfaces }))
  on('command.register', ($, e) => ({ value: { command: e.name } }))
  on('tool.register', ($, e) => ({ value: { tool: `mcp__thread-chat__${e.name}` } }))
  on('fs.stat', ($, e) => {
    const text = world.files[pathOf(e.path)]
    if (text === undefined) throw new Error(`ENOENT: ${e.path}`)
    return { value: { kind: 'file' as const, size: text.length, mtimeMs: world.mtimeMs, isLink: false } }
  })
  on('fs.read', ($, e) => {
    world.reads.push(pathOf(e.path))
    const text = world.files[pathOf(e.path)]
    if (text === undefined) throw new Error(`ENOENT: ${e.path}`)
    return { value: text }
  })
  on('ui.toast', ($, e) => {
    world.toasts.push(e.text)
    return { value: undefined }
  })
  on('prompt.submit', ($, e) => {
    world.prompts.push({ text: e.text, context: e.context ?? [] })
    return { text: e.text }
  })
  return world
}

// the engine hands a path on resolved (on Windows, `C:\profile\.claude.json`)
const pathOf = (path: string) => path.replace(/\\/g, '/').replace(/^[A-Za-z]:/, '')
const CONFIG = '/profile/.claude.json'

// The engine saving the global config anew.
function save(world: World, path: string, isOn: boolean) {
  world.files[path] = configWith(isOn)
  world.mtimeMs += 1000
}

const start = ($: Engine) => $.session.start({ cwd: '.', surface: 'desktop', isInteractive: true })
const sayInApp = ($: Engine, text: string, context?: string[]) =>
  $.prompt.submit({ text, origin: { kind: 'sdk' }, wait: false, ...(context !== undefined && { context }) })
const sayInTerminal = ($: Engine, text: string) => $.prompt.submit({ text, origin: { kind: 'composer' }, wait: false })

const switchNotes = (world: World) => world.prompts.map(prompt => prompt.context.filter(note => note.includes(SWITCH_MARK)).length)

test('the model and the person are told once when the saved switch turns the controls off, and again the next time', async ($, on) => {
  const world = engine(on)
  save(world, CONFIG, true)
  await start($)

  await sayInApp($, 'one')
  save(world, CONFIG, false)
  await sayInApp($, 'two')
  await sayInApp($, 'three')
  expect(switchNotes(world)).toEqual([0, 1, 0])
  expect(world.prompts[1]?.context).toContain(SWITCH_NOTE)
  expect(world.toasts).toEqual([SWITCH_TOAST])

  // a newer version saves it on again: quiet; off once more, told once more
  save(world, CONFIG, true)
  await sayInApp($, 'four')
  save(world, CONFIG, false)
  await sayInApp($, 'five')
  await sayInApp($, 'six')
  expect(switchNotes(world)).toEqual([0, 1, 0, 0, 1, 0])
  expect(world.toasts).toEqual([SWITCH_TOAST, SWITCH_TOAST])
})

test('the note says what happened and what to do, in public words', async () => {
  expect(SWITCH_NOTE).toContain('older Claude Code version')
  expect(SWITCH_NOTE).toContain('open a new session in the Code tab')
  expect(SWITCH_NOTE).toContain('DISABLE_GROWTHBOOK=1')
  expect(SWITCH_NOTE).toContain('2.1.289')
  expect(SWITCH_TOAST.length).toBeLessThan(200)
})

test('the config is read again only once it changed', async ($, on) => {
  const world = engine(on)
  save(world, CONFIG, false)
  await start($)
  await sayInApp($, 'one')
  await sayInApp($, 'two')
  expect(world.reads.filter(path => path === CONFIG)).toHaveLength(1)
  save(world, CONFIG, false)
  await sayInApp($, 'three')
  expect(world.reads.filter(path => path === CONFIG)).toHaveLength(2)
  expect(switchNotes(world)).toEqual([1, 0, 0])
})

test('a session run with DISABLE_GROWTHBOOK reads the switch on: nothing is said', async ($, on) => {
  const world = engine(on, { USERPROFILE: 'C:\\profile', DISABLE_GROWTHBOOK: '1' })
  save(world, CONFIG, false)
  await start($)
  await sayInApp($, 'one')
  expect(switchNotes(world)).toEqual([0])
  expect(world.toasts).toEqual([])
  expect(world.reads).not.toContain(CONFIG)
})

test('the terminal draws the controls itself: nothing is said there, unless an app draws too', async ($, on) => {
  const world = engine(on)
  world.surfaces = ['terminal']
  save(world, CONFIG, false)
  await start($)
  await sayInTerminal($, 'one')
  expect(switchNotes(world)).toEqual([0])
  expect(world.toasts).toEqual([])

  world.surfaces = ['terminal', 'mobile']
  await sayInTerminal($, 'two')
  expect(switchNotes(world)).toEqual([0, 1])
})

test("another mod's note beside the message tells for all: this one stays quiet, then and after", async ($, on) => {
  const world = engine(on)
  save(world, CONFIG, false)
  await start($)
  await sayInApp($, 'one', [SWITCH_NOTE])
  await sayInApp($, 'two')
  expect(switchNotes(world)).toEqual([1, 0])
  expect(world.toasts).toEqual([])
})

test('a config that cannot be read, or holds no switch, says nothing', async ($, on) => {
  const world = engine(on)
  await start($)
  await sayInApp($, 'missing')
  world.files[CONFIG] = '{"cachedGrowthBookFeatures": {"tengu_plugin_hooks_mod'
  world.mtimeMs += 1000
  await sayInApp($, 'cut short')
  world.files[CONFIG] = JSON.stringify({ cachedGrowthBookFeatures: {} })
  world.mtimeMs += 1000
  await sayInApp($, 'no switch')
  expect(switchNotes(world)).toEqual([0, 0, 0])
  expect(world.toasts).toEqual([])
})

test('the global config is read from CLAUDE_CONFIG_DIR when it is set', async ($, on) => {
  const world = engine(on, { USERPROFILE: 'C:\\profile', CLAUDE_CONFIG_DIR: '/config/' })
  save(world, CONFIG, true)
  save(world, '/config/.claude.json', false)
  await start($)
  await sayInApp($, 'one')
  expect(switchNotes(world)).toEqual([1])
})

test("only a person's own message is told beside", async ($, on) => {
  const world = engine(on)
  save(world, CONFIG, false)
  await start($)
  await $.prompt.submit({ text: 'from a plugin', origin: { kind: 'plugin', plugin: 'other' } as never, wait: false })
  await sayInApp($, 'mine')
  expect(switchNotes(world)).toEqual([0, 1])
})
