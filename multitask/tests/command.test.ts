import type { On } from 'claude-code'
import { expect, mock, test } from 'claude-code/testing'
import type { Engine } from 'claude-code/testing'

// What the test saw of /multitask: the questions asked in the engine's dialog, each as
// `question [header] option / option`, how many times the menu was told the command's
// line changed, the hint the command registered with, and the tools the mod offered.
type Seen = { asked: string[]; invalidated: number; hint?: string; registered: string[] }

type Question = { question: string; header: string; options: { label: string }[] }

// The test stands in for the engine beneath the plugin, and for the person at its
// question dialog: each question is answered from `answers` (by its text) or, with no
// answer there, dismissed. `surfaces` are where the session draws: none, no one to ask.
function engine(on: On, answers: Record<string, string>, surfaces: readonly ('desktop' | 'terminal')[] = ['desktop']) {
  const seen: Seen = { asked: [], invalidated: 0, registered: [] }
  const store: Record<string, unknown> = {}
  on('store.get', ($, e) => ({ value: store[e.key] }))
  on('store.set', ($, e) => {
    store[e.key] = e.value
    return { value: undefined }
  })
  on('store.keys', () => ({ value: Object.keys(store) }))
  mock.clock(on, { now: 1000 })
  on('session.id', () => ({ value: 'session-1' }))
  on('session.messages', () => ({ value: [] }))
  on('session.start', ($, e) => ({ cwd: e.cwd }))
  on('session.surfaces', () => ({ value: surfaces }))
  on('agent.register', () => ({ value: { agent: 'multitask:thought' } }))
  on('agent.list', () => ({ value: [] }))
  on('tool.register', ($, e) => {
    seen.registered.push(e.name)
    return { value: { tool: `mcp__multitask__${e.name}` } }
  })
  on('command.register', ($, e) => {
    if (e.name === 'multitask') seen.hint = e.argumentHint
    return { value: { command: e.name } }
  })
  on('command.describe', ($, e) => ({ description: e.description, argumentHint: e.argumentHint, isHidden: e.isHidden }))
  on('ui.invalidate', ($, e) => {
    if (e.event === 'command.describe') seen.invalidated++
    return { value: undefined }
  })
  on('ui.message', () => ({}))
  on('tool.call', { tool: 'AskUserQuestion' }, ($, e) => {
    const [q] = (e as unknown as { questions: Question[] }).questions
    if (q === undefined) return { deny: 'no question' }
    seen.asked.push(`${q.question} [${q.header}] ${q.options.map(o => o.label).join(' / ')}`)
    const answer = answers[q.question]
    return answer === undefined ? { deny: 'dismissed' } : { result: { questions: [q], answers: { [q.question]: answer } } }
  })
  return { seen, store }
}

const start = ($: Engine) => $.session.start({ cwd: '.', surface: 'desktop', isInteractive: true })
const multitask = async ($: Engine, args = '') =>
  (await $.command.run({ command: 'multitask', args, origin: { kind: 'composer' }, presentation: {} as never })).text
const status = ($: Engine) => multitask($, 'status')
// A command's line in the menu.
const describe = async ($: Engine, command = 'multitask') =>
  (
    await $.command.describe({
      command,
      description: 'as registered',
      isHidden: false,
      immediate: false,
      provider: { plugin: 'multitask', tier: 'user' },
    })
  ).description

const HERE = 'Multitask in this chat?'
const NEW = 'Multitask in new chats?'
const MODE = 'Which mode for this chat?'
const ON_TEXT =
  'Multitask is on in this chat, in Multitask mode: this chat is now the voice and hands all work to thoughts. Switch to Focus above the prompt, or use `/multitask mode`, to work with the agent as usual.'
const OFF_TEXT = 'Multitask is off in this chat; `/multitask on` turns it on.'
const MULTITASK_TEXT = 'Multitask mode: this chat is now the voice and hands all work to thoughts.'
const FOCUS_TEXT = 'Focus mode: this chat does its work itself again.'
const WHERE = 'in new chats and in chats where you have not used `/multitask`.'
const USAGE = 'Usage: `/multitask [on|off|toggle|status|mode [multitask|focus]|default [on|off]]`; with no argument it asks.'
const VOICE_TOOLS = ['think', 'tell', 'unqueue', 'stop', 'thoughts']

