import type { AgentInfo, On, TurnStepChunk } from 'claude-code'
import { expect, mock, test } from 'claude-code/testing'
import type { Engine } from 'claude-code/testing'

import {
  NO_RESPONSE,
  RELAY_NOTES,
  VOICE,
  VOICE_REMINDER,
  WAKE,
  formatUpdates,
  isQuiet,
  marksOf,
  relayNames,
} from '../hooks/prompts'
import type { KeptThoughts, Thought, ThoughtStatus } from '../types'

type Seen = {
  prompts: string[]
  // set to have the model answer each request with these pieces
  reply?: TurnStepChunk[]
  sends: { to: string; text: string }[]
  ran: string[]
  efforts: unknown[]
  aborts: string[]
  spawns: number
  // the name each spawn gave its agent
  names: (string | undefined)[]
  // set to refuse every message with this reason, as the engine does one it cannot deliver
  refuse?: string
  // set to have every turn.abort reject, as the engine does for a turn that is not running
  isAbortRefused?: boolean
  // set to leave an agent's run counted as running after its turn ends, as while it winds down
  isWindingDown?: boolean
  // set to keep the user rows appended, as a transcript would; else the mod's own are refused
  hidden?: string[]
  // the tools the mod offered the model, by name
  registered: string[]
  // set to refuse, as auto mode does, every message the mod sends but from inside an event
  // the engine raised to it, which the test raises through raised() (seen.raising counts them)
  isAutoMode?: boolean
  raising: number
  // how many times the band above the prompt was drawn
  bandDraws: number
  // the panes the mod opened, by id
  opened: string[]
  // the panes the mod closed, by id
  closed: string[]
}

// What auto mode answers a SendMessage of the mod's that the mod's own allowance (its
// tool.check) never saw: one made after the hook that made it had returned, or from a
// timer, which the engine runs beneath the mod's own frame, every hook of the mod left out.
const NO_VERDICT =
  'The server-side auto mode classifier gave no verdict for SendMessage: the request that produced this action did not ask for one.'

// Raises an event to the mod as the engine does, in its own call: in auto mode, what the
// mod sends from inside it is allowed.
async function raised<T>(seen: Seen, call: () => Promise<T>): Promise<T> {
  seen.raising++
  try {
    return await call()
  } finally {
    seen.raising--
  }
}

// An agent whose run has ended, which a message resumes from its transcript.
const ENDED: ReadonlySet<AgentInfo['status']> = new Set(['completed', 'failed', 'killed'])
// The engine's refusal to resume an agent whose type is not offered.
const notOffered = (type: string) => `Agent type '${type}' is not offered in this session`

// The test stands in for the engine beneath the plugin, and records what reached it:
// each prompt with the notes beside it, the effort each model request asked for, each
// turn it was asked to cut, and how many agents it was asked to start. Its agents' runs
// end with their turns, and a message that reaches one starts it again; one whose run has
// ended is resumed only if its type is offered, as the engine does. `$` is the test's own,
// to ask that as the engine does. `store` seeds the mod store; `null` leaves the store to
// the test.
function engine(
  $: Engine,
  on: On,
  agents: AgentInfo[] = [{ id: 'agent-1', description: 'auth-bug', type: 'multitask:thought', status: 'running' }],
  store: Record<string, unknown> | null = {},
): Seen {
  const seen: Seen = { prompts: [], sends: [], ran: [], efforts: [], aborts: [], spawns: 0, names: [], registered: [], raising: 0, bandDraws: 0, opened: [], closed: [] }
  // the welcome line dismissed: welcome.test.ts covers it
  if (store !== null) mock.store(on, { welcome: ['multitask'], ...store })
  on('session.id', () => ({ value: 'session-1' }))
  on('session.start', ($, e) => ({ cwd: e.cwd }))
  on('session.end', ($, e) => ({ sessionId: e.sessionId }))
  on('agent.register', () => ({ value: { agent: 'multitask:thought' } }))
  on('tool.register', ($, e) => {
    seen.registered.push(e.name)
    return { value: { tool: `mcp__multitask__${e.name}` } }
  })
  on('command.register', ($, e) => ({ value: { command: e.name } }))
  on('ui.open', ($, e) => {
    seen.opened.push(e.id)
    return { value: { isPlaced: true } }
  })
  on('ui.close', ($, e) => {
    seen.closed.push(e.id)
    return { value: undefined }
  })
  on('ui.message', () => ({}))
  on('ui.render', ($, e) => {
    if (e.component === 'AbovePrompt') seen.bandDraws++
    return { type: 'engine', ref: 0 }
  })
  // Only the real engine can hand back a spawned agent's id; the agent list stands in.
  on('agent.spawn', ($, e) => {
    seen.spawns++
    seen.names.push(e.name)
    return { model: 'test' }
  })
  on('agent.list', () => ({ value: agents }))
  on('agent.offer', () => ({ isOffered: true }))
  on('session.send', async (_, e) => {
    seen.sends.push({ to: e.to, text: e.text })
    if (seen.isAutoMode === true && seen.raising === 0) return { isDelivered: false, reason: NO_VERDICT }
    if (seen.refuse !== undefined) return { isDelivered: false, reason: seen.refuse }
    const agent = agents.find(a => a.id === e.to || a.description === e.to)
    if (agent !== undefined && ENDED.has(agent.status)) {
      const offer = { agent: agent.type, description: '', source: 'plugin', provider: { plugin: 'multitask', tier: 'user' as const } }
      if (!(await $.agent.offer(offer)).isOffered) return { isDelivered: false, reason: notOffered(agent.type) }
    }
    if (agent !== undefined) agent.status = 'running'
    return { isDelivered: true }
  })
  on('prompt.submit', ($, e) => {
    seen.prompts.push([e.text, ...(e.context ?? [])].join('\n--\n'))
    return { text: e.text }
  })
  // Beneath this the kit stores every row; a hook may refuse only a plugin's own (door note).
  on('session.append', ($, e, next) => {
    if (seen.hidden === undefined) return e.door === 'note' ? { deny: 'no transcript to store the row in' } : next(e)
    if (e.message.type === 'user') seen.hidden.push(e.message.content.map(block => (block.type === 'text' ? block.text : '')).join(''))
    return next(e)
  })
  on('turn.start', ($, e) => ({ turnId: e.turnId }))
  on('turn.complete', ($, e) => {
    const agent = agents.find(a => a.id === e.agentId)
    if (agent !== undefined && seen.isWindingDown !== true) agent.status = 'completed'
    return { text: e.answer }
  })
  on('turn.abort', ($, e) => {
    if (seen.isAbortRefused === true) throw new Error(`turn ${e.turnId} is not running`)
    seen.aborts.push(e.turnId)
    return { value: undefined }
  })
  on('session.compact', () => ({ messages: [{ role: 'user' as const, text: 'the summary', toolUses: [] }] }))
  on('turn.step', async function* ($, e) {
    seen.efforts.push(e.effort)
    const reply = seen.reply ?? []
    for (const chunk of reply) yield chunk
    const answer = reply.flatMap(chunk => (chunk.kind === 'text' ? [chunk.text] : [])).join('')
    return { turnId: e.turnId, index: e.index, answer, toolUses: [], stopReason: 'end_turn' as const, usage: null }
  })
  on('tool.check', () => ({ decision: 'ask' as const }))
  on('tool.call', ($, e) => {
    seen.ran.push(String(e.tool))
    return { result: 'ran' }
  })
  return seen
}

// Multitask's dropdown in the band, and the mode its face shows: `multitask`, `focus`
// (Multitask off), or undefined where the band has none.
const DROPDOWN = 'multitask'
const modeOf = async (band: { find: (query: { key: string }) => Promise<{ props: Record<string, unknown> } | undefined> }) =>
  (await band.find({ key: DROPDOWN }))?.props.value

// What the band's `thoughts` button shows: its word, then a ● for each dot in it (a
// picture on the desktop; elsewhere a glyph, the Button's text as it is); undefined where
// the band has none.
const thoughtsShown = async (band: { drawn: () => Promise<unknown> }) => {
  const button = elementsOf(await band.drawn()).find(n => n.props?.key === 'open-thoughts')
  if (button === undefined) return undefined
  if (button.type === 'Button') return textIn(button)
  const word = textIn(elementsOf(button).find(n => n.type === 'Text'))
  return [word, '●'.repeat(dotKeys(button).length)].filter(part => part !== '').join(' ')
}

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

// Runs /multitask, with `args`, as the person types it; its output. With none given, it
// toggles: turns the mod on in the chat, in Multitask mode, or off.
const multitask = async ($: Engine, args = 'toggle') =>
  (await $.command.run({ command: 'multitask', args, origin: { kind: 'composer' }, presentation: {} as never })).text

// Switches the chat to the other mode, as `/multitask mode multitask` or `focus` does.
const switchMode = async ($: Engine) =>
  multitask($, (await multitask($, 'status'))?.includes('Multitask mode') === true ? 'mode focus' : 'mode multitask')

const finished = (agentId: string) => ({
  answer: '',
  durationMs: 10,
  isAborted: false,
  turnId: 'turn-1',
  agentId,
  reason: 'answer' as const,
})

// The end of one of the voice's own turns, on the main loop.
const voiceTurnEnd = (turnId: string) => ({ answer: '', durationMs: 10, isAborted: false, turnId, reason: 'answer' as const })

// The engine's notice that a thought's run finished.
const noticeOf = (agentId: string, result: string) =>
  `<task-notification>\n<task-id>${agentId}</task-id>\n<status>completed</status>\n<result>${result}</result>\n</task-notification>`

test('quiet is exact and updates are one line each under a short header', async () => {
  expect(isQuiet(' (quiet)\n')).toBe(true)
  expect(isQuiet('No response requested.')).toBe(true)
  expect(isQuiet('(quiet) but also this')).toBe(false)
  const text = formatUpdates([
    { thought: 'auth', text: 'Checking the token' },
    { thought: 'docs', text: 'Found it:\n\n- in a.ts\n- in b.ts', isDone: true },
    { thought: 'auth', text: '', isDone: true },
  ])
  expect(text).toBe('Thought updates:\nauth: Checking the token\ndocs (done): Found it: - in a.ts - in b.ts\nauth: done')
  expect(relayNames(text)).toEqual(['auth', 'docs'])
  // the person's own message to a thought, from the Thoughts pane
  const told = formatUpdates([{ thought: 'ui', text: 'use the\nsame colours', isFromPerson: true }])
  expect(told).toBe('Thought updates:\nui (from the user): use the same colours')
  expect(relayNames(told)).toEqual(['ui'])
})

test('a quiet reply draws as nothing on every surface while Multitask is on, and as the engine draws it while off', async ($, on) => {
  engine($, on)
  const drawn = async (surface: 'terminal' | 'desktop', text: string) => {
    const row = await $.ui.mount({
      plugin: 'multitask',
      surface,
      component: 'AssistantMessage',
      props: { text, isFirstOfReply: true },
    })
    const tree = (await row.drawn()) as { type: string; props?: { display?: string } }
    await row.unmount()
    return tree.props?.display === 'none' ? 'nothing' : tree.type
  }
  const each = async (expected: string) => {
    for (const surface of ['terminal', 'desktop'] as const) {
      for (const text of ['(quiet)', NO_RESPONSE]) expect({ surface, text, as: await drawn(surface, text) }).toEqual({ surface, text, as: expected })
    }
  }
  await each('engine')
  await multitask($)
  await each('nothing')
})

test('a session that never turns Multitask on is left as it is: no band, no tools, no notes, no folded notices', async ($, on) => {
  const seen = engine($, on)
  // what the mod offers the model
  const { registered } = seen
  await $.session.start({ cwd: '.', surface: 'desktop', isInteractive: true })
  expect(registered).toEqual([])
  await $.prompt.submit({ text: 'hello', origin: { kind: 'composer' }, wait: false })
  expect(seen.prompts).toEqual(['hello'])
  const band = await $.ui.mount({ plugin: 'multitask', surface: 'desktop', ...BAND })
  expect(await band.drawn()).toEqual({ type: 'engine', ref: 0 })

  // turned on, it is in Multitask mode: the voice has its tools and the band shows
  // `thoughts`; in Focus, a reload while it has thoughts offers them again, and `thoughts`
  // stays while they do
  const flip = () => switchMode($)
  await multitask($)
  expect(registered).toEqual(['think', 'tell', 'unqueue', 'stop', 'thoughts'])
  await band.redraw()
  expect(await modeOf(band)).toBe('multitask')
  await $.tool.call({ tool: 'mcp__multitask__think', tool_use_id: 'c1', name: 'auth bug', task: 'Find why login fails' })
  await flip()
  await band.redraw()
  expect(await modeOf(band)).toBe('focus')
  expect(await thoughtsShown(band)).toBe('thoughts ●')
  registered.length = 0
  await $.session.start({ cwd: '.', surface: 'desktop', isInteractive: true })
  expect(registered).toEqual(['think', 'tell', 'unqueue', 'stop', 'thoughts'])

  // off, the engine's notice that a thought finished is the engine's drawing alone
  const notice = async () => {
    const row = await $.ui.mount({
      plugin: 'multitask',
      surface: 'desktop',
      component: 'UserMessage',
      props: { text: 'agent-1 finished', origin: { kind: 'task-notification' }, isExpanded: false, task: { id: 'agent-1' } } as never,
    })
    const tree = (await row.drawn()) as { type: string; props?: { display?: string } }
    await row.unmount()
    return tree.props?.display === 'none' ? 'nothing' : tree.type
  }
  expect(await notice()).toBe('engine')
  await flip()
  expect(await notice()).toBe('nothing')
})

test('the voice\'s quiet reply goes on as "No response requested.", held back only while it could still be quiet', async ($, on) => {
  const seen = engine($, on)
  await $.session.start({ cwd: '.', surface: 'desktop', isInteractive: true })
  const step = async (pieces: TurnStepChunk[], agentId?: string) => {
    seen.reply = pieces
    const stream = $.turn.step({ turnId: 't', index: 0, model: 'opus', messageCount: 1, ...(agentId === undefined ? {} : { agentId }) })
    const out: TurnStepChunk[] = []
    for (let piece = await stream.next(); ; piece = await stream.next()) {
      if (piece.done === true) return { out, answer: piece.value.answer }
      out.push(piece.value)
    }
  }
  const text = (piece: string): TurnStepChunk => ({ kind: 'text', index: 0, text: piece })
  const thinking: TurnStepChunk = { kind: 'thinking', index: 0, text: 'Nothing new.' }
  const stop: TurnStepChunk = { kind: 'stop', stopReason: 'end_turn', usage: null }
  const quiet = [thinking, text('(qu'), text('iet)\n'), stop]

  // With Multitask off, it goes on as it came.
  expect(await step(quiet)).toEqual({ out: quiet, answer: '(quiet)\n' })

  await multitask($)
  // Split across pieces, it goes on as one, in its first piece's place.
  expect(await step(quiet)).toEqual({ out: [thinking, text(NO_RESPONSE), stop], answer: NO_RESPONSE })
  // A reply that goes on past it is passed on whole, as it came.
  const more = [thinking, text('(qu'), text('iet) but one thing:'), text(' the build broke.'), stop]
  expect(await step(more)).toEqual({ out: more, answer: '(quiet) but one thing: the build broke.' })
  // A thought's reply goes on as it came.
  expect(await step(quiet, 'agent-1')).toEqual({ out: quiet, answer: '(quiet)\n' })
})

