import { atom, read, update } from 'claude-code'
import type { EngineInterface, HookStream, Register, RenderElement, TurnStepChunk, TurnStepResult } from 'claude-code'

import type { Place, Reaction } from '../types'
import {
  BRIEF,
  NO_RESPONSE,
  OFF_NOTE,
  couldBeEmoji,
  isOneEmoji,
  joinReactions,
  markOf,
  marksOf,
  reactionFor,
  reactionsHeld,
  withReaction,
} from './reactions'

const isOn = atom({ plugin: 'react', key: 'isOn' } as const, false)
const isBriefed = atom({ plugin: 'react', key: 'isBriefed' } as const, false)
const reactions = atom({ plugin: 'react', key: 'reactions' } as const, [])
const answering = atom({ plugin: 'react', key: 'answering' } as const, null)
const place = atom({ plugin: 'react', key: 'place' } as const, 'corner')

// The ways a person's own prompt arrives: typed in the terminal, the desktop
// app (an SDK host) or Remote Control.
const PERSON = new Set(['composer', 'sdk', 'bridge'])

type Block = { type: string; [field: string]: unknown }

function textsOf(content: readonly Block[]): string[] {
  return content.flatMap(block => (block.type === 'text' && typeof block.text === 'string' ? [block.text] : []))
}

// Reactions are on in a session from the person's /react until they run it again. Off,
// the mod leaves the session be: nothing beside the person's messages, replies go on as
// they come, and messages and replies are the engine's drawing alone.
async function flip($: EngineInterface): Promise<boolean> {
  let now = false
  await update($, isOn, was => (now = !was))
  await keep($)
  return now
}

// Where a session's switch and reactions are kept between runs of the app: whether it
// is on, when it was kept, whether the model was told, its reactions, and, once it has
// been on, the marks of its newest messages.
const recordKey = (sessionId: string) => `session:${sessionId}`
type Kept = { isOn: boolean; at: number; isBriefed: boolean; reactions: Reaction[]; marks: string[] }
const MARKS_KEPT = 200

// Keeps the switch and reactions for the session's next run. A session never on keeps
// no marks: one rewound or forked from it starts off as it would anyway. Best effort: a
// store or transcript that cannot be read or written keeps what it kept.
async function keep($: EngineInterface) {
  try {
    const key = recordKey(await $.session.id())
    const was = (await $.store.get(key)) as Partial<Kept> | undefined
    const now = await read($, isOn)
    const isMarked = now || (was?.marks?.length ?? 0) > 0
    const marks = isMarked ? marksOf(await $.session.messages()).slice(-MARKS_KEPT) : []
    await $.store.set(key, {
      isOn: now,
      at: await $.clock.now(),
      isBriefed: await read($, isBriefed),
      reactions: await read($, reactions),
      marks,
    } satisfies Kept)
  } catch {
    // kept as it was
  }
}

// What a session kept, and whether it is its own: for one rewound or forked, which starts
// under a new id with copies of the messages it kept, that of the session it came from:
// the kept one that knows the most of its messages, else, of those near that, the one
// kept last (the one it was just in). None when no session is known.
async function kept($: EngineInterface): Promise<{ record: Partial<Kept>; isOwn: boolean } | undefined> {
  const own = (await $.store.get(recordKey(await $.session.id()))) as Partial<Kept> | undefined
  if (own !== undefined) return { record: own, isOwn: true }
  const mine = new Set(marksOf(await $.session.messages()))
  if (mine.size === 0) return undefined
  const scored: { record: Partial<Kept>; score: number }[] = []
  for (const key of await $.store.keys()) {
    if (!key.startsWith('session:')) continue
    const record = ((await $.store.get(key)) ?? {}) as Partial<Kept>
    const score = new Set((record.marks ?? []).filter(mark => mine.has(mark))).size
    if (score > 0) scored.push({ record, score })
  }
  const best = Math.max(0, ...scored.map(s => s.score))
  if (best < 3) return undefined
  const near = scored.filter(s => s.score * 2 > best).sort((a, b) => (b.record.at ?? 0) - (a.record.at ?? 0))
  return near[0] === undefined ? undefined : { record: near[0].record, isOwn: false }
}

// Takes up what the session, or the one it came from, kept: the switch (one held on, by
// a reload, stays on), the reactions on messages it still holds, and, its own, whether
// the model was told.
async function takeUp($: EngineInterface) {
  const found = await kept($).catch(() => undefined)
  if (found === undefined) return
  const { record, isOwn } = found
  if (record.isOn === true) await update($, isOn, () => true)
  const theirs = record.reactions ?? []
  const held = isOwn ? theirs : reactionsHeld(theirs, await $.session.messages().catch(() => []))
  if (held.length > 0) await update($, reactions, mine => joinReactions(held, mine))
  if (isOwn && record.isBriefed === true) await update($, isBriefed, () => true)
}

