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
  // set to keep the user rows the mod appends, as a transcript would; else appends are refused
  hidden?: string[]
}

// The test stands in for the engine beneath the plugin, and records what reached it:
// each prompt with the notes beside it, the effort each model request asked for, each
// turn it was asked to cut, and how many agents it was asked to start. Its agents' runs
// end with their turns, and a message that reaches one starts it again. `store` seeds the
// mod store; `null` leaves the store to the test.
function engine(
  on: On,
  agents: AgentInfo[] = [{ id: 'agent-1', description: 'auth-bug', type: 'multitask:thought', status: 'running' }],
  store: Record<string, unknown> | null = {},
): Seen {
  const seen: Seen = { prompts: [], sends: [], ran: [], efforts: [], aborts: [], spawns: 0, names: [] }
  if (store !== null) mock.store(on, store)
  on('session.id', () => ({ value: 'session-1' }))
  on('session.start', ($, e) => ({ cwd: e.cwd }))
  on('agent.register', () => ({ value: { agent: 'multitask:thought' } }))
  on('tool.register', ($, e) => ({ value: { tool: `mcp__multitask__${e.name}` } }))
  on('command.register', ($, e) => ({ value: { command: e.name } }))
  on('ui.open', () => ({ value: { isPlaced: true } }))
  on('ui.message', () => ({}))
  on('ui.render', () => ({ type: 'engine', ref: 0 }))
  // Only the real engine can hand back a spawned agent's id; the agent list stands in.
  on('agent.spawn', ($, e) => {
    seen.spawns++
    seen.names.push(e.name)
    return { model: 'test' }
  })
  on('agent.list', () => ({ value: agents }))
  on('session.send', ($, e) => {
    seen.sends.push({ to: e.to, text: e.text })
    if (seen.refuse !== undefined) return { isDelivered: false, reason: seen.refuse }
    const agent = agents.find(a => a.id === e.to || a.description === e.to)
    if (agent !== undefined) agent.status = 'running'
    return { isDelivered: true }
  })
  on('prompt.submit', ($, e) => {
    seen.prompts.push([e.text, ...(e.context ?? [])].join('\n--\n'))
    return { text: e.text }
  })
  on('session.append', ($, e) => {
    if (seen.hidden === undefined || e.message.type !== 'user') throw new Error('no transcript to store the row in')
    seen.hidden.push(e.message.content.map(block => (block.type === 'text' ? block.text : '')).join(''))
    return { message: e.message, uuid: `row-${seen.hidden.length}` } as never
  })
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

const finished = (agentId: string) => ({
  answer: '',
  durationMs: 10,
  isAborted: false,
  turnId: 'turn-1',
  agentId,
  reason: 'answer' as const,
})

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
})

test('a quiet reply draws as nothing on every surface while Multitask is on, and as the engine draws it while off', async ($, on) => {
  engine(on)
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
  await $.command.run({ command: 'multitask', args: '', origin: { kind: 'composer' }, presentation: {} as never })
  await each('nothing')
})

