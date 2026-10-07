import type { AgentInfo, On } from 'claude-code'
import { expect, mock, test } from 'claude-code/testing'

import { RELAY_NOTES, VOICE_REMINDER, formatUpdates, isQuiet, relayNames } from '../hooks/prompts'

type Seen = {
  prompts: string[]
  sends: { to: string; text: string }[]
  ran: string[]
  efforts: unknown[]
  aborts: string[]
}

// The test stands in for the engine beneath the plugin, and records what reached it:
// each prompt with the notes beside it, the effort each model request asked for, and
// each turn it was asked to cut.
function engine(
  on: On,
  agents: AgentInfo[] = [{ id: 'agent-1', description: 'auth-bug', type: 'multitask:thought', status: 'running' }],
): Seen {
  const seen: Seen = { prompts: [], sends: [], ran: [], efforts: [], aborts: [] }
  on('session.start', ($, e) => ({ cwd: e.cwd }))
  on('agent.register', () => ({ value: { agent: 'multitask:thought' } }))
  on('tool.register', ($, e) => ({ value: { tool: `mcp__multitask__${e.name}` } }))
  on('command.register', ($, e) => ({ value: { command: e.name } }))
  on('ui.open', () => ({ value: { isPlaced: true } }))
  on('ui.message', () => ({}))
  on('ui.render', () => ({ type: 'engine', ref: 0 }))
  // Only the real engine can hand back a spawned agent's id; the agent list stands in.
  on('agent.spawn', () => ({ model: 'test' }))
  on('agent.list', () => ({ value: agents }))
  on('session.send', ($, e) => {
    seen.sends.push({ to: e.to, text: e.text })
    return { isDelivered: true }
  })
  on('prompt.submit', ($, e) => {
    seen.prompts.push([e.text, ...(e.context ?? [])].join('\n--\n'))
    return { text: e.text }
  })
  on('turn.complete', ($, e) => ({ text: e.answer }))
  on('turn.abort', ($, e) => {
    seen.aborts.push(e.turnId)
    return { value: undefined }
  })
  on('session.compact', () => ({ messages: [{ role: 'user' as const, text: 'the summary', toolUses: [] }] }))
  on('turn.step', async function* ($, e) {
    seen.efforts.push(e.effort)
    return { turnId: e.turnId, index: e.index, answer: '', toolUses: [], stopReason: 'end_turn' as const, usage: null }
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
  expect(isQuiet('(quiet) but also this')).toBe(false)
  const text = formatUpdates([
    { thought: 'auth', text: 'Checking the token' },
    { thought: 'docs', text: 'Found it:\n\n- in a.ts\n- in b.ts', isDone: true },
    { thought: 'auth', text: '', isDone: true },
  ])
  expect(text).toBe('Thought updates:\nauth: Checking the token\ndocs (done): Found it: - in a.ts - in b.ts\nauth: done')
  expect(relayNames(text)).toEqual(['auth', 'docs'])
})

test('a quiet reply draws as nothing on every surface', async ($, on) => {
  engine(on)
  for (const surface of ['terminal', 'desktop'] as const) {
    const row = await $.ui.mount({
      plugin: 'multitask',
      surface,
      component: 'AssistantMessage',
      props: { text: '(quiet)', isFirstOfReply: true },
    })
    expect(await row.find({ text: /quiet/ })).toBeUndefined()
    await row.unmount()
  }
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

  const band = await $.ui.mount({ plugin: 'multitask', surface: 'desktop', ...BAND })
  expect(await band.find({ text: /^Multitask$/ })).toBeDefined()
  expect((await band.find({ type: 'Svg' }))?.props.alt).toBe('Multitask: off')
  await band.pointer({ type: 'down', x: 1, y: 0, button: 'left', in: 'multitask-switch' })
  await band.pointer({ type: 'up', x: 1, y: 0, button: 'left', in: 'multitask-switch' })
  await band.redraw()
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

test("the voice's thoughts start without a second permission ask; other agents are asked as before", async ($, on) => {
  engine(on)
  const thought = await $.tool.check({ tool: 'Agent', input: { subagent_type: 'multitask:thought', prompt: 'x', description: 'y' } })
  expect(thought.decision).toBe('allow')
  const other = await $.tool.check({ tool: 'Agent', input: { subagent_type: 'general-purpose', prompt: 'x', description: 'y' } })
  expect(other.decision).toBe('ask')
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

test("a thought's card shows its report only while no note is newer", async ($, on) => {
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
  const shown = async () => {
    await pane.redraw()
    return {
      notes: (await pane.findAll({ type: 'Text', text: /^· / })).map(n => n.text),
      report: (await pane.find({ type: 'Markdown' }))?.text,
    }
  }

  await says('u1', 'Checking the token')
  await says('u2', 'The token expires early.')
  await $.turn.complete({ ...finished('agent-1'), answer: 'The token expires early.' })
  await clock.settle()
  await $.ui.press({ plugin: 'multitask', key: 'expand:agent-1' })
  expect(await shown()).toEqual({ notes: ['· Checking the token'], report: 'The token expires early.' })

  // Told more, it works on: its fresh notes show, the old report does not.
  await $.tool.call({ tool: 'mcp__multitask__tell', tool_use_id: 'c2', thought: 'auth-bug', message: 'and refresh?' })
  await says('u3', 'Reading the refresh path')
  expect(await shown()).toEqual({ notes: ['· Checking the token', '· Reading the refresh path'], report: undefined })

  // Its next report shows again.
  await says('u4', 'Refresh is fine.')
  await $.turn.complete({ ...finished('agent-1'), answer: 'Refresh is fine.' })
  await clock.settle()
  expect(await shown()).toEqual({ notes: ['· Checking the token', '· Reading the refresh path'], report: 'Refresh is fine.' })
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
  const terminal = await $.ui.mount({ plugin: 'multitask', surface: 'terminal', ...BAND })
  await terminal.press({ key: 'multitask' })

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
