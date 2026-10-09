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

import type { Thought, ThoughtStatus, Update } from '../types'
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
  heardOf,
  isQuiet,
  isRelayText,
  isWakeText,
  marksOf,
  newsOf,
  oneLine,
  relayNames,
} from './prompts'

const isOn = atom({ plugin: 'multitask', key: 'isOn' } as const, false)
const thoughts = atom({ plugin: 'multitask', key: 'thoughts' } as const, [])
const inbox = atom({ plugin: 'multitask', key: 'inbox' } as const, [])
const isMainBusy = atom({ plugin: 'multitask', key: 'isMainBusy' } as const, false)
const toldVoice = atom({ plugin: 'multitask', key: 'toldVoice' } as const, false)
const expanded = atom({ plugin: 'multitask', key: 'expanded' } as const, [])
const openReports = atom({ plugin: 'multitask', key: 'openReports' } as const, [])
const heard = atom({ plugin: 'multitask', key: 'heard' } as const, {})

const PANE = 'multitask-thoughts'
// Multitask's dropdown in the band. Its face is the mode the chat is in, Multitask or
// Focus (Multitask off); picking the other mode switches to it.
const DROPDOWN = 'multitask'
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

const PALETTE = ['#4fa3e0', '#d9636a', '#58b36b', '#c98a2e', '#9b6fd6', '#2fb3a6', '#d66bb0', '#8a9a3a']
const GLYPH: Record<ThoughtStatus, string> = { running: '◐', idle: '○', stopped: '×', failed: '!' }

// Updates arriving close together reach the voice as one message.
const FLUSH_MS = 2000
// How long an interrupted thought gets to end its turn before the message goes anyway.
const INTERRUPT_GRACE_MS = 4000
// How often, and how many times, a hand-over looks for the engine to have ended a thought's run.
const SETTLE_POLL_MS = 250
const SETTLE_POLLS = 20
// How many of a thought's progress notes are kept, and how long each may be.
const NOTES_KEPT = 5
const NOTE_MAX = 500
// How long the engine's notice that a thought's turn ended waits, at most, for that end
// to be settled.
const NOTICE_WAIT_MS = 1000
// What marks the engine's own hand-back of an agent's final report to the session that
// started it ("Another Claude session sent a message: ... [Subagent hand-back] ...").
const HANDBACK = '[Subagent hand-back]'

const OFF = {
  deny: 'Multitask is off. The user turns it on with the switch above the prompt or /multitask.',
}
const NOT_VOICE = { deny: 'Only the voice starts, steers or lists thoughts; this call came from another agent.' }

let flushTimer: Timer | undefined
// The settling of each thought's latest turn end, by thought id, with its name, which the
// engine's notice or hand-back of that end waits for. Kept here, not in state: what one
// dispatch reads of state stands still while it runs, so a wait for it would never see it.
const settling = new Map<string, { name: string; done: Promise<void> }>()

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