test('updates handed to the voice draw as nothing on the desktop and one dim line in the terminal', async ($, on) => {
  engine($, on)
  const relay = formatUpdates([
    { thought: 'voice-tone', text: 'Checking the prompt' },
    { thought: 'voice-tone', text: 'found it', isDone: true },
  ])
  // As the engine stores it, and as the desktop shows it: framed, under no plugin origin.
  const framed = `The multitask plugin sent a message:\n${relay}\n\nThis is how Claude Code surfaces a prompt a plugin submits between turns.`
  const draw = async (surface: 'terminal' | 'desktop', text: string, origin: object, isExpanded = false) => {
    const row = await $.ui.mount({
      plugin: 'multitask',
      surface,
      component: 'UserMessage',
      props: { text, origin: origin as never, isExpanded },
    })
    const drawn = (await row.drawn()) as { type: string; props?: { display?: string } }
    const line = (await row.find({ type: 'Text' }))?.text
    await row.unmount()
    return { isHidden: drawn.props?.display === 'none', isEngine: drawn.type === 'engine', line }
  }

  for (const origin of [{ kind: 'unclassified' }, { kind: 'sdk' }, { kind: 'plugin', name: 'multitask' }]) {
    expect((await draw('desktop', framed, origin)).isHidden).toBe(true)
    expect((await draw('desktop', framed, origin, true)).isHidden).toBe(true)
  }
  expect((await draw('desktop', relay, { kind: 'plugin', name: 'multitask' })).isHidden).toBe(true)

  expect((await draw('terminal', relay, { kind: 'plugin', name: 'multitask' })).line).toBe('◦ thought update: voice-tone')
  expect((await draw('terminal', framed, { kind: 'unclassified' })).line).toBe('◦ thought update: voice-tone')
  // ctrl+o shows it whole
  expect((await draw('terminal', relay, { kind: 'plugin', name: 'multitask' }, true)).isEngine).toBe(true)

  // The person's own words stay theirs, even about thought updates.
  expect((await draw('desktop', 'Thought updates: why do I see these?', { kind: 'sdk' })).isEngine).toBe(true)
  expect((await draw('terminal', 'what are thought updates?', { kind: 'composer' })).isEngine).toBe(true)
})

test('a turn ending reaches the voice once: bare when it has nothing more to say, and a failure says so', async ($, on) => {
  const seen = engine($, on, [{ id: 'agent-1', description: 'auth-bug', type: 'multitask:thought', status: 'completed' }])
  const clock = mock.clock(on)
  await $.session.start({ cwd: '.', surface: 'desktop', isInteractive: true })
  await multitask($)
  await $.tool.call({ tool: 'mcp__multitask__think', tool_use_id: 'c1', name: 'auth bug', task: 'Find why login fails' })
  const band = await $.ui.mount({ plugin: 'multitask', surface: 'desktop', ...BAND })
  const label = async () => {
    await band.redraw()
    return thoughtsShown(band)
  }
  const says = (uuid: string, text: string) =>
    $.session.append({
      message: { type: 'assistant', role: 'assistant', content: [{ type: 'text', text }] },
      door: 'response',
      origin: { kind: 'model', model: 'test' },
      uuid,
      agentId: 'agent-1',
    })
  expect(await label()).toBe('thoughts ●')

  // A turn that ends with no text is a bare done; the band counts only running thoughts.
  await $.turn.complete({ ...finished('agent-1'), answer: '' })
  await clock.advance(2500)
  expect(seen.prompts).toEqual(['Thought updates:\nauth-bug: done'])
  const listed = String((await $.tool.call({ tool: 'mcp__multitask__thoughts', tool_use_id: 'c2' })).result)
  expect(listed).toContain('auth-bug [idle]')
  expect(await label()).toBe('thoughts')

  // A report that already reached the voice as a note is not sent again. With notes
  // not relayed (RELAY_NOTES off), it goes out once, on the done line.
  await $.tool.call({ tool: 'mcp__multitask__tell', tool_use_id: 'c3', thought: 'auth-bug', message: 'go on' })
  expect(await label()).toBe('thoughts ●')
  await says('u1', 'Nothing else is wrong.')
  await clock.advance(2500)
  await $.turn.complete({ ...finished('agent-1'), answer: 'Nothing else is wrong.' })
  await clock.advance(2500)
  expect(seen.prompts.slice(1)).toEqual(
    RELAY_NOTES
      ? ['Thought updates:\nauth-bug: Nothing else is wrong.', 'Thought updates:\nauth-bug: done']
      : ['Thought updates:\nauth-bug (done): Nothing else is wrong.'],
  )

  // Nor is one whose row lands after its turn ended.
  let sent = seen.prompts.length
  await $.tool.call({ tool: 'mcp__multitask__tell', tool_use_id: 'c4', thought: 'auth-bug', message: 'and logout?' })
  await $.turn.complete({ ...finished('agent-1'), answer: 'Logout is fine.' })
  await clock.settle()
  await says('u2', 'Logout is fine.')
  await clock.advance(2500)
  expect(seen.prompts.slice(sent)).toEqual(['Thought updates:\nauth-bug (done): Logout is fine.'])

  sent = seen.prompts.length
  await $.turn.complete({ ...finished('agent-1'), answer: '', reason: 'error' })
  await clock.advance(2500)
  expect(seen.prompts.slice(sent)).toEqual(['Thought updates:\nauth-bug (done): (ended on an error)'])
})

test('the voice is refused work, and its thoughts relay, queue and unqueue', async ($, on) => {
  const seen = engine($, on)
  const clock = mock.clock(on)
  await $.session.start({ cwd: '.', surface: 'desktop', isInteractive: true })

  // Off: thinking is refused.
  const off = await $.tool.call({ tool: 'mcp__multitask__think', tool_use_id: 'c0', name: 'a', task: 'x' })
  expect(off.deny).toBeDefined()

  // Turned on, then in Focus, with no thoughts the band has no `thoughts`, only the
  // dropdown: Multitask in it switches to Multitask mode.
  await multitask($)
  await multitask($, 'mode focus')
  const band = await $.ui.mount({ plugin: 'multitask', surface: 'desktop', ...BAND })
  expect(await band.find({ key: 'open-thoughts' })).toBeUndefined()
  expect(await modeOf(band)).toBe('focus')
  await band.select({ key: DROPDOWN, value: 'multitask' })
  await band.redraw()
  expect(await band.find({ key: 'open-thoughts' })).toBeDefined()
  expect(await modeOf(band)).toBe('multitask')

  // On: the voice's own work is refused, its tools are not.
  const bash = await $.tool.call({ tool: 'Bash', tool_use_id: 'c1', command: 'ls' })
  expect(bash.deny).toContain('voice')

  const started = await $.tool.call({
    tool: 'mcp__multitask__think',
    tool_use_id: 'c2',
    name: 'auth bug',
    task: 'Find why login fails',
  })
  expect(started.deny).toBeUndefined()
  await band.redraw()
  expect(await thoughtsShown(band)).toBe('thoughts ●')

  // What the thought writes as it works is kept as a progress note, and relayed while
  // RELAY_NOTES is on; what its tool calls carry never is.
  const says = (uuid: string, text: string, tool?: { name: string; input: object }) =>
    $.session.append({
      message: {
        type: 'assistant',
        role: 'assistant',
        content: [{ type: 'text', text }, ...(tool === undefined ? [] : [{ type: 'tool_use', id: `tu-${uuid}`, ...tool }])],
      },
      door: 'response',
      origin: { kind: 'model', model: 'test' },
      uuid,
      agentId: 'agent-1',
    })
  await says('u1', 'Checking how the token expiry is computed', { name: 'Grep', input: { pattern: 'expiresAt' } })
  await clock.advance(2500)
  const noted = RELAY_NOTES ? ['Thought updates:\nauth-bug: Checking how the token expiry is computed'] : []
  expect(seen.prompts).toEqual(noted)
  const listed = await $.tool.call({ tool: 'mcp__multitask__thoughts', tool_use_id: 'c2b' })
  expect(String(listed.result)).toContain('Checking how the token expiry is computed')

  // Queued messages wait for the turn to end; one withdrawn never arrives.
  await $.tool.call({ tool: 'mcp__multitask__tell', tool_use_id: 'c3', thought: 'auth-bug', message: 'keep', how: 'queue' })
  await $.tool.call({ tool: 'mcp__multitask__tell', tool_use_id: 'c4', thought: 'auth-bug', message: 'drop', how: 'queue' })
  await band.redraw()
  expect(await thoughtsShown(band)).toBe('thoughts ●')
  await $.tool.call({ tool: 'mcp__multitask__unqueue', tool_use_id: 'c5', thought: 'auth-bug', index: 2 })
  expect(seen.sends).toHaveLength(0)

  // Its next notes (while relayed) and the text its turn ends with reach the voice as one
  // prompt, once things go quiet, the report once, with the queue still pending; the turn
  // that prompt wakes the voice to hands the queue over.
  await says('u2', 'Reading the refresh path')
  await says('u3', 'Token expiry is off by one.')
  await $.turn.complete({ ...finished('agent-1'), answer: 'Token expiry is off by one.' })
  await clock.settle()
  expect(seen.sends).toHaveLength(0)
  expect(seen.prompts).toEqual(noted)
  await clock.advance(2500)
  expect(seen.prompts.slice(noted.length)).toEqual([
    `Thought updates:\n${RELAY_NOTES ? 'auth-bug: Reading the refresh path\n' : ''}auth-bug (done): Token expiry is off by one. — 1 message still pending; it will be handed over and you'll hear back`,
  ])
  await $.turn.start({ text: '', turnId: 'voice-1' })
  expect(seen.sends).toEqual([{ to: expect.any(String), text: 'keep' }])
  await $.turn.complete(voiceTurnEnd('voice-1'))
  expect(seen.prompts.join('\n')).not.toContain('expiresAt')
  const after = String((await $.tool.call({ tool: 'mcp__multitask__thoughts', tool_use_id: 'c5b' })).result)
  expect(after).toContain('· Checking how the token expiry is computed')
  expect(after).toContain('report: Token expiry is off by one.')
  expect(after).not.toContain('· Token expiry')

  // Posting reaches it at once.
  await $.tool.call({ tool: 'mcp__multitask__tell', tool_use_id: 'c6', thought: 'auth-bug', message: 'also check refresh' })
  expect(seen.sends.at(-1)?.text).toBe('also check refresh')

  // Focus in the dropdown turns Multitask off; `thoughts` stays while the thought lives.
  await band.select({ key: DROPDOWN, value: 'focus' })
  await band.redraw()
  expect(await modeOf(band)).toBe('focus')
  expect(await band.find({ key: 'open-thoughts' })).toBeDefined()
})

test('the voice is told as Multitask comes on and goes off, and thinks less hard while on', async ($, on) => {
  const seen = engine($, on)
  await $.session.start({ cwd: '.', surface: 'desktop', isInteractive: true })
  const say = (text: string) => $.prompt.submit({ text, origin: { kind: 'composer' }, wait: false })
  const flip = () => switchMode($)
  const step = async (agentId?: string) => {
    const stream = $.turn.step({ turnId: 't', index: 0, model: 'opus', effort: 'xhigh', messageCount: 1, ...(agentId === undefined ? {} : { agentId }) })
    for await (const _ of stream) void _
    return seen.efforts.at(-1)
  }

  await say('hello')
  expect(seen.prompts.at(-1)).toBe('hello')
  expect(await step()).toBe('xhigh')

  // turned on, it is in Multitask mode: the voice is told its part
  await multitask($)
  await say('do a thing')
  expect(seen.prompts.at(-1)).toContain('# Multitasking mind')
  await say('and another')
  expect(seen.prompts.at(-1)).toBe(`and another\n--\n${VOICE_REMINDER}`)
  // the voice asks for less effort; a thought keeps the session's
  expect(await step()).toBe('low')
  expect(await step('agent-1')).toBe('xhigh')

  // A compaction may have summarised its part away: it is told whole again, once.
  await $.session.compact({ trigger: 'manual', messages: [{ role: 'user', text: 'do a thing', toolUses: [] }] })
  await say('where were we')
  expect(seen.prompts.at(-1)).toContain('# Multitasking mind')
  await say('go on')
  expect(seen.prompts.at(-1)).toBe(`go on\n--\n${VOICE_REMINDER}`)

  // in Focus, it is told once that it is not the voice, and thinks as hard as the session
  await flip()
  await say('back to normal')
  expect(seen.prompts.at(-1)).toContain('Multitask is now off')
  expect(await step()).toBe('xhigh')
  await say('plain')
  expect(seen.prompts.at(-1)).toBe('plain')

  // so it is once Multitask is turned off from Multitask mode
  await flip()
  await say('again')
  expect(seen.prompts.at(-1)).toContain('# Multitasking mind')
  await multitask($)
  await say('off now')
  expect(seen.prompts.at(-1)).toContain('Multitask is now off')
  await say('still plain')
  expect(seen.prompts.at(-1)).toBe('still plain')
})

// A conversation's messages as the engine lists them, and the switch a session kept.
const SAID = ['why does the band wrap onto two rows?', 'Both mods share one row, so it wraps.', 'can it stay on one row instead?']
const listed = (texts: string[]) => texts.map(text => ({ role: 'user' as const, text, toolUses: [] }))
// The switch as a version of the mod from before /multitask turned it on in a chat kept
// it, Multitask mode then its only switch; and as it is kept now, with the person's choice.
const kept = (isOn: boolean, at: number, texts: string[]) => ({ isOn, at, marks: marksOf(listed(texts)) })
const keptChoice = (isOn: boolean, choice: boolean | null, at: number, texts: string[]) => ({
  isOn,
  choice,
  at,
  marks: marksOf(listed(texts)),
})

test('a session keeps its switch for its next run, with its messages\' marks once it has been switched', async ($, on) => {
  const store: Record<string, unknown> = {}
  on('store.get', ($, e) => ({ value: store[e.key] }))
  on('store.set', ($, e) => {
    store[e.key] = e.value
    return { value: undefined }
  })
  on('store.keys', () => ({ value: Object.keys(store) }))
  mock.clock(on, { now: 1000 })
  engine($, on, undefined, null)
  on('session.messages', () => ({ value: listed(SAID) }))
  const flip = () => switchMode($)

  await $.session.start({ cwd: '.', surface: 'desktop', isInteractive: true })
  expect(store['session:session-1']).toEqual({ isOn: false, choice: null, at: 1000, marks: [] })
  await multitask($)
  expect(store['session:session-1']).toEqual(keptChoice(true, true, 1000, SAID))
  await flip()
  expect(store['session:session-1']).toEqual(keptChoice(false, true, 1000, SAID))
  await flip()
  expect(store['session:session-1']).toEqual(keptChoice(true, true, 1000, SAID))
  await multitask($)
  expect(store['session:session-1']).toEqual(keptChoice(false, false, 1000, SAID))
})

// Whether, once started, the session's switch is on: the voice is told its part.
const isOnAtStart = async ($: Engine, seen: Seen) => {
  await $.session.start({ cwd: '.', surface: 'desktop', isInteractive: true })
  await $.prompt.submit({ text: 'hello', origin: { kind: 'composer' }, wait: false })
  return seen.prompts.at(-1)?.includes('# Multitasking mind') === true
}

test('a restarted session takes up the switch it kept, with the voice\'s tools and the band', async ($, on) => {
  const seen = engine($, on, undefined, { 'session:session-1': kept(true, 1, []) })
  expect(await isOnAtStart($, seen)).toBe(true)
  expect(seen.registered).toEqual(['think', 'tell', 'unqueue', 'stop', 'thoughts'])
  const band = await $.ui.mount({ plugin: 'multitask', surface: 'desktop', ...BAND })
  expect(await modeOf(band)).toBe('multitask')
})

test('a rewound or forked session, under a new id, takes up the switch of the session it came from', async ($, on) => {
  const seen = engine($, on, undefined, {
    'session:old': kept(true, 1, [...SAID, 'and a later message the rewind left behind']),
    'session:unrelated': kept(false, 2, ['a different conversation altogether', 'with nothing in common at all']),
  })
  on('session.messages', () => ({ value: listed(SAID) }))
  expect(await isOnAtStart($, seen)).toBe(true)
})

