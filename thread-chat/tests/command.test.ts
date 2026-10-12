import type { On } from 'claude-code'
import { expect, test } from 'claude-code/testing'
import type { Engine } from 'claude-code/testing'

// What the test saw of /threads: the questions asked in the engine's dialog, each as
// `question [header] option / option`, how many times the menu was told the command's
// line changed, the hint the command registered with, and the prompts that reached the
// engine, each with the notes beside it.
type Seen = { asked: string[]; invalidated: number; hint?: string; prompts: string[] }

type Question = { question: string; header: string; options: { label: string }[] }

// The test stands in for the engine beneath the plugin, and for the person at its
// question dialog: each question is answered from `answers` (by its text) or, with no
// answer there, dismissed. `surfaces` are where the session draws: none, no one to ask.
function engine(on: On, answers: Record<string, string>, surfaces: readonly ('desktop' | 'terminal')[] = ['desktop']) {
  const seen: Seen = { asked: [], invalidated: 0, prompts: [] }
  const store: Record<string, unknown> = {}
  on('store.get', ($, e) => ({ value: store[e.key] }))
  on('store.set', ($, e) => {
    store[e.key] = e.value
    return { value: undefined }
  })
  on('store.keys', () => ({ value: Object.keys(store) }))
  on('session.id', () => ({ value: 'session-1' }))
  on('session.start', ($, e) => ({ cwd: e.cwd }))
  on('session.surfaces', () => ({ value: surfaces }))
  on('prompt.submit', ($, e) => {
    seen.prompts.push([e.text, ...(e.context ?? [])].join('\n--\n'))
    return { text: e.text }
  })
  on('tool.register', ($, e) => ({ value: { tool: `mcp__thread-chat__${e.name}` } }))
  on('command.register', ($, e) => {
    if (e.name === 'threads') seen.hint = e.argumentHint
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
const threads = async ($: Engine, args = '') =>
  (await $.command.run({ command: 'threads', args, origin: { kind: 'composer' }, presentation: {} as never })).text
const status = ($: Engine) => threads($, 'status')
const say = ($: Engine, text: string) => $.prompt.submit({ text, origin: { kind: 'composer' }, wait: false })
// A command's line in the menu.
const describe = async ($: Engine, command = 'threads') =>
  (
    await $.command.describe({
      command,
      description: 'as registered',
      isHidden: false,
      immediate: false,
      provider: { plugin: 'thread-chat', tier: 'user' },
    })
  ).description

const HERE = 'Threads in this chat?'
const NEW = 'Threads in new chats?'
const ON_TEXT = 'Threads are on: start or reply to one with a # name heading (or + thread in the desktop app).'
const OFF_TEXT = 'Threads are off. They are kept for when /threads turns them on again.'
const WHERE = 'as do chats where you have not turned them on or off.'
const USAGE = 'Usage: `/threads [on|off|toggle|status|default [on|off]]`; with no argument it asks.'

test('/threads alone asks for this chat, then new chats, the current option marked, and changes each as answered', async ($, on) => {
  const answers: Record<string, string> = { [HERE]: 'On', [NEW]: 'On' }
  const { seen, store } = engine(on, answers)
  await start($)

  expect(await threads($)).toBe(`${ON_TEXT}\n\nNew chats now start with threads on, ${WHERE}`)
  expect(seen.asked).toEqual([`${HERE} [This chat] On / Off (current)`, `${NEW} [New chats] On / Off (current)`])
  expect(await status($)).toBe('Threads: on in this chat (your choice) · on in new chats')
  expect(store.isOnByDefault).toBe(true)
  // on, the model is told how threads work
  await say($, 'hello')
  expect(seen.prompts.at(-1)).toContain('# Conversation threads')

  // turned off here, it says so as /threads off does; this chat's choice is kept over the default
  seen.asked.length = 0
  answers[HERE] = 'Off'
  answers[NEW] = 'On (current)'
  expect(await threads($)).toBe(OFF_TEXT)
  expect(seen.asked).toEqual([`${HERE} [This chat] On (current) / Off`, `${NEW} [New chats] On (current) / Off`])
  expect(await status($)).toBe('Threads: off in this chat (your choice) · on in new chats')
})

test('a dismissed question changes nothing and asks nothing more; an answer of what is so, or of neither, changes nothing', async ($, on) => {
  const answers: Record<string, string> = {}
  const { seen } = engine(on, answers)
  await start($)
  const unchanged = 'No change. Threads: off in this chat (following the default) · off in new chats'

  expect(await threads($)).toBe(unchanged)
  expect(seen.asked).toEqual([`${HERE} [This chat] On / Off (current)`])

  answers[HERE] = 'Off (current)'
  expect(await threads($)).toBe(unchanged)
  expect(seen.asked).toHaveLength(3)

  answers[HERE] = 'not sure'
  expect(await threads($)).toBe(unchanged)

  // the first answered, the second dismissed: the first change stands
  answers[HERE] = 'On'
  expect(await threads($)).toBe(ON_TEXT)
  expect(await status($)).toBe('Threads: on in this chat (your choice) · off in new chats')
})

test('where no one can be asked, /threads and /threads default say how threads are instead', async ($, on) => {
  const { seen } = engine(on, { [HERE]: 'On', [NEW]: 'On' }, [])
  await start($)
  const now = 'Threads: off in this chat (following the default) · off in new chats'
  expect(await threads($)).toBe(now)
  expect(await threads($, 'default')).toBe(now)
  expect(seen.asked).toEqual([])
})

test('/threads on, off, enable, disable and toggle set this chat; what is so already changes nothing and says so', async ($, on) => {
  const { seen } = engine(on, {})
  await start($)
  expect(await threads($, 'off')).toBe('Threads are already off in this chat.')
  expect(await status($)).toBe('Threads: off in this chat (following the default) · off in new chats')
  expect(await threads($, 'ON')).toBe(ON_TEXT)
  expect(await threads($, 'enable')).toBe('Threads are already on in this chat.')
  expect(await threads($, 'disable')).toBe(OFF_TEXT)
  expect(await threads($, 'toggle')).toBe(ON_TEXT)
  expect(await threads($, 'toggle')).toBe(OFF_TEXT)
  expect(await status($)).toBe('Threads: off in this chat (your choice) · off in new chats')
  expect(seen.asked).toEqual([])
})

test('/threads default asks for new chats alone; default on|off sets it; what is so already changes nothing', async ($, on) => {
  const answers: Record<string, string> = { [NEW]: 'On' }
  const { seen, store } = engine(on, answers)
  await start($)
  expect(await threads($, 'default')).toBe(`New chats now start with threads on, ${WHERE}`)
  expect(seen.asked).toEqual([`${NEW} [New chats] On / Off (current)`])
  expect(store.isOnByDefault).toBe(true)
  // this chat follows it
  expect(await status($)).toBe('Threads: on in this chat (following the default) · on in new chats')
  delete answers[NEW]
  expect(await threads($, 'default')).toBe('No change. Threads: on in this chat (following the default) · on in new chats')
  expect(await threads($, 'default enable')).toBe('Threads are already on by default in new chats.')
  // on already, by the default, `on` changes nothing: the chat still follows the default
  expect(await threads($, 'on')).toBe('Threads are already on in this chat.')
  expect(await status($)).toBe('Threads: on in this chat (following the default) · on in new chats')
  // a chat that chose keeps its choice, and says how to change it
  await threads($, 'off')
  expect(await threads($, 'default off')).toBe(`New chats now start with threads off, ${WHERE}`)
  expect(await threads($, 'default on')).toBe(`New chats now start with threads on, ${WHERE} This chat keeps them off; /threads on turns them on here.`)
  expect(store.isOnByDefault).toBe(true)
})

test('anything else changes nothing and says how to use /threads', async ($, on) => {
  const { seen, store } = engine(on, {})
  await start($)
  for (const args of ['sideways', 'on now', 'status please', 'default maybe', 'default off please', 'default toggle']) {
    expect(await threads($, args)).toBe(USAGE)
  }
  expect(await status($)).toBe('Threads: off in this chat (following the default) · off in new chats')
  expect(store.isOnByDefault).toBeUndefined()
  expect(seen.asked).toEqual([])
})

test("the menu's line for /threads says how threads are, here and in new chats, and is asked for again as that changes", async ($, on) => {
  const { seen } = engine(on, {})
  await start($)
  expect(seen.hint).toBe('[on|off|toggle|status|default [on|off]]')
  expect(await describe($)).toBe('Threads: off here · off in new chats')
  // the mod's other commands keep their own lines
  expect(await describe($, 'thread-view')).toBe('as registered')

  const before = seen.invalidated
  await threads($, 'on')
  expect(seen.invalidated).toBeGreaterThan(before)
  expect(await describe($)).toBe('Threads: on here · off in new chats')

  const later = seen.invalidated
  await threads($, 'default on')
  expect(seen.invalidated).toBeGreaterThan(later)
  expect(await describe($)).toBe('Threads: on here · on in new chats')

  // nothing changed, nothing to ask for again
  const now = seen.invalidated
  await threads($, 'on')
  await threads($, 'status')
  expect(seen.invalidated).toBe(now)
})