async function patchThought($: EngineInterface, id: string, fn: (t: Thought) => Thought) {
  await update($, thoughts, list => list.map(t => (t.id === id ? fn(t) : t)))
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

// A task's first line, which a running card shows until it is opened.
function firstLine(task: string): string {
  return task.trimStart().split('\n')[0]?.trimEnd() ?? ''
}

// The voice's tools are the model's from Multitask first coming on: a session that
// never switches it on has no tool of this mod's. Registered again, each is replaced.
async function offerVoiceTools($: EngineInterface) {
  for (const spec of TOOL_SPECS) {
    try {
      await $.tool.register(spec)
    } catch {
      // the switch stands; the next time it comes on tries again
    }
  }
}

async function toggle($: EngineInterface): Promise<boolean> {
  let now = false
  await update($, isOn, was => (now = !was))
  if (now) {
    await offerVoiceTools($)
  }
  await keepSwitch($)
  return now
}

// Switches to the mode picked in the band's dropdown; the mode the chat is in already,
// or anything else, leaves it be.
async function pickMode($: EngineInterface, value: string) {
  const wantsOn = value === MULTITASK_MODE ? true : value === FOCUS_MODE ? false : undefined
  if (wantsOn !== undefined && wantsOn !== (await read($, isOn))) await toggle($)
}

// Where a session's switch is kept between runs of the app: whether it is on, when it
// was kept, and, once it has been on, the marks of its newest messages.
const switchKey = (sessionId: string) => `session:${sessionId}`
type KeptSwitch = { isOn: boolean; at: number; marks: string[] }
const MARKS_KEPT = 200

// Keeps the switch for the session's next run. A session never on keeps no marks: one
// rewound or forked from it starts off as it would anyway. Best effort: a store or
// transcript that cannot be read or written keeps what it kept.
async function keepSwitch($: EngineInterface) {
  try {
    const key = switchKey(await $.session.id())
    const was = (await $.store.get(key)) as Partial<KeptSwitch> | undefined
    const now = await read($, isOn)
    const isMarked = now || (was?.marks?.length ?? 0) > 0
    const marks = isMarked ? marksOf(await $.session.messages()).slice(-MARKS_KEPT) : []
    await $.store.set(key, { isOn: now, at: await $.clock.now(), marks } satisfies KeptSwitch)
  } catch {
    // kept as it was
  }
}

// The switch a session kept, or for one rewound or forked, which starts under a new id
// with copies of the messages it kept, that of the session it came from: the kept one
// that knows the most of its messages, else, of those near that, the one kept last (the
// one it was just in). None when no session is known.
async function keptSwitch($: EngineInterface): Promise<boolean | undefined> {
  const own = (await $.store.get(switchKey(await $.session.id()))) as Partial<KeptSwitch> | undefined
  if (own !== undefined) return own.isOn === true
  const mine = new Set(marksOf(await $.session.messages()))
  if (mine.size === 0) return undefined
  const scored: { kept: Partial<KeptSwitch>; score: number }[] = []
  for (const key of await $.store.keys()) {
    if (!key.startsWith('session:')) continue
    const kept = ((await $.store.get(key)) ?? {}) as Partial<KeptSwitch>
    const score = new Set((kept.marks ?? []).filter(mark => mine.has(mark))).size
    if (score > 0) scored.push({ kept, score })
  }
  const best = Math.max(0, ...scored.map(s => s.score))
  if (best < 3) return undefined
  const near = scored.filter(s => s.score * 2 > best).sort((a, b) => (b.kept.at ?? 0) - (a.kept.at ?? 0))
  return near[0]?.kept.isOn === true
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
// relayed to the voice while RELAY_NOTES is on. Its tool calls never are.
async function noteThoughtSaid($: EngineInterface, id: string, text: string) {
  const t = (await read($, thoughts)).find(one => one.id === id)
  // The turn's report, should its row land after the turn ended, has been relayed already.
  if (t === undefined || text === '' || text === t.lastText) return
  await patchThought($, id, one => ({
    ...one,
    notes: [...(one.notes ?? []), text.slice(0, NOTE_MAX)].slice(-NOTES_KEPT),
    notedSinceReport: true,
  }))
  if (RELAY_NOTES) await relay($, list => [...list, { thought: t.name, text }])
}

// The end of a thought's turn reaches the voice once, as a done line. Its report replaces
// the notes still waiting that it repeats; if it went out already as the latest note,
// the line is a bare "done". With notes not relayed, nothing went out before it.
async function relayDone($: EngineInterface, t: Thought, report: string, isFailed: boolean) {
  const notes = t.notes ?? []
  const wasSent = RELAY_NOTES && report !== '' && notes.at(-1) === report.slice(0, NOTE_MAX)
  await relay($, list => {
    const kept = [...list]
    let isWaiting = false
    for (let i = kept.length - 1; i >= 0; i--) {
      const u = kept[i] as Update
      if (u.thought !== t.name) continue
      if (u.isDone === true || !report.includes(u.text)) break
      kept.splice(i, 1)
      isWaiting = true
    }
    const said = isWaiting || !wasSent ? report : ''
    const text = isFailed ? [said, '(ended on an error)'].filter(part => part !== '').join(' ') : said
    return [...kept, { thought: t.name, text, isDone: true }]
  })
}

// Sends a thought a message: to its agent's id, failing that to its name. The answer says
// whether it got there and why not; a thought that has it runs again, one that has not
// keeps the status it had.
async function deliver($: EngineInterface, t: Thought, text: string): Promise<SessionSendResult> {
  let was: ThoughtStatus = t.status
  await patchThought($, t.id, one => {
    was = one.status
    return { ...one, status: 'running' }
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
  if (!sent.isDelivered) await patchThought($, t.id, one => (one.status === 'running' ? { ...one, status: was } : one))
  return sent
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

// Hands a thought what waited for its turn to end, once the engine has ended the run.
// What does not reach it goes back to the front of its queue, and the voice is told.
async function handOver($: EngineInterface, id: string, waited: string[], text: string) {
  const ended = await runEnded($, id)
  const t = (await read($, thoughts)).find(one => one.id === id)
  if (t === undefined || t.status === 'stopped') return
  const sent = await deliver($, t, text)
  if (sent.isDelivered) return
  await patchThought($, id, one => ({
    ...one,
    queued: [...waited, ...one.queued],
    status: ended === 'running' ? one.status : statusOf(ended ?? 'completed'),
  }))
  const what = waited.length === 1 ? 'a message' : `${waited.length} messages`
  await relay($, list => [...list, { thought: t.name, text: `(${what} did not reach it, still queued for the end of its next turn: ${sent.reason})` }])
}

async function stopThought($: EngineInterface, id: string) {
  await patchThought($, id, t => ({ ...t, status: 'stopped', queued: [], interruptWith: null }))
  try {
    await $.tool.call({ tool: 'TaskStop', task_id: id })
  } catch {
    // it had already ended
  }
}

async function unqueue($: EngineInterface, id: string, index: number | undefined) {
  await patchThought($, id, t => ({
    ...t,
    queued: index === undefined ? [] : t.queued.filter((_, i) => i !== index),
  }))
}

// Cuts a thought's running turn so the message goes in at once: the cut turn's end (or
// the grace timer) hands it over. With no turn the engine will cut, the message waits in
// its queue for the run's end, or goes now when the run has ended. The thought is never
// stopped: a stopped agent takes no more messages. Answers as tell does.
async function interrupt($: EngineInterface, t: Thought, text: string): Promise<TellAnswer> {
  let pending = text
  if (t.turnId !== null) {
    await patchThought($, t.id, one => ({
      ...one,
      interruptWith: one.interruptWith === null ? text : `${one.interruptWith}\n\n${text}`,
    }))
    try {
      await $.turn.abort({ turnId: t.turnId })
      // Normally its turn.complete hands the message over; this covers a turn that never reports.
      $.clock.after(INTERRUPT_GRACE_MS, () => void handOverInterrupt($, t.id))
      return { result: `Interrupting ${t.name}; it gets the message as soon as its current turn is cut.` }
    } catch {
      // That turn had ended. Unless its end handed the message over, it goes another way.
      let taken = null as string | null
      await patchThought($, t.id, one => {
        taken = one.interruptWith
        return { ...one, interruptWith: null }
      })
      if (taken === null) return { result: `${t.name}'s turn had just ended; it gets the message now.` }
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

// Hands over the interruption still waiting, if any. Whichever comes second, the cut
// turn's end or the grace timer, finds none and leaves the thought be: its turn by
// then may be the one the interruption started, whose id a later interrupt aborts.
async function handOverInterrupt($: EngineInterface, id: string) {
  let text = null as string | null
  await patchThought($, id, t => {
    text = t.interruptWith
    return text === null ? t : { ...t, interruptWith: null, turnId: null }
  })
  if (text !== null) await handOver($, id, [text], `Interruption from the voice: ${text}`)
}

// The notes a turn's report leaves: its own text arrived as notes too, last.
function notesBefore(notes: string[], report: string): string[] {
  const kept = [...notes]
  while (kept.length > 0 && report.includes(kept.at(-1) as string)) kept.pop()
  return kept
}

// A thought's turn ended: the voice is told, with the text it ended on as its report (a
// result, question or problem); then an interruption or its queue is handed over, or
// it goes idle.
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
  if (!isCut) await relayDone($, t, report, reason === 'error' || reason === 'refusal')
  // What waits for it is read as it stands now, in the same step that settles it, not as
  // it stood when the turn ended: the voice may have queued or interrupted since.
  const status: ThoughtStatus = reason === 'error' || reason === 'refusal' ? 'failed' : 'idle'
  let waiting = null as 'interruption' | 'queue' | null
  let queued: string[] = []
  await patchThought($, id, one => {
    if (one.status === 'stopped') return one
    if (one.interruptWith !== null) {
      waiting = 'interruption'
      return one
    }
    if (one.queued.length > 0) {
      waiting = 'queue'
      queued = one.queued
      return { ...one, queued: [], turnId: null }
    }
    return { ...one, status, turnId: null }
  })
  if (waiting === 'interruption') return handOverInterrupt($, id)
  if (waiting === 'queue') return handOver($, id, queued, queued.join('\n\n'))
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
  const voiceEffort = typeof options.voiceEffort === 'string' ? options.voiceEffort : 'low'

  on('session.start', async ($, e, next) => {
    await update($, isMainBusy, () => false)
    await $.agent.register({
      name: 'thought',
      description: 'One thought of a multitasking mind; started by the multitask mod only.',
      prompt: THOUGHT,
      disallowedTools: Object.values(TOOL),
    })
    // A restarted or resumed session takes up the switch it kept; a rewound or forked
    // one, that of the session it came from. One that holds it on (a reload) stays on.
    if ((await keptSwitch($).catch(() => undefined)) === true) await update($, isOn, () => true)
    await keepSwitch($)
    // The switch and the thoughts outlive a reload of this code or a restart of the
    // session: the tools they had are offered again. Never switched on, the session gets none.
    if ((await read($, isOn)) || (await read($, thoughts)).length > 0) await offerVoiceTools($)
    await $.command.register({ name: 'multitask', description: 'Turn Multitask on or off' })
    await $.command.register({ name: 'thoughts', description: 'Show the multitasking thoughts in a pane' })
    return next(e)
  })

  // The engine resumes an ended thought with a message only if its type is offered, so it
  // is offered while Multitask is on; the model still cannot start one (tool.check, below).
  on('agent.offer', { agent: AGENT }, async ($, e, next) => ((await read($, isOn)) ? next(e) : { isOffered: false }))

  on('command.run', { command: 'multitask' }, async $ => {
    const now = await toggle($)
    return {
      text: now
        ? 'Multitask is on: this session is now the voice and hands all work to thoughts.'
        : 'Multitask is off.',
    }
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

    const thought: Thought = {
      id,
      name,
      task,
      color: PALETTE[list.length % PALETTE.length] ?? '#888888',
      status: 'running',
      queued: [],
      lastText: '',
      notes: [],
      turnId: null,
      interruptWith: null,
    }
    await update($, thoughts, all => [...all, thought])
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
    // With no turn running, its last run may still be winding down: the message goes once it has ended.
    if (!isRunning) await runEnded($, t.id)
    const sent = await deliver($, t, message)
    if (!sent.isDelivered) return notDelivered(t, sent.reason)
    return {
      result: isRunning
        ? `Posted to ${t.name}; it reads it at its next step.`
        : `${t.name} was ${t.status === 'running' ? 'idle' : t.status}; it has the message now and resumes.`,
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
    const agents = await $.agent.list()
    await update($, thoughts, list =>
      list.map(t => {
        const agent = agents.find(a => a.id === t.id)
        return agent === undefined || t.status === 'stopped' ? t : { ...t, status: statusOf(agent.status) }
      }),
    )
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
      const t = (await read($, thoughts)).find(one => isAbout(e.text, one.id, one.name))
      if (t === undefined || !(await read($, isOn))) return next(e)
      const relayed = await takeRelay($)
      if (relayed !== undefined) return next({ ...e, text: (await appendHidden($, relayed)) ? WAKE : relayed })
      const news = await takeNews($)
      const woken = isHandBack ? { ...e, text: WAKE } : e
      return news === undefined ? next(woken) : next({ ...woken, context: [...(e.context ?? []), news] })
    }
    if (!PERSON.has(e.origin.kind)) return next(e)
    // While on, the marks a session rewound or forked from this one is known by are kept fresh.
    if (await read($, isOn)) await keepSwitch($)
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
  // thoughts is allowed; any other send is decided as before.
  on('tool.check', { tool: 'SendMessage' }, async ($, e, next) => {
    if (next.origin.plugin !== $.plugin.name) return next(e)
    const to = (e.input as { to?: unknown } | null)?.to
    if (typeof to !== 'string' || findThought(await read($, thoughts), to.trim()) === undefined) return next(e)
    return { decision: 'allow', reason: 'A message from the multitask voice to its own thought.' }
  })

  on('turn.start', async ($, e, next) => {
    flushTimer?.cancel()
    await update($, isMainBusy, () => true)
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
      await patchThought($, id, one => ({
        ...one,
        turnId: e.turnId,
        status: one.status === 'stopped' ? one.status : 'running',
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

  // What a thought writes as it works is kept as its progress notes (and relayed, while RELAY_NOTES is on).
  // While Multitask is on, the engine's hand-back of a thought's report is stored as the
  // wake-up: the engine keeps the text a hand-back was queued with, whatever prompt.submit
  // returns, so it is changed here, as it is stored.
  on('session.append', async ($, e, next) => {
    if (e.agentId !== undefined && e.door === 'response') {
      await noteThoughtSaid($, e.agentId, textOf(e.message.content))
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

  // The band above the prompt: Multitask's dropdown and, while Multitask is on or has
  // thoughts left, `thoughts`. They sit after what other mods draw there, keeping their
  // width while the others give way. The mobile app draws no dropdown: /multitask is there.
  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    const below = await next(e)
    if (e.props.hasSurvey) return below

    const on_ = await read($, isOn)
    const live = (await read($, thoughts)).filter(t => t.status !== 'stopped')
    // The count is of the thoughts running now; an idle or failed one only keeps the button up.
    const running = live.filter(t => t.status === 'running').length
    const queued = live.reduce((n, t) => n + t.queued.length, 0)
    const thoughtsLabel =
      (running > 0 ? `thoughts ${running}` : 'thoughts') + (queued > 0 ? ` · ${queued} queued` : '')
    const { Box, Button } = $.ui.resolve(e)
    let dropdown: RenderElement | undefined
    if (e.surface !== 'mobile') {
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
    // Off with no thoughts left, the band has no `thoughts`.
    const showsThoughts = on_ || live.length > 0
    if (dropdown === undefined && !showsThoughts) return below

    const mine = (
      <Box flexDirection="row" alignItems="center" columnGap={1} flexShrink={0}>
        {dropdown}
        {showsThoughts && (
          <Button key="open-thoughts" label={thoughtsLabel} onPress={() => void $.ui.open({ id: PANE, title: 'Thoughts' })} />
        )}
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

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const { Box, Text, Button, Markdown } = $.ui.resolve(e)
    const list = await read($, thoughts)
    const on_ = await read($, isOn)
    // Running thoughts come first, as cards showing their task's first line; the rest draw
    // as one line. Opening one (its name, or more) shows everything, the whole task too.
    const ordered = [...list].sort((a, b) => Number(a.status !== 'running') - Number(b.status !== 'running'))
    const opened = await read($, expanded)
    const shownReports = await read($, openReports)
    // Cells a card's task line has: the pane's body less the card's border and padding.
    const taskColumns = e.props.bodyColumns - 4

    return (
      <Box flexDirection="column">
        <Box marginBottom={1}>
          <Text dimColor>
            Multitask is {on_ ? 'on' : 'off'}. {list.length === 0 ? 'No thoughts yet.' : `${list.length} thought(s).`}
          </Text>
        </Box>
        {ordered.map(t =>
          t.status !== 'running' && !opened.includes(t.id) ? (
            <Box flexDirection="row" columnGap={1} alignItems="center">
              <Text color={t.color}>{GLYPH[t.status]}</Text>
              <Button key={`expand:${t.id}`} plain label={t.name} onPress={() => void toggleExpanded($, t.id)} />
              <Text dimColor>{t.status}</Text>
              {t.status !== 'stopped' && (
                <Button key={`stop:${t.id}`} label="stop" onPress={() => void stopThought($, t.id)} />
              )}
            </Box>
          ) : (
          <Box flexDirection="column" borderStyle="round" borderColor={t.color} paddingX={1} marginBottom={1}>
            <Box flexDirection="row" columnGap={1} alignItems="center">
              <Text color={t.color} bold>
                {GLYPH[t.status]}
              </Text>
              <Button key={`expand:${t.id}`} plain label={t.name} onPress={() => void toggleExpanded($, t.id)} />
              <Text dimColor>{t.status}</Text>
              {t.status !== 'stopped' && (
                <Button key={`stop:${t.id}`} label="stop" onPress={() => void stopThought($, t.id)} />
              )}
              {t.status === 'running' && (t.task.trim() !== firstLine(t.task) || firstLine(t.task).length > taskColumns) && (
                <Button
                  key={`more:${t.id}`}
                  plain
                  dimColor
                  label={opened.includes(t.id) ? 'less' : 'more'}
                  onPress={() => void toggleExpanded($, t.id)}
                />
              )}
              {t.status !== 'running' && (
                <Button key={`collapse:${t.id}`} plain dimColor label="hide" onPress={() => void toggleExpanded($, t.id)} />
              )}
            </Box>
            {opened.includes(t.id) ? (
              <Text dimColor>{t.task}</Text>
            ) : (
              <Text dimColor wrap="truncate-end">
                {firstLine(t.task)}
              </Text>
            )}
            {t.queued.map((q, i) => (
              <Box flexDirection="row" columnGap={1}>
                <Text>
                  queued {i + 1}: {q}
                </Text>
                <Button key={`unqueue:${t.id}:${i}`} label="unqueue" onPress={() => void unqueue($, t.id, i)} />
              </Box>
            ))}
            {(t.notes ?? []).slice(-3).map(n => (
              <Text dimColor wrap="truncate-end">
                · {oneLine(n, 200)}
              </Text>
            ))}
            {/* Its report, its first line until opened. Not while it works on, nor once it has
                written notes since: an old report would read as the result of the new work. */}
            {t.lastText !== '' && t.status !== 'running' && t.notedSinceReport !== true && (
              <Box key={`reportbox:${t.id}`} flexDirection="column">
                {shownReports.includes(t.id) && <Markdown text={t.lastText.slice(-1500)} />}
                <Box flexDirection="row" columnGap={1}>
                  {!shownReports.includes(t.id) && (
                    <Box flexShrink={1} minWidth={0}>
                      <Text wrap="truncate-end">{oneLine(t.lastText, 200)}</Text>
                    </Box>
                  )}
                  {/* Lit in the thought's colour with the pointer anywhere on the report; the line gives way, not it. */}
                  <Box flexShrink={0}>
                    <Button
                      key={`report:${t.id}`}
                      plain
                      dimColor
                      hover={{ color: t.color }}
                      label={shownReports.includes(t.id) ? 'less' : 'more'}
                      onPress={() => void toggleReport($, t.id)}
                    />
                  </Box>
                </Box>
              </Box>
            )}
          </Box>
        ))}
      </Box>
    )
  })
}