test('of sessions that know as much of a rewound one, it takes up the switch of the one kept last', async ($, on) => {
  // rewound from "old" into "later", switched off there, and rewound again
  const seen = engine($, on, undefined, { 'session:old': kept(true, 1, SAID), 'session:later': kept(false, 2, SAID) })
  on('session.messages', () => ({ value: listed(SAID) }))
  expect(await isOnAtStart($, seen)).toBe(false)
})

// The mode the band's dropdown shows once the session has started, or undefined where it
// has none (Multitask off), and whether the voice is told its part.
const switchAtStart = async ($: Engine, seen: Seen) => {
  const isOn = await isOnAtStart($, seen)
  const band = await $.ui.mount({ plugin: 'multitask', surface: 'desktop', ...BAND })
  const mode = await modeOf(band)
  await band.unmount()
  return { mode, isOn }
}

// What a session takes up as it starts, from what the store kept: the mode the band's
// dropdown shows (none: Multitask off) and whether the voice is told its part.
const TAKEN_UP: { name: string; store: Record<string, unknown>; mode: string | undefined; isOn: boolean }[] = [
  { name: 'a new chat', store: {}, mode: undefined, isOn: false },
  { name: 'a new chat, the default on', store: { isEnabledByDefault: true }, mode: 'multitask', isOn: true },
  { name: 'turned on, in Focus', store: { 'session:session-1': keptChoice(false, true, 1, []) }, mode: 'focus', isOn: false },
  { name: 'in Multitask mode', store: { 'session:session-1': keptChoice(true, true, 1, []) }, mode: 'multitask', isOn: true },
  {
    name: 'in Multitask mode by the default, the default on',
    store: { isEnabledByDefault: true, 'session:session-1': keptChoice(true, null, 1, []) },
    mode: 'multitask',
    isOn: true,
  },
  {
    name: 'in Multitask mode by the default, the default since off',
    store: { 'session:session-1': keptChoice(true, null, 1, []) },
    mode: undefined,
    isOn: false,
  },
  {
    name: 'forked from one in Multitask mode by the default, the default on',
    store: { isEnabledByDefault: true, 'session:old': keptChoice(true, null, 1, SAID) },
    mode: 'multitask',
    isOn: true,
  },
  {
    name: 'turned off, the default on',
    store: { isEnabledByDefault: true, 'session:session-1': keptChoice(false, false, 1, []) },
    mode: undefined,
    isOn: false,
  },
  {
    // in Focus, or off when the default was: an open chat the default turns on stays in Focus
    name: 'never switched, not in Multitask mode, the default on',
    store: { isEnabledByDefault: true, 'session:session-1': keptChoice(false, null, 1, []) },
    mode: 'focus',
    isOn: false,
  },
  {
    name: 'kept before choices were, off, the default on',
    store: { isEnabledByDefault: true, 'session:session-1': kept(false, 1, []) },
    mode: 'focus',
    isOn: false,
  },
  { name: 'kept before choices were, off', store: { 'session:session-1': kept(false, 1, []) }, mode: undefined, isOn: false },
  { name: 'forked from one turned on, in Focus', store: { 'session:old': keptChoice(false, true, 1, SAID) }, mode: 'focus', isOn: false },
  {
    name: 'forked from one turned off, the default on',
    store: { isEnabledByDefault: true, 'session:old': keptChoice(false, false, 1, SAID) },
    mode: undefined,
    isOn: false,
  },
]

for (const one of TAKEN_UP) {
  test(`a session takes up the switch it, or the one it came from, kept: ${one.name}`, async ($, on) => {
    const seen = engine($, on, undefined, one.store)
    on('session.messages', () => ({ value: listed(SAID) }))
    expect(await switchAtStart($, seen)).toEqual({ mode: one.mode, isOn: one.isOn })
    expect(seen.registered).toEqual(one.isOn ? ['think', 'tell', 'unqueue', 'stop', 'thoughts'] : [])
  })
}

test('`/multitask default on|off` sets whether new chats start with Multitask on, off at first; a chat that chose keeps its choice', async ($, on) => {
  const store = liveStore(on)
  const seen = engine($, on, undefined, null)
  await $.session.start({ cwd: '.', surface: 'desktop', isInteractive: true })
  const band = await $.ui.mount({ plugin: 'multitask', surface: 'desktop', ...BAND })
  const mode = async () => {
    await band.redraw()
    return modeOf(band)
  }
  expect(await mode()).toBeUndefined()

  // this chat, never switched, follows the default: open, it stays in Focus, the dropdown
  // alone, no `thoughts`, no tools, no notes
  expect(await multitask($, 'default on')).toBe(
    'Multitask is now on by default, in new chats and in chats where you have not used `/multitask`.',
  )
  expect(store.isEnabledByDefault).toBe(true)
  expect(await mode()).toBe('focus')
  expect(await band.find({ key: 'open-thoughts' })).toBeUndefined()
  expect(seen.registered).toEqual([])
  await $.prompt.submit({ text: 'hello', origin: { kind: 'composer' }, wait: false })
  expect(seen.prompts.at(-1)).toBe('hello')
  expect(await multitask($, 'default off')).toBe(
    'Multitask is now off by default, in new chats and in chats where you have not used `/multitask`.',
  )
  expect(store.isEnabledByDefault).toBe(false)
  expect(await mode()).toBeUndefined()

  // one switched keeps its choice, and says so
  await multitask($)
  expect(await multitask($, 'default enable')).toBe(
    'Multitask is now on by default, in new chats and in chats where you have not used `/multitask`.',
  )
  expect(await multitask($, 'default disable')).toBe(
    'Multitask is now off by default, in new chats and in chats where you have not used `/multitask`. This chat keeps it on; `/multitask off` turns it off here.',
  )
  expect(await mode()).toBe('multitask')
  await multitask($)
  expect(await multitask($, 'default on')).toBe(
    'Multitask is now on by default, in new chats and in chats where you have not used `/multitask`. This chat keeps it off; `/multitask on` turns it on here.',
  )
  expect(await mode()).toBeUndefined()
})

test('a new chat starts in Multitask mode while the default is on, and leaves it as the default goes off', async ($, on) => {
  const store = liveStore(on, { isEnabledByDefault: true })
  const seen = engine($, on, undefined, null)
  mock.clock(on)
  on('session.messages', () => ({ value: [] }))
  await $.session.start({ cwd: '.', surface: 'desktop', isInteractive: true })
  const band = await $.ui.mount({ plugin: 'multitask', surface: 'desktop', ...BAND })
  expect(await modeOf(band)).toBe('multitask')
  expect(seen.registered).toEqual(['think', 'tell', 'unqueue', 'stop', 'thoughts'])
  await $.prompt.submit({ text: 'hello', origin: { kind: 'composer' }, wait: false })
  expect(seen.prompts.at(-1)).toContain('# Multitasking mind')
  // it follows the default, not a choice of its own
  expect(store['session:session-1']).toMatchObject({ isOn: true, choice: null })

  expect(await multitask($, 'default off')).toBe(
    'Multitask is now off by default, in new chats and in chats where you have not used `/multitask`.',
  )
  await band.redraw()
  expect(await modeOf(band)).toBeUndefined()
  expect(store['session:session-1']).toMatchObject({ isOn: false, choice: null })
  await $.prompt.submit({ text: 'back to normal', origin: { kind: 'composer' }, wait: false })
  expect(seen.prompts.at(-1)).toContain('Multitask is now off')
  expect((await $.tool.call({ tool: 'mcp__multitask__think', tool_use_id: 'c1', name: 'a', task: 'x' })).deny).toBeDefined()
})

test('turning Multitask off in a chat shows nothing of it, though a thought runs on unseen', async ($, on) => {
  const seen = engine($, on)
  mock.clock(on)
  await $.session.start({ cwd: '.', surface: 'desktop', isInteractive: true })
  const band = await $.ui.mount({ plugin: 'multitask', surface: 'desktop', ...BAND })
  const thoughtsCommand = async () =>
    (await $.command.run({ command: 'thoughts', args: '', origin: { kind: 'composer' }, presentation: {} as never })).text
  await multitask($)
  await $.tool.call({ tool: 'mcp__multitask__think', tool_use_id: 'c1', name: 'auth bug', task: 'Find why login fails' })
  await $.prompt.submit({ text: 'hello', origin: { kind: 'composer' }, wait: false })
  expect(await thoughtsCommand()).toBe('Thoughts pane opened.')
  expect(seen.opened).toEqual(['multitask-thoughts'])

  // off, the band is the other mods' alone and the Thoughts pane closes, with a thought running
  expect(await multitask($)).toBe('Multitask is off in this chat; `/multitask on` turns it on.')
  expect(seen.closed).toEqual(['multitask-thoughts'])
  await band.redraw()
  expect(await band.drawn()).toEqual({ type: 'engine', ref: 0 })
  expect(await thoughtsCommand()).toBe('Multitask is off in this chat; `/multitask on` turns it on.')
  expect(seen.opened).toEqual(['multitask-thoughts'])
  await $.prompt.submit({ text: 'back to normal', origin: { kind: 'composer' }, wait: false })
  expect(seen.prompts.at(-1)).toContain('Multitask is now off')
  expect((await $.tool.call({ tool: 'mcp__multitask__think', tool_use_id: 'c2', name: 'b', task: 'x' })).deny).toBeDefined()

  // off, the mode is not switched: the command says how to turn it on
  expect(await multitask($, 'mode')).toBe(
    'Multitask is off in this chat; `/multitask on` turns it on. It comes on in Multitask mode; `/multitask mode` then switches to Focus.',
  )
  await band.redraw()
  expect(await modeOf(band)).toBeUndefined()
  await $.prompt.submit({ text: 'still plain', origin: { kind: 'composer' }, wait: false })
  expect(seen.prompts.at(-1)).toBe('still plain')

  // its turn ends unseen: the engine's notice of it enters nothing, and the band stays the
  // other mods'; a reload offers no tools
  await $.turn.complete({ ...finished('agent-1'), answer: 'Found it.' })
  const prompts = seen.prompts.length
  await $.prompt.submit({ text: noticeOf('agent-1', 'Found it.'), origin: { kind: 'task-notification' }, wait: false })
  expect(seen.prompts).toHaveLength(prompts)
  await band.redraw()
  expect(await band.drawn()).toEqual({ type: 'engine', ref: 0 })
  await $.tool.call({ tool: 'mcp__multitask__stop', tool_use_id: 'c3', name: 'auth-bug' })
  await band.redraw()
  expect(await band.drawn()).toEqual({ type: 'engine', ref: 0 })
  seen.registered.length = 0
  await $.session.start({ cwd: '.', surface: 'desktop', isInteractive: true })
  expect(seen.registered).toEqual([])

  // on again, in Multitask mode; anything else is not a switch
  expect(await multitask($, 'sideways')).toBe(
    'Usage: `/multitask [on|off|toggle|status|mode [multitask|focus]|default [on|off]]`; with no argument it asks.',
  )
  await band.redraw()
  expect(await modeOf(band)).toBeUndefined()
  expect(await multitask($)).toContain('Multitask is on in this chat, in Multitask mode')
  await band.redraw()
  expect(await modeOf(band)).toBe('multitask')
})

// The store as the test reads it, from `entries`: what the mod kept, by key.
function liveStore(on: On, entries: Record<string, unknown> = {}): Record<string, unknown> {
  const store = { ...entries }
  on('store.get', ($, e) => ({ value: store[e.key] }))
  on('store.set', ($, e) => {
    store[e.key] = e.value
    return { value: undefined }
  })
  on('store.delete', ($, e) => {
    delete store[e.key]
    return { value: undefined }
  })
  on('store.keys', () => ({ value: Object.keys(store) }))
  return store
}

// A thought as the store keeps it, its agent's id its name; one that ended has a report.
const keptThought = (id: string, status: ThoughtStatus, endedAt?: number, color = '#4fa3e0'): Thought => ({
  id,
  name: id,
  task: `the brief for ${id}`,
  color,
  status,
  queued: [],
  lastText: status === 'running' ? '' : `The report of ${id}.`,
  notes: [],
  turnId: status === 'running' ? `turn-${id}` : null,
  interruptWith: null,
  ...(endedAt !== undefined && { endedAt }),
})

// The Thoughts pane, mounted as the person opens it.
const PANE = {
  plugin: 'multitask',
  surface: 'terminal',
  component: 'Pane',
  requestId: 'multitask-thoughts',
  props: { title: 'Thoughts', isFocused: false, bodyColumns: 80, placement: 'dock', scroll: { offset: 0, bodyRows: 200 }, view: {} },
} as const

const END = { reason: 'prompt_input_exit', sessionId: 'session-1', resume: { id: 'session-1' } } as const

test('a session keeps its thoughts for its next run a moment after they change, and its notes as it ends', async ($, on) => {
  const store = liveStore(on)
  const clock = mock.clock(on, { now: 1000 })
  engine($, on, undefined, null)
  await $.session.start({ cwd: '.', surface: 'terminal', isInteractive: true })
  await multitask($)
  await $.tool.call({ tool: 'mcp__multitask__think', tool_use_id: 'c1', name: 'auth bug', task: 'Find why login fails' })
  const says = (uuid: string, text: string) =>
    $.session.append({
      message: { type: 'assistant', role: 'assistant', content: [{ type: 'text', text }] },
      door: 'response',
      origin: { kind: 'model', model: 'test' },
      uuid,
      agentId: 'agent-1',
    })
  const kept = () => store['thoughts:session-1'] as KeptThoughts | undefined

  // Kept a moment after it started, not at once.
  expect(kept()).toBeUndefined()
  await clock.advance(2000)
  expect(kept()).toMatchObject({
    at: 3000,
    thoughts: [{ id: 'agent-1', name: 'auth-bug', task: 'Find why login fails', status: 'running', notes: [] }],
  })

  // A note alone is not kept straight away; it goes with the next change.
  await says('u1', 'Checking the token')
  await clock.advance(2000)
  expect(kept()?.thoughts[0]?.notes).toEqual([])
  await $.turn.complete({ ...finished('agent-1'), answer: 'The token expires early.' })
  await clock.advance(2000)
  expect(kept()?.thoughts[0]).toMatchObject({ status: 'idle', lastText: 'The token expires early.', notes: ['Checking the token'] })

  // Or as the session ends.
  await says('u2', 'One more thing about the token')
  await clock.advance(2000)
  expect(kept()?.thoughts[0]?.notes).toEqual(['Checking the token'])
  await $.session.end(END)
  expect(kept()?.thoughts[0]?.notes).toEqual(['Checking the token', 'One more thing about the token'])
})

test("the store keeps a session's running thoughts and its most recently ended, 200 in all, each task cut short", async ($, on) => {
  const ended = Array.from({ length: 205 }, (_, i) => keptThought(`t${i}`, 'idle', 1000 + i))
  const long = { ...keptThought('long', 'running'), task: 'x'.repeat(5000) }
  const store = liveStore(on, { 'session:session-1': kept(true, 1, []), 'thoughts:session-1': { at: 9000, thoughts: [long, ...ended] } })
  engine($, on, [{ id: 'long', description: 'long', type: 'multitask:thought', status: 'running' }], null)
  await $.session.start({ cwd: '.', surface: 'terminal', isInteractive: true })
  await $.session.end(END)
  const kept_ = store['thoughts:session-1'] as KeptThoughts
  expect(kept_.thoughts.map(t => t.id)).toEqual(['long', ...ended.slice(6).map(t => t.id)])
  expect(kept_.thoughts[0]?.task).toHaveLength(4000)
})