// Where the desktop draws reactions is the person's choice for every session, kept
// under its own key; the corner until they choose. Best effort, as `keep` is.
const PLACE_KEY = 'place'
const PLACES: Record<Place, string> = {
  corner: "on your message's bottom-right corner",
  under: 'under your message, where its time and copy buttons show',
}
const isPlace = (value: unknown): value is Place => value === 'corner' || value === 'under'

async function takeUpPlace($: EngineInterface) {
  const chosen = await $.store.get(PLACE_KEY).catch(() => undefined)
  if (isPlace(chosen)) await update($, place, () => chosen)
}

// `/react place`: says where the desktop draws reactions; `/react place corner|under`
// moves them there, in every session from now on.
async function choosePlace($: EngineInterface, asked: string): Promise<string> {
  const how = 'Use `/react place corner` or `/react place under`.'
  if (asked === '') return `On the desktop, reactions sit ${PLACES[await read($, place)]}. ${how}`
  if (!isPlace(asked)) return `"${asked}" is not a place for reactions. ${how}`
  await update($, place, () => asked)
  await $.store.set(PLACE_KEY, asked).catch(() => undefined)
  return `On the desktop, reactions now sit ${PLACES[asked]}.`
}

// What the model is told beside the person's message: how reactions work once they come
// on (and again after a compaction), and once that they have gone off.
async function noteFor($: EngineInterface): Promise<string | undefined> {
  const now = await read($, isOn)
  if (now === (await read($, isBriefed))) return undefined
  await update($, isBriefed, () => now)
  await keep($)
  return now ? BRIEF : OFF_NOTE
}

// Puts `emoji` on the person's message the turn answers; whether there was one.
async function react($: EngineInterface, emoji: string): Promise<boolean> {
  const to = await read($, answering)
  if (to === null) return false
  await update($, reactions, list => withReaction(list, { id: to.id, mark: to.mark, emoji }))
  return true
}

// The main conversation's reply as it streams, its text held back while it could still
// be one emoji: then passed on as it came or, being one emoji on a person's message, as
// NO_RESPONSE, which the desktop draws as nothing, the emoji put on the message. A reply
// that calls a tool, or thinks after its text, is passed on as it came.
async function* reacting(
  $: EngineInterface,
  stream: HookStream<TurnStepChunk, TurnStepResult>,
): AsyncGenerator<TurnStepChunk, TurnStepResult> {
  // Every piece since the reply's text began, in order (null once passed on), and that text.
  let held: TurnStepChunk[] | null = []
  let text = ''
  let isReaction = false
  const settle = async () => isOneEmoji(text) && (await react($, text.trim()))
  for await (const chunk of stream) {
    if (held === null || (held.length === 0 && chunk.kind !== 'text')) {
      yield chunk
      continue
    }
    if (chunk.kind === 'stop') {
      isReaction = await settle()
      yield* isReaction ? asNoResponse(held) : held
      held = null
      yield chunk
      continue
    }
    held.push(chunk)
    if (chunk.kind === 'engine') continue
    if (chunk.kind === 'text') {
      text += chunk.text
      if (couldBeEmoji(text)) continue
    }
    yield* held
    held = null
  }
  if (held !== null) {
    isReaction = await settle()
    yield* isReaction ? asNoResponse(held) : held
  }
  const result = await stream.result
  return isReaction ? { ...result, answer: NO_RESPONSE } : result
}

// The pieces of a reply with its text as NO_RESPONSE, in the first piece of text.
function asNoResponse(held: TurnStepChunk[]): TurnStepChunk[] {
  const first = held.findIndex(chunk => chunk.kind === 'text')
  return held.flatMap((chunk, i): TurnStepChunk[] => {
    if (chunk.kind !== 'text') return [chunk]
    return i === first ? [{ ...chunk, text: NO_RESPONSE }] : []
  })
}

// A stored reply's blocks with its text as NO_RESPONSE, in its first text block.
function asNoResponseContent(content: readonly Block[]): Block[] {
  const first = content.findIndex(block => block.type === 'text')
  return content.flatMap((block, i) => (block.type !== 'text' ? [block] : i === first ? [{ type: 'text', text: NO_RESPONSE }] : []))
}

// Props that give a Box something to show, or room, though it holds nothing.
const SHAPED = /^(border|padding|margin|height|minHeight|width|minWidth|background)/

