import { atom, read, update } from 'claude-code'
import type {
  AgentStatus,
  EngineInterface,
  Register,
  RenderElement,
  SessionSendAddress,
  SessionSendResult,
  Timer,
  TurnCompleteReason,
} from 'claude-code'

import type { KeptThoughts, Thought, ThoughtStatus, Update } from '../types'
import type { HookStream, TurnStepChunk, TurnStepResult } from 'claude-code'
import {
  NO_RESPONSE,
  QUIET,
  RELAY_NOTES,
  THOUGHT,
  VOICE,
  VOICE_OFF,
  VOICE_REMINDER,
  WAKE,
  describeThoughts,
  formatNews,
  formatUpdates,
  fromPerson,
  heardOf,
  isQuiet,
  isRelayText,
  isWakeText,
  marksOf,
  newsOf,
  oneLine,
  pendingNote,
  relayNames,
} from './prompts'
import { TELL_FIELD, drawThoughts } from './pane'
import { BLINK_MS, FADE_MS, drawThoughtsButton } from './band'
import { watchSwitch } from './ui-switch'

const isOn = atom({ plugin: 'multitask', key: 'isOn' } as const, false)
const choice = atom({ plugin: 'multitask', key: 'choice' } as const, null)
const isEnabledByDefault = atom({ plugin: 'multitask', key: 'isEnabledByDefault' } as const, false)
const thoughts = atom({ plugin: 'multitask', key: 'thoughts' } as const, [])
const inbox = atom({ plugin: 'multitask', key: 'inbox' } as const, [])
const isMainBusy = atom({ plugin: 'multitask', key: 'isMainBusy' } as const, false)
const toldVoice = atom({ plugin: 'multitask', key: 'toldVoice' } as const, false)
const expanded = atom({ plugin: 'multitask', key: 'expanded' } as const, [])
const openReports = atom({ plugin: 'multitask', key: 'openReports' } as const, [])
const heard = atom({ plugin: 'multitask', key: 'heard' } as const, {})
const paneTick = atom({ plugin: 'multitask', key: 'paneTick' } as const, 0)
const bandTick = atom({ plugin: 'multitask', key: 'bandTick' } as const, 0)
const tellingTo = atom({ plugin: 'multitask', key: 'tellingTo' } as const, '')
const colorTurn = atom({ plugin: 'multitask', key: 'colorTurn' } as const, 0)
const showsAllEnded = atom({ plugin: 'multitask', key: 'showsAllEnded' } as const, false)

const PANE = 'multitask-thoughts'
// Multitask's dropdown in the band, drawn while the mod is on in the chat. Its face is the
// mode the chat is in, Multitask or Focus (Multitask mode off); picking the other mode
// switches to it.
const DROPDOWN = 'multitask'
// The keys of the hit areas over the parts of the desktop's `thoughts` button: this, then the part.
const THOUGHTS_HIT = 'thoughts-hit:'
const MULTITASK_MODE = 'multitask'
const FOCUS_MODE = 'focus'
const AGENT = 'multitask:thought'
const TOOL = {
  think: 'mcp__multitask__think',
  tell: 'mcp__multitask__tell',
  unqueue: 'mcp__multitask__unqueue',
  stop: 'mcp__multitask__stop',
  thoughts: 'mcp__multitask__thoughts',
} as const
const OWN_TOOLS: ReadonlySet<string> = new Set(Object.values(TOOL))

// The ways a person's own prompt arrives: typed in the terminal, the desktop
// app (an SDK host) or Remote Control.
const PERSON = new Set(['composer', 'sdk', 'bridge'])

// How hard a model request may be asked to think, from least to most.
const EFFORTS = ['low', 'medium', 'high', 'xhigh', 'max'] as const

// What the voice may still call itself while multitasking is on.
const VOICE_TOOLS = /^(mcp__multitask__|mcp__thread-chat__)|^(AskUserQuestion|ToolSearch)$/

// The colours thoughts are drawn in: the first ones, the clearest, taken in turn; the rest
// only while every one of those is held (see freeColor).
const FIRST_COLORS = ['#4fa3e0', '#d9636a', '#58b36b', '#c98a2e']
const PALETTE = [...FIRST_COLORS, '#9b6fd6', '#2fb3a6', '#d66bb0', '#8a9a3a']

// Updates arriving close together reach the voice as one message.
const FLUSH_MS = 2000
// How long an interrupted thought gets to end its turn before the message goes anyway.
const INTERRUPT_GRACE_MS = 4000
// How often, and how many times, a hand-over looks for the engine to have ended a thought's run.
const SETTLE_POLL_MS = 250
const SETTLE_POLLS = 20
// How long after a thought's turn ended its run may still count as running, ending, before
// what waits for it goes anyway.
const SETTLE_MS = SETTLE_POLL_MS * SETTLE_POLLS
// When the voice is woken to hand a thought what waits for it, should no hook of this
// mod's have handed it over since it fell due: after each of these waits, then no more.
const DUE_WAKES_MS = [3000, 15000, 60000]
// How many of a thought's progress notes are kept, and how long each may be.
const NOTES_KEPT = 5
const NOTE_MAX = 500
// How long the engine's notice that a thought's turn ended waits, at most, for that end
// to be settled.
const NOTICE_WAIT_MS = 1000
// How long after a change to the thoughts they are kept in the store, changes meanwhile
// going with it. A progress note alone keeps nothing: it goes with the next change, or as
// the session ends.
const KEEP_MS = 2000
// What of a session's thoughts the store keeps: those running, and of the rest the most
// recently ended, to this many in all and this many characters of JSON; each one's task and
// report cut to this length.
const THOUGHTS_KEPT = 200
const THOUGHTS_KEPT_CHARS = 256 * 1024
const TEXT_KEPT = 4000
// Of the sessions whose thoughts the store keeps, those kept last, to this many and this
// many characters of JSON in all; the rest are dropped as a session starts. The store
// holds 4 MiB at most, the switches of every session included.
const SESSIONS_KEPT = 20
const SESSIONS_KEPT_CHARS = 2 * 1024 * 1024
// What marks the engine's own hand-back of an agent's final report to the session that
// started it ("Another Claude session sent a message: ... [Subagent hand-back] ...").
const HANDBACK = '[Subagent hand-back]'

const OFF = {
  deny: 'Multitask mode is off. The user switches to it with the dropdown above the prompt or /multitask mode, or, where Multitask is off in the chat, turns it on with /multitask.',
}
const NOT_VOICE = { deny: 'Only the voice starts, steers or lists thoughts; this call came from another agent.' }

let flushTimer: Timer | undefined
// What keeps the thoughts in the store KEEP_MS after a change, while one is pending.
let keepTimer: Timer | undefined
// What draws the Thoughts pane's ages afresh, AGE_TICK_MS after it was last drawn.
let ageTick: Timer | undefined
const AGE_TICK_MS = 60_000
// What draws the band afresh when its dots next change (band.tsx), and when each running
// thought's turn was last seen to end or it was stopped, by thought id, for its dot to
// fade out by: kept here, as `settling` is, and set before the change it goes with.
let bandTimer: Timer | undefined
const endings = new Map<string, number>()
// When each running thought's dot last began to blink, by thought id: kept here, so a row
// that starts no blink writes nothing to state and draws nothing afresh.
const blinks = new Map<string, number>()
// The settling of each thought's latest turn end, by thought id, with its name, which the
// engine's notice or hand-back of that end waits for. Kept here, not in state: what one
// dispatch reads of state stands still while it runs, so a wait for it would never see it.
const settling = new Map<string, { name: string; done: Promise<void> }>()
// Of the messages due to each thought, by thought id, kept here for the same reason: the
// hand-overs in flight, when each thought's fell due, the refusal the voice was last told
// of, and the timer that wakes the voice to hand them over.
const handingOver = new Set<string>()
const dueAt = new Map<string, number>()
const toldRefusal = new Map<string, string>()
const dueWakes = new Map<string, Timer>()

// Whether an engine's notice or hand-back is about this thought: the notice names its
// agent id, the hand-back its sender (by id or, once named, by name).
const isAbout = (text: string, id: string, name: string) => text.includes(id) || text.includes(`from="${name}"`)

// How tell delivers a message, given as `how` (or `mode`).
const TELL_HOWS = ['post', 'queue', 'interrupt']

const TOOL_SPECS = [
  {
    name: 'think',
    description:
      'Start a thought: a background agent that does the work on one task while you keep talking with the user. Give it a self-contained brief; it cannot see this conversation.',
    inputSchema: {
      type: 'object',
      properties: {
        name: {
          type: 'string',
          description:
            'A short kebab-case name for the thought, 1-3 words, by its task (fix-login-expiry); one already taken gets -2, -3',
        },
        task: { type: 'string', description: 'The full, self-contained brief' },
      },
      required: ['name', 'task'],
    },
  },
  {
    name: 'tell',
    description:
      'Give the thought `name` the text `message`, delivered as `how`. post (default): it reads it at its next step. queue: held until it finishes its current turn (can be unqueued until then). interrupt: cut what it is doing and hand it this now.',
    inputSchema: {
      type: 'object',
      properties: {
        name: { type: 'string', description: 'The thought\'s name' },
        message: { type: 'string' },
        how: { type: 'string', enum: TELL_HOWS, description: 'post, queue or interrupt; default post' },
      },
      required: ['name', 'message'],
    },
  },
  {
    name: 'unqueue',
    description: 'Withdraw messages queued for a thought before it reads them.',
    inputSchema: {
      type: 'object',
      properties: {
        name: { type: 'string', description: 'The thought\'s name' },
        index: { type: 'integer', description: '1-based position in its queue; leave out to withdraw all' },
      },
      required: ['name'],
    },
  },
  {
    name: 'stop',
    description: 'Stop a thought for good.',
    inputSchema: {
      type: 'object',
      properties: { name: { type: 'string', description: 'The thought\'s name' } },
      required: ['name'],
    },
  },
  {
    name: 'thoughts',
    description:
      'Every thought\'s status, queue, latest progress notes and last report; with a thought\'s name, its recent transcript instead.',
    inputSchema: { type: 'object', properties: { name: { type: 'string', description: 'The thought\'s name' } } },
  },
]