test('a restarted session takes up the thoughts it kept: one whose agent is gone reads done, what waited for it falls due', async ($, on) => {
  const cut = { ...keptThought('cut', 'running', undefined, '#d9636a'), queued: ['and logout'], notes: ['Checking the token'] }
  const seen = engine($, on, [{ id: 'busy', description: 'busy', type: 'multitask:thought', status: 'running' }], {
    'session:session-1': kept(true, 1, []),
    'thoughts:session-1': {
      at: 300_000,
      thoughts: [keptThought('busy', 'running'), cut, keptThought('done', 'idle', 240_000, '#58b36b'), keptThought('gone', 'stopped', 180_000)],
    },
  })
  mock.clock(on, { now: 600_000 })
  await $.session.start({ cwd: '.', surface: 'terminal', isInteractive: true })
  const pane = await $.ui.mount(PANE)

  // Its agent running still, `busy` runs on; `cut`, whose agent went with the last run, is
  // done, as of when the store last kept it.
  expect((await pane.find({ type: 'Text', text: /^Multitask mode/ }))?.text).toBe('Multitask mode · 1 running · 2 done · 1 stopped')
  expect((await pane.findAll({ type: 'Button' })).map(b => b.key)).toEqual([
    'expand:busy',
    'tell:busy',
    'stop:busy',
    'expand:cut',
    'stop:cut',
    'expand:done',
    'stop:done',
    'expand:gone',
  ])
  expect((await pane.findAll({ type: 'Text', text: /^done / })).map(t => t.text)).toEqual(['done 5m ago', 'done 6m ago'])
  // A done thought's glyph is a solid dot in its colour.
  expect((await pane.findAll({ type: 'Text', text: '●' })).map(dot => dot.props.color)).toEqual(['#d9636a', '#58b36b'])

  // The voice has heard of them all as they are: it is told nothing new of them.
  await $.prompt.submit({ text: 'hello', origin: { kind: 'composer' }, wait: false })
  expect(seen.prompts.at(-1)?.split('\n--\n').some(note => note.startsWith("What's new"))).toBe(false)
  // What waited for `cut`'s turn to end goes to it at the next chance, resuming it.
  await $.turn.start({ text: '', turnId: 'voice-1' })
  expect(seen.sends.map(s => s.text)).toEqual(['and logout'])
})

test('a rewound or forked session, under a new id, takes up the thoughts of the session it came from and keeps them as its own', async ($, on) => {
  const store = liveStore(on, {
    'session:old': kept(true, 1, [...SAID, 'and a later message the rewind left behind']),
    'thoughts:old': { at: 5000, thoughts: [keptThought('done', 'idle', 4000)] },
    'session:unrelated': kept(false, 2, ['a different conversation altogether', 'with nothing in common at all']),
    'thoughts:unrelated': { at: 6000, thoughts: [keptThought('other', 'idle', 5000)] },
  })
  engine($, on, [], null)
  on('session.messages', () => ({ value: listed(SAID) }))
  await $.session.start({ cwd: '.', surface: 'terminal', isInteractive: true })
  const pane = await $.ui.mount(PANE)
  expect((await pane.findAll({ type: 'Button' })).map(b => b.key)).toEqual(['expand:done', 'stop:done'])
  expect((store['thoughts:session-1'] as KeptThoughts | undefined)?.thoughts.map(t => t.id)).toEqual(['done'])
})

test('the Thoughts pane lists the 16 most recently ended thoughts, the rest behind `N more`, and running ones always', async ($, on) => {
  // Twenty done, the latest last, and one that failed before them all.
  const done = Array.from({ length: 20 }, (_, i) => keptThought(`d${i + 1}`, 'idle', 1000 * (i + 1)))
  engine($, on, [{ id: 'busy', description: 'busy', type: 'multitask:thought', status: 'running' }], {
    'session:session-1': kept(true, 1, []),
    'thoughts:session-1': { at: 30_000, thoughts: [keptThought('broke', 'failed', 500), ...done, keptThought('busy', 'running')] },
  })
  await $.session.start({ cwd: '.', surface: 'terminal', isInteractive: true })
  const pane = await $.ui.mount(PANE)
  const shown = async () => {
    await pane.redraw()
    return (await pane.findAll({ type: 'Button' })).flatMap(b => (b.key?.startsWith('expand:') === true ? [b.key.slice('expand:'.length)] : []))
  }
  const toggle = async () => {
    const last = (await pane.findAll({ type: 'Button' })).at(-1)
    return { key: last?.key, label: last?.text }
  }
  const latest = done.slice(4).reverse().map(t => t.id)

  // The failed one ended before the sixteen most recent: it waits behind `5 more` with the oldest.
  expect(await shown()).toEqual(['busy', ...latest])
  expect(await toggle()).toEqual({ key: 'more-ended', label: '5 more' })
  await $.ui.press({ plugin: 'multitask', key: 'more-ended' })
  expect(await shown()).toEqual(['busy', 'broke', ...done.slice().reverse().map(t => t.id)])
  expect(await toggle()).toEqual({ key: 'more-ended', label: 'less' })
  await $.ui.press({ plugin: 'multitask', key: 'more-ended' })
  expect(await shown()).toEqual(['busy', ...latest])
})

test("what is new from the thoughts goes beside the person's messages and after a relay, each thing once", async ($, on) => {
  const seen = engine($, on, [
    { id: 'agent-1', description: 'auth-bug', type: 'multitask:thought', status: 'running' },
    { id: 'agent-2', description: 'docs', type: 'multitask:thought', status: 'running' },
  ])
  const clock = mock.clock(on)
  await $.session.start({ cwd: '.', surface: 'desktop', isInteractive: true })
  const say = async (text: string) => {
    await $.prompt.submit({ text, origin: { kind: 'composer' }, wait: false })
    return seen.prompts.at(-1)
  }
  const says = (agentId: string, uuid: string, text: string) =>
    $.session.append({
      message: { type: 'assistant', role: 'assistant', content: [{ type: 'text', text }] },
      door: 'response',
      origin: { kind: 'model', model: 'test' },
      uuid,
      agentId,
    })
  await multitask($)
  await say('look into login and the docs')
  await $.tool.call({ tool: 'mcp__multitask__think', tool_use_id: 'c1', name: 'auth bug', task: 'Find why login fails' })
  await $.tool.call({ tool: 'mcp__multitask__think', tool_use_id: 'c2', name: 'docs', task: 'Check the docs' })

  // A running thought's latest notes; then nothing, until there is more.
  await says('agent-1', 'u1', 'Checking the token')
  expect(await say('how is it going?')).toBe(
    `how is it going?\n--\n${VOICE_REMINDER}\n--\nWhat's new from your thoughts:\nauth-bug: Checking the token`,
  )
  expect(await say('and now?')).toBe(`and now?\n--\n${VOICE_REMINDER}`)

  // A relay tells of its own thoughts, then what is new from the others.
  await says('agent-1', 'u2', 'Reading the refresh path')
  await $.turn.complete({ ...finished('agent-2'), answer: 'The docs are current.' })
  await clock.advance(2500)
  expect(seen.prompts.at(-1)).toBe(
    "Thought updates:\ndocs (done): The docs are current.\n\nWhat's new from your thoughts:\nauth-bug: Reading the refresh path",
  )
  expect(await say('thanks')).toBe(`thanks\n--\n${VOICE_REMINDER}`)

  // A thought that ended unheard of is told once.
  await $.tool.call({ tool: 'mcp__multitask__stop', tool_use_id: 'c3', thought: 'auth-bug' })
  expect(await say('anything else?')).toBe(
    `anything else?\n--\n${VOICE_REMINDER}\n--\nWhat's new from your thoughts:\nauth-bug was stopped`,
  )
  expect(await say('ok')).toBe(`ok\n--\n${VOICE_REMINDER}`)
})

test('updates go in as a hidden row, and the voice is woken by a wake-up that draws as nothing', async ($, on) => {
  const seen = engine($, on, [{ id: 'agent-1', description: 'auth-bug', type: 'multitask:thought', status: 'completed' }])
  seen.hidden = []
  const clock = mock.clock(on)
  await $.session.start({ cwd: '.', surface: 'desktop', isInteractive: true })
  await multitask($)
  await $.tool.call({ tool: 'mcp__multitask__think', tool_use_id: 'c1', name: 'auth bug', task: 'Find why login fails' })

  // Idle: the relay is a hidden row, then the wake-up.
  await $.turn.complete({ ...finished('agent-1'), answer: 'Token expiry is off by one.' })
  await clock.advance(2500)
  expect(seen.hidden).toEqual(['Thought updates:\nauth-bug (done): Token expiry is off by one.'])
  expect(seen.prompts).toEqual([WAKE])

  // The engine's notice of a turn's end becomes the wake-up after the hidden relay.
  const notice = `<task-notification>\n<task-id>agent-1</task-id>\n<status>completed</status>\n<result>Done.</result>\n</task-notification>`
  await $.tool.call({ tool: 'mcp__multitask__tell', tool_use_id: 'c2', thought: 'auth-bug', message: 'and logout?' })
  await $.turn.complete({ ...finished('agent-1'), answer: 'Logout is fine.' })
  await $.prompt.submit({ text: notice, origin: { kind: 'task-notification' }, wait: false })
  expect(seen.hidden.at(-1)).toBe('Thought updates:\nauth-bug (done): Logout is fine.')
  expect(seen.prompts.at(-1)).toBe(WAKE)

  // The wake-up draws as nothing, on the desktop and in the terminal.
  for (const surface of ['desktop', 'terminal'] as const) {
    const row = await $.ui.mount({
      plugin: 'multitask',
      surface,
      component: 'UserMessage',
      props: { text: WAKE, origin: { kind: 'plugin', name: 'multitask', asUser: true } as never, isExpanded: false },
    })
    const drawn = (await row.drawn()) as { type: string; props?: { display?: string } }
    await row.unmount()
    expect(drawn.props?.display).toBe('none')
  }
})

test("the engine's hand-back of a thought's report goes in as the wake-up while Multitask is on, and as it came otherwise", async ($, on) => {
  const seen = engine($, on)
  seen.hidden = []
  mock.clock(on)
  await $.session.start({ cwd: '.', surface: 'desktop', isInteractive: true })
  await multitask($)
  const flip = () => switchMode($)
  const handBack = (from: string, report: string) =>
    `Another Claude session sent a message:\n<agent-message from="${from}">\n[Subagent hand-back] ${report}\n</agent-message>`
  const deliver = (text: string) => $.prompt.submit({ text, origin: { kind: 'peer' }, wait: false })
  await $.tool.call({ tool: 'mcp__multitask__think', tool_use_id: 'c1', name: 'auth bug', task: 'Find why login fails' })

  // Right after the turn ends: the relay as a hidden row, the hand-back as the wake-up.
  await $.turn.complete({ ...finished('agent-1'), answer: 'Token expiry is off by one.' })
  await deliver(handBack('auth-bug', 'Token expiry is off by one.'))
  expect(seen.hidden).toEqual(['Thought updates:\nauth-bug (done): Token expiry is off by one.'])
  expect(seen.prompts).toEqual([WAKE])

  // With nothing waiting, a bare wake-up: nothing shows, nothing is dropped.
  await deliver(handBack('auth-bug', 'Token expiry is off by one.'))
  expect(seen.prompts.at(-1)).toBe(WAKE)

  // Another session's hand-back is not a thought's.
  await deliver(handBack('someone-else', 'Hello.'))
  expect(seen.prompts.at(-1)).toBe(handBack('someone-else', 'Hello.'))

  // As stored, a thought's hand-back is the wake-up, whatever text the engine kept for it.
  const store = async (text: string) => {
    await $.session.append({
      message: { type: 'user', role: 'user', content: [{ type: 'text', text }] },
      door: 'delivery',
      origin: { kind: 'peer' },
      uuid: `delivered-${seen.hidden?.length}`,
    })
    return seen.hidden?.at(-1)
  }
  expect(await store(handBack('auth-bug', 'Done.'))).toBe(WAKE)
  expect(await store(handBack('someone-else', 'Hello.'))).toBe(handBack('someone-else', 'Hello.'))

  // The row is hidden on the desktop only while on and only for a thought's. The desktop
  // shows the message's body alone, its sender beside it.
  const hidden = async (from: string) => {
    const row = await $.ui.mount({
      plugin: 'multitask',
      surface: 'desktop',
      component: 'UserMessage',
      props: { text: '[Subagent hand-back] Done.', origin: { kind: 'peer' } as never, isExpanded: false, from: { name: from } },
    })
    const drawn = (await row.drawn()) as { props?: { display?: string } }
    await row.unmount()
    return drawn.props?.display === 'none'
  }
  expect(await hidden('auth-bug')).toBe(true)
  expect(await hidden('someone-else')).toBe(false)

  await flip()
  await deliver(handBack('auth-bug', 'Done.'))
  expect(seen.prompts.at(-1)).toBe(handBack('auth-bug', 'Done.'))
  expect(await store(handBack('auth-bug', 'Done.'))).toBe(handBack('auth-bug', 'Done.'))
  expect(await hidden('auth-bug')).toBe(false)
})

test("the engine's notice that a thought's turn ended goes in as the relay while Multitask is on, and as it came otherwise", async ($, on) => {
  const seen = engine($, on)
  const clock = mock.clock(on)
  await $.session.start({ cwd: '.', surface: 'desktop', isInteractive: true })
  await multitask($)
  const flip = () => switchMode($)
  const notice = (result: string) =>
    `<task-notification>\n<task-id>agent-1</task-id>\n<status>completed</status>\n<result>${result}</result>\n</task-notification>`
  const notify = (text: string) => $.prompt.submit({ text, origin: { kind: 'task-notification' }, wait: false })
  await $.tool.call({ tool: 'mcp__multitask__think', tool_use_id: 'c1', name: 'auth bug', task: 'Find why login fails' })

  // Come as the turn ends, while its end may still be settling, it waits for that, then
  // carries the update in place of its own text; nothing is dropped, and no relay follows.
  await $.turn.complete({ ...finished('agent-1'), answer: 'Token expiry is off by one.' })
  expect((await notify(notice('Token expiry is off by one.'))).drop).toBeUndefined()
  expect(seen.prompts).toEqual(['Thought updates:\nauth-bug (done): Token expiry is off by one.'])
  await clock.advance(2500)
  expect(seen.prompts).toHaveLength(1)
  // What it told is not told again beside the person's next message.
  await $.prompt.submit({ text: 'ok', origin: { kind: 'composer' }, wait: false })
  expect(seen.prompts.at(-1)).toBe(`ok\n--\n${VOICE}`)

  // With nothing waiting, it goes in as it came.
  expect((await notify(notice('Token expiry is off by one.'))).drop).toBeUndefined()
  expect(seen.prompts.at(-1)).toBe(notice('Token expiry is off by one.'))

  // So it does with Multitask off.
  await flip()
  await $.turn.complete({ ...finished('agent-1'), answer: 'Logout is fine.' })
  expect((await notify(notice('Logout is fine.'))).drop).toBeUndefined()
  expect(seen.prompts.at(-1)).toBe(notice('Logout is fine.'))
  await clock.advance(2500)
  expect(seen.prompts).toHaveLength(4)
})

