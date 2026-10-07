import { atom, read, update } from 'claude-code'
import type { AgentStatus, EngineInterface, Register, RenderElement, Timer, TurnCompleteReason } from 'claude-code'

import type { Thought, ThoughtStatus, Update } from '../types'
import {
  RELAY_NOTES,
  THOUGHT,
  VOICE,
  VOICE_OFF,
  VOICE_REMINDER,
  describeThoughts,
  formatUpdates,
  isQuiet,
  isRelayText,
  oneLine,
  relayNames,
} from './prompts'

const isOn = atom({ plugin: 'multitask', key: 'isOn' } as const, false)
const thoughts = atom({ plugin: 'multitask', key: 'thoughts' } as const, [])
const inbox = atom({ plugin: 'multitask', key: 'inbox' } as const, [])
const isMainBusy = atom({ plugin: 'multitask', key: 'isMainBusy' } as const, false)
const toldVoice = atom({ plugin: 'multitask', key: 'toldVoice' } as const, false)
const expanded = atom({ plugin: 'multitask', key: 'expanded' } as const, [])

const PANE = 'multitask-thoughts'
const SWITCH = 'multitask-switch'
const AGENT = 'multitask:thought'
const TOOL = {
  think: 'mcp__multitask__think',
  tell: 'mcp__multitask__tell',
  unqueue: 'mcp__multitask__unqueue',
  stop: 'mcp__multitask__stop',
  thoughts: 'mcp__multitask__thoughts',
} as const

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
// How many of a thought's progress notes are kept, and how long each may be.
const NOTES_KEPT = 5
const NOTE_MAX = 500

const OFF = {
  deny: 'Multitask is off. The user turns it on with the switch above the prompt or /multitask.',
}

let flushTimer: Timer | undefined

const TOOL_SPECS = [
  {
    name: 'think',
    description:
      'Start a thought: a background agent that does the work on one task while you keep talking with the user. Give it a self-contained brief; it cannot see this conversation.',
    inputSchema: {
      type: 'object',
      properties: {
        name: { type: 'string', description: 'Short name for the thought, 1-3 words' },
        task: { type: 'string', description: 'The full, self-contained brief' },
      },
      required: ['name', 'task'],
    },
  },
  {
    name: 'tell',
    description:
      'Give a thought a message. post: it reads it at its next step. queue: held until it finishes its current turn (can be unqueued until then). interrupt: cut what it is doing and hand it this now.',
    inputSchema: {
      type: 'object',
      properties: {
        thought: { type: 'string', description: 'The thought\'s name' },
        message: { type: 'string' },
        how: { type: 'string', enum: ['post', 'queue', 'interrupt'], description: 'Default post' },
      },
      required: ['thought', 'message'],
    },
  },
  {
    name: 'unqueue',
    description: 'Withdraw messages queued for a thought before it reads them.',
    inputSchema: {
      type: 'object',
      properties: {
        thought: { type: 'string' },
        index: { type: 'integer', description: '1-based position in its queue; leave out to withdraw all' },
      },
      required: ['thought'],
    },
  },
  {
    name: 'stop',
    description: 'Stop a thought for good.',
    inputSchema: { type: 'object', properties: { thought: { type: 'string' } }, required: ['thought'] },
  },
  {
    name: 'thoughts',
    description:
      'Every thought\'s status, queue, latest progress notes and last report; with a thought\'s name, its recent transcript instead.',
    inputSchema: { type: 'object', properties: { thought: { type: 'string' } } },
  },
]

// The SVG of a slide switch: a rounded track with the knob to the right when on.
function switchPicture(isOn: boolean): string {
  const track = isOn ? '#3b82f6' : '#8c8c8c'
  const knob = isOn ? 23 : 11
  return `<svg xmlns="http://www.w3.org/2000/svg" width="34" height="20" viewBox="0 0 34 20"><rect x="1" y="2" width="32" height="16" rx="8" fill="${track}"/><circle cx="${knob}" cy="10" r="6" fill="#ffffff"/></svg>`
}

function str(e: unknown, key: string): string {
  const value = (e as Record<string, unknown>)[key]
  return typeof value === 'string' ? value.trim() : ''
}

function findThought(list: Thought[], ref: string): Thought | undefined {
  const wanted = ref.toLowerCase()
  return list.find(t => t.id === ref) ?? list.find(t => t.name.toLowerCase() === wanted)
}