function str(e: unknown, key: string): string {
  const value = (e as Record<string, unknown>)[key]
  return typeof value === 'string' ? value.trim() : ''
}

// The thought a call names: every tool takes its name as `name`, as think gives it; an
// earlier spelling, `thought`, still works.
function refOf(e: unknown): string {
  return str(e, 'name') || str(e, 'thought')
}

function findThought(list: Thought[], ref: string): Thought | undefined {
  const wanted = ref.toLowerCase()
  return list.find(t => t.id === ref) ?? list.find(t => t.name.toLowerCase() === wanted)
}

function unknownThought(list: Thought[], ref: string) {
  const names = list.map(t => t.name).join(', ') || 'none'
  if (ref === '') return { deny: `Give the thought's name as \`name\`. Thoughts: ${names}.` }
  return { deny: `No thought called "${ref}". Thoughts: ${names}.` }
}

// What tell answers: what became of the message, or, as an error, why it did not arrive.
type TellAnswer = { result: string } | { deny: string }

function notDelivered(t: Thought, reason: string): TellAnswer {
  return { deny: `${t.name} did not get the message: ${reason}` }
}

// A thought's name: up to three words of the text in lower-case kebab-case, of plain
// letters and digits alone, as an agent's name is spelled; "" when it has none.
function slug(text: string): string {
  const words = text
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter(word => word !== '')
    .slice(0, 3)
  return words.join('-').slice(0, 40).replace(/-+$/, '')
}

function uniqueName(list: Thought[], name: string): string {
  const taken = new Set(list.map(t => t.name))
  let candidate = name
  for (let n = 2; taken.has(candidate); n++) candidate = `${name}-${n}`
  return candidate
}

// The colour a thought takes as it starts, or resumes when its own is taken, and where the
// turn through the first colours stands after it. The first colours go in turn from `turn`,
// past any another running thought holds, and the turn moves on past the one taken, so
// thoughts started one after another go through them all; with every first colour held,
// the first of the rest no running thought holds, the turn left as it is; with every one
// held, the one fewest hold. An ended thought holds none, so a new one may take its colour.
function freeColor(list: readonly Thought[], turn: number, except?: string): { color: string; turn: number } {
  const held = list.filter(t => t.status === 'running' && t.id !== except).map(t => t.color)
  const next = [...FIRST_COLORS.slice(turn), ...FIRST_COLORS.slice(0, turn)].find(color => !held.includes(color))
  if (next !== undefined) return { color: next, turn: (FIRST_COLORS.indexOf(next) + 1) % FIRST_COLORS.length }
  const holders = (color: string) => held.filter(one => one === color).length
  return { color: PALETTE.reduce((best, color) => (holders(color) < holders(best) ? color : best)), turn }
}

// Picks a colour for a thought in `list` through freeColor, moving the turn on.
type PickColor = (list: readonly Thought[], except?: string) => string

// A thought set running in `list`: one running already is left as it is, so its rows keep
// their colour while it runs; one resuming keeps its colour unless a running thought now
// holds it, then takes a free one.
function asRunning(list: readonly Thought[], t: Thought, pick: PickColor): Thought {
  if (t.status === 'running') return t
  const isTaken = list.some(one => one.id !== t.id && one.status === 'running' && one.color === t.color)
  return { ...t, status: 'running', color: isTaken ? pick(list, t.id) : t.color }
}

function statusOf(status: AgentStatus): ThoughtStatus {
  if (status === 'failed') return 'failed'
  if (status === 'killed') return 'stopped'
  if (status === 'completed' || status === 'idle') return 'idle'
  return 'running'
}

function textOf(content: readonly { type: string; [field: string]: unknown }[]): string {
  return content
    .filter(block => block.type === 'text' && typeof block.text === 'string')
    .map(block => block.text as string)
    .join('\n')
    .trim()
}

// The time now, for the Thoughts pane's ages; none where the clock cannot be read, which
// leaves them out and fails nothing else.
async function timeNow($: EngineInterface): Promise<number | undefined> {
  try {
    return await $.clock.now()
  } catch {
    return undefined
  }
}

// Updates the thoughts through `fn`, which picks any colour it needs with `pick`. Where the
// turn through the first colours then stands is kept in state, so a reload carries it on.
async function updateThoughts($: EngineInterface, fn: (list: readonly Thought[], pick: PickColor) => Thought[]) {
  const start = await read($, colorTurn)
  let turn = start
  await update($, thoughts, list => {
    // Run again from the start should the write miss.
    turn = start
    return fn(list, (all, except) => {
      const picked = freeColor(all, turn, except)
      turn = picked.turn
      return picked.color
    })
  })
  if (turn !== start) await update($, colorTurn, () => turn)
  scheduleKeep($)
}

async function patchThought($: EngineInterface, id: string, fn: (t: Thought) => Thought) {
  await update($, thoughts, list => list.map(t => (t.id === id ? fn(t) : t)))
  scheduleKeep($)
}

// Patches a thought as patchThought does, for a change that may pick it a colour.
async function patchPicking($: EngineInterface, id: string, fn: (t: Thought, list: readonly Thought[], pick: PickColor) => Thought) {
  await updateThoughts($, (list, pick) => list.map(t => (t.id === id ? fn(t, list, pick) : t)))
}

// Opens a thought in the Thoughts pane to show everything, or closes it: a finished
// thought's one line becomes its whole card, a running card shows its whole task.
async function toggleExpanded($: EngineInterface, id: string) {
  await update($, expanded, ids => (ids.includes(id) ? ids.filter(one => one !== id) : [...ids, id]))
}

// Opens a thought's last report in the Thoughts pane to read whole, or folds it to its first line.
async function toggleReport($: EngineInterface, id: string) {
  await update($, openReports, ids => (ids.includes(id) ? ids.filter(one => one !== id) : [...ids, id]))
}

// Opens the field in a thought's card in the Thoughts pane to tell it something, or closes it.
async function toggleTell($: EngineInterface, id: string) {
  await update($, tellingTo, was => (was === id ? '' : id))
}

// Multitask is on in a chat as the person last chose there with /multitask, else as the
// default (`/multitask default`), off until they choose. Off, the mod leaves the chat be:
// nothing above the prompt but the `thoughts` button while a thought it started is left,
// Focus mode, no tool of the voice's offered. On, the chat is in Multitask mode (isOn),
// where it is the voice, or in Focus, as off but with the band's dropdown; the dropdown or
// `/multitask mode` switches between them. Turned on with /multitask, or on by default in
// a new chat, it starts in Multitask mode; an open chat the default turns on stays in
// Focus. Multitask mode is only for a chat the mod is on in: off, it is left (settleMode).
async function isEnabled($: EngineInterface): Promise<boolean> {
  return (await read($, choice)) ?? (await read($, isEnabledByDefault))
}

// Leaves Multitask mode where the mod is off in the chat: a default gone off, or state a
// reload of this code kept from before.
async function settleMode($: EngineInterface) {
  if ((await read($, isOn)) && !(await isEnabled($))) await setMode($, false)
}

// The voice's tools are the model's from Multitask mode first coming on: a session that
// never switches to it has no tool of this mod's. Registered again, each is replaced.
async function offerVoiceTools($: EngineInterface) {
  for (const spec of TOOL_SPECS) {
    try {
      await $.tool.register(spec)
    } catch {
      // the switch stands; the next time it comes on tries again
    }
  }
}

// Switches Multitask mode on, or off to Focus, and keeps the switch; the mode the chat is
// in already leaves it be.
async function setMode($: EngineInterface, now: boolean) {
  if (now === (await read($, isOn))) return
  await update($, isOn, () => now)
  if (now) {
    await offerVoiceTools($)
    // What fell due for a thought while off goes to it now that it can be resumed again.
    for (const t of await read($, thoughts)) if (isDue(t)) scheduleDueWake($, t.id, 0)
  }
  await keepSwitch($)
}

// `/multitask`: turns the mod on in this chat, in Multitask mode, or off, leaving
// Multitask mode; the chat's own choice from then on, whatever the default. Whether it is
// now on.
async function flipEnabled($: EngineInterface): Promise<boolean> {
  const now = !(await isEnabled($))
  await update($, choice, () => now)
  await setMode($, now)
  await keepSwitch($)
  return now
}

// Switches to the mode picked in the band's dropdown; the mode the chat is in already,
// anything else, or a pick while the mod is off (a press drawn before), leaves it be.
async function pickMode($: EngineInterface, value: string) {
  const wantsOn = value === MULTITASK_MODE ? true : value === FOCUS_MODE ? false : undefined
  if (wantsOn !== undefined && (await isEnabled($))) await setMode($, wantsOn)
}

// `/multitask mode`: switches between Multitask and Focus, as the band's dropdown does (the
// mobile app draws none); says which the chat is now in. Off, it says how to turn it on.
async function flipMode($: EngineInterface): Promise<string> {
  if (!(await isEnabled($))) return `${OFF_TEXT} It comes on in Multitask mode; \`/multitask mode\` then switches to Focus.`
  const now = !(await read($, isOn))
  await setMode($, now)
  return now ? MULTITASK_TEXT : FOCUS_TEXT
}