test('/multitask alone asks for this chat alone, the current option marked, and changes it as answered', async ($, on) => {
  const answers: Record<string, string> = { [HERE]: 'On', [NEW]: 'On' }
  const { seen, store } = engine(on, answers)
  await start($)

  // turned on, it starts in Multitask mode, the voice's tools offered; new chats are not
  // asked about, though an answer waits
  expect(await multitask($)).toBe(ON_TEXT)
  expect(seen.asked).toEqual([`${HERE} [This chat] On / Off (current)`])
  expect(await status($)).toBe('Multitask: on in this chat (your choice), Multitask mode · off in new chats')
  expect(seen.registered).toEqual(VOICE_TOOLS)
  expect(store.isEnabledByDefault).toBeUndefined()

  seen.asked.length = 0
  answers[HERE] = 'Off'
  expect(await multitask($)).toBe(OFF_TEXT)
  expect(seen.asked).toEqual([`${HERE} [This chat] On (current) / Off`])
  expect(await status($)).toBe('Multitask: off in this chat (your choice) · off in new chats')
})

test('a dismissed question, or an answer of neither, changes nothing; an answer of what is so makes it this chat\'s choice', async ($, on) => {
  const answers: Record<string, string> = {}
  const { seen } = engine(on, answers)
  await start($)
  const unchanged = 'No change. Multitask: off in this chat (following the default) · off in new chats'

  expect(await multitask($)).toBe(unchanged)
  expect(seen.asked).toEqual([`${HERE} [This chat] On / Off (current)`])

  answers[HERE] = 'later'
  expect(await multitask($)).toBe(unchanged)
  expect(seen.asked).toHaveLength(2)
  expect(await status($)).toBe('Multitask: off in this chat (following the default) · off in new chats')

  answers[HERE] = 'Off (current)'
  expect(await multitask($)).toBe('Multitask is already off; this chat now keeps it off.')
  expect(await status($)).toBe('Multitask: off in this chat (your choice) · off in new chats')
  expect(await multitask($)).toBe('Multitask is already off in this chat.')
})

test('where no one can be asked, /multitask, /multitask default and /multitask mode say how it is instead', async ($, on) => {
  const { seen } = engine(on, { [HERE]: 'On', [NEW]: 'On', [MODE]: 'Focus' }, [])
  await start($)
  expect(await multitask($)).toBe('Multitask: off in this chat (following the default) · off in new chats')
  expect(await multitask($, 'default')).toBe('Multitask: off in this chat (following the default) · off in new chats')
  await multitask($, 'on')
  expect(await multitask($, 'mode')).toBe('Multitask: on in this chat (your choice), Multitask mode · off in new chats')
  expect(seen.asked).toEqual([])
})

test('/multitask on, off, enable, disable and toggle set this chat; what is so already becomes this chat\'s choice and says so', async ($, on) => {
  const { seen } = engine(on, {})
  await start($)
  expect(await multitask($, 'off')).toBe('Multitask is already off; this chat now keeps it off.')
  expect(await status($)).toBe('Multitask: off in this chat (your choice) · off in new chats')
  expect(await multitask($, 'enable')).toBe(ON_TEXT)
  expect(await multitask($, 'on')).toBe('Multitask is already on in this chat.')
  // on in Focus, `on` leaves the mode be
  await multitask($, 'mode focus')
  expect(await multitask($, 'on')).toBe('Multitask is already on in this chat.')
  expect(await status($)).toBe('Multitask: on in this chat (your choice), Focus mode · off in new chats')
  expect(await multitask($, 'disable')).toBe(OFF_TEXT)
  // turned on again, it starts in Multitask mode
  expect(await multitask($, 'toggle')).toBe(ON_TEXT)
  expect(await status($)).toBe('Multitask: on in this chat (your choice), Multitask mode · off in new chats')
  expect(await multitask($, 'toggle')).toBe(OFF_TEXT)
  expect(seen.asked).toEqual([])
})