test('an interrupt cuts the running turn and hands the message over; a second one cuts the next turn', async ($, on) => {
  const seen = engine($, on)
  const clock = mock.clock(on)
  await $.session.start({ cwd: '.', surface: 'desktop', isInteractive: true })
  await multitask($)
  await $.tool.call({ tool: 'mcp__multitask__think', tool_use_id: 'c1', name: 'auth bug', task: 'Find why login fails' })
  // The thought's model request names the turn it runs.
  const step = async (turnId: string) => {
    for await (const _ of $.turn.step({ turnId, index: 0, model: 'opus', effort: 'high', messageCount: 1, agentId: 'agent-1' })) void _
  }
  const interrupt = (id: string, message: string) =>
    $.tool.call({ tool: 'mcp__multitask__tell', tool_use_id: id, thought: 'auth-bug', message, how: 'interrupt' })
  const cut = (turnId: string) =>
    $.turn.complete({ ...finished('agent-1'), turnId, isAborted: true, reason: 'aborted', answer: 'half a thought' })

  // The cut turn's end makes the message due; the voice's turn that interrupted, ending, hands it over.
  await step('turn-1')
  await interrupt('c2', 'stop, check refresh first')
  expect(seen.aborts).toEqual(['turn-1'])
  await cut('turn-1')
  await clock.settle()
  expect(seen.sends).toHaveLength(0)
  await $.turn.complete(voiceTurnEnd('voice-1'))
  expect(seen.sends.map(s => s.text)).toEqual(['Interruption from the voice: stop, check refresh first'])
  // The cut turn's text is no report.
  await clock.advance(2500)
  expect(seen.prompts).toHaveLength(0)

  // The thought takes up the message in a new turn; the first interrupt's grace runs out.
  await step('turn-2')
  await clock.advance(4000)
  expect(seen.sends).toHaveLength(1)

  // A second interrupt cuts that turn, never stopping the thought.
  await interrupt('c3', 'and the logout path')
  expect(seen.aborts).toEqual(['turn-1', 'turn-2'])
  expect(seen.ran).not.toContain('TaskStop')
  await cut('turn-2')
  await $.turn.complete(voiceTurnEnd('voice-2'))
  expect(seen.sends.at(-1)?.text).toBe('Interruption from the voice: and the logout path')
  const listed = String((await $.tool.call({ tool: 'mcp__multitask__thoughts', tool_use_id: 'c4' })).result)
  expect(listed).toContain('auth-bug [running]')
})

test('an interrupt the engine cannot cut never stops the thought: the message waits for its turn, or goes now', async ($, on) => {
  const agents: AgentInfo[] = [{ id: 'agent-1', description: 'auth-bug', type: 'multitask:thought', status: 'running' }]
  const seen = engine($, on, agents)
  const clock = mock.clock(on)
  await $.session.start({ cwd: '.', surface: 'desktop', isInteractive: true })
  await multitask($)
  await $.tool.call({ tool: 'mcp__multitask__think', tool_use_id: 'c1', name: 'auth bug', task: 'Find why login fails' })
  for await (const _ of $.turn.step({ turnId: 'turn-1', index: 0, model: 'opus', effort: 'high', messageCount: 1, agentId: 'agent-1' })) void _
  const interrupt = async (id: string, message: string) =>
    String((await $.tool.call({ tool: 'mcp__multitask__tell', tool_use_id: id, name: 'auth-bug', message, how: 'interrupt' })).result)

  // Its run going on, the message waits for the end of its turn.
  seen.isAbortRefused = true
  expect(await interrupt('c2', 'check refresh first')).toBe(
    "Could not cut auth-bug's turn; the message is queued as #1, for when that turn ends.",
  )
  expect(seen.ran).not.toContain('TaskStop')
  expect(seen.sends).toHaveLength(0)
  await $.turn.complete({ ...finished('agent-1'), answer: 'Found it.' })
  await clock.settle()
  expect(seen.sends).toHaveLength(0)
  await $.prompt.submit({ text: noticeOf('agent-1', 'Found it.'), origin: { kind: 'task-notification' }, wait: false })
  expect(seen.sends.map(s => s.text)).toEqual(['check refresh first'])

  // Its run ended with no turn of it seen, the message goes at once and resumes it.
  agents[0] = { ...(agents[0] as AgentInfo), status: 'completed' }
  expect(await interrupt('c3', 'and logout')).toBe('auth-bug had no turn running; it has the message now and resumes.')
  expect(seen.sends.map(s => s.text)).toEqual(['check refresh first', 'and logout'])
  expect(seen.ran).not.toContain('TaskStop')

  // stop takes the thought's name as the other tools do.
  expect((await $.tool.call({ tool: 'mcp__multitask__stop', tool_use_id: 'c4', name: 'auth-bug' })).result).toBe('Stopped auth-bug.')
  expect(seen.ran).toContain('TaskStop')
})

test('in auto mode, a message an interrupt could not cut in reaches the thought once that turn ends, resuming it', async ($, on) => {
  const agents: AgentInfo[] = [{ id: 'agent-1', description: 'auth-bug', type: 'multitask:thought', status: 'running' }]
  const seen = engine($, on, agents)
  const clock = mock.clock(on)
  seen.isAutoMode = true
  await $.session.start({ cwd: '.', surface: 'desktop', isInteractive: true })
  await multitask($)
  await raised(seen, () => $.tool.call({ tool: 'mcp__multitask__think', tool_use_id: 'c1', name: 'auth bug', task: 'Find why login fails' }))
  for await (const _ of $.turn.step({ turnId: 'turn-1', index: 0, model: 'opus', effort: 'high', messageCount: 1, agentId: 'agent-1' })) void _
  const listed = async (id: string) => String((await $.tool.call({ tool: 'mcp__multitask__thoughts', tool_use_id: id })).result)

  seen.isAbortRefused = true
  const told = await raised(seen, () =>
    $.tool.call({ tool: 'mcp__multitask__tell', tool_use_id: 'c2', name: 'auth-bug', message: 'check refresh first', how: 'interrupt' }),
  )
  expect(told.result).toBe("Could not cut auth-bug's turn; the message is queued as #1, for when that turn ends.")

  // Its turn ends in its own loop, its run with it: nothing is sent from there, where auto
  // mode would refuse it.
  await $.turn.complete({ ...finished('agent-1'), answer: 'Found it.' })
  await clock.settle()
  expect(seen.sends).toEqual([])

  // The engine's notice that it finished hands the message over, resuming it, and the voice
  // is told it has it.
  await raised(seen, () => $.prompt.submit({ text: noticeOf('agent-1', 'Found it.'), origin: { kind: 'task-notification' }, wait: false }))
  expect(seen.sends).toEqual([{ to: 'agent-1', text: 'check refresh first' }])
  expect(seen.prompts).toEqual(["Thought updates:\nauth-bug (done): Found it. — it has your queued message now; you'll hear back"])
  expect(await listed('c3')).toContain('- auth-bug [running]: Find why login fails\n  report: Found it.')

  // Nothing more is sent, and nothing else wakes the voice for it.
  await clock.advance(90000)
  expect(seen.sends).toHaveLength(1)
  expect(seen.prompts).toHaveLength(1)
})

test('a message due to a thought that no notice handed over wakes the voice, whose turn hands it over; a refusal is told once', async ($, on) => {
  const agents: AgentInfo[] = [{ id: 'agent-1', description: 'auth-bug', type: 'multitask:thought', status: 'running' }]
  const seen = engine($, on, agents)
  const clock = mock.clock(on)
  seen.isAutoMode = true
  await $.session.start({ cwd: '.', surface: 'desktop', isInteractive: true })
  await multitask($)
  await raised(seen, () => $.tool.call({ tool: 'mcp__multitask__think', tool_use_id: 'c1', name: 'auth bug', task: 'Find why login fails' }))
  const listed = async (id: string) => String((await $.tool.call({ tool: 'mcp__multitask__thoughts', tool_use_id: id })).result)
  const voiceTurn = async (turnId: string) => {
    await raised(seen, () => $.turn.start({ text: '', turnId }))
    await raised(seen, () => $.turn.complete(voiceTurnEnd(turnId)))
  }
  await raised(seen, () => $.tool.call({ tool: 'mcp__multitask__tell', tool_use_id: 'c2', name: 'auth-bug', message: 'and logout', how: 'queue' }))

  // The notice comes while its run still counts as running: the message would wait unread,
  // so it stays pending, and the voice is told it will get it.
  seen.isWindingDown = true
  await $.turn.complete({ ...finished('agent-1'), answer: 'Found it.' })
  await raised(seen, () => $.prompt.submit({ text: noticeOf('agent-1', 'Found it.'), origin: { kind: 'task-notification' }, wait: false }))
  expect(seen.sends).toEqual([])
  expect(seen.prompts).toEqual(["Thought updates:\nauth-bug (done): Found it. — 1 message still pending; it will be handed over and you'll hear back"])

  // Its run ends with no word of it; nothing hands the message over, so the voice is woken to.
  agents[0] = { ...(agents[0] as AgentInfo), status: 'completed' }
  await clock.advance(5000)
  expect(seen.sends).toEqual([])
  expect(seen.prompts.at(-1)).toBe("Thought updates:\nauth-bug: (1 message still pending; it will be handed over and you'll hear back)")

  // Its turn tries, and is refused: the voice is told why once, the message still pending.
  const why = 'Agent "auth-bug" was stopped by the user and was not resumed.'
  seen.refuse = why
  await voiceTurn('voice-1')
  await clock.advance(2500)
  expect(seen.sends.map(s => s.text)).toEqual(['and logout', 'and logout', 'and logout', 'and logout'])
  expect(seen.prompts.at(-1)).toBe(
    `Thought updates:\nauth-bug: (1 message still pending; it will be handed over and you'll hear back. The last try failed: ${why})`,
  )
  expect(await listed('c3')).toContain('- auth-bug [idle]: Find why login fails\n  queued: 1. and logout')
  await voiceTurn('voice-2')
  await clock.advance(2500)
  expect(seen.prompts).toHaveLength(3)

  // Once it can be reached, the voice's next turn hands it over.
  seen.refuse = undefined
  await voiceTurn('voice-3')
  expect(seen.sends.at(-1)).toEqual({ to: 'agent-1', text: 'and logout' })
  const now = await listed('c4')
  expect(now).toContain('- auth-bug [running]')
  expect(now).not.toContain('queued')
  await clock.advance(90000)
  expect(seen.prompts).toHaveLength(3)
})

test("a thought's queue goes over once the engine has ended its run, not while the run winds down", async ($, on) => {
  const agents: AgentInfo[] = [{ id: 'agent-1', description: 'auth-bug', type: 'multitask:thought', status: 'running' }]
  const seen = engine($, on, agents)
  const clock = mock.clock(on)
  await $.session.start({ cwd: '.', surface: 'desktop', isInteractive: true })
  await multitask($)
  await $.tool.call({ tool: 'mcp__multitask__think', tool_use_id: 'c1', name: 'auth bug', task: 'Find why login fails' })
  const queue = (id: string, message: string) =>
    $.tool.call({ tool: 'mcp__multitask__tell', tool_use_id: id, name: 'auth-bug', message, how: 'queue' })

  const voiceTurn = async (turnId: string) => {
    await $.turn.start({ text: '', turnId })
    await $.turn.complete(voiceTurnEnd(turnId))
  }

  seen.isWindingDown = true
  await queue('c2', 'and logout')
  await $.turn.complete({ ...finished('agent-1'), answer: 'Found it.' })
  await $.prompt.submit({ text: noticeOf('agent-1', 'Found it.'), origin: { kind: 'task-notification' }, wait: false })
  expect(seen.sends).toHaveLength(0)
  agents[0] = { ...(agents[0] as AgentInfo), status: 'completed' }
  await voiceTurn('voice-1')
  expect(seen.sends.map(s => s.text)).toEqual(['and logout'])

  // A run the engine never reports ended still gets its queue, after a few seconds.
  await queue('c3', 'and signup')
  await $.turn.complete({ ...finished('agent-1'), answer: 'Logout is fine.' })
  await clock.advance(4000)
  await voiceTurn('voice-2')
  expect(seen.sends).toHaveLength(1)
  await clock.advance(1000)
  await voiceTurn('voice-3')
  expect(seen.sends.map(s => s.text)).toEqual(['and logout', 'and signup'])
})

test('a message that does not reach its thought says so: as an error from tell, or to the voice with the message still pending', async ($, on) => {
  const seen = engine($, on)
  const clock = mock.clock(on)
  await $.session.start({ cwd: '.', surface: 'desktop', isInteractive: true })
  await multitask($)
  await $.tool.call({ tool: 'mcp__multitask__think', tool_use_id: 'c1', name: 'auth bug', task: 'Find why login fails' })
  const tell = async (id: string, message: string, how?: string) =>
    String((await $.tool.call({ tool: 'mcp__multitask__tell', tool_use_id: id, name: 'auth-bug', message, ...(how === undefined ? {} : { how }) })).result)
  const listed = async (id: string) => String((await $.tool.call({ tool: 'mcp__multitask__thoughts', tool_use_id: id })).result)
  const why = 'Agent "auth-bug" was stopped by the user and was not resumed.'

  // Handed over once its turn has ended (at the engine's notice) and refused: by its id,
  // then by its name. The voice is told it is still pending, and why.
  expect(await tell('c2', 'check refresh too', 'queue')).toBe('Queued for auth-bug as #1; it reads it when its turn ends.')
  seen.refuse = why
  await $.turn.complete({ ...finished('agent-1'), answer: 'Found it.' })
  await $.prompt.submit({ text: noticeOf('agent-1', 'Found it.'), origin: { kind: 'task-notification' }, wait: false })
  expect(seen.sends).toEqual([
    { to: expect.any(String), text: 'check refresh too' },
    { to: 'auth-bug', text: 'check refresh too' },
  ])
  const pending = "1 message still pending; it will be handed over and you'll hear back"
  expect(seen.prompts).toEqual([
    `Thought updates:\nauth-bug (done): Found it. — ${pending}\nauth-bug: (${pending}. The last try failed: ${why})`,
  ])
  expect(await listed('c3')).toContain('- auth-bug [idle]: Find why login fails\n  queued: 1. check refresh too')

  // A message told to it now fails the call, saying why it did not arrive, and leaves the
  // thought as it was, the other still pending.
  const failed = await $.tool.call({ tool: 'mcp__multitask__tell', tool_use_id: 'c4', name: 'auth-bug', message: 'are you there?' })
  expect(failed.result).toBeUndefined()
  expect(failed.deny).toBe(`auth-bug did not get the message: ${why}`)
  expect(await listed('c5')).toContain('- auth-bug [idle]: Find why login fails\n  queued: 1. check refresh too')

  // Once it can be reached, a message told to it goes after the one still pending.
  seen.refuse = undefined
  expect(await tell('c6', 'go on')).toBe('auth-bug was idle; it has the message now, after the message still pending for it, and resumes.')
  expect(seen.sends.at(-1)).toEqual({ to: expect.any(String), text: 'check refresh too\n\ngo on' })
  expect(await listed('c7')).not.toContain('queued')
  // The voice was told of that refusal once.
  await clock.advance(90000)
  expect(seen.prompts.join('\n').split('The last try failed').length).toBe(2)
})