test('a session that never switches Multitask on is left as it is: no band, no tools, no notes, no folded notices', async ($, on) => {
  // what the mod offers the model, answered here before the stand-in engine beneath
  const registered: string[] = []
  on('tool.register', ($, e) => {
    registered.push(e.name)
    return { value: { tool: `mcp__multitask__${e.name}` } }
  })
  const seen = engine(on)
  await $.session.start({ cwd: '.', surface: 'desktop', isInteractive: true })
  expect(registered).toEqual([])
  await $.prompt.submit({ text: 'hello', origin: { kind: 'composer' }, wait: false })
  expect(seen.prompts).toEqual(['hello'])
  const band = await $.ui.mount({ plugin: 'multitask', surface: 'desktop', ...BAND })
  expect(await band.find({ text: /^Multitask$/ })).toBeUndefined()

  // switched on, the voice has its tools and the band shows; a reload while it has
  // thoughts offers them again, and the band stays while they do
  const flip = () => $.command.run({ command: 'multitask', args: '', origin: { kind: 'composer' }, presentation: {} as never })
  await flip()
  expect(registered).toEqual(['think', 'tell', 'unqueue', 'stop', 'thoughts'])
  await band.redraw()
  expect((await band.find({ type: 'Svg' }))?.props.alt).toBe('Multitask: on')
  await $.tool.call({ tool: 'mcp__multitask__think', tool_use_id: 'c1', name: 'auth bug', task: 'Find why login fails' })
  await flip()
  await band.redraw()
  expect((await band.find({ type: 'Svg' }))?.props.alt).toBe('Multitask: off')
  expect((await band.find({ key: 'open-thoughts' }))?.props.label).toBe('thoughts 1')
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
  const seen = engine(on)
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

  await $.command.run({ command: 'multitask', args: '', origin: { kind: 'composer' }, presentation: {} as never })
  // Split across pieces, it goes on as one, in its first piece's place.
  expect(await step(quiet)).toEqual({ out: [thinking, text(NO_RESPONSE), stop], answer: NO_RESPONSE })
  // A reply that goes on past it is passed on whole, as it came.
  const more = [thinking, text('(qu'), text('iet) but one thing:'), text(' the build broke.'), stop]
  expect(await step(more)).toEqual({ out: more, answer: '(quiet) but one thing: the build broke.' })
  // A thought's reply goes on as it came.
  expect(await step(quiet, 'agent-1')).toEqual({ out: quiet, answer: '(quiet)\n' })
})

test('updates handed to the voice draw as nothing on the desktop and one dim line in the terminal', async ($, on) => {
  engine(on)
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
  const seen = engine(on, [{ id: 'agent-1', description: 'auth-bug', type: 'multitask:thought', status: 'completed' }])
  const clock = mock.clock(on)
  await $.session.start({ cwd: '.', surface: 'desktop', isInteractive: true })
  await $.command.run({ command: 'multitask', args: '', origin: { kind: 'composer' }, presentation: {} as never })
  await $.tool.call({ tool: 'mcp__multitask__think', tool_use_id: 'c1', name: 'auth bug', task: 'Find why login fails' })
  const band = await $.ui.mount({ plugin: 'multitask', surface: 'desktop', ...BAND })
  const label = async () => {
    await band.redraw()
    return (await band.find({ key: 'open-thoughts' }))?.props.label
  }
  const says = (uuid: string, text: string) =>
    $.session.append({
      message: { type: 'assistant', role: 'assistant', content: [{ type: 'text', text }] },
      door: 'response',
      origin: { kind: 'model', model: 'test' },
      uuid,
      agentId: 'agent-1',
    }).catch(() => undefined) // the kit has no transcript to store the row in
  expect(await label()).toBe('thoughts 1')

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
  expect(await label()).toBe('thoughts 1')
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
  const seen = engine(on)
  const clock = mock.clock(on)
  await $.session.start({ cwd: '.', surface: 'desktop', isInteractive: true })

  // Off: thinking is refused.
  const off = await $.tool.call({ tool: 'mcp__multitask__think', tool_use_id: 'c0', name: 'a', task: 'x' })
  expect(off.deny).toBeDefined()

  // Off with no thoughts there is no band: /multitask turns it on.
  const band = await $.ui.mount({ plugin: 'multitask', surface: 'desktop', ...BAND })
  expect(await band.find({ text: /^Multitask$/ })).toBeUndefined()
  await $.command.run({ command: 'multitask', args: '', origin: { kind: 'composer' }, presentation: {} as never })
  await band.redraw()
  expect(await band.find({ text: /^Multitask$/ })).toBeDefined()
  expect((await band.find({ type: 'Svg' }))?.props.alt).toBe('Multitask: on')

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
  expect((await band.find({ key: 'open-thoughts' }))?.props.label).toBe('thoughts 1')

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
    }).catch(() => undefined) // the kit has no transcript to store the row in
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
  expect((await band.find({ key: 'open-thoughts' }))?.props.label).toBe('thoughts 1 · 2 queued')
  await $.tool.call({ tool: 'mcp__multitask__unqueue', tool_use_id: 'c5', thought: 'auth-bug', index: 2 })
  expect(seen.sends).toHaveLength(0)

  // Its next notes (while relayed) and the text its turn ends with reach the voice as one
  // prompt, once things go quiet, the report once; and the queue is handed over.
  await says('u2', 'Reading the refresh path')
  await says('u3', 'Token expiry is off by one.')
  await $.turn.complete({ ...finished('agent-1'), answer: 'Token expiry is off by one.' })
  await clock.settle()
  expect(seen.sends).toEqual([{ to: expect.any(String), text: 'keep' }])
  expect(seen.prompts).toEqual(noted)
  await clock.advance(2500)
  expect(seen.prompts.slice(noted.length)).toEqual([
    `Thought updates:\n${RELAY_NOTES ? 'auth-bug: Reading the refresh path\n' : ''}auth-bug (done): Token expiry is off by one.`,
  ])
  expect(seen.prompts.join('\n')).not.toContain('expiresAt')
  const after = String((await $.tool.call({ tool: 'mcp__multitask__thoughts', tool_use_id: 'c5b' })).result)
  expect(after).toContain('· Checking how the token expiry is computed')
  expect(after).toContain('report: Token expiry is off by one.')
  expect(after).not.toContain('· Token expiry')

  // Posting reaches it at once.
  await $.tool.call({ tool: 'mcp__multitask__tell', tool_use_id: 'c6', thought: 'auth-bug', message: 'also check refresh' })
  expect(seen.sends.at(-1)?.text).toBe('also check refresh')

  // The band's switch turns Multitask off; the band stays while the thought lives.
  await band.pointer({ type: 'down', x: 1, y: 0, button: 'left', in: 'multitask-switch' })
  await band.pointer({ type: 'up', x: 1, y: 0, button: 'left', in: 'multitask-switch' })
  await band.redraw()
  expect((await band.find({ type: 'Svg' }))?.props.alt).toBe('Multitask: off')
  expect(await band.find({ key: 'open-thoughts' })).toBeDefined()
})