// A drawing that shows nothing, as a plugin beneath draws a row it hides: none, a Box
// drawn "none" that no hover reveals, or a Box or Text of only such with no shape of
// its own. Anything else, the engine's own drawing among it, shows something.
function isBlank(node: unknown): boolean {
  if (node === null || node === undefined || node === false || node === '') return true
  if (typeof node !== 'object') return false
  const el = node as { type?: unknown; props?: Record<string, unknown>; hover?: Record<string, unknown>; children?: unknown[] }
  if (el.type === 'Box' && el.props?.display === 'none') return el.hover?.display === undefined
  if (el.type !== 'Box' && el.type !== 'Text') return false
  if (Object.keys(el.props ?? {}).some(prop => SHAPED.test(prop))) return false
  return (el.children ?? []).every(isBlank)
}

const BADGE_HEIGHT = 20
const BADGE_WIDTH = 30

// The SVG of a reaction: the emoji in a small faint pill, as thread-chat draws its
// filter pills, light or dark with the app.
function badgePicture(emoji: string): string {
  const escaped = emoji.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
  const h = BADGE_HEIGHT
  const w = BADGE_WIDTH
  return [
    `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}" viewBox="0 0 ${w} ${h}">`,
    '<style>.bg{fill:#ffffff14;stroke:#ffffff38}',
    '@media (prefers-color-scheme: light){.bg{fill:#0000000a;stroke:#00000038}}</style>',
    `<rect class="bg" x="0.75" y="0.75" width="${w - 1.5}" height="${h - 1.5}" rx="${(h - 1.5) / 2}"/>`,
    `<text x="${w / 2}" y="${h / 2}" text-anchor="middle" dominant-baseline="central" font-size="12"`,
    ` font-family="Segoe UI Emoji, Apple Color Emoji, Noto Color Emoji, sans-serif">${escaped}</text>`,
    '</svg>',
  ].join('')
}

// How far up from the bottom of the message's row the desktop's reaction floats, in
// lines: the row ends with the room the desktop keeps under the bubble for the message's
// time and copy buttons (shown on hover), so one line up sits on the bubble's corner.
const RISE: Record<Place, number> = { corner: 1, under: 0 }

