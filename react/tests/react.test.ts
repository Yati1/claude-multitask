import type { On, RenderElement, TurnStepChunk } from 'claude-code'
import { expect, mock, test } from 'claude-code/testing'
import type { Engine } from 'claude-code/testing'

import { MENU, MENU_BUTTON, drawBand } from '../hooks/menu'
import { BRIEF, NO_RESPONSE, OFF_NOTE, couldBeEmoji, isOneEmoji, markOf, marksOf } from '../hooks/reactions'

type Seen = {
  // each prompt with the notes beside it
  prompts: string[]
  // set to have the model answer each request with these pieces
  reply?: TurnStepChunk[]
  // the rows stored, as the engine stores them: each as the chain answered it
  rows: { uuid: string; content: unknown }[]
}

// The test stands in for the engine beneath the plugin, and records each prompt that
// reached it with the notes beside it. `store` seeds the mod store; `null` leaves it
// to the test. A person's message reading "hidden by a plugin" is drawn as nothing, as
// another mod beneath may draw a row.
function engine(on: On, store: Record<string, unknown> | null = {}): Seen {
  const seen: Seen = { prompts: [], rows: [] }
  if (store !== null) mock.store(on, store)
  on('session.id', () => ({ value: 'session-1' }))
  on('session.start', ($, e) => ({ cwd: e.cwd }))
  on('command.register', ($, e) => ({ value: { command: e.name } }))
  on('ui.render', ($, e) => {
    if (e.component === 'UserMessage' && e.props.text === 'hidden by a plugin') {
      const { Box } = $.ui.resolve(e)
      return Box({ display: 'none' })
    }
    return { type: 'engine', ref: 0 }
  })
  on('prompt.submit', ($, e) => {
    seen.prompts.push([e.text, ...(e.context ?? [])].join('\n--\n'))
    return { text: e.text }
  })
  on('session.compact', () => ({ messages: [{ role: 'user' as const, text: 'the summary', toolUses: [] }] }))
  on('turn.step', async function* ($, e) {
    const reply = seen.reply ?? []
    for (const chunk of reply) yield chunk
    const answer = reply.flatMap(chunk => (chunk.kind === 'text' ? [chunk.text] : [])).join('')
    return { turnId: e.turnId, index: e.index, answer, toolUses: [], stopReason: 'end_turn' as const, usage: null }
  })
  on('turn.complete', ($, e) => ({ text: e.answer }))
  // Beneath the plugin: what reaches the transcript. Where the kit has no transcript to
  // store the row in, the append fails after this; the row is recorded all the same.
  on('session.append', ($, e, next) => {
    seen.rows.push({ uuid: e.uuid, content: e.message.content })
    return next(e)
  })
  return seen
}

const start = ($: Engine) => $.session.start({ cwd: '.', surface: 'desktop', isInteractive: true })
const flip = ($: Engine) => $.command.run({ command: 'react', args: '', origin: { kind: 'composer' }, presentation: {} as never })
const say = ($: Engine, text: string) => $.prompt.submit({ text, origin: { kind: 'composer' }, wait: false })

// A row of the main conversation as the engine stores it: a person's message (or, by
// `kind`, another party's), or a reply.
const storePrompt = ($: Engine, uuid: string, text: string, kind: 'composer' | 'task-notification' = 'composer') =>
  $.session.append({
    message: { type: 'user', role: 'user', content: [{ type: 'text', text }] },
    door: 'prompt',
    origin: { kind },
    uuid,
  }).catch(() => undefined)
const storeReply = ($: Engine, uuid: string, text: string) =>
  $.session.append({
    message: { type: 'assistant', role: 'assistant', content: [{ type: 'text', text }] },
    door: 'response',
    origin: { kind: 'model', model: 'opus' },
    uuid,
  }).catch(() => undefined)