// What /multitask says.
const ON_TEXT =
  'Multitask is on in this chat, in Multitask mode: this chat is now the voice and hands all work to thoughts. Pick Focus above the prompt, or use `/multitask mode`, to work with the agent as usual.'
const OFF_TEXT = 'Multitask is off in this chat; `/multitask` turns it on.'
const MULTITASK_TEXT = 'Multitask mode: this chat is now the voice and hands all work to thoughts.'
const FOCUS_TEXT = 'Focus mode: this chat does its work itself again.'
const USAGE =
  '`/multitask` turns Multitask on or off in this chat, `/multitask mode` switches between Multitask and Focus, and `/multitask default` sets whether new chats start with it on.'

// Whether the mod is on in new chats, and in those never switched with /multitask: the
// person's choice for every chat, kept under its own key; off until they choose.
const DEFAULT_KEY = 'isEnabledByDefault'

async function takeUpDefault($: EngineInterface) {
  const chosen = await $.store.get(DEFAULT_KEY).catch(() => undefined)
  if (typeof chosen === 'boolean') await update($, isEnabledByDefault, () => chosen)
}

// `/multitask default`: flips the default, which this chat follows too unless the person
// switched it with /multitask: turned on so, it stays in Focus, and turned off, it leaves
// Multitask mode. Says what the default now is.
async function flipDefault($: EngineInterface): Promise<string> {
  let now = false
  await update($, isEnabledByDefault, was => (now = !was))
  await $.store.set(DEFAULT_KEY, now).catch(() => undefined)
  await settleMode($)
  const word = now ? 'on' : 'off'
  const said = `Multitask is now ${word} by default, in new chats and in chats where you have not used \`/multitask\`.`
  const chosen = await read($, choice)
  if (chosen === null || chosen === now) return said
  return `${said} This chat keeps it ${chosen ? 'on' : 'off'}; \`/multitask\` turns it ${chosen ? 'off' : 'on'} here.`
}

// Where a session's switch is kept between runs of the app: whether it is in Multitask
// mode, the person's choice of the mod there (null: never switched, so it follows the
// default), when it was kept, and, once it has been in Multitask mode or chosen, the marks
// of its newest messages.
const switchKey = (sessionId: string) => `session:${sessionId}`
type KeptSwitch = { isOn: boolean; choice: boolean | null; at: number; marks: string[] }
const MARKS_KEPT = 200

// Keeps the switch for the session's next run. A session never switched nor in Multitask
// mode keeps no marks: one rewound or forked from it follows the default as it would
// anyway. Best effort: a store or transcript that cannot be read or written keeps what it
// kept.
async function keepSwitch($: EngineInterface) {
  try {
    const key = switchKey(await $.session.id())
    const was = (await $.store.get(key)) as Partial<KeptSwitch> | undefined
    const now = await read($, isOn)
    const chosen = await read($, choice)
    const isMarked = now || chosen !== null || (was?.marks?.length ?? 0) > 0
    const marks = isMarked ? marksOf(await $.session.messages()).slice(-MARKS_KEPT) : []
    await $.store.set(key, { isOn: now, choice: chosen, at: await $.clock.now(), marks } satisfies KeptSwitch)
  } catch {
    // kept as it was
  }
}

// The session whose kept switch and thoughts a session takes up: its own, once it has kept
// its switch; for one rewound or forked, which starts under a new id with copies of the
// messages it kept, the session it came from: the kept one that knows the most of its
// messages, else, of those near that, the one kept last (the one it was just in). None
// when no session is known.
async function keptSession($: EngineInterface): Promise<string | undefined> {
  const own = await $.session.id()
  if ((await $.store.get(switchKey(own))) !== undefined) return own
  const mine = new Set(marksOf(await $.session.messages()))
  if (mine.size === 0) return undefined
  const scored: { id: string; at: number; score: number }[] = []
  for (const key of await $.store.keys()) {
    if (!key.startsWith('session:')) continue
    const kept = ((await $.store.get(key)) ?? {}) as Partial<KeptSwitch>
    const score = new Set((kept.marks ?? []).filter(mark => mine.has(mark))).size
    if (score > 0) scored.push({ id: key.slice('session:'.length), at: kept.at ?? 0, score })
  }
  const best = Math.max(0, ...scored.map(s => s.score))
  if (best < 3) return undefined
  return scored.filter(s => s.score * 2 > best).sort((a, b) => b.at - a.at)[0]?.id
}

// The switch the session `from` kept: the person's choice of the mod there, and whether it
// was in Multitask mode, which a chat they turned it off in is not. One kept before
// choices were (Multitask mode was then the only switch) chose only if it was in it.
async function keptSwitch($: EngineInterface, from: string): Promise<{ isOn: boolean; choice: boolean | null }> {
  const kept = ((await $.store.get(switchKey(from))) ?? {}) as Partial<KeptSwitch>
  const chosen = kept.choice === true || kept.choice === false || kept.choice === null ? kept.choice : kept.isOn === true ? true : null
  return { isOn: kept.isOn === true && chosen !== false, choice: chosen }
}

// Where a session's thoughts are kept between runs of the app (KeptThoughts).
const thoughtsKey = (sessionId: string) => `thoughts:${sessionId}`

// The thoughts as the store keeps them: each one's task and report cut to TEXT_KEPT, and,
// past THOUGHTS_KEPT of them or THOUGHTS_KEPT_CHARS of JSON, those that ended longest ago
// dropped; running ones are never dropped.
function keptList(list: readonly Thought[]): Thought[] {
  const all = list.map((t, i) => {
    const kept = { ...t, task: t.task.slice(0, TEXT_KEPT), lastText: t.lastText.slice(0, TEXT_KEPT) }
    return { t: kept, i, chars: JSON.stringify(kept).length + 1 }
  })
  let count = all.length
  let chars = all.reduce((n, one) => n + one.chars, 0)
  const oldestFirst = all
    .filter(one => one.t.status !== 'running')
    .sort((a, b) => (a.t.endedAt ?? 0) - (b.t.endedAt ?? 0) || a.i - b.i)
  const dropped = new Set<number>()
  for (const one of oldestFirst) {
    if (count <= THOUGHTS_KEPT && chars <= THOUGHTS_KEPT_CHARS) break
    dropped.add(one.i)
    count--
    chars -= one.chars
  }
  return all.filter(one => !dropped.has(one.i)).map(one => one.t)
}

// Keeps the thoughts in the store under the session's id (or `sessionId`), for its next
// run. A session with none keeps nothing. Best effort: a store that cannot be written
// (it holds 4 MiB at most) keeps what it kept.
async function keepThoughts($: EngineInterface, sessionId?: string) {
  keepTimer?.cancel()
  keepTimer = undefined
  try {
    const list = await read($, thoughts)
    if (list.length === 0) return
    const kept: KeptThoughts = { at: (await timeNow($)) ?? 0, thoughts: keptList(list) }
    await $.store.set(thoughtsKey(sessionId ?? (await $.session.id())), kept)
  } catch {
    // kept as it was
  }
}

// Keeps the thoughts KEEP_MS from now, unless that is pending already: changes in a burst,
// or one after another without pause, are kept together, at most each KEEP_MS.
function scheduleKeep($: EngineInterface) {
  if (keepTimer !== undefined) return
  keepTimer = $.clock.after(KEEP_MS, () => {
    keepTimer = undefined
    void keepThoughts($)
  })
}

// Takes up the thoughts the session `from` kept, unless the session has thoughts already
// (this code was reloaded, which state outlives). A thought that was running when they were
// kept is running still only if its agent is; else its turn ended with the run that held it,
// and what waited for that end falls due, as when a turn ends (settleThought), though the
// voice is not told it ended. The voice has heard of each as it is taken up, so what is new
// from the thoughts tells it only what changes after.
async function takeUpThoughts($: EngineInterface, from: string) {
  if ((await read($, thoughts)).length > 0) return
  const kept = (await $.store.get(thoughtsKey(from))) as Partial<KeptThoughts> | undefined
  const list = Array.isArray(kept?.thoughts) ? kept.thoughts : []
  if (list.length === 0) return
  const agents = await $.agent.list()
  const endedAt = kept?.at ?? (await timeNow($))
  const taken = list.map((t): Thought => {
    if (t.status !== 'running') return t
    const status = statusOf(agents.find(a => a.id === t.id)?.status ?? 'completed')
    if (status === 'running') return t
    const queued = status === 'stopped' ? [] : withInterruption(t)
    return { ...t, status, turnId: null, queued, interruptWith: null, isHandOverDue: queued.length > 0, endedAt }
  })
  await update($, thoughts, now => (now.length > 0 ? now : taken))
  await update($, heard, was => ({ ...Object.fromEntries(taken.map(t => [t.id, heardOf(t)])), ...was }))
  if (await read($, isOn)) for (const t of taken) if (isDue(t)) scheduleDueWake($, t.id, 0)
  // Under this session's id too, for its next run, should it have come from another.
  if (from !== (await $.session.id())) await keepThoughts($)
}

// Drops from the store the thoughts of sessions kept longest ago, past SESSIONS_KEPT of
// them or SESSIONS_KEPT_CHARS of JSON, this session's own aside. Best effort.
async function dropOldThoughts($: EngineInterface) {
  try {
    const own = thoughtsKey(await $.session.id())
    const others: { key: string; at: number; chars: number }[] = []
    for (const key of await $.store.keys()) {
      if (!key.startsWith('thoughts:') || key === own) continue
      const kept = await $.store.get(key)
      const at = (kept as Partial<KeptThoughts> | undefined)?.at
      others.push({ key, at: typeof at === 'number' ? at : 0, chars: JSON.stringify(kept ?? null).length })
    }
    others.sort((a, b) => b.at - a.at)
    let chars = 0
    for (const [i, one] of others.entries()) {
      chars += one.chars
      if (i >= SESSIONS_KEPT || chars > SESSIONS_KEPT_CHARS) await $.store.delete(one.key)
    }
  } catch {
    // left as they were
  }
}