test('a message to a thought whose run has ended resumes it while Multitask is on; while off, it waits for Multitask', async ($, on) => {
  const seen = engine($, on)
  const clock = mock.clock(on)
  const flip = () => switchMode($)
  const provider = { plugin: 'multitask', tier: 'user' as const }
  const offered = async () => (await $.agent.offer({ agent: 'multitask:thought', description: '', source: 'plugin', provider })).isOffered
  const tell = (id: string, message: string, how?: string) =>
    $.tool.call({ tool: 'mcp__multitask__tell', tool_use_id: id, name: 'auth-bug', message, ...(how === undefined ? {} : { how }) })
  const listed = async (id: string) => String((await $.tool.call({ tool: 'mcp__multitask__thoughts', tool_use_id: id })).result)
  await $.session.start({ cwd: '.', surface: 'desktop', isInteractive: true })
  expect(await offered()).toBe(false)
  await multitask($)
  expect(await offered()).toBe(true)
  await $.tool.call({ tool: 'mcp__multitask__think', tool_use_id: 'c1', name: 'auth bug', task: 'Find why login fails' })

  // Its run ended, a message resumes it, by its id.
  await $.turn.complete({ ...finished('agent-1'), answer: 'Found it.' })
  await clock.settle()
  const told = await tell('c2', 'check refresh too')
  expect(told.deny).toBeUndefined()
  expect(told.result).toBe('auth-bug was idle; it has the message now and resumes.')
  expect(seen.sends).toEqual([{ to: 'agent-1', text: 'check refresh too' }])
  expect(await listed('c3')).toContain('- auth-bug [running]')

  // With Multitask switched off before its turn ends, what waited for it, which the engine
  // would not resume it with, stays pending; switched on again, it goes to it.
  expect((await tell('c4', 'and logout', 'queue')).result).toBe('Queued for auth-bug as #1; it reads it when its turn ends.')
  await flip()
  expect(await offered()).toBe(false)
  await $.turn.complete({ ...finished('agent-1'), answer: 'Refresh is fine.' })
  await $.prompt.submit({ text: noticeOf('agent-1', 'Refresh is fine.'), origin: { kind: 'task-notification' }, wait: false })
  await $.turn.start({ text: 'hello', turnId: 'main-1' })
  await clock.advance(90000)
  expect(seen.sends).toHaveLength(1)
  expect(await listed('c5')).toContain('- auth-bug [idle]: Find why login fails\n  queued: 1. and logout')
  await flip()
  expect(seen.sends.slice(1)).toEqual([{ to: 'agent-1', text: 'and logout' }])
  expect(await listed('c6')).toContain('- auth-bug [running]')
})

test('the model cannot start a thought itself, in any loop; other agents are asked as before', async ($, on) => {
  engine($, on)
  // The engine's `$` checks as the model's own call does. The mod's own start of a thought,
  // allowed by its origin, is not reachable here.
  const input = { subagent_type: 'multitask:thought', prompt: 'x', description: 'y' }
  for (const loop of [{}, { agentId: 'agent-1' }]) {
    const thought = await $.tool.check({ tool: 'Agent', input, tool_use_id: 'a1', ...loop })
    expect(thought.decision).toBe('deny')
    expect(thought.reason).toContain('Only the multitask mod starts a thought')
  }
  const other = await $.tool.check({ tool: 'Agent', input: { ...input, subagent_type: 'general-purpose' } })
  expect(other.decision).toBe('ask')
})

test("the model's own message to a thought is still asked; only the mod's own sends to its thoughts skip the ask", async ($, on) => {
  engine($, on)
  await $.session.start({ cwd: '.', surface: 'desktop', isInteractive: true })
  await multitask($)
  await $.tool.call({ tool: 'mcp__multitask__think', tool_use_id: 't1', name: 'auth bug', task: 'Find why login fails' })
  // The engine's `$` checks as the model's own call does; by the thought's id or name, it is asked as before.
  for (const to of ['agent-1', 'auth-bug']) {
    expect((await $.tool.check({ tool: 'SendMessage', input: { to, message: 'hi' } })).decision).toBe('ask')
  }
})

test('the voice names each thought by its task: kebab-case, made unique, from the task when it gives none', async ($, on) => {
  const names = ['fix-login-expiry', 'fix-login-expiry-2', 'find-why-login', 'cafe-creme']
  const seen = engine(
    $,
    on,
    names.map((name, i) => ({ id: `agent-${i + 1}`, description: name, type: 'multitask:thought', status: 'running' })),
  )
  await $.session.start({ cwd: '.', surface: 'desktop', isInteractive: true })
  await multitask($)
  const think = async (id: string, name: string, task: string) =>
    String((await $.tool.call({ tool: 'mcp__multitask__think', tool_use_id: id, name, task })).result)

  expect(await think('c1', 'Fix login expiry!', 'Find why the token expires early')).toBe(
    'Started thought "fix-login-expiry". Its updates reach you as they come.',
  )
  expect(await think('c2', 'fix-login-expiry', 'Check the refresh path too')).toContain('"fix-login-expiry-2"')
  expect(await think('c3', ' -- ', 'Find why login fails')).toContain('"find-why-login"')
  expect(await think('c4', 'Café crème', 'Order the coffee')).toContain('"cafe-creme"')
  // The engine is given each name, so its agent answers to it as the thought does.
  expect(seen.names).toEqual(names)
  const listed = String((await $.tool.call({ tool: 'mcp__multitask__thoughts', tool_use_id: 'c5' })).result)
  expect(listed).toContain('- fix-login-expiry-2 [running]: Check the refresh path too')
})

test("a call from another agent's loop (an engine fork, a subagent) never starts, steers or stops a thought", async ($, on) => {
  const seen = engine($, on)
  await $.session.start({ cwd: '.', surface: 'desktop', isInteractive: true })
  const think = { tool: 'mcp__multitask__think', name: 'placeholder', task: 'Placeholder - not used' } as const
  const list = async (id: string) => String((await $.tool.call({ tool: 'mcp__multitask__thoughts', tool_use_id: id })).result)

  // A fork's think is refused, Multitask off or on, and starts nothing.
  expect((await $.tool.call({ ...think, tool_use_id: 'f1', agentId: 'fork-1' })).deny).toContain('another agent')
  await multitask($)
  expect((await $.tool.call({ ...think, tool_use_id: 'f2', agentId: 'fork-1' })).deny).toContain('another agent')
  expect(seen.spawns).toBe(0)
  expect(await list('v1')).toBe('No thoughts yet.')

  // The voice's own think, on the main loop, still starts one.
  const started = await $.tool.call({ tool: 'mcp__multitask__think', tool_use_id: 'v2', name: 'auth bug', task: 'Find why login fails' })
  expect(started.deny).toBeUndefined()
  expect(seen.spawns).toBe(1)

  // Nor can another loop message, queue for, interrupt, unqueue, stop or list it.
  const calls = [
    { tool: 'mcp__multitask__tell', thought: 'auth-bug', message: 'hi' },
    { tool: 'mcp__multitask__tell', thought: 'auth-bug', message: 'later', how: 'queue' },
    { tool: 'mcp__multitask__tell', thought: 'auth-bug', message: 'now', how: 'interrupt' },
    { tool: 'mcp__multitask__unqueue', thought: 'auth-bug' },
    { tool: 'mcp__multitask__stop', thought: 'auth-bug' },
    { tool: 'mcp__multitask__thoughts' },
  ] as const
  for (const [i, call] of calls.entries()) {
    expect((await $.tool.call({ ...call, tool_use_id: `f${i + 3}`, agentId: 'agent-7' })).deny).toContain('another agent')
  }
  expect(seen.sends).toHaveLength(0)
  expect(seen.aborts).toHaveLength(0)
  expect(seen.ran).not.toContain('TaskStop')
  expect(await list('v3')).toBe('- auth-bug [running]: Find why login fails')
})

test("the Thoughts pane draws running thoughts first with their task's first line, then failed, done and stopped ones as one line, until opened", async ($, on) => {
  // Each thought's agent, named for it, in the status the engine reports for it.
  const statuses = { done: 'completed', busy: 'running', gone: 'killed', broke: 'failed' } as const
  engine(
    $,
    on,
    Object.entries(statuses).map(([name, status]) => ({ id: name, description: name, type: 'multitask:thought', status })),
  )
  await $.session.start({ cwd: '.', surface: 'terminal', isInteractive: true })
  await multitask($)
  for (const name of Object.keys(statuses)) {
    const task = `the brief for ${name}\n\nthe details for ${name}`
    await $.tool.call({ tool: 'mcp__multitask__think', tool_use_id: `think-${name}`, name, task })
  }
  // Listing the thoughts brings their statuses up to date with the agents'.
  await $.tool.call({ tool: 'mcp__multitask__thoughts', tool_use_id: 'list' })

  const pane = await $.ui.mount({
    plugin: 'multitask',
    surface: 'terminal',
    component: 'Pane',
    requestId: 'multitask-thoughts',
    props: {
      title: 'Thoughts',
      isFocused: false,
      bodyColumns: 80,
      placement: 'dock',
      scroll: { offset: 0, bodyRows: 40 },
      view: {},
    },
  })

  // A line counts them by status.
  expect((await pane.find({ type: 'Text', text: /^Multitask mode/ }))?.text).toBe('Multitask mode · 1 running · 1 failed · 1 done · 1 stopped')
  // The running card shows only its task's first line.
  expect(await pane.find({ text: /brief for busy/ })).toBeDefined()
  expect(await pane.find({ text: /details for busy/ })).toBeUndefined()
  for (const id of ['done', 'gone', 'broke']) expect(await pane.find({ text: `brief for ${id}` })).toBeUndefined()
  const keys = (await pane.findAll({ type: 'Button' })).map(b => b.key)
  expect(keys).toEqual([
    'expand:busy',
    'more:busy',
    'tell:busy',
    'stop:busy',
    'expand:broke',
    'stop:broke',
    'expand:done',
    'stop:done',
    'expand:gone',
  ])

  // More shows its whole task; a click on its name hides it again.
  await $.ui.press({ plugin: 'multitask', key: 'more:busy' })
  await pane.redraw()
  expect(await pane.find({ text: /details for busy/ })).toBeDefined()
  expect((await pane.find({ key: 'more:busy' }))?.text).toBe('less')
  await $.ui.press({ plugin: 'multitask', key: 'expand:busy' })
  await pane.redraw()
  expect(await pane.find({ text: /details for busy/ })).toBeUndefined()
  expect((await pane.find({ key: 'more:busy' }))?.text).toBe('more')

  // A finished thought opens into its whole card, task and all.
  await $.ui.press({ plugin: 'multitask', key: 'expand:done' })
  await pane.redraw()
  expect(await pane.find({ text: /brief for done/ })).toBeDefined()
  expect(await pane.find({ text: /details for done/ })).toBeDefined()
  await $.ui.press({ plugin: 'multitask', key: 'collapse:done' })
  await pane.redraw()
  expect(await pane.find({ text: /brief for done/ })).toBeUndefined()
})

test("a thought's card shows its report's first line until opened, and none while it works on or a note is newer", async ($, on) => {
  engine($, on)
  const clock = mock.clock(on)
  await $.session.start({ cwd: '.', surface: 'terminal', isInteractive: true })
  await multitask($)
  await $.tool.call({ tool: 'mcp__multitask__think', tool_use_id: 'c1', name: 'auth bug', task: 'Find why login fails' })
  const says = (uuid: string, text: string) =>
    $.session.append({
      message: { type: 'assistant', role: 'assistant', content: [{ type: 'text', text }] },
      door: 'response',
      origin: { kind: 'model', model: 'test' },
      uuid,
      agentId: 'agent-1',
    })
  const pane = await $.ui.mount({
    plugin: 'multitask',
    surface: 'terminal',
    component: 'Pane',
    requestId: 'multitask-thoughts',
    props: { title: 'Thoughts', isFocused: false, bodyColumns: 80, placement: 'dock', scroll: { offset: 0, bodyRows: 40 }, view: {} },
  })
  // Its notes, and what of its report shows: its first line, or the whole of it, and the
  // control that opens or folds it.
  const shown = async () => {
    await pane.redraw()
    return {
      notes: sectionOf(await pane.drawn(), 'notes'),
      line: (await pane.find({ type: 'Text', text: /^Refresh|^The token/ }))?.text,
      whole: (await pane.find({ type: 'Markdown' }))?.text,
      toggle: (await pane.find({ key: 'report:agent-1' }))?.text,
    }
  }
  const nothing = { line: undefined, whole: undefined, toggle: undefined }

  await says('u1', 'Checking the token')
  await says('u2', 'The token expires early.\n\nIt is set an hour short.')
  await $.turn.complete({ ...finished('agent-1'), answer: 'The token expires early.\n\nIt is set an hour short.' })
  await clock.settle()
  await $.ui.press({ plugin: 'multitask', key: 'expand:agent-1' })
  const notes = ['Checking the token']
  expect(await shown()).toEqual({
    notes,
    line: 'The token expires early. It is set an hour short.',
    whole: undefined,
    toggle: 'more',
  })
  // With the pointer anywhere on the report, its control lights in the thought's colour.
  const toggle = pathTo(await pane.drawn(), n => n.props?.key === 'report:agent-1') ?? []
  const card = toggle.find(n => n.props?.borderStyle === 'round')
  expect(toggle.some(n => n.type === 'Box' && n.props?.key === 'reportbox:agent-1')).toBe(true)
  expect(toggle.at(-1)?.hover).toEqual({ color: card?.props?.borderColor })
  // More shows it whole; less folds it again.
  await $.ui.press({ plugin: 'multitask', key: 'report:agent-1' })
  expect(await shown()).toEqual({
    notes,
    line: undefined,
    whole: 'The token expires early.\n\nIt is set an hour short.',
    toggle: 'less',
  })

  // Told more, it works on: the old report is gone at once, before any note; its fresh notes show.
  await $.tool.call({ tool: 'mcp__multitask__tell', tool_use_id: 'c2', thought: 'auth-bug', message: 'and refresh?' })
  expect(await shown()).toEqual({ notes, ...nothing })
  for await (const _ of $.turn.step({ turnId: 'turn-2', index: 0, model: 'opus', messageCount: 1, agentId: 'agent-1' })) void _
  await says('u3', 'Reading the refresh path')
  expect(await shown()).toEqual({ notes: [...notes, 'Reading the refresh path'], ...nothing })

  // Its next report shows, folded again though the last was opened.
  await says('u4', 'Refresh is fine.')
  await $.turn.complete({ ...finished('agent-1'), turnId: 'turn-2', answer: 'Refresh is fine.' })
  await clock.settle()
  expect(await shown()).toEqual({
    notes: [...notes, 'Reading the refresh path'],
    line: 'Refresh is fine.',
    whole: undefined,
    toggle: 'more',
  })
})

type Drawn = { type?: string; props?: Record<string, unknown>; hover?: Record<string, unknown>; children?: unknown[] }

// The text a drawing shows, all of it, in order.
function textIn(node: unknown): string {
  if (typeof node === 'string') return node
  if (typeof node !== 'object' || node === null) return ''
  return ((node as Drawn).children ?? []).map(textIn).join('')
}

// The lines of a card's part under its label ('task', 'notes', 'report', 'queued'):
// each line's first text, as the line beside it (an age) is left out.
function sectionOf(tree: unknown, label: string): string[] {
  const row = elementsOf(tree).find(n => n.type === 'Box' && n.children?.length === 2 && textIn(n.children[0]) === label)
  const lines = ((row?.children?.[1] as Drawn | undefined)?.children ?? []).filter(line => typeof line === 'object' && line !== null)
  return lines.map(line => textIn(elementsOf(line).find(n => n.type === 'Text')))
}

// Every element of a drawing, outermost first.
function elementsOf(node: unknown): Drawn[] {
  if (typeof node !== 'object' || node === null) return []
  const n = node as Drawn
  return [n, ...(n.children ?? []).flatMap(elementsOf)]
}

// The elements from `node` down to the first that `is` matches.
function pathTo(node: unknown, is: (n: Drawn) => boolean): Drawn[] | undefined {
  if (typeof node !== 'object' || node === null) return undefined
  const n = node as Drawn
  if (is(n)) return [n]
  for (const child of n.children ?? []) {
    const below = pathTo(child, is)
    if (below !== undefined) return [n, ...below]
  }
  return undefined
}