const text = (piece: string): TurnStepChunk => ({ kind: 'text', index: 0, text: piece })
const thinking: TurnStepChunk = { kind: 'thinking', index: 0, text: 'Nothing to add.' }
const stop: TurnStepChunk = { kind: 'stop', stopReason: 'end_turn', usage: null }

// One model request of the main conversation (or of a subagent's): the pieces that came
// out and the answer it settled to.
async function step($: Engine, seen: Seen, pieces: TurnStepChunk[], agentId?: string) {
  seen.reply = pieces
  const stream = $.turn.step({ turnId: 't', index: 0, model: 'opus', messageCount: 1, ...(agentId === undefined ? {} : { agentId }) })
  const out: TurnStepChunk[] = []
  for (let piece = await stream.next(); ; piece = await stream.next()) {
    if (piece.done === true) return { out, answer: piece.value.answer }
    out.push(piece.value)
  }
}

// How a person's message draws on a surface: the reaction under it, or the engine's
// drawing alone, or nothing.
async function badgeOf($: Engine, surface: 'terminal' | 'desktop', requestId: string, said: string) {
  const row = await $.ui.mount({
    plugin: 'react',
    surface,
    component: 'UserMessage',
    props: { text: said, origin: { kind: 'composer' }, isExpanded: false },
    requestId,
  })
  try {
    const tree = (await row.drawn()) as { type: string; props?: { display?: string } }
    if (tree.type === 'engine') return 'none'
    if (tree.props?.display === 'none') return 'hidden'
    if (surface === 'desktop') return String((await row.find({ type: 'Svg' }))?.props.alt ?? 'no picture')
    const texts = await Promise.all(['(', ')'].map(mark => row.find({ type: 'Text', text: mark })))
    const emoji = await row.find({ type: 'Text', text: /\p{Extended_Pictographic}/u })
    return texts.every(t => t !== undefined) ? `(${emoji?.text ?? ''})` : 'no brackets'
  } finally {
    await row.unmount()
  }
}

test('a reply of one emoji, spacing round it aside, is a reaction; anything more or less is a reply', async () => {
  const scotland = '\u{1F3F4}\u{E0067}\u{E0062}\u{E0073}\u{E0063}\u{E0074}\u{E007F}'
  for (const one of ['👍', ' ✅\n', '👍🏽', '❤️', '🏳️‍🌈', '👩‍💻', '🇦🇺', '1️⃣', scotland]) {
    expect({ one, is: isOneEmoji(one) }).toEqual({ one, is: true })
  }
  for (const not of ['', ' ', 'ok', '1', '#', '👍👍', '👍 thanks', 'done 👍', ':+1:']) {
    expect({ not, is: isOneEmoji(not) }).toEqual({ not, is: false })
  }
  // held back while it could still turn out to be one, half a pair included
  for (const held of ['', '\n', '👍', '👍\uD83C', '\uD83D', '👩‍']) expect({ held, could: couldBeEmoji(held) }).toEqual({ held, could: true })
  for (const passed of ['On it', '👍 t', 'Done.']) expect({ passed, could: couldBeEmoji(passed) }).toEqual({ passed, could: false })
})

test('a chat that never turns reactions on is left as it is: no notes, replies as they come, no badges', async ($, on) => {
  const seen = engine(on)
  await start($)
  await say($, 'thanks for the fix')
  expect(seen.prompts).toEqual(['thanks for the fix'])
  await storePrompt($, 'p1', 'thanks for the fix')
  expect(await step($, seen, [text('👍'), stop])).toEqual({ out: [text('👍'), stop], answer: '👍' })
  expect(await badgeOf($, 'desktop', 'p1', 'thanks for the fix')).toBe('none')
})