function scheduleFlush($: EngineInterface) {
  flushTimer?.cancel()
  flushTimer = $.clock.after(FLUSH_MS, () => void flushInbox($))
}

// Hands what the thoughts said to the voice, once it is idle: as a row the person never
// sees, then the wake-up that draws as nothing; failing that, as one plugin message.
async function flushInbox($: EngineInterface) {
  if (!(await read($, isOn)) || (await read($, isMainBusy))) return
  const text = await takeRelay($)
  if (text === undefined) return
  if (await appendHidden($, text)) void $.prompt.submit({ text: WAKE, asUser: true })
  else void $.prompt.submit({ text })
}

// Puts text in the conversation as a user row the person does not see; whether it went in.
async function appendHidden($: EngineInterface, text: string): Promise<boolean> {
  try {
    const appended = await $.session.append({ message: { type: 'user', content: [{ type: 'text', text }] } })
    return appended.deny === undefined
  } catch {
    return false
  }
}

async function relay($: EngineInterface, fn: (list: Update[]) => Update[]) {
  if (!(await read($, isOn))) return
  await update($, inbox, fn)
  scheduleFlush($)
}

// What a thought writes as it works is a progress note: kept to follow it by, and
// relayed to the voice while RELAY_NOTES is on. Its tool calls never are. Whether it was
// one.
async function noteThoughtSaid($: EngineInterface, id: string, text: string): Promise<boolean> {
  const t = (await read($, thoughts)).find(one => one.id === id)
  // The turn's report, should its row land after the turn ended, has been relayed already.
  if (t === undefined || text === '' || text === t.lastText) return false
  const now = await timeNow($)
  // Not through patchThought: a note alone is not kept in the store straight away (KEEP_MS).
  await update($, thoughts, list =>
    list.map(one =>
      one.id !== id
        ? one
        : { ...one, notes: [...(one.notes ?? []), text.slice(0, NOTE_MAX)].slice(-NOTES_KEPT), notedSinceReport: true, notedAt: now },
    ),
  )
  if (RELAY_NOTES) await relay($, list => [...list, { thought: t.name, text }])
  return true
}

// Any other new row in a running thought's conversation (a tool call or its result, a
// message to it) blinks its dot in the band, unless a blink began under BLINK_MS ago: only
// a blink's start draws the band afresh, so a busy thought redraws it once a BLINK_MS at most.
async function blinkThought($: EngineInterface, id: string) {
  const now = await timeNow($)
  const last = blinks.get(id)
  if (now === undefined || (last !== undefined && now - last < BLINK_MS)) return
  if ((await read($, thoughts)).find(one => one.id === id)?.status !== 'running') return
  for (const [one, at] of blinks) if (now - at >= BLINK_MS) blinks.delete(one)
  blinks.set(id, now)
  await update($, bandTick, n => n + 1)
}

// The end of a thought's turn reaches the voice once, as a done line. Its report replaces
// the notes still waiting that it repeats; if it went out already as the latest note,
// the line is a bare "done". With notes not relayed, nothing went out before it.
async function relayDone($: EngineInterface, t: Thought, report: string, isFailed: boolean, pending: number) {
  const notes = t.notes ?? []
  const wasSent = RELAY_NOTES && report !== '' && notes.at(-1) === report.slice(0, NOTE_MAX)
  await relay($, list => {
    const kept = [...list]
    let isWaiting = false
    for (let i = kept.length - 1; i >= 0; i--) {
      const u = kept[i] as Update
      if (u.thought !== t.name) continue
      if (u.isDone === true || u.isFromPerson === true || !report.includes(u.text)) break
      kept.splice(i, 1)
      isWaiting = true
    }
    const said = isWaiting || !wasSent ? report : ''
    const text = isFailed ? [said, '(ended on an error)'].filter(part => part !== '').join(' ') : said
    return [...kept, { thought: t.name, text, isDone: true, ...(pending > 0 && { pending }) }]
  })
}

// Sends a thought a message: to its agent's id, failing that to its name. The answer says
// whether it got there and why not; a thought that has it runs again, one that has not
// keeps the status it had.
async function deliver($: EngineInterface, t: Thought, text: string): Promise<SessionSendResult> {
  let was: ThoughtStatus = t.status
  let wasColor = t.color
  await patchPicking($, t.id, (one, list, pick) => {
    was = one.status
    wasColor = one.color
    return asRunning(list, one, pick)
  })
  const send = async (to: SessionSendAddress): Promise<SessionSendResult> => {
    try {
      return await $.session.send({ to, text })
    } catch (error) {
      return { isDelivered: false, reason: error instanceof Error ? error.message : String(error) }
    }
  }
  const byId = await send({ agentId: t.id })
  const sent = byId.isDelivered || !(await send(t.name)).isDelivered ? byId : { isDelivered: true as const }
  // Not delivered, it goes back to its colour; the turn through the first colours stays
  // moved on, which does no harm, as a pick passes over the colours held.
  if (!sent.isDelivered) {
    await patchThought($, t.id, one => (one.status === 'running' ? { ...one, status: was, color: wasColor } : one))
  }
  return sent
}

// Posts a thought a message, as tell's post does: one running reads it at its next step;
// one whose turn has ended gets it once its run has ended (it may still be winding down),
// after the messages still pending for it, and resumes. What the send answered, and how
// many pending messages went before it.
async function post(
  $: EngineInterface,
  t: Thought,
  text: string,
  isRunning: boolean,
): Promise<{ sent: SessionSendResult; pending: number }> {
  if (!isRunning) await runEnded($, t.id)
  const pending = !isRunning && isDue(t) ? t.queued.length : 0
  const sent = (pending > 0 ? await handOver($, t.id, text) : undefined) ?? (await deliver($, t, text))
  return { sent, pending }
}

// The person's own message to a thought, typed in its card in the Thoughts pane: posted as
// tell posts the voice's, then put before the voice with the thoughts' next updates, so it
// knows what the thought was asked. Sent from the pane's ui.input hook (below), as auto
// mode allows only a send made from an event the engine raised to this mod (handOverDue).
// A message that did not arrive is told in a toast, the field left open.
async function tellFromPane($: EngineInterface, id: string, text: string) {
  const message = text.trim()
  const t = (await read($, thoughts)).find(one => one.id === id)
  if (message === '' || t === undefined || t.status === 'stopped') return
  if (!(await read($, isOn))) {
    $.ui.toast('Switch to Multitask mode to tell a thought something.')
    return
  }
  const { sent } = await post($, t, fromPerson(message), t.status === 'running')
  if (!sent.isDelivered) {
    $.ui.toast(`${t.name} did not get your message: ${sent.reason}`)
    return
  }
  await update($, tellingTo, was => (was === id ? '' : was))
  await update($, inbox, list => [...list, { thought: t.name, text: message, isFromPerson: true }])
}

// Queues a message for the end of a thought's turn, if it has a turn running that will
// end: its place in the queue, or 0 when it has none and nothing would hand it over.
async function queueFor($: EngineInterface, id: string, text: string): Promise<number> {
  let at = 0
  await patchThought($, id, one => {
    if (one.status !== 'running') return one
    at = one.queued.length + 1
    return { ...one, queued: [...one.queued, text] }
  })
  return at
}

// The engine's status of a thought's agent once its run no longer counts as running, or
// after SETTLE_POLLS looks. A message sent while a finished run is still winding down
// waits for a tool round that never comes, until something else wakes the session; sent
// once the run has ended, it resumes the thought straight away.
async function runEnded($: EngineInterface, id: string): Promise<AgentStatus | undefined> {
  for (let look = 1; ; look++) {
    const status = (await $.agent.list()).find(a => a.id === id)?.status
    if (status !== 'running' || look >= SETTLE_POLLS) return status
    await new Promise<void>(resolve => $.clock.after(SETTLE_POLL_MS, resolve))
  }
}

// Whether a thought has messages due: its queue no longer waits for a turn to end.
function isDue(t: Thought): boolean {
  return t.isHandOverDue === true && t.queued.length > 0 && t.status !== 'stopped'
}

// What a thought is handed for an interruption that waited for its turn to be cut.
const interruption = (text: string) => `Interruption from the voice: ${text}`

// Its queue, after the interruption waiting for its turn to be cut, if any.
function withInterruption(t: Thought): string[] {
  return t.interruptWith === null ? t.queued : [interruption(t.interruptWith), ...t.queued]
}

// What waits for a thought fell due (isHandOverDue set with it): the next hook of this
// mod's the engine raises hands it over (handOverDue), and should none have by then, the
// voice is woken, for its turn to.
async function fellDue($: EngineInterface, id: string) {
  dueAt.set(id, await $.clock.now())
  scheduleDueWake($, id, 0)
}

// Forgets a thought's due messages: handed over, withdrawn, or the thought stopped.
function forgetDue(id: string) {
  dueWakes.get(id)?.cancel()
  dueWakes.delete(id)
  dueAt.delete(id)
  toldRefusal.delete(id)
}

function scheduleDueWake($: EngineInterface, id: string, step: number) {
  dueWakes.get(id)?.cancel()
  dueWakes.delete(id)
  const ms = DUE_WAKES_MS[step]
  if (ms !== undefined) dueWakes.set(id, $.clock.after(ms, () => void wakeForDue($, id, step)))
}