test('the voice is told as Multitask comes on and goes off, and thinks less hard while on', async ($, on) => {
  const seen = engine(on)
  await $.session.start({ cwd: '.', surface: 'desktop', isInteractive: true })
  const say = (text: string) => $.prompt.submit({ text, origin: { kind: 'composer' }, wait: false })
  const flip = () => $.command.run({ command: 'multitask', args: '', origin: { kind: 'composer' }, presentation: {} as never })
  const step = async (agentId?: string) => {
    const stream = $.turn.step({ turnId: 't', index: 0, model: 'opus', effort: 'xhigh', messageCount: 1, ...(agentId === undefined ? {} : { agentId }) })
    for await (const _ of stream) void _
    return seen.efforts.at(-1)
  }

  await say('hello')
  expect(seen.prompts.at(-1)).toBe('hello')
  expect(await step()).toBe('xhigh')

  await flip()
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

  await flip()
  await say('back to normal')
  expect(seen.prompts.at(-1)).toContain('Multitask is now off')
  expect(await step()).toBe('xhigh')
  await say('plain')
  expect(seen.prompts.at(-1)).toBe('plain')
})

// A conversation's messages as the engine lists them, and the switch a session kept.
const SAID = ['why does the band wrap onto two rows?', 'Both mods share one row, so it wraps.', 'can it stay on one row instead?']
const listed = (texts: string[]) => texts.map(text => ({ role: 'user' as const, text, toolUses: [] }))
const kept = (isOn: boolean, at: number, texts: string[]) => ({ isOn, at, marks: marksOf(listed(texts)) })

test('a session keeps its switch for its next run, with its messages\' marks once it has been on', async ($, on) => {
  const store: Record<string, unknown> = {}
  on('store.get', ($, e) => ({ value: store[e.key] }))
  on('store.set', ($, e) => {
    store[e.key] = e.value
    return { value: undefined }
  })
  on('store.keys', () => ({ value: Object.keys(store) }))
  mock.clock(on, { now: 1000 })
  engine(on, undefined, null)
  on('session.messages', () => ({ value: listed(SAID) }))
  const flip = () => $.command.run({ command: 'multitask', args: '', origin: { kind: 'composer' }, presentation: {} as never })

  await $.session.start({ cwd: '.', surface: 'desktop', isInteractive: true })
  expect(store['session:session-1']).toEqual({ isOn: false, at: 1000, marks: [] })
  await flip()
  expect(store['session:session-1']).toEqual(kept(true, 1000, SAID))
  await flip()
  expect(store['session:session-1']).toEqual(kept(false, 1000, SAID))
})