// A message with its reaction. On the desktop, a small pill floating over the message's
// row at its right edge, on the bubble's bottom-right corner or under it (`where`): the
// desktop draws the bubble and the time and copy buttons under it as one piece, so a pill
// drawn after it in the flow would sit below those buttons, away from the bubble. It
// floats beside the message, never round it: the engine refuses a drawing that puts
// position or size on a box holding its message. On the terminal, the emoji in faint
// brackets on the line under the message. Elsewhere, a pill on the line above the bubble,
// at the edge the person's messages keep to. Never beside the bubble in the flow: the
// desktop sizes its bubble to a share of the row it is drawn in, and a row shared with
// the badge shrinks to the message, so the bubble would narrow and its words wrap.
function withBadge(
  $: EngineInterface,
  e: Parameters<EngineInterface['ui']['resolve']>[0],
  message: RenderElement,
  emoji: string,
  where: Place,
): RenderElement {
  if (e.surface === 'desktop') {
    const { Box, Svg } = $.ui.resolve(e)
    return (
      <Box flexDirection="column">
        {message}
        <Box position="absolute" right={0} bottom={RISE[where]}>
          <Svg source={badgePicture(emoji)} alt={`Reaction: ${emoji}`} width={BADGE_WIDTH} height={BADGE_HEIGHT} />
        </Box>
      </Box>
    )
  }
  if (e.surface === 'terminal') {
    const { Box, Text } = $.ui.resolve(e)
    return (
      <Box flexDirection="column">
        {message}
        <Box flexDirection="row" marginLeft={2}>
          <Text dimColor>(</Text>
          <Text>{emoji}</Text>
          <Text dimColor>)</Text>
        </Box>
      </Box>
    )
  }
  const { Box, Svg } = $.ui.resolve(e)
  const isOnRight = e.surface === 'mobile'
  return (
    <Box flexDirection="column">
      <Box flexDirection="row" justifyContent={isOnRight ? 'flex-end' : 'flex-start'}>
        <Svg source={badgePicture(emoji)} alt={`Reaction: ${emoji}`} width={BADGE_WIDTH} height={BADGE_HEIGHT} />
      </Box>
      {message}
    </Box>
  )
}

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    await $.command.register({
      name: 'react',
      description: 'Turn emoji reactions on or off in this chat',
      argumentHint: '[place corner|under]',
    })
    // A restarted or resumed session takes up the switch and reactions it kept; a
    // rewound or forked one, those of the session it came from.
    await takeUp($)
    await takeUpPlace($)
    await keep($)
    return next(e)
  })

  // `/react` flips reactions on or off; `/react place …` says or moves where the desktop
  // draws them.
  on('command.run', { command: 'react' }, async ($, e) => {
    const [word = '', ...rest] = e.args.trim().split(/\s+/)
    if (word.toLowerCase() === 'place') return { text: await choosePlace($, rest.join(' ').toLowerCase()) }
    const now = await flip($)
    return {
      text: now
        ? 'Reactions are on: the agent may acknowledge a message with an emoji reaction on it instead of a reply.'
        : 'Reactions are off.',
    }
  })

  // Beside the person's message the model is told when reactions came on or went off:
  // that is the one way it is told. A system prompt section would not follow the switch,
  // as the engine sends the prompt it recorded at the first request until a compaction.
  on('prompt.submit', async ($, e, next) => {
    if (!PERSON.has(e.origin.kind)) return next(e)
    const note = await noteFor($)
    // While on, the marks a session rewound or forked from this one is known by are kept fresh.
    if (note === undefined && (await read($, isOn))) await keep($)
    return note === undefined ? next(e) : next({ ...e, context: [...(e.context ?? []), note] })
  })

  // A compaction may summarise how reactions work away: while they are on, the model is
  // told again beside the person's next message. (Gone off, it is still told so.)
  on('session.compact', async ($, e, next) => {
    const result = await next(e)
    const isCompacted = e.agentId === undefined && e.trigger !== 'precompute' && result.skip === undefined
    if (isCompacted && (await read($, isOn)) && (await read($, isBriefed))) {
      await update($, isBriefed, () => false)
      await keep($)
    }
    return result
  })

  // The person's message a turn answers is noted as it is stored: one sent to a running
  // turn too. A turn started by anything else (a notification, a command, a plugin's
  // prompt) answers none of theirs. While on, a reply of one emoji that reached here as
  // it came is stored as NO_RESPONSE all the same, and put on the message.
  on('session.append', async ($, e, next) => {
    if (e.agentId !== undefined) return next(e)
    const isTurnStart = e.door === 'prompt' || e.door === 'delivery' || e.door === 'command'
    if (e.message.type === 'user' && isTurnStart) {
      if (PERSON.has(e.origin.kind) && e.door !== 'command') {
        await update($, answering, () => ({ id: e.uuid, mark: markOf(textsOf(e.message.content)[0] ?? '') }))
      } else if (e.door !== 'delivery') {
        await update($, answering, () => null)
      }
    }
    if (e.door !== 'response' || e.message.type !== 'assistant' || !(await read($, isOn))) return next(e)
    const isText = e.message.content.every(block => block.type === 'text' || block.type === 'thinking' || block.type === 'redacted_thinking')
    const text = textsOf(e.message.content).join('')
    if (!isText || !isOneEmoji(text) || !(await react($, text.trim()))) return next(e)
    return next({ ...e, message: { ...e.message, content: asNoResponseContent(e.message.content) } })
  })

  // While on, the main conversation's reply of one emoji goes on as NO_RESPONSE, the
  // emoji put on the person's message it answers.
  on('turn.step', async function* ($, e, next) {
    if (e.agentId !== undefined || !(await read($, isOn))) return yield* next(e)
    return yield* reacting($, next(e))
  })

  // The reactions are kept for the session's next run as each turn ends.
  on('turn.complete', async ($, e, next) => {
    const result = await next(e)
    if (e.agentId === undefined && (await read($, isOn))) await keep($)
    return result
  })

  // A reply that became a reaction draws as nothing, on every surface. Off, a reply is
  // the engine's drawing alone.
  on('ui.render', { component: 'AssistantMessage' }, async ($, e, next) => {
    if (e.props.text.trim() !== NO_RESPONSE || !(await read($, isOn))) return next(e)
    const { Box } = $.ui.resolve(e)
    return <Box display="none" />
  })

  // A message with a reaction is the engine's drawing (or another mod's), the reaction on
  // it (on the desktop, its bubble's corner or under it, as the person chose; under it on
  // the terminal). A row drawn as nothing stays nothing.
  on('ui.render', { component: 'UserMessage' }, async ($, e, next) => {
    if (!(await read($, isOn))) return next(e)
    const isPerson = PERSON.has(e.props.origin.kind)
    const reaction = reactionFor(await read($, reactions), e.requestId, isPerson ? e.props.text : undefined)
    if (reaction === undefined) return next(e)
    const message = await next(e)
    if (isBlank(message)) return message
    return withBadge($, e, message, reaction.emoji, await read($, place))
  })
}