// Messages are still due to a thought, which no hook of this mod's has handed over since
// they fell due: the voice is told they are still pending, which wakes it, and its turn
// hands them over. A note already waiting for the voice about the thought wakes it as well.
async function wakeForDue($: EngineInterface, id: string, step: number) {
  dueWakes.delete(id)
  const t = (await read($, thoughts)).find(one => one.id === id)
  const isInFlight = handingOver.has(id)
  if (t === undefined || (!isInFlight && !isDue(t))) return
  scheduleDueWake($, id, step + 1)
  if (isInFlight) return
  const note: Update = { thought: t.name, text: `(${pendingNote(t.queued.length)})`, isPending: true }
  await relay($, list => (list.some(u => u.thought === t.name) ? list : [...list, note]))
}

// Hands each thought whose turn has ended the messages due to it. Called only from hooks
// of this mod's that the engine raises (the voice's turns, the engine's notice that a
// thought finished, tell), as only there does the engine run this mod's allowance of its
// own SendMessage (tool.check, below). A $ call made after the hook that made it has
// returned, or from a timer, runs beneath this mod's own frame, where the engine leaves out
// every hook of this mod, the allowance too: auto mode then refuses the send.
async function handOverDue($: EngineInterface) {
  if (!(await read($, isOn))) return
  const due = (await read($, thoughts)).filter(t => isDue(t) && !handingOver.has(t.id))
  if (due.length === 0) return
  const agents = await $.agent.list()
  const now = await $.clock.now()
  for (const t of due) {
    // Still ending the run its turn ended, a message would wait unread (runEnded): it goes
    // at the next chance. One running a new turn reads it at its next step.
    const run = agents.find(a => a.id === t.id)?.status
    const isEnding = run === 'running' && t.turnId === null && now - (dueAt.get(t.id) ?? 0) < SETTLE_MS
    if (!isEnding) await handOver($, t.id)
  }
}

// Hands a thought the messages due to it, and `also` after them (tell's message to an idle
// one), from a hook of this mod's the engine raised (handOverDue says why). Delivered, they
// are off its queue and the voice's relay says so; refused, they stay at its front, due
// still, and the voice is told why, once a reason. Undefined when there was nothing to send.
async function handOver($: EngineInterface, id: string, also?: string): Promise<SessionSendResult | undefined> {
  const isFree = !handingOver.has(id)
  let waited: string[] = []
  if (isFree) {
    handingOver.add(id)
    await patchThought($, id, one => {
      if (!isDue(one)) return one
      waited = one.queued
      return { ...one, queued: [] }
    })
  }
  try {
    const t = (await read($, thoughts)).find(one => one.id === id)
    const parts = also === undefined ? waited : [...waited, also]
    if (t === undefined || parts.length === 0) return undefined
    const sent = await deliver($, t, parts.join('\n\n'))
    if (waited.length === 0) return sent
    if (sent.isDelivered) {
      await patchThought($, id, one => ({ ...one, isHandOverDue: false }))
      forgetDue(id)
      // The voice's relay, if it has not gone out yet, says they reached it.
      await update($, inbox, list =>
        list
          .filter(u => u.thought !== t.name || u.isPending !== true)
          .map(u => (u.thought === t.name && u.isDone === true && (u.pending ?? 0) > 0 ? { ...u, isHandedOver: true } : u)),
      )
      return sent
    }
    await patchThought($, id, one =>
      one.status === 'stopped' ? one : { ...one, queued: [...waited, ...one.queued], isHandOverDue: true },
    )
    if (toldRefusal.get(id) !== sent.reason) {
      toldRefusal.set(id, sent.reason)
      const text = `(${pendingNote(waited.length)}. The last try failed: ${sent.reason})`
      await relay($, list => [...list, { thought: t.name, text, isPending: true }])
    }
    return sent
  } finally {
    if (isFree) handingOver.delete(id)
  }
}

// A running thought's turn ended, or it was stopped, at `now`: its dot in the band fades
// out from then. Ends from FADE_MS ago or more are forgotten.
function noteEnding(id: string, now: number | undefined) {
  if (now === undefined) return
  for (const [one, at] of endings) if (now - at >= FADE_MS) endings.delete(one)
  endings.set(id, now)
}

async function stopThought($: EngineInterface, id: string) {
  const now = await timeNow($)
  if ((await read($, thoughts)).find(t => t.id === id)?.status === 'running') noteEnding(id, now)
  await patchThought($, id, t => ({ ...t, status: 'stopped', queued: [], interruptWith: null, isHandOverDue: false, endedAt: now }))
  forgetDue(id)
  try {
    await $.tool.call({ tool: 'TaskStop', task_id: id })
  } catch {
    // it had already ended
  }
}

async function unqueue($: EngineInterface, id: string, index: number | undefined) {
  let isEmpty = false
  await patchThought($, id, t => {
    const queued = index === undefined ? [] : t.queued.filter((_, i) => i !== index)
    isEmpty = queued.length === 0
    return { ...t, queued, isHandOverDue: !isEmpty && t.isHandOverDue === true }
  })
  if (isEmpty) forgetDue(id)
}

// Cuts a thought's running turn so the message goes in at once: the cut turn's end (or
// the grace timer) makes it due, and it goes at the next chance. With no turn the engine
// will cut, the message waits in its queue for the run's end, or goes now when the run has
// ended. The thought is never stopped: a stopped agent takes no more messages. Answers as
// tell does.
async function interrupt($: EngineInterface, t: Thought, text: string): Promise<TellAnswer> {
  let pending = text
  if (t.turnId !== null) {
    await patchThought($, t.id, one => ({
      ...one,
      interruptWith: one.interruptWith === null ? text : `${one.interruptWith}\n\n${text}`,
    }))
    try {
      await $.turn.abort({ turnId: t.turnId })
      // Normally its turn.complete makes the message due; this covers a turn that never reports.
      $.clock.after(INTERRUPT_GRACE_MS, () => void interruptionFallsDue($, t.id))
      return { result: `Interrupting ${t.name}; it gets the message as soon as its current turn is cut.` }
    } catch {
      // That turn had ended. Unless its end made the message due, it goes another way.
      let taken = null as string | null
      await patchThought($, t.id, one => {
        taken = one.interruptWith
        return { ...one, interruptWith: null }
      })
      if (taken === null) {
        // Due now, it goes from here, this being the voice's own call.
        await runEnded($, t.id)
        const sent = await handOver($, t.id)
        if (sent === undefined || sent.isDelivered) return { result: `${t.name}'s turn had just ended; it has the message now.` }
        return { result: `${t.name}'s turn had just ended; the message is pending and goes to it at the next chance (${sent.reason}).` }
      }
      pending = taken
    }
  }
  if ((await $.agent.list()).find(a => a.id === t.id)?.status === 'running') {
    const at = await queueFor($, t.id, pending)
    if (at > 0) return { result: `Could not cut ${t.name}'s turn; the message is queued as #${at}, for when that turn ends.` }
  }
  await runEnded($, t.id)
  const sent = await deliver($, t, pending)
  if (!sent.isDelivered) return notDelivered(t, sent.reason)
  return { result: `${t.name} had no turn running; it has the message now and resumes.` }
}

// Makes the interruption still waiting, if any, due, before the thought's queue: the grace
// timer's, for a cut turn that never reports. Whichever comes second, the cut turn's end
// or the grace timer, finds none and leaves the thought be.
async function interruptionFallsDue($: EngineInterface, id: string) {
  let isMoved = false
  await patchThought($, id, t => {
    if (t.interruptWith === null || t.status === 'stopped') return t
    isMoved = true
    return { ...t, queued: withInterruption(t), interruptWith: null, isHandOverDue: true }
  })
  if (isMoved) await fellDue($, id)
}

// The notes a turn's report leaves: its own text arrived as notes too, last.
function notesBefore(notes: string[], report: string): string[] {
  const kept = [...notes]
  while (kept.length > 0 && report.includes(kept.at(-1) as string)) kept.pop()
  return kept
}

// A thought's turn ended: it goes idle (or failed), and what waited for that end, an
// interruption and its queue, falls due; the voice is told, with the text it ended on as
// its report (a result, question or problem) and how many messages are still pending.
// Nothing is handed over here: this runs on after the engine's hook has returned (see
// handOverDue), and the run that turn ended may not have ended yet.
async function settleThought($: EngineInterface, id: string, reason: TurnCompleteReason, answer: string) {
  const t = (await read($, thoughts)).find(one => one.id === id)
  if (t === undefined || t.status === 'stopped') return
  // A turn that was cut ended on whatever it was doing, not on a report; it was cut by
  // the voice's interruption or a stop, so the voice is not told it ended.
  const isCut = reason === 'aborted'
  const report = isCut ? '' : answer.trim()
  if (report !== '') {
    await patchThought($, id, one => ({
      ...one,
      lastText: report,
      notes: notesBefore(one.notes ?? [], report),
      notedSinceReport: false,
    }))
  }
  // What waits for it is read as it stands now, in the same step that settles it, not as
  // it stood when the turn ended: the voice may have queued or interrupted since.
  const isFailed = reason === 'error' || reason === 'refusal'
  const status: ThoughtStatus = isFailed ? 'failed' : 'idle'
  let pending = 0
  const now = await timeNow($)
  // A cut turn's thought goes on with the message it was cut for: its dot does not fade.
  if (!isCut && t.status === 'running') noteEnding(id, now)
  await patchThought($, id, one => {
    if (one.status === 'stopped') return one
    const queued = withInterruption(one)
    pending = queued.length
    return { ...one, status, turnId: null, queued, interruptWith: null, isHandOverDue: pending > 0, endedAt: now }
  })
  if (!isCut) await relayDone($, t, report, isFailed, pending)
  if (pending > 0) await fellDue($, id)
}