test('the model is told how reactions work once they come on, again after a compaction, and once that they went off', async ($, on) => {
  const seen = engine(on)
  await start($)
  await flip($)
  await say($, 'hello')
  expect(seen.prompts.at(-1)).toBe(`hello\n--\n${BRIEF}`)
  await say($, 'and again')
  expect(seen.prompts.at(-1)).toBe('and again')

  await $.session.compact({ trigger: 'manual', messages: [{ role: 'user', text: 'hello', toolUses: [] }] })
  await say($, 'where were we')
  expect(seen.prompts.at(-1)).toBe(`where were we\n--\n${BRIEF}`)
  await say($, 'go on')
  expect(seen.prompts.at(-1)).toBe('go on')

  await flip($)
  await say($, 'words please')
  expect(seen.prompts.at(-1)).toBe(`words please\n--\n${OFF_NOTE}`)
  await say($, 'plain')
  expect(seen.prompts.at(-1)).toBe('plain')
  // another party's prompt gets no note
  await flip($)
  await $.prompt.submit({ text: 'a task finished', origin: { kind: 'task-notification' }, wait: false })
  expect(seen.prompts.at(-1)).toBe('a task finished')
})

test("a reply of one emoji goes on as \"No response requested.\" and draws as a reaction on the person's message", async ($, on) => {
  const seen = engine(on)
  await start($)
  await flip($)
  await storePrompt($, 'p1', 'thanks, that fixed the build')

  // Held back while it could be one emoji, then passed on as NO_RESPONSE in its place.
  expect(await step($, seen, [thinking, text('👍'), text('🏽\n'), stop])).toEqual({
    out: [thinking, text(NO_RESPONSE), stop],
    answer: NO_RESPONSE,
  })
  for (const surface of ['terminal', 'desktop'] as const) {
    expect({ surface, badge: await badgeOf($, surface, 'p1', 'thanks, that fixed the build') }).toEqual({
      surface,
      badge: surface === 'desktop' ? 'Reaction: 👍🏽' : '(👍🏽)',
    })
  }
  // A message with no reaction is the engine's drawing alone; one drawn under another id
  // is known by its text, where that is long enough to tell it from others.
  expect(await badgeOf($, 'desktop', 'p0', 'an earlier message')).toBe('none')
  expect(await badgeOf($, 'desktop', 'other-id', 'thanks, that fixed the build')).toBe('Reaction: 👍🏽')

  // A reply that goes on past the emoji, calls a tool, or is a subagent's goes on as it came.
  const more = [text('👍'), text(' and the tests pass too.'), stop]
  expect(await step($, seen, more)).toEqual({ out: more, answer: '👍 and the tests pass too.' })
  const tool: TurnStepChunk[] = [text('👍'), { kind: 'tool', index: 1, id: 'toolu_1', name: 'Bash' }, stop]
  expect((await step($, seen, tool)).out).toEqual(tool)
  expect(await step($, seen, [text('✅'), stop], 'agent-1')).toEqual({ out: [text('✅'), stop], answer: '✅' })
  expect(await badgeOf($, 'terminal', 'p1', 'thanks, that fixed the build')).toBe('(👍🏽)')

  // A turn another party started answers none of the person's messages: its emoji is a reply.
  await storePrompt($, 'n1', 'a background task finished', 'task-notification')
  expect(await step($, seen, [text('🎉'), stop])).toEqual({ out: [text('🎉'), stop], answer: '🎉' })
  expect(await badgeOf($, 'desktop', 'p1', 'thanks, that fixed the build')).toBe('Reaction: 👍🏽')

  // Off, the chat is the engine's drawing alone again.
  await flip($)
  expect(await badgeOf($, 'desktop', 'p1', 'thanks, that fixed the build')).toBe('none')
})

test('a reply of one emoji that reaches the transcript as it came is stored as "No response requested."', async ($, on) => {
  const seen = engine(on)
  await start($)
  await flip($)
  await storePrompt($, 'p1', 'can you rerun the deploy')
  await storeReply($, 'a1', '✅')
  expect(seen.rows.find(row => row.uuid === 'a1')?.content).toEqual([{ type: 'text', text: NO_RESPONSE }])
  expect(await badgeOf($, 'desktop', 'p1', 'can you rerun the deploy')).toBe('Reaction: ✅')
  // a reply in words is stored as it came
  await storeReply($, 'a2', 'Rerunning it now.')
  expect(seen.rows.find(row => row.uuid === 'a2')?.content).toEqual([{ type: 'text', text: 'Rerunning it now.' }])
})