test("a card says how long its thought has run and since its latest note, in the warning colour once it has been quiet a while", async ($, on) => {
  engine($, on)
  const clock = mock.clock(on, { now: 1_000_000 })
  await $.session.start({ cwd: '.', surface: 'terminal', isInteractive: true })
  await multitask($)
  await $.tool.call({ tool: 'mcp__multitask__think', tool_use_id: 'c1', name: 'auth bug', task: 'Find why login fails' })
  const says = (uuid: string, text: string) =>
    $.session.append({
      message: { type: 'assistant', role: 'assistant', content: [{ type: 'text', text }] },
      door: 'response',
      origin: { kind: 'model', model: 'test' },
      uuid,
      agentId: 'agent-1',
    })
  const pane = await $.ui.mount({
    plugin: 'multitask',
    surface: 'terminal',
    component: 'Pane',
    requestId: 'multitask-thoughts',
    props: { title: 'Thoughts', isFocused: false, bodyColumns: 80, placement: 'dock', scroll: { offset: 0, bodyRows: 40 }, view: {} },
  })
  const status = async () => (await pane.find({ type: 'Text', text: /^(running|done|failed|stopped)/ }))?.text

  expect(await status()).toBe('running for <1m')
  expect(sectionOf(await pane.drawn(), 'notes')).toEqual(['none yet, started just now'])

  // The latest note at full strength with its age; those before it dim.
  await says('u1', 'Checking the token')
  await clock.advance(60_000)
  await says('u2', 'Reading the refresh path')
  await clock.advance(2 * 60_000)
  // drawn afresh as the minutes pass, with nothing else changing
  expect(await status()).toBe('running for 3m')
  expect(sectionOf(await pane.drawn(), 'notes')).toEqual(['Checking the token', 'Reading the refresh path'])
  expect((await pane.find({ type: 'Text', text: 'Checking the token' }))?.props.dimColor).toBe(true)
  expect((await pane.find({ type: 'Text', text: 'Reading the refresh path' }))?.props.dimColor).toBeUndefined()
  const age = await pane.find({ type: 'Text', text: '2m ago' })
  expect(age?.props).toMatchObject({ dimColor: true })
  expect(age?.props.color).toBeUndefined()

  // Quiet a while, the age is drawn in the warning colour.
  await clock.advance(4 * 60_000)
  expect((await pane.find({ type: 'Text', text: '6m ago' }))?.props).toMatchObject({ color: 'warning' })

  // Its turn ended, it says how long ago.
  await $.turn.complete({ ...finished('agent-1'), answer: 'Found it.' })
  await clock.settle()
  await clock.advance(3 * 60_000)
  expect(await status()).toBe('done 3m ago')
})

test('new thoughts take the first four colours in turn, past any held, then the rest; one that ended keeps its own, dim while taken', async ($, on) => {
  const names = ['one', 'two', 'three', 'four', 'five', 'six', 'seven', 'eight']
  const agents: AgentInfo[] = names.map(name => ({ id: name, description: name, type: 'multitask:thought', status: 'running' }))
  const seen = engine($, on, agents)
  const clock = mock.clock(on)
  await $.session.start({ cwd: '.', surface: 'terminal', isInteractive: true })
  await multitask($)
  const think = (name: string) => $.tool.call({ tool: 'mcp__multitask__think', tool_use_id: `think-${name}`, name, task: `the brief for ${name}` })
  const tell = (name: string) => $.tool.call({ tool: 'mcp__multitask__tell', tool_use_id: `tell-${name}`, name, message: 'and logout' })
  const end = async (name: string) => {
    await $.turn.complete({ ...finished(name), answer: 'Done.' })
    await clock.settle()
  }
  const pane = await $.ui.mount({
    plugin: 'multitask',
    surface: 'terminal',
    component: 'Pane',
    requestId: 'multitask-thoughts',
    props: { title: 'Thoughts', isFocused: false, bodyColumns: 80, placement: 'dock', scroll: { offset: 0, bodyRows: 40 }, view: {} },
  })
  // The colour a thought's glyph is drawn in, whether dim, and its card's border, if a card.
  const lookOf = async (id: string) => {
    await pane.redraw()
    const box = elementsOf(await pane.drawn()).find(n => n.props?.key === `card:${id}` || n.props?.key === `line:${id}`)
    const glyph = elementsOf(box).find(n => n.type === 'Text')
    return { color: glyph?.props?.color, isDim: glyph?.props?.dimColor === true, border: box?.props?.borderColor }
  }
  // The palette: the first four, the clearest, go in turn; the rest only while those are all held.
  const [c1, c2, c3, c4, c5, c6] = ['#4fa3e0', '#d9636a', '#58b36b', '#c98a2e', '#9b6fd6', '#2fb3a6']

  await think('one')
  await think('two')
  expect(await lookOf('one')).toEqual({ color: c1, isDim: false, border: c1 })
  expect(await lookOf('two')).toEqual({ color: c2, isDim: false, border: c2 })

  // Ended, its colour is free, but the next thought takes the next colour in turn; the ended
  // one, its colour held by no running thought, is drawn as it is.
  await end('one')
  await think('three')
  expect((await lookOf('three')).color).toBe(c3)
  expect(await lookOf('one')).toEqual({ color: c1, isDim: false, border: undefined })

  // The turn is kept in the session, so it carries on after a reload rather than starting over.
  await $.session.start({ cwd: '.', surface: 'terminal', isInteractive: true })
  await think('four')
  expect((await lookOf('four')).color).toBe(c4)

  // Round again to the first, which the ended thought keeps, drawn dim while it is taken.
  await think('five')
  expect(await lookOf('five')).toEqual({ color: c1, isDim: false, border: c1 })
  expect(await lookOf('one')).toEqual({ color: c1, isDim: true, border: undefined })

  // With the first four all held by running thoughts, the first of the rest none holds.
  await think('six')
  expect((await lookOf('six')).color).toBe(c5)

  // Resumed while its colour is taken, it takes a free one; the running thoughts keep theirs.
  expect((await tell('one')).deny).toBeUndefined()
  expect(seen.sends).toEqual([{ to: 'one', text: 'and logout' }])
  expect(await lookOf('one')).toEqual({ color: c6, isDim: false, border: c6 })
  expect((await lookOf('five')).color).toBe(c1)
  expect((await lookOf('six')).color).toBe(c5)

  // Picks from the rest left the turn where it was: the next takes the second, now free.
  await end('two')
  await think('seven')
  expect((await lookOf('seven')).color).toBe(c2)

  // The next in turn, the third, is held, so the next thought takes the fourth, now free.
  await end('four')
  await think('eight')
  expect((await lookOf('eight')).color).toBe(c4)
  expect((await lookOf('three')).color).toBe(c3)

  // Resumed with its colour free, a thought keeps it.
  await end('three')
  expect(await lookOf('three')).toEqual({ color: c3, isDim: false, border: undefined })
  expect((await tell('three')).deny).toBeUndefined()
  expect(await lookOf('three')).toEqual({ color: c3, isDim: false, border: c3 })
})

test("the person tells a thought something from its card: it gets it, resuming if its turn ended, and the voice hears of it", async ($, on) => {
  const seen = engine($, on)
  const clock = mock.clock(on)
  await $.session.start({ cwd: '.', surface: 'desktop', isInteractive: true })
  await multitask($)
  await $.tool.call({ tool: 'mcp__multitask__think', tool_use_id: 'c1', name: 'auth bug', task: 'Find why login fails' })
  const pane = await $.ui.mount({
    plugin: 'multitask',
    surface: 'desktop',
    component: 'Pane',
    requestId: 'multitask-thoughts',
    props: { title: 'Thoughts', isFocused: false, bodyColumns: 80, placement: 'dock', scroll: { offset: 0, bodyRows: 40 }, view: {} },
  })
  const field = 'tell-field:agent-1'
  seen.isAutoMode = true

  // `tell` opens a field at the foot of its card; Enter sends what is typed there, as the
  // person's own words, from the event the engine raises to the mod (in auto mode, a send
  // from anywhere else is refused).
  expect(await pane.find({ key: field })).toBeUndefined()
  await pane.press({ key: 'tell:agent-1' })
  expect(await pane.find({ key: field })).toBeDefined()
  expect((await pane.find({ key: 'tell:agent-1' }))?.text).toBe('cancel')
  await raised(seen, () => pane.input({ key: field, text: '  check refresh too ' }))
  expect(seen.sends.map(s => s.text)).toEqual(['The user, from the Thoughts pane: check refresh too'])
  expect(await pane.find({ key: field })).toBeUndefined()

  // The voice hears of it with the thought's next update, before it.
  await $.turn.complete({ ...finished('agent-1'), answer: 'Refresh is fine too.' })
  await clock.advance(2500)
  expect(seen.prompts.at(-1)).toBe('Thought updates:\nauth-bug (from the user): check refresh too\nauth-bug (done): Refresh is fine too.')

  // A thought whose turn ended, opened, takes a message too, and resumes with it.
  await pane.press({ key: 'expand:agent-1' })
  await pane.press({ key: 'tell:agent-1' })
  await raised(seen, () => pane.input({ key: field, text: 'and logout?' }))
  expect(seen.sends.at(-1)?.text).toBe('The user, from the Thoughts pane: and logout?')
  expect((await pane.find({ type: 'Text', text: /^(running|done)/ }))?.text).toMatch(/^running/)

  // In Focus, no card offers it; nor with Multitask off. The pane's first line says which.
  const heading = async () => (await pane.find({ type: 'Text', text: / · 1 running$/ }))?.text
  expect(await heading()).toBe('Multitask mode · 1 running')
  await multitask($, 'mode focus')
  await pane.redraw()
  expect(await pane.find({ key: 'tell:agent-1' })).toBeUndefined()
  expect(await heading()).toBe('Focus mode · 1 running')
  await multitask($)
  await pane.redraw()
  expect(await pane.find({ key: 'tell:agent-1' })).toBeUndefined()
  expect(await heading()).toBe('Multitask is off · 1 running')
})

test('the band shares one row with another mod: its controls keep their width, nothing wraps or shows on hover', async ($, on) => {
  // another mod's controls, drawn beneath, as thread-chat's are
  on('ui.render', { component: 'AbovePrompt' }, ($, e) => {
    const { Box, Text } = $.ui.resolve(e)
    return Box({ flexDirection: 'row', children: [Text({ children: ['other mod'] })] })
  })
  engine($, on)
  await $.session.start({ cwd: '.', surface: 'desktop', isInteractive: true })
  await multitask($)

  for (const surface of ['desktop', 'terminal'] as const) {
    const band = await $.ui.mount({ plugin: 'multitask', surface, ...BAND })
    const tree = await band.drawn()
    const all = elementsOf(tree)
    const other = pathTo(tree, n => n.type === 'Text' && (n.children ?? []).join('') === 'other mod')
    const thoughts = pathTo(tree, n => n.props?.key === 'open-thoughts')
    const dropdown = pathTo(tree, n => n.props?.key === DROPDOWN)
    expect(other).toBeDefined()
    expect(thoughts).toBeDefined()
    expect(dropdown?.at(-1)?.type).toBe('Select')
    let at = 0
    while (other?.[at] === thoughts?.[at]) at++
    // the other mod first, giving way; this one's dropdown and `thoughts` after it, keeping their width
    expect(other?.[at]?.props).toMatchObject({ flexShrink: 1, minWidth: 0 })
    expect(thoughts?.[at]?.props).toMatchObject({ flexShrink: 0 })
    expect(dropdown?.[at]).toBe(thoughts?.[at])
    expect(other?.[0]?.children?.at(-1)).toBe(thoughts?.[at])
    expect(all.filter(n => n.props?.flexWrap === 'wrap' || n.props?.flexWrap === 'wrap-reverse')).toEqual([])
    expect(all.filter(n => n.hover?.display === 'flex' && n.props?.position !== 'absolute')).toEqual([])
    await band.unmount()
  }
})

test('the dropdown shows the mode the chat is in, and picking the other mode switches to it', async ($, on) => {
  const seen = engine($, on)
  await $.session.start({ cwd: '.', surface: 'desktop', isInteractive: true })
  await multitask($)
  const say = async (text: string) => {
    await $.prompt.submit({ text, origin: { kind: 'composer' }, wait: false })
    return seen.prompts.at(-1) ?? ''
  }

  for (const surface of ['desktop', 'terminal'] as const) {
    const band = await $.ui.mount({ plugin: 'multitask', surface, ...BAND })
    const dropdown = await band.find({ key: DROPDOWN })
    expect(dropdown?.type).toBe('Select')
    expect(dropdown?.props.options).toEqual([
      { value: 'multitask', label: 'Multitask' },
      { value: 'focus', label: 'Focus' },
    ])
    expect(dropdown?.props.value).toBe('multitask')
    expect(dropdown?.props.label).toBeUndefined()
    await band.unmount()
  }

  const band = await $.ui.mount({ plugin: 'multitask', surface: 'desktop', ...BAND })
  // the mode the chat is in already, or anything else, leaves it be
  await band.select({ key: DROPDOWN, value: 'multitask' })
  await band.select({ key: DROPDOWN, value: 'something else' })
  expect(await say('do a thing')).toContain('# Multitasking mind')
  // Focus switches to Focus, as /multitask mode does
  await band.select({ key: DROPDOWN, value: 'focus' })
  await band.redraw()
  expect(await modeOf(band)).toBe('focus')
  expect(await say('and now')).not.toContain('# Multitasking mind')
  await band.select({ key: DROPDOWN, value: 'focus' })
  await band.redraw()
  expect(await modeOf(band)).toBe('focus')
  // Multitask switches back
  await band.select({ key: DROPDOWN, value: 'multitask' })
  await band.redraw()
  expect(await modeOf(band)).toBe('multitask')
  expect(await say('again')).toContain('# Multitasking mind')
})

test('no button of the mod is below the input, and the mobile app, which draws no dropdown, switches mode with `/multitask mode`', async ($, on) => {
  const seen = engine($, on)
  await $.session.start({ cwd: '.', surface: 'desktop', isInteractive: true })
  const mode = await $.ui.mount({ plugin: 'multitask', surface: 'desktop', component: 'SessionMode', props: { modes: [] } })
  expect(await mode.drawn()).toEqual({ type: 'engine', ref: 0 })
  await mode.unmount()

  const band = await $.ui.mount({ plugin: 'multitask', surface: 'mobile', ...BAND })
  expect(await band.drawn()).toEqual({ type: 'engine', ref: 0 })
  // on, in Multitask mode, `thoughts` alone
  expect(await multitask($)).toBe(
    'Multitask is on in this chat, in Multitask mode: this chat is now the voice and hands all work to thoughts. Pick Focus above the prompt, or use `/multitask mode`, to work with the agent as usual.',
  )
  await band.redraw()
  expect(await band.find({ key: DROPDOWN })).toBeUndefined()
  expect(await band.find({ key: 'open-thoughts' })).toBeDefined()
  await $.prompt.submit({ text: 'hello', origin: { kind: 'composer' }, wait: false })
  expect(seen.prompts.at(-1)).toContain('# Multitasking mind')
  // in Focus, nothing there
  expect(await multitask($, 'mode focus')).toBe('Focus mode: this chat does its work itself again.')
  await band.redraw()
  expect(await band.drawn()).toEqual({ type: 'engine', ref: 0 })
  expect(await multitask($, 'Mode Multitask')).toBe('Multitask mode: this chat is now the voice and hands all work to thoughts.')
  await band.redraw()
  expect(await band.find({ key: 'open-thoughts' })).toBeDefined()
})

// A thought's dot in a drawing of the band (its keyed Box, on the desktop), the picture it
// draws on a page, the lines of its hover card; on the terminal, the glyphs on the
// `thoughts` button, in order, which keeps no key on them.
const dotIn = (tree: unknown, id: string) => elementsOf(tree).find(n => n.props?.key === `dot:${id}`)
const glyphsIn = (tree: unknown) =>
  (elementsOf(tree).find(n => n.props?.key === 'open-thoughts')?.children ?? []).filter(
    (n): n is Drawn => typeof n === 'object' && n !== null && (n as Drawn).type === 'Text',
  )
const pictureIn = (dot: Drawn | undefined) => String(elementsOf(dot).find(n => n.type === 'Svg')?.props?.source ?? '')
const cardIn = (dot: Drawn | undefined) =>
  elementsOf(dot).find(n => n.type === 'Box' && n.props?.position === 'absolute' && n.props?.display === 'none')