// Whether, once started, the session's switch is on: the voice is told its part.
const isOnAtStart = async ($: Engine, seen: Seen) => {
  await $.session.start({ cwd: '.', surface: 'desktop', isInteractive: true })
  await $.prompt.submit({ text: 'hello', origin: { kind: 'composer' }, wait: false })
  return seen.prompts.at(-1)?.includes('# Multitasking mind') === true
}

test('a restarted session takes up the switch it kept, with the voice\'s tools and the band', async ($, on) => {
  const registered: string[] = []
  on('tool.register', ($, e) => {
    registered.push(e.name)
    return { value: { tool: `mcp__multitask__${e.name}` } }
  })
  const seen = engine(on, undefined, { 'session:session-1': kept(true, 1, []) })
  expect(await isOnAtStart($, seen)).toBe(true)
  expect(registered).toEqual(['think', 'tell', 'unqueue', 'stop', 'thoughts'])
  const band = await $.ui.mount({ plugin: 'multitask', surface: 'desktop', ...BAND })
  expect((await band.find({ type: 'Svg' }))?.props.alt).toBe('Multitask: on')
})

test('a rewound or forked session, under a new id, takes up the switch of the session it came from', async ($, on) => {
  const seen = engine(on, undefined, {
    'session:old': kept(true, 1, [...SAID, 'and a later message the rewind left behind']),
    'session:unrelated': kept(false, 2, ['a different conversation altogether', 'with nothing in common at all']),
  })
  on('session.messages', () => ({ value: listed(SAID) }))
  expect(await isOnAtStart($, seen)).toBe(true)
})

test('of sessions that know as much of a rewound one, it takes up the switch of the one kept last', async ($, on) => {
  // rewound from "old" into "later", switched off there, and rewound again
  const seen = engine(on, undefined, { 'session:old': kept(true, 1, SAID), 'session:later': kept(false, 2, SAID) })
  on('session.messages', () => ({ value: listed(SAID) }))
  expect(await isOnAtStart($, seen)).toBe(false)
})