// What the voice is told beside the person's message: its whole part once Multitask
// comes on (and again after a compaction), a reminder while it stays on, and once
// that it has gone off.
async function voiceNote($: EngineInterface): Promise<string | undefined> {
  const now = await read($, isOn)
  const told = await read($, toldVoice)
  if (now !== told) await update($, toldVoice, () => now)
  if (now) return told ? VOICE_REMINDER : VOICE
  return told ? VOICE_OFF : undefined
}

// What is new from the thoughts the voice has not heard of, but those a relay names (it
// tells of them itself); none when nothing is. Once told, the voice has heard of them all.
async function takeNews($: EngineInterface, relayed: ReadonlySet<string> = new Set()): Promise<string | undefined> {
  const list = await read($, thoughts)
  const was = await read($, heard)
  const lines = list.filter(t => !relayed.has(t.name)).flatMap(t => newsOf(t, was[t.id]))
  await update($, heard, () => Object.fromEntries(list.map(t => [t.id, heardOf(t)])))
  return lines.length === 0 ? undefined : formatNews(lines)
}

// The updates waiting for the voice, taken, as one relay with what is new from the other
// thoughts after them; none when no update waits.
async function takeRelay($: EngineInterface): Promise<string | undefined> {
  let taken: Update[] = []
  await update($, inbox, list => {
    taken = list
    return []
  })
  if (taken.length === 0) return undefined
  const news = await takeNews($, new Set(taken.map(u => u.thought)))
  return news === undefined ? formatUpdates(taken) : `${formatUpdates(taken)}\n\n${news}`
}

// Waits, a short while at most, for the turn end an engine's notice tells of to be
// settled (its update waiting for the voice), when the notice names a thought whose turn
// ended. The notice can come while the settling still runs.
async function settledFor($: EngineInterface, notice: string) {
  const found = [...settling].find(([id, s]) => isAbout(notice, id, s.name))
  if (found === undefined) return
  await Promise.race([found[1].done, $.clock.sleep(NOTICE_WAIT_MS)])
  settling.delete(found[0])
}

// The voice's reply as it streams, its text held back while it could still be QUIET: then
// passed on as it came or, being QUIET, as NO_RESPONSE, which the desktop draws as
// nothing. A reply that calls a tool, or thinks after its text, is passed on as it came.
async function* unquiet(
  stream: HookStream<TurnStepChunk, TurnStepResult>,
): AsyncGenerator<TurnStepChunk, TurnStepResult> {
  // Every piece since the reply's text began, in order (null once passed on), and that text.
  let held: TurnStepChunk[] | null = []
  let text = ''
  let isRewritten = false
  for await (const chunk of stream) {
    if (held === null || (held.length === 0 && chunk.kind !== 'text')) {
      yield chunk
      continue
    }
    if (chunk.kind === 'stop') {
      isRewritten = text.trim() === QUIET
      yield* isRewritten ? quieted(held) : held
      held = null
      yield chunk
      continue
    }
    held.push(chunk)
    if (chunk.kind === 'engine') continue
    if (chunk.kind === 'text') {
      text += chunk.text
      if (QUIET.startsWith(text.trim())) continue
    }
    yield* held
    held = null
  }
  if (held !== null) {
    isRewritten = text.trim() === QUIET
    yield* isRewritten ? quieted(held) : held
  }
  const result = await stream.result
  return isRewritten ? { ...result, answer: NO_RESPONSE } : result
}

// The pieces of a quiet reply with its text as NO_RESPONSE, in the first piece of text.
function quieted(held: TurnStepChunk[]): TurnStepChunk[] {
  const first = held.findIndex(chunk => chunk.kind === 'text')
  return held.flatMap((chunk, i): TurnStepChunk[] => {
    if (chunk.kind !== 'text') return [chunk]
    return i === first ? [{ ...chunk, text: NO_RESPONSE }] : []
  })
}

// The voice's effort: the lighter of the session's and the chosen one, so the voice
// that only talks and steers costs less; a budget given as a number stays.
function lighterEffort<E>(effort: E, chosen: string): E {
  const at = EFFORTS.indexOf(effort as never)
  const cap = EFFORTS.indexOf(chosen as never)
  return at < 0 || cap < 0 || at <= cap ? effort : (EFFORTS[cap] as E)
}

