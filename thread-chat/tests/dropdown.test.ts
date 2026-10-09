import type { On } from 'claude-code'
import { expect, mock, test } from 'claude-code/testing'
import type { Engine } from 'claude-code/testing'

// The test stands in for the engine beneath the plugin.
function engine(on: On) {
  mock.store(on, {})
  on('session.id', () => ({ value: 'session-1' }))
  on('session.start', ($, e) => ({ cwd: e.cwd }))
  on('prompt.submit', ($, e) => ({ text: e.text }))
  on('tool.register', ($, e) => ({ value: { tool: `mcp__thread-chat__${e.name}` } }))
  on('command.register', ($, e) => ({ value: { command: e.name } }))
  on('ui.render', () => ({ type: 'engine', ref: 0 }))
  on('ui.message', () => ({}))
  on('turn.complete', () => ({ text: '' }))
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

// The row below the input that holds the mode and model.
const MODE = { component: 'SessionMode', props: { modes: [] } } as const

// Thread-chat's dropdown in the band.
const DROPDOWN = 'threads'

const say = (text: string) => ({ text, origin: { kind: 'composer' as const }, wait: false })

const flipThreads = ($: Engine) =>
  $.command.run({ command: 'threads', args: '', origin: { kind: 'composer' }, presentation: {} as never })

type Band = { find: (query: { key: string }) => Promise<{ type: string; props: Record<string, unknown> } | undefined> }

// The dropdown as drawn: the option its face shows, and its rows' labels.
async function dropdownOf(band: Band) {
  const drawn = await band.find({ key: DROPDOWN })
  const options = (drawn?.props.options ?? []) as { value: string; label?: string }[]
  return { type: drawn?.type, value: drawn?.props.value, rows: options.map(o => o.label ?? o.value) }
}

test('thread-chat draws its dropdown in the band, its face reading Threads, and nothing below the input', async ($, on) => {
  engine(on)
  await $.session.start({ cwd: '.', surface: 'desktop', isInteractive: true })
  for (const surface of ['desktop', 'terminal'] as const) {
    const band = await $.ui.mount({ plugin: 'thread-chat', surface, ...BAND })
    expect(await dropdownOf(band)).toEqual({ type: 'Select', value: 'face', rows: ['Threads', 'Threads: off'] })
    // no caption before it: the face says what it is
    expect((await band.find({ key: DROPDOWN }))?.props.label).toBeUndefined()
    await band.unmount()
  }
  const mode = await $.ui.mount({ plugin: 'thread-chat', surface: 'desktop', ...MODE })
  expect(await mode.drawn()).toEqual({ type: 'engine', ref: 0 })
})

test("the dropdown's rows flip threads and the agent switch, and its face stays on Threads", async ($, on) => {
  engine(on)
  await $.session.start({ cwd: '.', surface: 'desktop', isInteractive: true })
  const tool = 'mcp__thread-chat__create_thread'
  const band = await $.ui.mount({ plugin: 'thread-chat', surface: 'desktop', ...BAND })
  const pick = async (value: string) => {
    await band.select({ key: DROPDOWN, value })
    await band.redraw()
  }

  // the face, or the agent switch while threads are off, leaves things be
  await pick('face')
  await pick('agent-threads')
  expect(await dropdownOf(band)).toEqual({ type: 'Select', value: 'face', rows: ['Threads', 'Threads: off'] })
  expect((await $.tool.call({ tool, tool_use_id: 't1', name: 'ideas' })).deny).toContain('off')

  // Threads: off turns them on, as /threads does, and the agent switch joins the list
  await pick('threads')
  expect(await dropdownOf(band)).toEqual({
    type: 'Select',
    value: 'face',
    rows: ['Threads', 'Threads: on', 'Agent may start threads: off'],
  })
  expect(await band.find({ text: /start a thread with # name/ })).toBeDefined()
  expect((await $.tool.call({ tool, tool_use_id: 't2', name: 'ideas' })).deny).toBeDefined()

  // the agent switch lets the agent start threads, and back
  await pick('agent-threads')
  expect((await dropdownOf(band)).rows.at(-1)).toBe('Agent may start threads: on')
  expect((await $.tool.call({ tool, tool_use_id: 't3', name: 'ideas' })).deny).toBeUndefined()
  await pick('agent-threads')
  expect((await dropdownOf(band)).rows.at(-1)).toBe('Agent may start threads: off')

  // Threads: on turns them off
  await pick('threads')
  expect(await dropdownOf(band)).toEqual({ type: 'Select', value: 'face', rows: ['Threads', 'Threads: off'] })
  const reply = await $.command.run({ command: 'merge-threads', args: 'a into b', origin: { kind: 'composer' }, presentation: {} as never })
  expect(reply.text).toBe('Threads are off in this chat; /threads turns them on.')
})

test('the mobile app, which draws no dropdown, shows the threads alone while they are on', async ($, on) => {
  engine(on)
  await $.session.start({ cwd: '.', surface: 'mobile', isInteractive: true })
  const band = await $.ui.mount({ plugin: 'thread-chat', surface: 'mobile', ...BAND })
  expect(await band.drawn()).toEqual({ type: 'engine', ref: 0 })
  await flipThreads($)
  await $.prompt.submit(say('# design\na'))
  await band.redraw()
  expect(await band.find({ key: DROPDOWN })).toBeUndefined()
  expect(await band.find({ key: 'thread:design' })).toBeDefined()
})
