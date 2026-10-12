import type { On } from 'claude-code'
import { expect, mock, test } from 'claude-code/testing'
import type { Engine } from 'claude-code/testing'

// What the test saw of /react: the questions asked in the engine's dialog, each as
// `question [header] option / option`, how many times the menu was told the command's
// line changed, and the hint the command registered with.
type Seen = { asked: string[]; invalidated: number; hint?: string }

type Question = { question: string; header: string; options: { label: string }[] }

// The test stands in for the engine beneath the plugin, and for the person at its
// question dialog: each question is answered from `answers` (by its text) or, with no
// answer there, dismissed. `surfaces` are where the session draws: none, no one to ask.
function engine(on: On, answers: Record<string, string>, surfaces: readonly ('desktop' | 'terminal')[] = ['desktop']) {
  const seen: Seen = { asked: [], invalidated: 0 }
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
  on('command.register', ($, e) => {
    seen.hint = e.argumentHint
    return { value: { command: e.name } }
  })
  on('command.describe', ($, e) => ({ description: e.description, argumentHint: e.argumentHint, isHidden: e.isHidden }))
  on('ui.invalidate', ($, e) => {
    if (e.event === 'command.describe') seen.invalidated++
    return { value: undefined }
  })
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
const react = async ($: Engine, args = '') =>
  (await $.command.run({ command: 'react', args, origin: { kind: 'composer' }, presentation: {} as never })).text
const status = ($: Engine) => react($, 'status')
// The command's line in the menu.
const describe = async ($: Engine) =>
  (
    await $.command.describe({
      command: 'react',
      description: 'Turn emoji reactions on or off in this chat, or by default in new chats',
      argumentHint: '[on|off|toggle|status|default [on|off]]',
      isHidden: false,
      immediate: false,
      provider: { plugin: 'react', tier: 'user' },
    })
  ).description

const HERE = 'Reactions in this chat?'
const NEW = 'Reactions in new chats?'
const ON_TEXT = 'Reactions are on in this chat: the agent may acknowledge a message with an emoji reaction on it instead of a reply.'
const OFF_TEXT = 'Reactions are off in this chat.'
const WHERE = 'in new chats and in chats where you have not used `/react`.'
const USAGE = 'Usage: `/react [on|off|toggle|status|default [on|off]]`; with no argument it asks.'

test('/react alone asks for this chat alone, the current option marked, and changes it as answered', async ($, on) => {
  const answers: Record<string, string> = { [HERE]: 'Off', [NEW]: 'Off' }
  const { seen, store } = engine(on, answers)
  await start($)

  // new chats are not asked about, though an answer waits
  expect(await react($)).toBe(OFF_TEXT)
  expect(seen.asked).toEqual([`${HERE} [This chat] On (current) / Off`])
  expect(await status($)).toBe('Reactions: off in this chat (your choice) · on in new chats')
  expect(store.isOnByDefault).toBeUndefined()

  // asked again, the option marked is the one now so
  seen.asked.length = 0
  answers[HERE] = 'On'
  expect(await react($)).toBe(ON_TEXT)
  expect(seen.asked).toEqual([`${HERE} [This chat] On / Off (current)`])
  expect(await status($)).toBe('Reactions: on in this chat (your choice) · on in new chats')
})

test('a dismissed question changes nothing; an answer of what is so, or of neither, changes nothing', async ($, on) => {
  const answers: Record<string, string> = {}
  const { seen } = engine(on, answers)
  await start($)
  const unchanged = 'No change. Reactions: on in this chat (following the default) · on in new chats'

  expect(await react($)).toBe(unchanged)
  expect(seen.asked).toEqual([`${HERE} [This chat] On (current) / Off`])

  // the current option picked
  answers[HERE] = 'On (current)'
  expect(await react($)).toBe(unchanged)

  // typed under "Other": a word that is neither changes nothing; one of the options counts as it
  answers[HERE] = 'maybe later'
  expect(await react($)).toBe(unchanged)
  expect(seen.asked).toHaveLength(3)
  answers[HERE] = 'off'
  expect(await react($)).toBe(OFF_TEXT)
  expect(await status($)).toBe('Reactions: off in this chat (your choice) · on in new chats')
})

test('where no one can be asked, /react and /react default say how reactions are instead', async ($, on) => {
  const { seen } = engine(on, { [HERE]: 'Off', [NEW]: 'Off' }, [])
  await start($)
  const now = 'Reactions: on in this chat (following the default) · on in new chats'
  expect(await react($)).toBe(now)
  expect(await react($, 'default')).toBe(now)
  expect(seen.asked).toEqual([])
})

test('/react on, off, enable, disable and toggle set this chat; what is so already changes nothing and says so', async ($, on) => {
  const { seen } = engine(on, {})
  await start($)
  expect(await react($, 'on')).toBe('Reactions are already on in this chat.')
  expect(await status($)).toBe('Reactions: on in this chat (following the default) · on in new chats')
  expect(await react($, 'Disable')).toBe(OFF_TEXT)
  expect(await react($, 'off')).toBe('Reactions are already off in this chat.')
  expect(await react($, 'enable')).toBe(ON_TEXT)
  expect(await react($, 'toggle')).toBe(OFF_TEXT)
  expect(await react($, 'toggle')).toBe(ON_TEXT)
  expect(await status($)).toBe('Reactions: on in this chat (your choice) · on in new chats')
  expect(seen.asked).toEqual([])
})

test('/react default asks for new chats alone; default on|off sets it; what is so already changes nothing', async ($, on) => {
  const answers: Record<string, string> = { [NEW]: 'Off' }
  const { seen, store } = engine(on, answers)
  await start($)
  expect(await react($, 'default')).toBe(`Reactions are now off by default, ${WHERE}`)
  expect(seen.asked).toEqual([`${NEW} [New chats] On (current) / Off`])
  expect(store.isOnByDefault).toBe(false)
  // this chat follows it
  expect(await status($)).toBe('Reactions: off in this chat (following the default) · off in new chats')
  delete answers[NEW]
  expect(await react($, 'default')).toBe('No change. Reactions: off in this chat (following the default) · off in new chats')
  expect(await react($, 'default off')).toBe('Reactions are already off by default in new chats.')
  expect(await react($, 'default on')).toBe(`Reactions are now on by default, ${WHERE}`)
  expect(store.isOnByDefault).toBe(true)
})

test('anything else changes nothing and says how to use /react', async ($, on) => {
  const { seen, store } = engine(on, {})
  await start($)
  for (const args of ['place', 'sideways', 'on now', 'status please', 'default maybe', 'default on please', 'default toggle']) {
    expect(await react($, args)).toBe(USAGE)
  }
  expect(await status($)).toBe('Reactions: on in this chat (following the default) · on in new chats')
  expect(store.isOnByDefault).toBeUndefined()
  expect(seen.asked).toEqual([])
})

test("the menu's line for /react says how reactions are, here and in new chats, and is asked for again as that changes", async ($, on) => {
  const { seen } = engine(on, {})
  await start($)
  expect(seen.hint).toBe('[on|off|toggle|status|default [on|off]]')
  expect(await describe($)).toBe('Reactions: on here · on in new chats')

  const before = seen.invalidated
  await react($, 'off')
  expect(seen.invalidated).toBeGreaterThan(before)
  expect(await describe($)).toBe('Reactions: off here · on in new chats')

  const later = seen.invalidated
  await react($, 'default off')
  expect(seen.invalidated).toBeGreaterThan(later)
  expect(await describe($)).toBe('Reactions: off here · off in new chats')

  // nothing changed, nothing to ask for again
  const now = seen.invalidated
  await react($, 'off')
  await react($, 'status')
  expect(seen.invalidated).toBe(now)
})