const linesIn = (node: Drawn | undefined) => elementsOf(node).filter(n => n.type === 'Text').map(textIn)
const glyphIn = (dot: Drawn | undefined) => {
  const text = elementsOf(dot).find(n => n.type === 'Text')
  return text && { glyph: textIn(text), color: text.props?.color, inverse: text.props?.inverse }
}
const dotKeys = (tree: unknown) =>
  elementsOf(tree).flatMap(n => (typeof n.props?.key === 'string' && n.props.key.startsWith('dot:') ? [n.props.key] : []))

// What a thought writes as it works, which the mod keeps as a progress note.
const sayer = ($: Engine, agentId: string) => (uuid: string, text: string) =>
  $.session.append({
    message: { type: 'assistant', role: 'assistant', content: [{ type: 'text', text }] },
    door: 'response',
    origin: { kind: 'model', model: 'test' },
    uuid,
    agentId,
  })

// What else a thought does as it works, which is no note: a tool call, and its result.
const worker = ($: Engine, agentId: string) => async (uuid: string) => {
  await $.session.append({
    message: { type: 'assistant', role: 'assistant', content: [{ type: 'tool_use', id: `call-${uuid}`, name: 'Read', input: {} }] },
    door: 'response',
    origin: { kind: 'model', model: 'test' },
    uuid: `${uuid}-call`,
    agentId,
  })
  await $.session.append({
    message: { type: 'user', role: 'user', content: [{ type: 'tool_result', tool_use_id: `call-${uuid}`, content: 'the file' }] },
    door: 'tool-result',
    origin: { kind: 'tool', tool: 'Read' },
    uuid: `${uuid}-result`,
    agentId,
  })
}

test('the `thoughts` button, left of the dropdown, has a dot for each running thought that blinks white as it works, swells at each note and fades out as its turn ends', async ($, on) => {
  engine($, on)
  const clock = mock.clock(on, { now: 1_000_000 })
  await $.session.start({ cwd: '.', surface: 'desktop', isInteractive: true })
  await multitask($)
  await $.tool.call({ tool: 'mcp__multitask__think', tool_use_id: 'c1', name: 'auth bug', task: 'Find why login fails' })
  const says = sayer($, 'agent-1')
  const band = await $.ui.mount({ plugin: 'multitask', surface: 'desktop', ...BAND })
  const dot = async () => dotIn(await band.drawn(), 'agent-1')
  const color = '#4fa3e0'

  // In the `thoughts` button, after its word, left of the dropdown in the band's own
  // controls: a still disc in the thought's colour.
  const tree = await band.drawn()
  const toDot = pathTo(tree, n => n.props?.key === 'dot:agent-1')
  const toDropdown = pathTo(tree, n => n.props?.key === DROPDOWN)
  let at = 0
  while (toDot?.[at] === toDropdown?.[at]) at++
  const row = toDot?.[at - 1]?.children ?? []
  expect(toDot?.[at]?.props?.key).toBe('open-thoughts')
  expect(row.indexOf(toDot?.[at])).toBeGreaterThanOrEqual(0)
  expect(row.indexOf(toDot?.[at])).toBeLessThan(row.indexOf(toDropdown?.[at]))
  expect(await thoughtsShown(band)).toBe('thoughts ●')
  expect(pictureIn(await dot())).toContain(`fill="${color}"`)
  expect(pictureIn(await dot())).not.toContain('<animate')

  // Its card, shown on hover alone, says its name and that it has no notes yet.
  expect(cardIn(await dot())?.props?.display).toBe('none')
  expect(cardIn(await dot())?.hover?.display).toBe('flex')
  expect(linesIn(cardIn(await dot()))).toEqual(['auth-bug', 'No notes yet', 'started just now'])

  // A tool call and its result blink it white and back; drawn again meanwhile, the blink
  // carries on where it had got to; over, the dot is drawn still.
  const works = worker($, 'agent-1')
  await works('w1')
  const blink = pictureIn(await dot())
  expect(blink).toContain(`<animate attributeName="fill" values="${color};#ffffff;${color}"`)
  expect(blink).toContain('begin="0ms"')
  expect(blink).not.toContain('attributeName="r"')
  await clock.advance(400)
  await band.redraw()
  expect(pictureIn(await dot())).toContain('begin="-400ms"')
  await clock.advance(700)
  await band.redraw()
  expect(pictureIn(await dot())).not.toContain('<animate')

  // A note swells it to 1.3 times as wide and back, about the same centre of the same box,
  // with no blink; drawn again meanwhile, it carries on; over, the dot is drawn still.
  await says('u1', 'Checking the token')
  const swell = pictureIn(await dot())
  expect(swell).toContain('<svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 14 14">')
  expect(swell).toContain('<circle cx="7" cy="7" r="3.5"')
  expect(swell).toContain('<animate attributeName="r" values="3.5;4.7;3.5"')
  expect(swell).toContain('begin="0ms"')
  expect(swell).not.toContain('attributeName="fill"')
  await clock.advance(400)
  await band.redraw()
  expect(pictureIn(await dot())).toContain('begin="-400ms"')
  // a blink meanwhile runs beside it, each carried on alone
  await works('w2')
  const both = pictureIn(await dot())
  expect(both).toContain('<animate attributeName="r" values="3.5;4.7;3.5" keyTimes="0;0.5;1" dur="1000ms" begin="-400ms"')
  expect(both).toContain(`<animate attributeName="fill" values="${color};#ffffff;${color}" keyTimes="0;0.25;1" dur="1000ms" begin="0ms"`)
  await clock.advance(700)
  await band.redraw()
  expect(pictureIn(await dot())).not.toContain('attributeName="r"')
  expect(pictureIn(await dot())).toContain('begin="-700ms"')
  await clock.advance(300)
  await band.redraw()
  expect(pictureIn(await dot())).not.toContain('<animate')

  // The card says the latest note and how long ago it came, drawn afresh as the minutes pass.
  expect(linesIn(cardIn(await dot()))).toEqual(['auth-bug', 'Checking the token', 'just now'])
  await clock.advance(2 * 60_000 + 30_000)
  expect(linesIn(cardIn(await dot()))).toEqual(['auth-bug', 'Checking the token', '2m ago'])

  // Its turn ends: a flash, then a check, and it fades out of the row of itself.
  await $.turn.complete({ ...finished('agent-1'), answer: 'Found it.' })
  await clock.settle()
  const end = pictureIn(await dot())
  expect(end).toContain('attributeName="stroke-dashoffset"')
  expect(end).toContain('M4 7.3')
  expect(linesIn(cardIn(await dot()))).toEqual(['auth-bug', 'Found it.', 'done'])
  await clock.advance(1500)
  expect(await dot()).toBeUndefined()

  // Resumed, it has its dot again.
  await $.tool.call({ tool: 'mcp__multitask__tell', tool_use_id: 'c2', name: 'auth-bug', message: 'and logout?' })
  expect(pictureIn(await dot())).toContain(`fill="${color}"`)
})

test("on the terminal a dot is a glyph on the `thoughts` button in its thought's colour, white a moment as it works, inverted a moment at each note, a check as its turn ends", async ($, on) => {
  const seen = engine($, on)
  const clock = mock.clock(on, { now: 1_000_000 })
  await $.session.start({ cwd: '.', surface: 'terminal', isInteractive: true })
  await multitask($)
  await $.tool.call({ tool: 'mcp__multitask__think', tool_use_id: 'c1', name: 'auth bug', task: 'Find why login fails' })
  const says = sayer($, 'agent-1')
  const band = await $.ui.mount({ plugin: 'multitask', surface: 'terminal', ...BAND })
  const dot = async () => glyphsIn(await band.drawn())[0]
  const color = '#4fa3e0'
  expect(glyphIn(await dot())).toEqual({ glyph: '●', color, inverse: undefined })
  expect(elementsOf(await band.drawn()).some(n => n.props?.position === 'absolute')).toBe(false)
  // on the button, after its word, which opens the Thoughts pane
  const button = await band.find({ key: 'open-thoughts' })
  expect(button?.type).toBe('Button')
  expect(button?.text).toBe('thoughts ●')
  await band.press({ key: 'open-thoughts' })
  expect(seen.opened).toEqual(['multitask-thoughts'])
  await worker($, 'agent-1')('w1')
  expect(glyphIn(await dot())).toEqual({ glyph: '●', color: '#ffffff', inverse: undefined })
  await clock.advance(400)
  expect(glyphIn(await dot())).toEqual({ glyph: '●', color, inverse: undefined })
  await clock.advance(600)
  await says('u1', 'Checking the token')
  expect(glyphIn(await dot())).toEqual({ glyph: '●', color, inverse: true })
  // back to itself once the pulse is over, with nothing else changing
  await clock.advance(1000)
  expect(glyphIn(await dot())).toEqual({ glyph: '●', color, inverse: undefined })

  await $.turn.complete({ ...finished('agent-1'), answer: 'Found it.' })
  await clock.settle()
  expect(glyphIn(await dot())).toEqual({ glyph: '✓', color, inverse: undefined })
  await clock.advance(1500)
  expect(await dot()).toBeUndefined()
  expect(await thoughtsShown(band)).toBe('thoughts')
})

test('a click anywhere on the desktop\'s `thoughts` button opens the Thoughts pane: its word, a dot, its `+N`, each under a hit area of its own', async ($, on) => {
  const names = ['one', 'two', 'three', 'four', 'five', 'six', 'seven', 'eight', 'nine']
  const agents: AgentInfo[] = names.map(name => ({ id: name, description: name, type: 'multitask:thought', status: 'running' }))
  const seen = engine($, on, agents)
  mock.clock(on, { now: 1_000_000 })
  await $.session.start({ cwd: '.', surface: 'desktop', isInteractive: true })
  await multitask($)
  const band = await $.ui.mount({ plugin: 'multitask', surface: 'desktop', ...BAND })
  // With no thought running, the word alone, under its hit area.
  expect(await thoughtsShown(band)).toBe('thoughts')
  for (const name of names) await $.tool.call({ tool: 'mcp__multitask__think', tool_use_id: `think-${name}`, name, task: `the brief for ${name}` })
  expect(await thoughtsShown(band)).toBe('thoughts ●●●●●●●●')

  // A dot's Box holds its picture, its card and, filling it, its hit area: the pointer on
  // the hit area is on the dot, so its card shows.
  const dot = dotIn(await band.drawn(), 'one')
  expect(dot?.children?.map(n => (n as Drawn).type)).toEqual(['Svg', 'Box', 'Box'])
  const hitBox = dot?.children?.[2] as Drawn
  expect(hitBox.props).toMatchObject({ position: 'absolute', top: 0, left: 0, width: '100%', height: '100%' })
  expect(elementsOf(hitBox).find(n => n.type === 'Client')?.props).toMatchObject({ key: 'thoughts-hit:dot:one', width: '100%', height: '100%' })

  // Every part has one, the padding inside the parts, so none of the ring is dead.
  const button = elementsOf(await band.drawn()).find(n => n.props?.key === 'open-thoughts')
  const hits = elementsOf(button).flatMap(n => (n.type === 'Client' ? [n.props?.key] : []))
  expect(hits).toEqual(['thoughts-hit:word', ...names.slice(0, 8).map(name => `thoughts-hit:dot:${name}`), 'thoughts-hit:more'])
  // The padding is in the parts: the ring's own, which the desktop would give it, is none.
  expect(button?.props).toMatchObject({ borderStyle: 'single', height: 1, paddingY: 0, paddingLeft: 0, paddingRight: 0 })

  const press = async (key: string) => {
    seen.opened.length = 0
    await band.pointer({ type: 'down', x: 0, y: 0, button: 'left', in: key } as never)
    return seen.opened
  }
  expect(await press('thoughts-hit:dot:three')).toEqual(['multitask-thoughts'])
  expect(await press('thoughts-hit:word')).toEqual(['multitask-thoughts'])
  expect(await press('thoughts-hit:more')).toEqual(['multitask-thoughts'])
})

test("a dot blinks once a second at most however busy its thought, and only a blink's start draws the band again", async ($, on) => {
  const seen = engine($, on)
  const clock = mock.clock(on, { now: 1_000_000 })
  await $.session.start({ cwd: '.', surface: 'desktop', isInteractive: true })
  await multitask($)
  await $.tool.call({ tool: 'mcp__multitask__think', tool_use_id: 'c1', name: 'auth bug', task: 'Find why login fails' })
  const works = worker($, 'agent-1')
  const band = await $.ui.mount({ plugin: 'multitask', surface: 'desktop', ...BAND })
  const picture = async () => pictureIn(dotIn(await band.drawn(), 'agent-1'))

  // (The kit draws the band again, if anything asked it to, as the drawing is read.)
  const drawsNow = async () => {
    await band.drawn()
    return seen.bandDraws
  }
  await works('w1')
  const first = await picture()
  expect(first).toContain('begin="0ms"')
  const draws = await drawsNow()

  // What it does under a second later starts no blink and draws nothing: the blink drawn
  // carries on of itself.
  await clock.advance(300)
  await works('w2')
  expect(await drawsNow()).toBe(draws)
  await clock.advance(400)
  await works('w3')
  expect(await drawsNow()).toBe(draws)
  expect(await picture()).toBe(first)

  // The first row a second or more after it starts the next blink, a picture of its own.
  await clock.advance(300)
  await works('w4')
  expect(await drawsNow()).toBe(draws + 1)
  const second = await picture()
  expect(second).toContain('begin="0ms"')
  expect(second).not.toBe(first)

  // Over, it ends of itself: nothing draws the band again.
  await clock.advance(5000)
  expect(await drawsNow()).toBe(draws + 1)

  // An ended thought's rows blink nothing.
  await $.turn.complete({ ...finished('agent-1'), answer: 'Found it.' })
  await clock.settle()
  await clock.advance(1500)
  const ended = await drawsNow()
  await works('w5')
  expect(await drawsNow()).toBe(ended)
})

test('the band shows eight dots at most, in the order their thoughts started, and counts the rest; a stopped one fades without a mark', async ($, on) => {
  const names = ['one', 'two', 'three', 'four', 'five', 'six', 'seven', 'eight', 'nine', 'ten']
  const agents: AgentInfo[] = names.map(name => ({ id: name, description: name, type: 'multitask:thought', status: 'running' }))
  engine($, on, agents)
  const clock = mock.clock(on, { now: 1_000_000 })
  await $.session.start({ cwd: '.', surface: 'desktop', isInteractive: true })
  await multitask($)
  for (const name of names) await $.tool.call({ tool: 'mcp__multitask__think', tool_use_id: `think-${name}`, name, task: `the brief for ${name}` })
  const band = await $.ui.mount({ plugin: 'multitask', surface: 'desktop', ...BAND })
  const more = async () => elementsOf(await band.drawn()).find(n => n.type === 'Text' && /^\+\d+$/.test(textIn(n)))

  expect(dotKeys(await band.drawn())).toEqual(names.slice(0, 8).map(name => `dot:${name}`))
  expect(textIn(await more())).toBe('+2')

  // Stopped, a dot fades where it stands, with no check or cross, then gives way.
  await $.tool.call({ tool: 'mcp__multitask__stop', tool_use_id: 's1', name: 'two' })
  const fading = pictureIn(dotIn(await band.drawn(), 'two'))
  expect(fading).toContain('attributeName="opacity"')
  expect(fading).not.toContain('<path')
  expect(dotKeys(await band.drawn())).toEqual(names.slice(0, 8).map(name => `dot:${name}`))
  await clock.advance(1500)
  expect(dotKeys(await band.drawn())).toEqual(['one', ...names.slice(2, 9)].map(name => `dot:${name}`))
  expect(textIn(await more())).toBe('+1')
})