function unknownThought(list: Thought[], ref: string) {
  const names = list.map(t => t.name).join(', ') || 'none'
  return { deny: `No thought called "${ref}". Thoughts: ${names}.` }
}

function slug(text: string): string {
  const words = text.toLowerCase().replace(/[^\p{L}\p{N}\s-]/gu, ' ').trim().split(/\s+/).slice(0, 3)
  return words.join('-') || 'thought'
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

// A task's first line, which a running card shows until it is opened.
function firstLine(task: string): string {
  return task.trimStart().split('\n')[0]?.trimEnd() ?? ''
}

async function toggle($: EngineInterface): Promise<boolean> {
  let now = false
  await update($, isOn, was => (now = !was))
  if (now) void $.ui.open({ id: PANE, title: 'Thoughts' })
  return now
}

function scheduleFlush($: EngineInterface) {
  flushTimer?.cancel()
  flushTimer = $.clock.after(FLUSH_MS, () => void flushInbox($))
}

// Hands what the thoughts said to the voice as one message, once it is idle.
async function flushInbox($: EngineInterface) {
  if (!(await read($, isOn)) || (await read($, isMainBusy))) return
  let taken: Update[] = []
  await update($, inbox, list => {
    taken = list
    return []
  })
  if (taken.length === 0) return
  void $.prompt.submit({ text: formatUpdates(taken) })
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

async function deliver($: EngineInterface, id: string, text: string) {
  await patchThought($, id, t => ({ ...t, status: 'running' }))
  await $.session.send({ to: { agentId: id }, text })
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

async function interrupt($: EngineInterface, t: Thought, text: string) {
  await patchThought($, t.id, one => ({ ...one, interruptWith: text }))
  let isCut = false
  if (t.turnId !== null) {
    try {
      await $.turn.abort({ turnId: t.turnId })
      isCut = true
    } catch {
      isCut = false
    }
  }
  if (!isCut) {
    try {
      await $.tool.call({ tool: 'TaskStop', task_id: t.id })
    } catch {
      // nothing was running
    }
  }
  // Normally its turn.complete hands the message over; this covers a turn that never reports.
  $.clock.after(INTERRUPT_GRACE_MS, () => void handOverInterrupt($, t.id))
}

// Hands over the interruption still waiting, if any. Whichever comes second, the cut
// turn's end or the grace timer, finds none and leaves the thought be: its turn by
// then may be the one the interruption started, whose id a later interrupt aborts.
async function handOverInterrupt($: EngineInterface, id: string) {
  let text: string | null = null
  await patchThought($, id, t => {
    text = t.interruptWith
    return text === null ? t : { ...t, interruptWith: null, turnId: null }
  })
  if (text !== null) await deliver($, id, `Interruption from the voice: ${text}`)
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
  if (t.interruptWith !== null) return handOverInterrupt($, id)
  if (t.queued.length > 0) {
    const text = t.queued.join('\n\n')
    await patchThought($, id, one => ({ ...one, queued: [], turnId: null }))
    return deliver($, id, text)
  }
  const status: ThoughtStatus = reason === 'error' || reason === 'refusal' ? 'failed' : 'idle'
  await patchThought($, id, one => ({ ...one, status, turnId: null }))
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
    for (const spec of TOOL_SPECS) await $.tool.register(spec)
    await $.command.register({ name: 'multitask', description: 'Turn Multitask on or off' })
    await $.command.register({ name: 'thoughts', description: 'Show the multitasking thoughts in a pane' })
    return next(e)
  })

  on('agent.offer', { agent: AGENT }, () => ({ isOffered: false }))

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
  on('tool.call', async ($, e, next) => {
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
    const name = uniqueName(list, slug(str(e, 'name') || task))

    const spawned = await $.agent.spawn({ prompt: task, description: name, subagentType: AGENT })
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
    const t = findThought(list, str(e, 'thought'))
    if (t === undefined) return unknownThought(list, str(e, 'thought'))
    const message = str(e, 'message')
    if (message === '') return { deny: 'Give a message.' }
    const how = str(e, 'how') || 'post'
    const isRunning = t.status === 'running'

    if (how === 'queue' && isRunning) {
      await patchThought($, t.id, one => ({ ...one, queued: [...one.queued, message] }))
      return { result: `Queued for ${t.name} as #${t.queued.length + 1}; it reads it when its turn ends.` }
    }
    if (how === 'interrupt' && isRunning) {
      await interrupt($, t, message)
      return { result: `Interrupting ${t.name}; it gets the message as soon as its current turn is cut.` }
    }
    await deliver($, t.id, message)
    return {
      result: isRunning
        ? `Posted to ${t.name}; it reads it at its next step.`
        : `${t.name} was ${t.status}; it has the message now and resumes.`,
    }
  })

  on('tool.call', { tool: 'mcp__multitask__unqueue' }, async ($, e) => {
    const list = await read($, thoughts)
    const t = findThought(list, str(e, 'thought'))
    if (t === undefined) return unknownThought(list, str(e, 'thought'))
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
    const t = findThought(list, str(e, 'thought'))
    if (t === undefined) return unknownThought(list, str(e, 'thought'))
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
    const ref = str(e, 'thought')
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

  // The engine's own note that a background agent ended would reach the voice
  // twice; the relay already carries it. Beside the person's own message the voice
  // is told when Multitask came on or went off: that is the one way it is told. A
  // system prompt section would not follow the switch, as the engine sends the
  // prompt it recorded at the first request until a compaction, and on a machine
  // with managed settings it is never sent, the managed plugin skipping a user
  // plugin's prompt.compose hook.
  on('prompt.submit', async ($, e, next) => {
    if (e.origin.kind === 'task-notification') {
      const list = await read($, thoughts)
      if (list.some(t => e.text.includes(t.id))) return { drop: 'multitask relays its thoughts itself' }
    }
    if (!PERSON.has(e.origin.kind)) return next(e)
    const note = await voiceNote($)
    return note === undefined ? next(e) : next({ ...e, context: [...(e.context ?? []), note] })
  })

  // A compaction may summarise the voice's part away: while Multitask is on, it is
  // told whole again beside the person's next message. (Gone off, it is told so.)
  on('session.compact', async ($, e, next) => {
    const result = await next(e)
    const isCompacted = e.agentId === undefined && e.trigger !== 'precompute' && result.skip === undefined
    if (isCompacted && (await read($, isOn))) await update($, toldVoice, () => false)
    return result
  })

  // The voice's think call was allowed as any call is; the thought it starts is the
  // mod's own agent type, which the model is never offered, so its start is not put
  // to a second decider. What the thought then does is checked as any agent's work.
  on('tool.check', { tool: 'Agent' }, async ($, e, next) => {
    const input = e.input as { subagent_type?: unknown; subagentType?: unknown } | null
    if (input?.subagent_type !== AGENT && input?.subagentType !== AGENT) return next(e)
    return { decision: 'allow', reason: 'A thought the multitask voice started.' }
  })

  on('turn.start', async ($, e, next) => {
    flushTimer?.cancel()
    await update($, isMainBusy, () => true)
    return next(e)
  })

  // A thought's latest turn is noted; the voice's requests think less hard.
  on('turn.step', async function* ($, e, next) {
    const id = e.agentId
    if (id === undefined) {
      const isLighter = voiceEffort !== 'session' && e.effort !== undefined && (await read($, isOn))
      return yield* next(isLighter ? { ...e, effort: lighterEffort(e.effort, voiceEffort) } : e)
    }
    const t = (await read($, thoughts)).find(one => one.id === id)
    if (t !== undefined && t.turnId !== e.turnId) {
      await patchThought($, id, one => ({
        ...one,
        turnId: e.turnId,
        status: one.status === 'stopped' ? one.status : 'running',
      }))
    }
    return yield* next(e)
  })

  on('turn.complete', async ($, e, next) => {
    const result = await next(e)
    if (e.agentId === undefined) {
      await update($, isMainBusy, () => false)
      scheduleFlush($)
    } else if ((await read($, thoughts)).some(t => t.id === e.agentId)) {
      void settleThought($, e.agentId, e.reason, e.answer)
    }
    return result
  })

  // What a thought writes as it works is kept as its progress notes (and relayed, while RELAY_NOTES is on).
  on('session.append', async ($, e, next) => {
    if (e.agentId !== undefined && e.door === 'response') {
      await noteThoughtSaid($, e.agentId, textOf(e.message.content))
    }
    return next(e)
  })

  // The voice saying nothing draws as nothing.
  on('ui.render', { component: 'AssistantMessage' }, async ($, e, next) => {
    if (!isQuiet(e.props.text)) return next(e)
    const { Box } = $.ui.resolve(e)
    return <Box display="none" />
  })

  // Updates handed to the voice are not the person's to read. The terminal draws them
  // as one dim line (ctrl+o shows them whole); other surfaces draw nothing. A surface
  // may not know the row came from this plugin (the desktop holds it under another
  // origin, its text still in the engine's frame), so the relay is known by its text too.
  on('ui.render', { component: 'UserMessage' }, async ($, e, next) => {
    const origin = e.props.origin
    const isRelay = (origin.kind === 'plugin' && origin.name === 'multitask') || isRelayText(e.props.text)
    const taskId = e.props.task?.id
    const isThoughtNotice =
      origin.kind === 'task-notification' &&
      taskId !== undefined &&
      (await read($, thoughts)).some(t => t.id === taskId)
    if (!isRelay && !isThoughtNotice) return next(e)
    if (e.surface !== 'terminal') {
      const { Box } = $.ui.resolve(e)
      return <Box display="none" />
    }
    if (e.props.isExpanded) return next(e)

    const { Text } = $.ui.resolve(e)
    const names = relayNames(e.props.text)
    return <Text dimColor>◦ thought update{names.length > 0 ? `: ${names.join(', ')}` : ''}</Text>
  })

  // The switch posts here when clicked.
  on('ui.message', async ($, e, next) => {
    if (e.element === SWITCH && (e.data as { flip?: unknown } | null)?.flip === true) await toggle($)
    return next(e)
  })

  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    const below = await next(e)
    if (e.props.hasSurvey) return below

    const on_ = await read($, isOn)
    const live = (await read($, thoughts)).filter(t => t.status !== 'stopped')
    // The count is of the thoughts running now; an idle or failed one only keeps the band up.
    const running = live.filter(t => t.status === 'running').length
    const queued = live.reduce((n, t) => n + t.queued.length, 0)
    const thoughtsLabel =
      (running > 0 ? `thoughts ${running}` : 'thoughts') + (queued > 0 ? ` · ${queued} queued` : '')
    const { Box, Text, Button } = $.ui.resolve(e)

    let toggleSwitch: RenderElement
    if (e.surface === 'desktop') {
      // A real switch: its picture with a hit area laid over it.
      const { Svg, Client } = $.ui.resolve(e)
      toggleSwitch = (
        <Box>
          <Svg source={switchPicture(on_)} alt={`Multitask: ${on_ ? 'on' : 'off'}`} width={34} height={20} />
          <Box position="absolute" top={0} left={0} width="100%" height="100%">
            <Client key={SWITCH} module="./switch.tsx" props={{ isOn: on_ }} width="100%" height="100%" />
          </Box>
        </Box>
      )
    } else {
      toggleSwitch = (
        <Button
          key="multitask"
          label={on_ ? '( ●)' : '(● )'}
          variant={on_ ? 'primary' : 'secondary'}
          dimColor={!on_}
          onPress={() => void toggle($)}
        />
      )
    }

    // One row that keeps its width; nothing the pointer shows takes room.
    const band = (
      <Box flexDirection="row" columnGap={1} alignItems="center" flexShrink={0}>
        <Text>Multitask</Text>
        {toggleSwitch}
        {(on_ || live.length > 0) && (
          <Button key="open-thoughts" label={thoughtsLabel} onPress={() => void $.ui.open({ id: PANE, title: 'Thoughts' })} />
        )}
      </Box>
    )

    // Shares the one row with other mods' controls, on its right: theirs give way, these
    // keep their width.
    if (below.type === 'engine') return band
    return (
      <Box flexDirection="row" justifyContent="space-between" alignItems="center" columnGap={2}>
        <Box flexDirection="row" alignItems="center" flexGrow={1} flexShrink={1} minWidth={0}>
          {below}
        </Box>
        {band}
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
            {/* Its report, unless it has written notes since: a stale report would sit under fresh ones. */}
            {t.lastText !== '' && t.notedSinceReport !== true && <Markdown text={t.lastText.slice(-1500)} />}
          </Box>
        ))}
      </Box>
    )
  })
}