export const register: Register = (on, options) => {
  watchSwitch(on)
  const voiceEffort = typeof options.voiceEffort === 'string' ? options.voiceEffort : 'low'

  on('session.start', async ($, e, next) => {
    await update($, isMainBusy, () => false)
    await $.agent.register({
      name: 'thought',
      description: 'One thought of a multitasking mind; started by the multitask mod only.',
      prompt: THOUGHT,
      disallowedTools: Object.values(TOOL),
    })
    // A restarted or resumed session takes up the switch and the thoughts it kept; a
    // rewound or forked one, those of the session it came from. Found before the switch
    // is kept below, which would make the session its own. One that holds a choice, the
    // switch on or thoughts (a reload of this code, which state outlives) keeps them.
    // Never switched, it follows the default: a new chat it is on in starts in Multitask
    // mode. Where the mod is off, Multitask mode goes.
    await takeUpDefault($)
    const from = await keptSession($).catch(() => undefined)
    if (from !== undefined) {
      const kept = await keptSwitch($, from).catch(() => ({ isOn: false, choice: null }))
      const chosen = kept.choice
      if (chosen !== null) await update($, choice, was => was ?? chosen)
      if (kept.isOn) await update($, isOn, () => true)
      await takeUpThoughts($, from).catch(() => undefined)
    } else if ((await read($, choice)) === null && (await read($, isEnabledByDefault))) {
      await update($, isOn, () => true)
    }
    if ((await read($, isOn)) && !(await isEnabled($))) await update($, isOn, () => false)
    await keepSwitch($)
    await dropOldThoughts($)
    // So the switch and the thoughts outlive a reload of this code (state) and a restart of
    // the session (the store): the tools they had are offered again. Never in Multitask
    // mode, or with the mod off, the session gets none.
    const hasThoughts = (await read($, thoughts)).length > 0
    if ((await read($, isOn)) || (hasThoughts && (await isEnabled($)))) await offerVoiceTools($)
    await $.command.register({
      name: 'multitask',
      description: 'Turn Multitask on or off in this chat',
      argumentHint: '[mode | default]',
    })
    await $.command.register({ name: 'thoughts', description: 'Show the multitasking thoughts in a pane' })
    return next(e)
  })

  // The thoughts are kept in the store as the session ends, with any progress notes since
  // they were last kept, under the id of the session ending.
  on('session.end', async ($, e, next) => {
    await keepThoughts($, e.sessionId)
    return next(e)
  })

  // The engine resumes an ended thought with a message only if its type is offered, so it
  // is offered while Multitask is on; the model still cannot start one (tool.check, below).
  on('agent.offer', { agent: AGENT }, async ($, e, next) => ((await read($, isOn)) ? next(e) : { isOffered: false }))

  // `/multitask` turns the mod on or off in this chat; `/multitask mode` switches between
  // Multitask and Focus; `/multitask default` flips whether new chats start with it on.
  on('command.run', { command: 'multitask' }, async ($, e) => {
    const word = (e.args.trim().split(/\s+/)[0] ?? '').toLowerCase()
    let text = USAGE
    if (word === '') text = (await flipEnabled($)) ? ON_TEXT : OFF_TEXT
    else if (word === 'mode') text = await flipMode($)
    else if (word === 'default') text = await flipDefault($)
    await handOverDue($)
    return { text }
  })

  on('command.run', { command: 'thoughts' }, async $ => {
    await $.ui.open({ id: PANE, title: 'Thoughts' })
    return { text: 'Thoughts pane opened.' }
  })

  // The voice does no work itself: the model's own calls on the main loop are refused.
  // And only the voice uses this mod's tools. The engine's hidden forks (a prompt
  // suggestion, a memory extraction) are offered the voice's tools, and the engine
  // refuses their every call beneath next(e); the tools' own hooks below answer
  // without calling it, so a call from any loop but the main one is refused here,
  // this hook being registered first and so running outside them. A fork's or a
  // subagent's call carries its loop's agentId; the voice's carries none.
  on('tool.call', async ($, e, next) => {
    if (e.agentId !== undefined && OWN_TOOLS.has(String(e.tool))) return NOT_VOICE
    const isVoiceCall = e.agentId === undefined && next.origin.plugin === 'engine'
    if (!isVoiceCall || VOICE_TOOLS.test(String(e.tool)) || !(await read($, isOn))) return next(e)
    return {
      deny: 'Multitask is on: you are the voice and do no work yourself. Hand this to a thought (think, or tell an existing one).',
    }
  })

  on('tool.call', { tool: 'mcp__multitask__think' }, async ($, e) => {
    if (!(await read($, isOn))) return OFF
    const task = str(e, 'task')
    if (task === '') return { deny: 'Give the thought a task.' }
    const list = await read($, thoughts)
    // The voice names it by its task; failing that, the task's first words do.
    const name = uniqueName(list, slug(str(e, 'name')) || slug(task) || 'thought')

    const spawned = await $.agent.spawn({ prompt: task, description: name, name, subagentType: AGENT })
    if (spawned.deny !== undefined) return { deny: `The thought did not start: ${spawned.deny}` }
    // The id normally comes back with the spawn; failing that, find it among the agents.
    const id =
      spawned.agentId ??
      (await $.agent.list()).filter(a => a.description === name && a.type === AGENT).at(-1)?.id
    if (id === undefined) return { deny: 'The thought did not start: no agent id came back.' }

    const thought: Omit<Thought, 'color'> = {
      id,
      name,
      task,
      status: 'running',
      queued: [],
      lastText: '',
      notes: [],
      turnId: null,
      interruptWith: null,
      startedAt: await timeNow($),
    }
    // Its colour is picked as it joins the list, so thoughts started together differ.
    await updateThoughts($, (all, pick) => [...all, { ...thought, color: pick(all) }])
    return { result: `Started thought "${name}". Its updates reach you as they come.` }
  })

  on('tool.call', { tool: 'mcp__multitask__tell' }, async ($, e) => {
    if (!(await read($, isOn))) return OFF
    const list = await read($, thoughts)
    const t = findThought(list, refOf(e))
    if (t === undefined) return unknownThought(list, refOf(e))
    const message = str(e, 'message')
    if (message === '') return { deny: 'Give a message.' }
    const how = (str(e, 'how') || str(e, 'mode') || 'post').toLowerCase()
    if (!TELL_HOWS.includes(how)) {
      return { deny: `Unknown how "${how}": give \`how\` as post, queue or interrupt. Nothing was sent.` }
    }
    let isRunning = t.status === 'running'

    if (how === 'queue' && isRunning) {
      const at = await queueFor($, t.id, message)
      if (at > 0) return { result: `Queued for ${t.name} as #${at}; it reads it when its turn ends.` }
      isRunning = false // its turn ended meanwhile
    }
    if (how === 'interrupt' && isRunning) return interrupt($, t, message)
    // With no turn running, its last run may still be winding down: the message goes once it
    // has ended, after what is still pending for it.
    const { sent, pending } = await post($, t, message, isRunning)
    if (!sent.isDelivered) return notDelivered(t, sent.reason)
    const after = pending === 0 ? '' : `, after the ${pending === 1 ? 'message' : `${pending} messages`} still pending for it,`
    return {
      result: isRunning
        ? `Posted to ${t.name}; it reads it at its next step.`
        : `${t.name} was ${t.status === 'running' ? 'idle' : t.status}; it has the message now${after} and resumes.`,
    }
  })

  on('tool.call', { tool: 'mcp__multitask__unqueue' }, async ($, e) => {
    const list = await read($, thoughts)
    const t = findThought(list, refOf(e))
    if (t === undefined) return unknownThought(list, refOf(e))
    const raw = (e as Record<string, unknown>).index
    const index = typeof raw === 'number' ? raw - 1 : undefined
    if (index !== undefined && (index < 0 || index >= t.queued.length)) {
      return { deny: `${t.name} has ${t.queued.length} queued message(s).` }
    }
    await unqueue($, t.id, index)
    return { result: index === undefined ? `Withdrew all of ${t.name}'s queue.` : `Withdrew #${index + 1}.` }
  })

  on('tool.call', { tool: 'mcp__multitask__stop' }, async ($, e) => {
    const list = await read($, thoughts)
    const t = findThought(list, refOf(e))
    if (t === undefined) return unknownThought(list, refOf(e))
    await stopThought($, t.id)
    return { result: `Stopped ${t.name}.` }
  })

  on('tool.call', { tool: 'mcp__multitask__thoughts' }, async ($, e) => {
    // Bring statuses up to date with the engine's own view of the agents.
    // One by one, so thoughts found running again take colours that differ.
    const agents = await $.agent.list()
    await updateThoughts($, (list, pick) => {
      const next = [...list]
      next.forEach((t, i) => {
        const agent = agents.find(a => a.id === t.id)
        if (agent === undefined || t.status === 'stopped') return
        const status = statusOf(agent.status)
        next[i] = status === 'running' ? asRunning(next, t, pick) : { ...t, status }
      })
      return next
    })
    const list = await read($, thoughts)
    const ref = refOf(e)
    if (ref === '') return { result: describeThoughts(list) }

    const t = findThought(list, ref)
    if (t === undefined) return unknownThought(list, ref)
    const messages = await $.session.messages({ agentId: t.id })
    if ('deny' in messages) return { result: describeThoughts([t]) }
    // One line a row: its text (a progress note, report or message) and the tools it
    // called; rows that only carry tool results are left out.
    const recent = messages
      .filter(m => m.text !== '' || m.toolUses.length > 0)
      .slice(-12)
      .map(m => {
        const tools = m.toolUses.length === 0 ? '' : ` [${m.toolUses.map(u => u.tool).join(', ')}]`
        const text = m.text === '' ? '' : ` ${oneLine(m.text, 300)}`
        return `${m.role}:${text}${tools}`
      })
    return { result: `${describeThoughts([t])}\n\nRecent:\n${recent.join('\n')}` }
  })

  // The engine's own notice that a thought's turn ended, and its hand-back of the thought's
  // final report, would tell the voice what the relay tells it: while Multitask is on, the
  // relay goes in as a hidden row and the notice as the wake-up after it. With nothing
  // waiting, a notice goes in as it came, with what is new beside it. A hand-back waits
  // for its thought's end here too, and takes the relay or what is new with it, but its
  // text is not the hook's to change: the engine keeps the text it was queued with, so it
  // becomes the wake-up as it is stored (session.append, below).
  // Beside the person's own message the voice is told when Multitask came on or went
  // off, and what is new from its thoughts: that is the one way it is told. A system
  // prompt section would not follow the switch, as the engine sends the prompt it
  // recorded at the first request until a compaction, and on a machine with managed
  // settings it is never sent, the managed plugin skipping a user plugin's
  // prompt.compose hook.
  on('prompt.submit', async ($, e, next) => {
    const isHandBack = e.origin.kind === 'peer' && e.text.includes(HANDBACK)
    if (e.origin.kind === 'task-notification' || isHandBack) {
      // Waited for before anything is read, so what is read has it.
      await settledFor($, e.text)
      // A thought finished: what waited for its turn to end goes to it now, before the
      // voice is told.
      await handOverDue($)
      const t = (await read($, thoughts)).find(one => isAbout(e.text, one.id, one.name))
      if (t === undefined || !(await read($, isOn))) return next(e)
      const relayed = await takeRelay($)
      if (relayed !== undefined) return next({ ...e, text: (await appendHidden($, relayed)) ? WAKE : relayed })
      const news = await takeNews($)
      const woken = isHandBack ? { ...e, text: WAKE } : e
      return news === undefined ? next(woken) : next({ ...woken, context: [...(e.context ?? []), news] })
    }
    if (!PERSON.has(e.origin.kind)) return next(e)
    // Only a chat in Multitask mode is told it is the voice, and only one the mod is on in
    // can be in it: one off leaves it first.
    await settleMode($)
    // Once switched, or in Multitask mode, the marks a session rewound or forked from this
    // one is known by are kept fresh.
    if ((await read($, choice)) !== null || (await read($, isOn))) await keepSwitch($)
    const notes = [await voiceNote($), (await read($, isOn)) ? await takeNews($) : undefined].filter(
      (note): note is string => note !== undefined,
    )
    return notes.length === 0 ? next(e) : next({ ...e, context: [...(e.context ?? []), ...notes] })
  })

  // A compaction may summarise the voice's part away: while Multitask is on, it is
  // told whole again beside the person's next message. (Gone off, it is told so.)
  on('session.compact', async ($, e, next) => {
    const result = await next(e)
    const isCompacted = e.agentId === undefined && e.trigger !== 'precompute' && result.skip === undefined
    if (isCompacted && (await read($, isOn))) await update($, toldVoice, () => false)
    return result
  })

  // Only this mod starts a thought. The voice's think call was allowed as any call is, so
  // the thought it starts is not put to a second decider. Anyone else's start of one (the
  // model's own Agent call, in any loop, or another plugin's) is refused. What a thought
  // then does is checked as any agent's work.
  on('tool.check', { tool: 'Agent' }, async ($, e, next) => {
    const input = e.input as { subagent_type?: unknown; subagentType?: unknown } | null
    if (input?.subagent_type !== AGENT && input?.subagentType !== AGENT) return next(e)
    if (next.origin.plugin === $.plugin.name) return { decision: 'allow', reason: 'A thought the multitask voice started.' }
    return { decision: 'deny', reason: 'Only the multitask mod starts a thought (the voice\'s think tool); use another agent type.' }
  })

  // The voice's messages to its thoughts go by the engine's SendMessage tool, called as
  // this plugin's own call, which the mode's decider would judge as the model's: auto
  // mode refuses a call the model never asked for. This plugin's own send to one of its
  // thoughts is allowed; any other send is decided as before. The engine runs this hook
  // only for a send made while another hook of this plugin runs, so every send is made so
  // (handOverDue says why).
  on('tool.check', { tool: 'SendMessage' }, async ($, e, next) => {
    if (next.origin.plugin !== $.plugin.name) return next(e)
    const to = (e.input as { to?: unknown } | null)?.to
    if (typeof to !== 'string' || findThought(await read($, thoughts), to.trim()) === undefined) return next(e)
    return { decision: 'allow', reason: 'A message from the multitask voice to its own thought.' }
  })

  // The voice's turns (a subagent's run raises no turn.start) are where what is due to a
  // thought goes when nothing else handed it over: the voice is woken for that if need be.
  on('turn.start', async ($, e, next) => {
    flushTimer?.cancel()
    await update($, isMainBusy, () => true)
    await handOverDue($)
    return next(e)
  })

  // A thought's latest turn is noted. While Multitask is on, the voice's requests think
  // less hard, and its quiet reply goes on as one the desktop draws as nothing.
  on('turn.step', async function* ($, e, next) {
    const id = e.agentId
    if (id === undefined) {
      if (!(await read($, isOn))) return yield* next(e)
      const isLighter = voiceEffort !== 'session' && e.effort !== undefined
      return yield* unquiet(next(isLighter ? { ...e, effort: lighterEffort(e.effort, voiceEffort) } : e))
    }
    const t = (await read($, thoughts)).find(one => one.id === id)
    if (t !== undefined && t.turnId !== e.turnId) {
      const now = await timeNow($)
      await patchPicking($, id, (one, list, pick) => ({
        ...(one.status === 'stopped' ? one : asRunning(list, one, pick)),
        turnId: e.turnId,
        startedAt: now,
      }))
      // New work: the report it ends on starts folded, as every report does.
      await update($, openReports, ids => ids.filter(one => one !== id))
    }
    return yield* next(e)
  })

  on('turn.complete', async ($, e, next) => {
    const result = await next(e)
    if (e.agentId === undefined) {
      await update($, isMainBusy, () => false)
      await handOverDue($)
      if (await read($, isOn)) scheduleFlush($)
    } else {
      const t = (await read($, thoughts)).find(one => one.id === e.agentId)
      if (t !== undefined) {
        const settle = settleThought($, t.id, e.reason, e.answer)
        settling.set(t.id, { name: t.name, done: settle.then(() => undefined, () => undefined) })
      }
    }
    return result
  })

  // What a thought writes as it works is kept as its progress notes (and relayed, while RELAY_NOTES is on);
  // any other row in its conversation blinks its dot in the band.
  // While Multitask is on, the engine's hand-back of a thought's report is stored as the
  // wake-up: the engine keeps the text a hand-back was queued with, whatever prompt.submit
  // returns, so it is changed here, as it is stored.
  on('session.append', async ($, e, next) => {
    if (e.agentId !== undefined) {
      const isNote = e.door === 'response' && (await noteThoughtSaid($, e.agentId, textOf(e.message.content)))
      if (!isNote) await blinkThought($, e.agentId)
    }
    if (e.agentId === undefined && e.door !== 'note' && e.message.type === 'user') {
      const text = textOf(e.message.content)
      const isThoughtHandBack =
        text.includes(HANDBACK) &&
        (await read($, isOn)) &&
        (await read($, thoughts)).some(t => isAbout(text, t.id, t.name))
      if (isThoughtHandBack) return next({ ...e, message: { ...e.message, content: [{ type: 'text', text: WAKE }] } })
    }
    return next(e)
  })

  // The voice saying nothing draws as nothing. Off, a reply is the engine's drawing alone.
  on('ui.render', { component: 'AssistantMessage' }, async ($, e, next) => {
    if (!isQuiet(e.props.text) || !(await read($, isOn))) return next(e)
    const { Box } = $.ui.resolve(e)
    return <Box display="none" />
  })

  // Updates handed to the voice are not the person's to read. The terminal draws them
  // as one dim line (ctrl+o shows them whole); other surfaces draw nothing. A surface
  // may not know the row came from this plugin (the desktop holds it under another
  // origin, its text still in the engine's frame), so the relay is known by its text too.
  // The engine's notice that a thought finished, and a message from a thought (its
  // hand-back), are folded the same way while Multitask is on; off, they are the engine's
  // drawing alone. A message is known by its sender: the desktop shows its body alone,
  // without the framing that names the sender.
  on('ui.render', { component: 'UserMessage' }, async ($, e, next) => {
    const origin = e.props.origin
    // The wake-up after a hidden relay says nothing to the person anywhere.
    if (isWakeText(e.props.text)) {
      const { Box } = $.ui.resolve(e)
      return <Box display="none" />
    }
    const isRelay = (origin.kind === 'plugin' && origin.name === 'multitask') || isRelayText(e.props.text)
    // A thought's notice folds to the dim line on the terminal. The desktop may never ask to
    // draw one (it draws its own task chips), but that is unconfirmed, so it is hidden there.
    const taskId = e.props.task?.id
    const isThoughtNotice =
      origin.kind === 'task-notification' &&
      taskId !== undefined &&
      (await read($, isOn)) &&
      (await read($, thoughts)).some(t => t.id === taskId)
    const from = e.props.from?.name
    const isHandBack = e.props.text.includes(HANDBACK)
    const isFromThought =
      (from !== undefined || isHandBack) &&
      (await read($, isOn)) &&
      (await read($, thoughts)).some(
        t => from === t.name || from === t.id || (isHandBack && isAbout(e.props.text, t.id, t.name)),
      )
    if (!isRelay && !isThoughtNotice && !isFromThought) return next(e)
    if (e.surface !== 'terminal') {
      const { Box } = $.ui.resolve(e)
      return <Box display="none" />
    }
    if (e.props.isExpanded) return next(e)

    const { Text } = $.ui.resolve(e)
    const names = relayNames(e.props.text)
    return <Text dimColor>◦ thought update{names.length > 0 ? `: ${names.join(', ')}` : ''}</Text>
  })

  // The band above the prompt: in Multitask mode, or with thoughts left, `thoughts` with
  // a dot for each running thought (band.tsx); then, while the mod is on in the chat,
  // Multitask's dropdown. Off with no thoughts left, the band is the other mods' alone.
  // They sit after what other mods draw there, keeping their width while the others give
  // way. The mobile app draws no dropdown: /multitask mode is there. The dots' timed
  // changes, and a dot's blink, draw the band afresh by a write of `bandTick`, which it
  // alone reads.
  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    const below = await next(e)
    if (e.props.hasSurvey) return below

    const on_ = await read($, isOn)
    const enabled = await isEnabled($)
    const all = await read($, thoughts)
    await read($, bandTick)
    // In Focus with no thoughts left, the band has no `thoughts`; an idle or failed one
    // keeps it up. Off, only a running one does.
    const showsThoughts = on_ || all.some(t => (enabled ? t.status !== 'stopped' : t.status === 'running'))
    const ui = $.ui.resolve(e)
    // On the desktop, the hit areas over the parts of `thoughts` (band.tsx draws them there).
    const hitOf =
      e.surface === 'desktop'
        ? (part: string) => {
            const { Client } = $.ui.resolve(e)
            return <Client key={`${THOUGHTS_HIT}${part}`} module="./press.tsx" width="100%" height="100%" />
          }
        : undefined
    const open = () => void $.ui.open({ id: PANE, title: 'Thoughts' })
    const drawing = { surface: e.surface, ui, now: await timeNow($), endings, blinks, open, ...(hitOf !== undefined && { hitOf }) }
    const { button, redrawIn } = showsThoughts ? drawThoughtsButton(drawing, all) : {}
    bandTimer?.cancel()
    bandTimer = redrawIn === undefined ? undefined : $.clock.after(redrawIn, () => void update($, bandTick, n => n + 1))
    const { Box } = ui
    let dropdown: RenderElement | undefined
    if (enabled && e.surface !== 'mobile') {
      const { Select } = $.ui.resolve(e)
      dropdown = (
        <Select
          key={DROPDOWN}
          options={[
            { value: MULTITASK_MODE, label: 'Multitask' },
            { value: FOCUS_MODE, label: 'Focus' },
          ]}
          value={on_ ? MULTITASK_MODE : FOCUS_MODE}
          onSelect={value => pickMode($, value)}
        />
      )
    }
    if (dropdown === undefined && button === undefined) return below

    const mine = (
      <Box flexDirection="row" alignItems="center" columnGap={1} flexShrink={0}>
        {button}
        {dropdown}
      </Box>
    )
    if (below.type === 'engine') return mine
    return (
      <Box flexDirection="row" alignItems="center" columnGap={2}>
        <Box flexDirection="row" alignItems="center" flexGrow={1} flexShrink={1} minWidth={0}>
          {below}
        </Box>
        {mine}
      </Box>
    )
  })

  // A click on any part of the desktop's `thoughts` button, a dot included, posts here from
  // its hit area (press.tsx) and opens the Thoughts pane.
  on('ui.message', async ($, e, next) => {
    if (!e.element.startsWith(THOUGHTS_HIT) || (e.data as { press?: unknown } | null)?.press !== true) return next(e)
    await $.ui.open({ id: PANE, title: 'Thoughts' })
    return next(e)
  })

  // The Thoughts pane, laid out by pane.tsx. Its ages are drawn afresh each minute it
  // stands open with thoughts in it, by a write of `paneTick`, which it alone reads.
  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const list = await read($, thoughts)
    await read($, paneTick)
    const now = await timeNow($)
    ageTick?.cancel()
    const hasAges = now !== undefined && list.length > 0
    ageTick = hasAges ? $.clock.after(AGE_TICK_MS, () => void update($, paneTick, n => n + 1)) : undefined
    return drawThoughts(
      {
        surface: e.surface,
        ui: $.ui.resolve(e),
        now,
        isEnabled: await isEnabled($),
        isOn: await read($, isOn),
        bodyColumns: e.props.bodyColumns,
        opened: await read($, expanded),
        shownReports: await read($, openReports),
        toggleExpanded: id => void toggleExpanded($, id),
        toggleReport: id => void toggleReport($, id),
        stop: id => void stopThought($, id),
        unqueue: (id, index) => void unqueue($, id, index),
        tellingTo: await read($, tellingTo),
        toggleTell: id => void toggleTell($, id),
        tell: (id, text) => void tellFromPane($, id, text),
        showsAllEnded: await read($, showsAllEnded),
        toggleShowsAllEnded: () => void update($, showsAllEnded, was => !was),
      },
      list,
    )
  })

  // Enter in a card's field in the Thoughts pane tells its thought the text, from here: an
  // event the engine raises to this mod, where auto mode allows the send (handOverDue says
  // why), which the field's own handler, run beneath every hook, may not be.
  on('ui.input', { component: 'Pane', requestId: PANE }, async ($, e, next) => {
    if (e.kind !== 'submit' || !e.element.startsWith(TELL_FIELD)) return next(e)
    await tellFromPane($, e.element.slice(TELL_FIELD.length), e.value)
    return { element: e.element, value: e.value }
  })
}