test('a reply that became a reaction draws as nothing while on, and a message drawn as nothing gets no badge', async ($, on) => {
  const seen = engine(on)
  await start($)
  const reply = async (surface: 'terminal' | 'desktop') => {
    const row = await $.ui.mount({
      plugin: 'react',
      surface,
      component: 'AssistantMessage',
      props: { text: NO_RESPONSE, isFirstOfReply: true },
    })
    const tree = (await row.drawn()) as { type: string; props?: { display?: string } }
    await row.unmount()
    return tree.props?.display === 'none' ? 'nothing' : tree.type
  }
  expect(await reply('terminal')).toBe('engine')
  await flip($)
  for (const surface of ['terminal', 'desktop'] as const) expect({ surface, as: await reply(surface) }).toEqual({ surface, as: 'nothing' })

  await storePrompt($, 'p1', 'hidden by a plugin')
  await step($, seen, [text('👍'), stop])
  expect(await badgeOf($, 'desktop', 'p1', 'hidden by a plugin')).toBe('hidden')
})

// A conversation's messages as the engine lists them, and the record a session kept.
const SAID = ['why does the band wrap onto two rows?', 'Both mods share one row, so it wraps.', 'can it stay on one row instead?']
const listed = (texts: string[]) => texts.map((said, i) => ({ role: i % 2 === 0 ? ('user' as const) : ('assistant' as const), text: said, toolUses: [] }))
const record = (isOn: boolean, at: number, texts: string[], reactions: { id: string; mark: string; emoji: string }[] = []) => ({
  isOn,
  at,
  isBriefed: isOn,
  reactions,
  marks: marksOf(listed(texts)),
})

test('a session keeps its switch and reactions for its next run, with its messages\' marks once it has been on', async ($, on) => {
  const store: Record<string, unknown> = {}
  on('store.get', ($, e) => ({ value: store[e.key] }))
  on('store.set', ($, e) => {
    store[e.key] = e.value
    return { value: undefined }
  })
  on('store.keys', () => ({ value: Object.keys(store) }))
  mock.clock(on, { now: 1000 })
  const seen = engine(on, null)
  on('session.messages', () => ({ value: listed(SAID) }))

  await start($)
  expect(store['session:session-1']).toEqual({ isOn: false, at: 1000, isBriefed: false, reactions: [], marks: [] })
  await flip($)
  await storePrompt($, 'p1', SAID[0] as string)
  await step($, seen, [text('👍'), stop])
  await $.turn.complete({ answer: NO_RESPONSE, durationMs: 10, isAborted: false, turnId: 't', reason: 'answer' })
  expect(store['session:session-1']).toEqual({
    isOn: true,
    at: 1000,
    isBriefed: false,
    reactions: [{ id: 'p1', mark: markOf(SAID[0] as string), emoji: '👍' }],
    marks: marksOf(listed(SAID)),
  })
})

test('a restarted session takes up its switch and reactions, and the model is not told again', async ($, on) => {
  const seen = engine(on, {
    'session:session-1': record(true, 1, [], [{ id: 'p1', mark: markOf('thanks, that fixed the build'), emoji: '🙏' }]),
  })
  await start($)
  expect(await badgeOf($, 'desktop', 'p1', 'thanks, that fixed the build')).toBe('Reaction: 🙏')
  await say($, 'next thing')
  expect(seen.prompts.at(-1)).toBe('next thing')
})