test("what is new from the thoughts goes beside the person's messages and after a relay, each thing once", async ($, on) => {
  const seen = engine(on, [
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
    }).catch(() => undefined) // the kit has no transcript to store the row in
  await $.command.run({ command: 'multitask', args: '', origin: { kind: 'composer' }, presentation: {} as never })
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
  const seen = engine(on, [{ id: 'agent-1', description: 'auth-bug', type: 'multitask:thought', status: 'completed' }])
  seen.hidden = []
  const clock = mock.clock(on)
  await $.session.start({ cwd: '.', surface: 'desktop', isInteractive: true })
  await $.command.run({ command: 'multitask', args: '', origin: { kind: 'composer' }, presentation: {} as never })
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
  const seen = engine(on)
  seen.hidden = []
  mock.clock(on)
  await $.session.start({ cwd: '.', surface: 'desktop', isInteractive: true })
  const flip = () => $.command.run({ command: 'multitask', args: '', origin: { kind: 'composer' }, presentation: {} as never })
  const handBack = (from: string, report: string) =>
    `Another Claude session sent a message:\n<agent-message from="${from}">\n[Subagent hand-back] ${report}\n</agent-message>`
  const deliver = (text: string) => $.prompt.submit({ text, origin: { kind: 'peer' }, wait: false })
  await flip()
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

  // The row is hidden on the desktop only while on and only for a thought's.
  const hidden = async (from: string) => {
    const row = await $.ui.mount({
      plugin: 'multitask',
      surface: 'desktop',
      component: 'UserMessage',
      props: { text: handBack(from, 'Done.'), origin: { kind: 'peer' } as never, isExpanded: false },
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
  expect(await hidden('auth-bug')).toBe(false)
})

test("the engine's notice that a thought's turn ended goes in as the relay while Multitask is on, and as it came otherwise", async ($, on) => {
  const seen = engine(on)
  const clock = mock.clock(on)
  await $.session.start({ cwd: '.', surface: 'desktop', isInteractive: true })
  const flip = () => $.command.run({ command: 'multitask', args: '', origin: { kind: 'composer' }, presentation: {} as never })
  const notice = (result: string) =>
    `<task-notification>\n<task-id>agent-1</task-id>\n<status>completed</status>\n<result>${result}</result>\n</task-notification>`
  const notify = (text: string) => $.prompt.submit({ text, origin: { kind: 'task-notification' }, wait: false })
  await flip()
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
  const seen = engine(on)
  const clock = mock.clock(on)
  await $.session.start({ cwd: '.', surface: 'desktop', isInteractive: true })
  await $.command.run({ command: 'multitask', args: '', origin: { kind: 'composer' }, presentation: {} as never })
  await $.tool.call({ tool: 'mcp__multitask__think', tool_use_id: 'c1', name: 'auth bug', task: 'Find why login fails' })
  // The thought's model request names the turn it runs.
  const step = async (turnId: string) => {
    for await (const _ of $.turn.step({ turnId, index: 0, model: 'opus', effort: 'high', messageCount: 1, agentId: 'agent-1' })) void _
  }
  const interrupt = (id: string, message: string) =>
    $.tool.call({ tool: 'mcp__multitask__tell', tool_use_id: id, thought: 'auth-bug', message, how: 'interrupt' })
  const cut = (turnId: string) =>
    $.turn.complete({ ...finished('agent-1'), turnId, isAborted: true, reason: 'aborted', answer: 'half a thought' })

  await step('turn-1')
  await interrupt('c2', 'stop, check refresh first')
  expect(seen.aborts).toEqual(['turn-1'])
  await cut('turn-1')
  await clock.settle()
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
  await clock.settle()
  expect(seen.sends.at(-1)?.text).toBe('Interruption from the voice: and the logout path')
  const listed = String((await $.tool.call({ tool: 'mcp__multitask__thoughts', tool_use_id: 'c4' })).result)
  expect(listed).toContain('auth-bug [running]')
})

test('an interrupt the engine cannot cut never stops the thought: the message waits for its turn, or goes now', async ($, on) => {
  const agents: AgentInfo[] = [{ id: 'agent-1', description: 'auth-bug', type: 'multitask:thought', status: 'running' }]
  const seen = engine(on, agents)
  const clock = mock.clock(on)
  await $.session.start({ cwd: '.', surface: 'desktop', isInteractive: true })
  await $.command.run({ command: 'multitask', args: '', origin: { kind: 'composer' }, presentation: {} as never })
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

test("a thought's queue goes over once the engine has ended its run, not while the run winds down", async ($, on) => {
  const agents: AgentInfo[] = [{ id: 'agent-1', description: 'auth-bug', type: 'multitask:thought', status: 'running' }]
  const seen = engine(on, agents)
  const clock = mock.clock(on)
  await $.session.start({ cwd: '.', surface: 'desktop', isInteractive: true })
  await $.command.run({ command: 'multitask', args: '', origin: { kind: 'composer' }, presentation: {} as never })
  await $.tool.call({ tool: 'mcp__multitask__think', tool_use_id: 'c1', name: 'auth bug', task: 'Find why login fails' })
  const queue = (id: string, message: string) =>
    $.tool.call({ tool: 'mcp__multitask__tell', tool_use_id: id, name: 'auth-bug', message, how: 'queue' })

  seen.isWindingDown = true
  await queue('c2', 'and logout')
  await $.turn.complete({ ...finished('agent-1'), answer: 'Found it.' })
  await clock.advance(250)
  expect(seen.sends).toHaveLength(0)
  agents[0] = { ...(agents[0] as AgentInfo), status: 'completed' }
  await clock.advance(250)
  expect(seen.sends.map(s => s.text)).toEqual(['and logout'])

  // A run the engine never reports ended still gets its queue, after a few seconds.
  await queue('c3', 'and signup')
  await $.turn.complete({ ...finished('agent-1'), answer: 'Logout is fine.' })
  await clock.advance(4000)
  expect(seen.sends).toHaveLength(1)
  await clock.advance(1000)
  expect(seen.sends.map(s => s.text)).toEqual(['and logout', 'and signup'])
})

test('a message that does not reach its thought says so: in tell, or to the voice with the message still queued', async ($, on) => {
  const seen = engine(on)
  const clock = mock.clock(on)
  await $.session.start({ cwd: '.', surface: 'desktop', isInteractive: true })
  await $.command.run({ command: 'multitask', args: '', origin: { kind: 'composer' }, presentation: {} as never })
  await $.tool.call({ tool: 'mcp__multitask__think', tool_use_id: 'c1', name: 'auth bug', task: 'Find why login fails' })
  const tell = async (id: string, message: string, how?: string) =>
    String((await $.tool.call({ tool: 'mcp__multitask__tell', tool_use_id: id, name: 'auth-bug', message, ...(how === undefined ? {} : { how }) })).result)
  const listed = async (id: string) => String((await $.tool.call({ tool: 'mcp__multitask__thoughts', tool_use_id: id })).result)
  const why = 'Agent "auth-bug" was stopped by the user and was not resumed.'

  // Handed over at its turn's end and refused: by its id, then by its name.
  expect(await tell('c2', 'check refresh too', 'queue')).toBe('Queued for auth-bug as #1; it reads it when its turn ends.')
  seen.refuse = why
  await $.turn.complete({ ...finished('agent-1'), answer: 'Found it.' })
  await clock.settle()
  expect(seen.sends).toEqual([
    { to: expect.any(String), text: 'check refresh too' },
    { to: 'auth-bug', text: 'check refresh too' },
  ])
  await clock.advance(2500)
  expect(seen.prompts).toEqual([
    `Thought updates:\nauth-bug (done): Found it.\nauth-bug: (a message did not reach it, still queued for the end of its next turn: ${why})`,
  ])
  expect(await listed('c3')).toContain('- auth-bug [idle]: Find why login fails\n  queued: 1. check refresh too')

  // A message told to it now says why it did not arrive, and leaves the thought as it was.
  expect(await tell('c4', 'are you there?')).toBe(`auth-bug did not get the message: ${why}`)
  expect(await listed('c5')).toContain('auth-bug [idle]')

  // Once it can be reached, it is, and its queue goes with its next turn's end.
  seen.refuse = undefined
  expect(await tell('c6', 'go on')).toBe('auth-bug was idle; it has the message now and resumes.')
  await $.turn.complete({ ...finished('agent-1'), answer: 'Done.' })
  await clock.settle()
  expect(seen.sends.at(-1)?.text).toBe('check refresh too')
})

test("the voice's thoughts start without a second permission ask; other agents are asked as before", async ($, on) => {
  engine(on)
  const thought = await $.tool.check({ tool: 'Agent', input: { subagent_type: 'multitask:thought', prompt: 'x', description: 'y' } })
  expect(thought.decision).toBe('allow')
  const other = await $.tool.check({ tool: 'Agent', input: { subagent_type: 'general-purpose', prompt: 'x', description: 'y' } })
  expect(other.decision).toBe('ask')
})

test('the voice names each thought by its task: kebab-case, made unique, from the task when it gives none', async ($, on) => {
  const names = ['fix-login-expiry', 'fix-login-expiry-2', 'find-why-login', 'cafe-creme']
  const seen = engine(
    on,
    names.map((name, i) => ({ id: `agent-${i + 1}`, description: name, type: 'multitask:thought', status: 'running' })),
  )
  await $.session.start({ cwd: '.', surface: 'desktop', isInteractive: true })
  await $.command.run({ command: 'multitask', args: '', origin: { kind: 'composer' }, presentation: {} as never })
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
  const seen = engine(on)
  await $.session.start({ cwd: '.', surface: 'desktop', isInteractive: true })
  const think = { tool: 'mcp__multitask__think', name: 'placeholder', task: 'Placeholder - not used' } as const
  const list = async (id: string) => String((await $.tool.call({ tool: 'mcp__multitask__thoughts', tool_use_id: id })).result)

  // A fork's think is refused, Multitask off or on, and starts nothing.
  expect((await $.tool.call({ ...think, tool_use_id: 'f1', agentId: 'fork-1' })).deny).toContain('another agent')
  await $.command.run({ command: 'multitask', args: '', origin: { kind: 'composer' }, presentation: {} as never })
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

test("the Thoughts pane draws running thoughts first with their task's first line, the rest as one line, until opened", async ($, on) => {
  // Each thought's agent, named for it, in the status the engine reports for it.
  const statuses = { done: 'completed', busy: 'running', gone: 'killed', broke: 'failed' } as const
  engine(
    on,
    Object.entries(statuses).map(([name, status]) => ({ id: name, description: name, type: 'multitask:thought', status })),
  )
  await $.session.start({ cwd: '.', surface: 'terminal', isInteractive: true })
  await $.command.run({ command: 'multitask', args: '', origin: { kind: 'composer' }, presentation: {} as never })
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

  // The running card shows only its task's first line.
  expect(await pane.find({ text: /brief for busy/ })).toBeDefined()
  expect(await pane.find({ text: /details for busy/ })).toBeUndefined()
  for (const id of ['done', 'gone', 'broke']) expect(await pane.find({ text: `brief for ${id}` })).toBeUndefined()
  const keys = (await pane.findAll({ type: 'Button' })).map(b => b.key)
  expect(keys).toEqual([
    'expand:busy',
    'stop:busy',
    'more:busy',
    'expand:done',
    'stop:done',
    'expand:gone',
    'expand:broke',
    'stop:broke',
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
  engine(on)
  const clock = mock.clock(on)
  await $.session.start({ cwd: '.', surface: 'terminal', isInteractive: true })
  await $.command.run({ command: 'multitask', args: '', origin: { kind: 'composer' }, presentation: {} as never })
  await $.tool.call({ tool: 'mcp__multitask__think', tool_use_id: 'c1', name: 'auth bug', task: 'Find why login fails' })
  const says = (uuid: string, text: string) =>
    $.session.append({
      message: { type: 'assistant', role: 'assistant', content: [{ type: 'text', text }] },
      door: 'response',
      origin: { kind: 'model', model: 'test' },
      uuid,
      agentId: 'agent-1',
    }).catch(() => undefined) // the kit has no transcript to store the row in
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
      notes: (await pane.findAll({ type: 'Text', text: /^· / })).map(n => n.text),
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
  const notes = ['· Checking the token']
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
  expect(await shown()).toEqual({ notes: [...notes, '· Reading the refresh path'], ...nothing })

  // Its next report shows, folded again though the last was opened.
  await says('u4', 'Refresh is fine.')
  await $.turn.complete({ ...finished('agent-1'), turnId: 'turn-2', answer: 'Refresh is fine.' })
  await clock.settle()
  expect(await shown()).toEqual({
    notes: [...notes, '· Reading the refresh path'],
    line: 'Refresh is fine.',
    whole: undefined,
    toggle: 'more',
  })
})

type Drawn = { type?: string; props?: Record<string, unknown>; hover?: Record<string, unknown>; children?: unknown[] }

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

test('the band shares one row with another mod: its controls keep their width, nothing wraps or shows on hover', async ($, on) => {
  // another mod's controls, drawn beneath, as thread-chat's are
  on('ui.render', { component: 'AbovePrompt' }, ($, e) => {
    const { Box, Text } = $.ui.resolve(e)
    return Box({ flexDirection: 'row', children: [Text({ children: ['other mod'] })] })
  })
  engine(on)
  await $.session.start({ cwd: '.', surface: 'desktop', isInteractive: true })
  await $.command.run({ command: 'multitask', args: '', origin: { kind: 'composer' }, presentation: {} as never })

  for (const surface of ['desktop', 'terminal'] as const) {
    const band = await $.ui.mount({ plugin: 'multitask', surface, ...BAND })
    const tree = await band.drawn()
    const all = elementsOf(tree)
    const other = pathTo(tree, n => n.type === 'Text' && (n.children ?? []).join('') === 'other mod')
    const thoughts = pathTo(tree, n => n.props?.key === 'open-thoughts')
    expect(other).toBeDefined()
    expect(thoughts).toBeDefined()
    let at = 0
    while (other?.[at] === thoughts?.[at]) at++
    // the other mod gives way; this one keeps its width
    expect(other?.[at]?.props).toMatchObject({ flexShrink: 1, minWidth: 0 })
    expect(thoughts?.[at]?.props).toMatchObject({ flexShrink: 0 })
    expect(all.filter(n => n.props?.flexWrap === 'wrap' || n.props?.flexWrap === 'wrap-reverse')).toEqual([])
    expect(all.filter(n => n.hover?.display === 'flex' && n.props?.position !== 'absolute')).toEqual([])
    await band.unmount()
  }
})