test('/multitask default asks for new chats alone; default on|off sets it; what is so already changes nothing', async ($, on) => {
  const answers: Record<string, string> = { [NEW]: 'On' }
  const { seen, store } = engine(on, answers)
  await start($)
  expect(await multitask($, 'default')).toBe(`Multitask is now on by default, ${WHERE}`)
  expect(seen.asked).toEqual([`${NEW} [New chats] On / Off (current)`])
  expect(store.isEnabledByDefault).toBe(true)
  // this chat follows it; open already, it stays in Focus
  expect(await status($)).toBe('Multitask: on in this chat (following the default), Focus mode · on in new chats')
  delete answers[NEW]
  expect(await multitask($, 'default')).toBe('No change. Multitask: on in this chat (following the default), Focus mode · on in new chats')
  expect(await multitask($, 'default on')).toBe('Multitask is already on by default in new chats.')
  // on already, by the default, `on` makes it this chat's choice, staying in Focus, which the default no longer turns off
  expect(await multitask($, 'on')).toBe('Multitask is already on; this chat now keeps it on.')
  expect(await status($)).toBe('Multitask: on in this chat (your choice), Focus mode · on in new chats')
  expect(await multitask($, 'default disable')).toBe(`Multitask is now off by default, ${WHERE} This chat keeps it on; \`/multitask off\` turns it off here.`)
  expect(await status($)).toBe('Multitask: on in this chat (your choice), Focus mode · off in new chats')
  await multitask($, 'off')
  expect(await multitask($, 'default enable')).toBe(`Multitask is now on by default, ${WHERE} This chat keeps it off; \`/multitask on\` turns it on here.`)
})

test('/multitask mode asks which mode, the current one marked; mode multitask|focus switches to it; off, it says to turn it on', async ($, on) => {
  const answers: Record<string, string> = { [MODE]: 'Focus' }
  const { seen } = engine(on, answers)
  await start($)
  const offText = `${OFF_TEXT} It comes on in Multitask mode; \`/multitask mode\` then switches to Focus.`
  expect(await multitask($, 'mode')).toBe(offText)
  expect(await multitask($, 'mode focus')).toBe(offText)
  expect(seen.asked).toEqual([])

  await multitask($, 'on')
  expect(await multitask($, 'mode')).toBe(FOCUS_TEXT)
  expect(seen.asked).toEqual([`${MODE} [Mode] Multitask (current) / Focus`])
  expect(await status($)).toBe('Multitask: on in this chat (your choice), Focus mode · off in new chats')
  expect(await multitask($, 'mode focus')).toBe('This chat is already in Focus mode.')
  // picked as it is, or dismissed, nothing changes
  answers[MODE] = 'Focus (current)'
  expect(await multitask($, 'mode')).toBe('This chat is already in Focus mode.')
  delete answers[MODE]
  expect(await multitask($, 'mode')).toBe('No change. Multitask: on in this chat (your choice), Focus mode · off in new chats')
  expect(seen.asked.at(-1)).toBe(`${MODE} [Mode] Multitask / Focus (current)`)
  expect(await multitask($, 'Mode Multitask')).toBe(MULTITASK_TEXT)
  expect(await multitask($, 'mode multitask')).toBe('This chat is already in Multitask mode.')
})

test('anything else changes nothing and says how to use /multitask', async ($, on) => {
  const { seen, store } = engine(on, {})
  await start($)
  for (const args of ['sideways', 'on now', 'status please', 'default maybe', 'default on please', 'mode sideways', 'mode focus now']) {
    expect(await multitask($, args)).toBe(USAGE)
  }
  expect(await status($)).toBe('Multitask: off in this chat (following the default) · off in new chats')
  expect(store.isEnabledByDefault).toBeUndefined()
  expect(seen.asked).toEqual([])
})

test("the menu's line for /multitask says how it is, here with its mode and in new chats, and is asked for again as that changes", async ($, on) => {
  const { seen } = engine(on, {})
  await start($)
  expect(seen.hint).toBe('[on|off|toggle|status|mode|default [on|off]]')
  expect(await describe($)).toBe('Multitask: off here · off in new chats')
  // the mod's other command keeps its own line
  expect(await describe($, 'thoughts')).toBe('as registered')

  let before = seen.invalidated
  await multitask($, 'on')
  expect(seen.invalidated).toBeGreaterThan(before)
  expect(await describe($)).toBe('Multitask: on here, Multitask mode · off in new chats')

  before = seen.invalidated
  await multitask($, 'mode focus')
  expect(seen.invalidated).toBeGreaterThan(before)
  expect(await describe($)).toBe('Multitask: on here, Focus mode · off in new chats')

  before = seen.invalidated
  await multitask($, 'default on')
  expect(seen.invalidated).toBeGreaterThan(before)
  expect(await describe($)).toBe('Multitask: on here, Focus mode · on in new chats')

  // nothing changed, nothing to ask for again
  before = seen.invalidated
  await multitask($, 'on')
  await multitask($, 'mode focus')
  await multitask($, 'status')
  expect(seen.invalidated).toBe(before)
})
