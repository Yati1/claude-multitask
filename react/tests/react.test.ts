import type { On, TurnStepChunk } from 'claude-code'
import { expect, mock, test } from 'claude-code/testing'
import type { Engine } from 'claude-code/testing'

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
// to the test. A person's message reading "hidden by a plugin" is drawn as nothing, and
// one reading "tagged by a plugin" with a row of tags above it, as another mod beneath
// may draw a row (thread-chat its thread tags).
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
    if (e.component === 'UserMessage' && e.props.text === 'tagged by a plugin') {
      const { Box, Text } = $.ui.resolve(e)
      const tags = Box({ flexDirection: 'row', justifyContent: 'flex-end', children: [Text({ children: ['DESIGN'] })] })
      return Box({ flexDirection: 'column', children: [tags, { type: 'engine', ref: 0 }] })
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

// The mod store as a plain record the test reads, for `engine(on, null)`.
function memoryStore(on: On): Record<string, unknown> {
  const store: Record<string, unknown> = {}
  on('store.get', ($, e) => ({ value: store[e.key] }))
  on('store.set', ($, e) => {
    store[e.key] = e.value
    return { value: undefined }
  })
  on('store.keys', () => ({ value: Object.keys(store) }))
  return store
}

const start = ($: Engine) => $.session.start({ cwd: '.', surface: 'desktop', isInteractive: true })
// The person's `/react …`: what it answers.
const runReact = async ($: Engine, args: string) =>
  ((await $.command.run({ command: 'react', args, origin: { kind: 'composer' }, presentation: {} as never })) as { text?: string }).text
const flip = ($: Engine) => runReact($, '')
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

// How a person's message draws on a surface: the reaction by it, or the engine's
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

// The props the engine refuses on any box that holds its own drawing of a message: such a
// drawing is refused whole and the engine's drawn alone.
const CONCEALING = ['display', 'overflow', 'position', 'width', 'height', 'minWidth', 'minHeight', 'top', 'left', 'right', 'bottom']

// Whether a reaction's picture is solid: before its faint pill it paints a shape in an
// opaque colour, in the dark scheme and the light, so what it floats over can't show
// through.
function isSolid(source: string): boolean {
  const [dark = '', light = ''] = source.split('@media')
  const isOpaque = (style: string) => /\.base\{fill:#[0-9a-f]{6}\}/i.test(style)
  const base = source.indexOf('class="base"')
  return isOpaque(dark) && isOpaque(light) && base !== -1 && base < source.indexOf('class="bg"')
}

// Where a person's message's reaction sits by it, read from the drawing: the way the box
// holding both runs, their order, and the edge the reaction keeps to in its own row, or
// where it floats over the message's row (and whether it is solid). Any prop the engine
// refuses on a box round its message is named after.
async function placeOf($: Engine, surface: 'terminal' | 'desktop', requestId: string, said: string) {
  const row = await $.ui.mount({
    plugin: 'react',
    surface,
    component: 'UserMessage',
    props: { text: said, origin: { kind: 'composer' }, isExpanded: false },
    requestId,
  })
  try {
    type Drawn = { type: string; props?: Record<string, unknown>; children?: unknown[] }
    const tree = (await row.drawn()) as Drawn
    const isDrawn = (node: unknown): node is Drawn => typeof node === 'object' && node !== null
    const holdsEngine = (node: unknown): boolean => isDrawn(node) && (node.type === 'engine' || (node.children ?? []).some(holdsEngine))
    // The refused props on the boxes from the root down to the engine's drawing.
    const round = (node: unknown): string[] =>
      isDrawn(node) && holdsEngine(node) && node.type !== 'engine'
        ? [...CONCEALING.filter(prop => node.props?.[prop] !== undefined), ...(node.children ?? []).flatMap(round)]
        : []
    const parts = (tree.children ?? []).filter(isDrawn).map(child => {
      if (holdsEngine(child)) return 'message'
      if (child.props?.position === 'absolute') {
        const picture = (child.children ?? []).filter(isDrawn).find(node => node.type === 'Svg')
        const solid = isSolid(String(picture?.props?.source ?? '')) ? 'solid ' : ''
        return `${solid}reaction floating at bottom ${child.props.bottom}, right ${child.props.right}`
      }
      const edge = child.props?.justifyContent
      return edge === undefined ? 'reaction' : `reaction at ${edge}`
    })
    const refused = round(tree)
    return `${tree.props?.flexDirection ?? 'row'}: ${parts.join(', ')}${refused.length > 0 ? `; message under ${refused.join(', ')}` : ''}`
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

test('a chat with reactions off is left as it is: no notes, replies as they come, no badges', async ($, on) => {
  const seen = engine(on, { isOnByDefault: false })
  await start($)
  await say($, 'thanks for the fix')
  expect(seen.prompts).toEqual(['thanks for the fix'])
  await storePrompt($, 'p1', 'thanks for the fix')
  expect(await step($, seen, [text('👍'), stop])).toEqual({ out: [text('👍'), stop], answer: '👍' })
  expect(await badgeOf($, 'desktop', 'p1', 'thanks for the fix')).toBe('none')
})

test('the model is told how reactions work in a new chat, again after a compaction, and once that they went off', async ($, on) => {
  const seen = engine(on)
  await start($)
  await say($, 'hello')
  expect(seen.prompts.at(-1)).toBe(`hello\n--\n${BRIEF}`)
  await say($, 'and again')
  expect(seen.prompts.at(-1)).toBe('and again')

  await $.session.compact({ trigger: 'manual', messages: [{ role: 'user', text: 'hello', toolUses: [] }] })
  await say($, 'where were we')
  expect(seen.prompts.at(-1)).toBe(`where were we\n--\n${BRIEF}`)
  await say($, 'go on')
  expect(seen.prompts.at(-1)).toBe('go on')

  expect(await flip($)).toBe('Reactions are off in this chat.')
  await say($, 'words please')
  expect(seen.prompts.at(-1)).toBe(`words please\n--\n${OFF_NOTE}`)
  await say($, 'plain')
  expect(seen.prompts.at(-1)).toBe('plain')
  // another party's prompt gets no note
  expect(await flip($)).toContain('Reactions are on in this chat')
  await $.prompt.submit({ text: 'a task finished', origin: { kind: 'task-notification' }, wait: false })
  expect(seen.prompts.at(-1)).toBe('a task finished')
})

test("a reply of one emoji goes on as \"No response requested.\" and draws as a reaction on the person's message", async ($, on) => {
  const seen = engine(on)
  await start($)
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
  // On the desktop it floats, solid, on the bubble's bottom-right corner: a line up from
  // the room kept under the bubble for its time and copy buttons and a column in from its
  // right edge, nothing round the message. On the terminal it is the line under the message.
  expect(await placeOf($, 'desktop', 'p1', 'thanks, that fixed the build')).toBe('column: message, solid reaction floating at bottom 1, right 1')
  expect(await placeOf($, 'terminal', 'p1', 'thanks, that fixed the build')).toBe('column: message, reaction')
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
  await storePrompt($, 'p1', 'can you rerun the deploy')
  await storeReply($, 'a1', '✅')
  expect(seen.rows.find(row => row.uuid === 'a1')?.content).toEqual([{ type: 'text', text: NO_RESPONSE }])
  expect(await badgeOf($, 'desktop', 'p1', 'can you rerun the deploy')).toBe('Reaction: ✅')
  // a reply in words is stored as it came
  await storeReply($, 'a2', 'Rerunning it now.')
  expect(seen.rows.find(row => row.uuid === 'a2')?.content).toEqual([{ type: 'text', text: 'Rerunning it now.' }])
})

test("the switch and reactions are kept as thread-chat's thread view reads them, to draw them as the chat does", async ($, on) => {
  const seen = engine(on)
  // what the mod writes to its values, as another plugin reads them
  const written: Record<string, unknown> = {}
  on('state.set', { plugin: 'react' }, ($, e, next) => {
    written[e.key] = e.value
    return next(e)
  })
  await start($)
  await storePrompt($, 'p1', 'thanks, that fixed the build')
  await step($, seen, [text('👍'), stop])
  expect(written.isOn).toBe(true)
  expect(written.reactions).toEqual([{ id: 'p1', mark: markOf('thanks, that fixed the build'), emoji: '👍' }])
  await flip($)
  expect(written.isOn).toBe(false)
})

test('a reply that became a reaction draws as nothing while on, and a message drawn as nothing gets no badge', async ($, on) => {
  const seen = engine(on, { isOnByDefault: false })
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

test('a place kept by an older version (under the message) is ignored: the reaction sits on the corner', async ($, on) => {
  const seen = engine(on, { place: 'under' })
  await start($)
  await storePrompt($, 'p1', 'can you rerun the deploy')
  await step($, seen, [text('✅'), stop])
  expect(await placeOf($, 'desktop', 'p1', 'can you rerun the deploy')).toBe('column: message, solid reaction floating at bottom 1, right 1')
})

test('with a row a mod beneath draws above the message (thread tags), the reaction floats on the corner, adding no row', async ($, on) => {
  const seen = engine(on)
  await start($)
  await storePrompt($, 'p1', 'tagged by a plugin')
  await step($, seen, [text('👍'), stop])
  // The mod's drawing, its tag row with the message, is the one thing in the flow; the
  // reaction floats over the row's bottom-right corner, round nothing.
  expect(await placeOf($, 'desktop', 'p1', 'tagged by a plugin')).toBe('column: message, solid reaction floating at bottom 1, right 1')
})

// A conversation's messages as the engine lists them, and the record a session kept.
const SAID = ['why does the band wrap onto two rows?', 'Both mods share one row, so it wraps.', 'can it stay on one row instead?']
const listed = (texts: string[]) => texts.map((said, i) => ({ role: i % 2 === 0 ? ('user' as const) : ('assistant' as const), text: said, toolUses: [] }))
// `choice` is the person's own in the session, null if never made: then it was on, by
// the default.
const record = (choice: boolean | null, at: number, texts: string[], reactions: { id: string; mark: string; emoji: string }[] = []) => ({
  isOn: choice ?? true,
  choice,
  at,
  isBriefed: choice ?? true,
  reactions,
  marks: marksOf(listed(texts)),
})

test("a session keeps its switch, the person's choice and its reactions for its next run, with its messages' marks once it has been on", async ($, on) => {
  const store = memoryStore(on)
  mock.clock(on, { now: 1000 })
  const seen = engine(on, null)
  on('session.messages', () => ({ value: listed(SAID) }))
  const marks = marksOf(listed(SAID))

  await start($)
  expect(store['session:session-1']).toEqual({ isOn: true, choice: null, at: 1000, isBriefed: false, reactions: [], marks })
  await storePrompt($, 'p1', SAID[0] as string)
  await step($, seen, [text('👍'), stop])
  await $.turn.complete({ answer: NO_RESPONSE, durationMs: 10, isAborted: false, turnId: 't', reason: 'answer' })
  const reactions = [{ id: 'p1', mark: markOf(SAID[0] as string), emoji: '👍' }]
  expect(store['session:session-1']).toEqual({ isOn: true, choice: null, at: 1000, isBriefed: false, reactions, marks })
  await flip($)
  expect(store['session:session-1']).toEqual({ isOn: false, choice: false, at: 1000, isBriefed: false, reactions, marks })
})

test('a session never on keeps no marks', async ($, on) => {
  const store = memoryStore(on)
  store.isOnByDefault = false
  mock.clock(on, { now: 1000 })
  engine(on, null)
  on('session.messages', () => ({ value: listed(SAID) }))
  await start($)
  expect(store['session:session-1']).toEqual({ isOn: false, choice: null, at: 1000, isBriefed: false, reactions: [], marks: [] })
})

test('/react default flips whether reactions are on in new chats, kept for every session, and says what it is now', async ($, on) => {
  const store = memoryStore(on)
  const seen = engine(on, null)
  await start($)
  const where = 'in new chats and in chats where you have not used `/react`.'

  // This chat, never switched with /react, follows the default.
  expect(await runReact($, 'default')).toBe(`Reactions are now off by default, ${where}`)
  expect(store.isOnByDefault).toBe(false)
  await say($, 'hello')
  expect(seen.prompts.at(-1)).toBe('hello')

  // Switched with /react, it keeps its own choice whatever the default.
  expect(await flip($)).toContain('Reactions are on in this chat')
  expect(await runReact($, 'Default')).toBe(`Reactions are now on by default, ${where}`)
  expect(store.isOnByDefault).toBe(true)
  expect(await runReact($, 'default')).toBe(`Reactions are now off by default, ${where} This chat keeps them on; \`/react\` turns them off here.`)
  expect(store.isOnByDefault).toBe(false)
  await say($, 'still on here')
  expect(seen.prompts.at(-1)).toBe(`still on here\n--\n${BRIEF}`)
  await storePrompt($, 'p1', 'thanks, that fixed the build')
  expect((await step($, seen, [text('👍'), stop])).answer).toBe(NO_RESPONSE)
})

test('a restarted session takes up its choice of on over a default of off, and its reactions, and the model is not told again', async ($, on) => {
  const seen = engine(on, {
    isOnByDefault: false,
    'session:session-1': record(true, 1, [], [{ id: 'p1', mark: markOf('thanks, that fixed the build'), emoji: '🙏' }]),
  })
  await start($)
  expect(await badgeOf($, 'desktop', 'p1', 'thanks, that fixed the build')).toBe('Reaction: 🙏')
  await say($, 'next thing')
  expect(seen.prompts.at(-1)).toBe('next thing')
})

test('a restarted session keeps its choice of off over a default of on', async ($, on) => {
  const seen = engine(on, { 'session:session-1': record(false, 1, []) })
  await start($)
  await say($, 'next thing')
  expect(seen.prompts.at(-1)).toBe('next thing')
  expect(await step($, seen, [text('👍'), stop])).toEqual({ out: [text('👍'), stop], answer: '👍' })
})

test('a restarted session never switched follows the default as it is now, and the model is told they went off', async ($, on) => {
  const seen = engine(on, { isOnByDefault: false, 'session:session-1': record(null, 1, []) })
  await start($)
  await say($, 'next thing')
  expect(seen.prompts.at(-1)).toBe(`next thing\n--\n${OFF_NOTE}`)
})

test('a session kept off before the default was on follows the default', async ($, on) => {
  const seen = engine(on, { 'session:session-1': { isOn: false, at: 1, isBriefed: false, reactions: [], marks: [] } })
  await start($)
  await say($, 'next thing')
  expect(seen.prompts.at(-1)).toBe(`next thing\n--\n${BRIEF}`)
})

test('a rewound or forked session, under a new id, takes up the choice and the reactions still in it from the session it came from', async ($, on) => {
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

test('a rewound or forked session takes up the choice of off from the session it came from', async ($, on) => {
  const seen = engine(on, { 'session:old': record(false, 1, SAID) })
  on('session.messages', () => ({ value: listed(SAID) }))
  await start($)
  await say($, 'go on')
  expect(seen.prompts.at(-1)).toBe('go on')
  expect(await step($, seen, [text('👍'), stop])).toEqual({ out: [text('👍'), stop], answer: '👍' })
})