test('a rewound or forked session, under a new id, takes up the switch and the reactions still in it from the session it came from', async ($, on) => {
  const left = 'and a later message the rewind left behind'
  const seen = engine(on, {
    'session:old': record(true, 1, [...SAID, left], [
      { id: 'p1', mark: markOf(SAID[0] as string), emoji: '👀' },
      { id: 'p9', mark: markOf(left), emoji: '🎉' },
    ]),
    'session:unrelated': record(false, 2, ['a different conversation altogether', 'with nothing in common at all']),
  })
  on('session.messages', () => ({ value: listed(SAID) }))
  await start($)
  expect(await badgeOf($, 'desktop', 'p1', SAID[0] as string)).toBe('Reaction: 👀')
  expect(await badgeOf($, 'desktop', 'p9', left)).toBe('none')
  // its history may not hold the note, so the model is told again
  await say($, 'go on')
  expect(seen.prompts.at(-1)).toBe(`go on\n--\n${BRIEF}`)
})

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

// Reactions' switch in the band's mods menu.
const SWITCH = 'mods-menu:react'

// The keys of the mods menu's switches, in the order drawn.
async function switchKeys(band: { findAll: (query: { type: string }) => Promise<{ key: string | undefined }[]> }) {
  return (await band.findAll({ type: 'Button' })).map(b => b.key ?? '').filter(key => key.startsWith('mods-menu:'))
}

test('alone, react draws the band with one mods menu, whose switch turns reactions on and off', async ($, on) => {
  const seen = engine(on)
  await start($)
  for (const surface of ['desktop', 'terminal'] as const) {
    const band = await $.ui.mount({ plugin: 'react', surface, ...BAND })
    expect(await band.findAll({ key: MENU })).toHaveLength(1)
    expect(await band.findAll({ key: MENU_BUTTON })).toHaveLength(1)
    expect(await switchKeys(band)).toEqual([SWITCH])
    expect((await band.find({ key: SWITCH }))?.props.label).toBe('off')
    await band.unmount()
  }
  const band = await $.ui.mount({ plugin: 'react', surface: 'desktop', ...BAND })
  await band.press({ key: SWITCH })
  await band.redraw()
  expect((await band.find({ key: SWITCH }))?.props.label).toBe('on')
  await say($, 'hello')
  expect(seen.prompts.at(-1)).toContain(BRIEF)
})

test('with the other mods drawn beneath, the band still holds one mods menu, every mod its switch in it', async ($, on) => {
  // thread-chat and multitask, drawn beneath through the same band as they draw it
  on('ui.render', { component: 'AbovePrompt' }, async ($, e) => {
    const ui = $.ui.resolve(e)
    const parts = (name: string, rank: number, label: string, control: RenderElement, grows: boolean) => ({
      ui,
      surface: e.surface,
      controls: { rank, name, element: control, grows },
      switches: [{ rank, key: `mods-menu:${name}`, label, isOn: true, onPress: () => undefined }],
      isOpen: async () => false,
      onToggle: () => undefined,
    })
    const pills = ui.Text({ children: ['pills'] })
    const thoughts = ui.Button({ key: 'open-thoughts', label: 'thoughts', onPress: () => undefined })
    const multitask = await drawBand({ type: 'engine', ref: 0 }, parts('multitask', 20, 'Multitask', thoughts, false))
    return drawBand(multitask, parts('threads', 10, 'Threads', pills, true))
  })
  engine(on)
  await start($)
  for (const surface of ['desktop', 'terminal'] as const) {
    const band = await $.ui.mount({ plugin: 'react', surface, ...BAND })
    expect(await band.findAll({ key: MENU })).toHaveLength(1)
    expect(await band.findAll({ key: MENU_BUTTON })).toHaveLength(1)
    expect(await switchKeys(band)).toEqual(['mods-menu:threads', 'mods-menu:multitask', SWITCH])
    expect(await band.find({ text: /^pills$/ })).toBeDefined()
    expect(await band.find({ key: 'open-thoughts' })).toBeDefined()
    await band.unmount()
  }
})
