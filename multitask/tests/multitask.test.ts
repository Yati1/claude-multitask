import type { On } from 'claude-code'
import { expect, mock, test } from 'claude-code/testing'

import { formatUpdates, isQuiet } from '../hooks/prompts'

type Seen = { prompts: string[]; sends: { to: string; text: string }[]; ran: string[] }

// The test stands in for the engine beneath the plugin, and records what reached it.
function engine(on: On): Seen {
  const seen: Seen = { prompts: [], sends: [], ran: [] }
  on('session.start', ($, e) => ({ cwd: e.cwd }))
  on('agent.register', () => ({ value: { agent: 'multitask:thought' } }))
  on('tool.register', ($, e) => ({ value: { tool: `mcp__multitask__${e.name}` } }))
  on('command.register', ($, e) => ({ value: { command: e.name } }))
  on('ui.open', () => ({ value: { isPlaced: true } }))
  on('ui.message', () => ({}))
  on('ui.render', () => ({ type: 'engine', ref: 0 }))
  // Only the real engine can hand back a spawned agent's id; the agent list stands in.
  on('agent.spawn', () => ({ model: 'test' }))
  on('agent.list', () => ({
    value: [{ id: 'agent-1', description: 'auth-bug', type: 'multitask:thought', status: 'running' }],
  }))
  on('session.send', ($, e) => {
    seen.sends.push({ to: e.to, text: e.text })
    return { isDelivered: true }
  })
  on('prompt.submit', ($, e) => {
    seen.prompts.push(e.text)
    return { text: e.text }
  })
  on('turn.complete', ($, e) => ({ text: e.answer }))
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

test('quiet is exact and updates name their thoughts', async () => {
  expect(isQuiet(' (quiet)\n')).toBe(true)
  expect(isQuiet('(quiet) but also this')).toBe(false)
  const text = formatUpdates([{ thought: 'auth', text: 'found it' }], [])
  expect(text).toContain('## auth (gone)')
  expect(text).toContain('found it')
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
  expect(await band.find({ text: /auth-bug/ })).toBeDefined()

  // What the thought says reaches the voice as one prompt once things go quiet.
  await $.session.append({
    message: { type: 'assistant', role: 'assistant', content: [{ type: 'text', text: 'Token expiry is off by one.' }] },
    door: 'response',
    origin: { kind: 'model', model: 'test' },
    uuid: 'u1',
    agentId: 'agent-1',
  }).catch(() => undefined) // the kit has no transcript to store the row in
  expect(seen.prompts).toHaveLength(0)
  await clock.advance(2500)
  expect(seen.prompts).toHaveLength(1)
  expect(seen.prompts[0]).toContain('## auth-bug (running)')
  expect(seen.prompts[0]).toContain('Token expiry is off by one.')

  // Queued messages wait for the turn to end; one withdrawn never arrives.
  await $.tool.call({ tool: 'mcp__multitask__tell', tool_use_id: 'c3', thought: 'auth-bug', message: 'keep', how: 'queue' })
  await $.tool.call({ tool: 'mcp__multitask__tell', tool_use_id: 'c4', thought: 'auth-bug', message: 'drop', how: 'queue' })
  await band.redraw()
  expect(await band.find({ text: /\+2/ })).toBeDefined()
  await $.tool.call({ tool: 'mcp__multitask__unqueue', tool_use_id: 'c5', thought: 'auth-bug', index: 2 })
  expect(seen.sends).toHaveLength(0)

  await $.turn.complete(finished('agent-1'))
  await clock.settle()
  expect(seen.sends).toEqual([{ to: expect.any(String), text: 'keep' }])

  // Posting reaches it at once.
  await $.tool.call({ tool: 'mcp__multitask__tell', tool_use_id: 'c6', thought: 'auth-bug', message: 'also check refresh' })
  expect(seen.sends.at(-1)?.text).toBe('also check refresh')
})
