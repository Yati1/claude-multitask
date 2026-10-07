import type { On } from 'claude-code'
import { expect, mock, test } from 'claude-code/testing'

import { closestThread, headingsIn, rewriteHeadings, splitSections } from '../hooks/parse'

// The test stands in for the engine beneath the plugin, and records the prompts
// that reach it, each with the notes beside it.
// `store` seeds the mod store; `null` leaves the store to the test.
function engine(on: On, store: Record<string, unknown> | null = {}): string[] {
  const prompts: string[] = []
  if (store !== null) mock.store(on, store)
  on('session.id', () => ({ value: 'session-1' }))
  on('session.start', ($, e) => ({ cwd: e.cwd }))
  on('prompt.submit', ($, e) => {
    prompts.push([e.text, ...(e.context ?? [])].join('\n--\n'))
    return { text: e.text }
  })
  on('tool.register', ($, e) => ({ value: { tool: `mcp__thread-chat__${e.name}` } }))
  on('command.register', ($, e) => ({ value: { command: e.name } }))
  // The engine draws a message as its text, so a test sees what it was asked to draw.
  on('ui.render', ($, e) => {
    if (e.component !== 'UserMessage' && e.component !== 'AssistantMessage') return { type: 'engine', ref: 0 }
    const { Text } = $.ui.resolve(e)
    return Text({ children: [e.props.text] })
  })
  on('ui.message', () => ({}))
  on('turn.complete', () => ({ text: '' }))
  return prompts
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

const userRow = (text: string) =>
  ({
    component: 'UserMessage',
    props: { text, origin: { kind: 'composer' }, isExpanded: false },
  }) as const

const assistantRow = (text: string) =>
  ({ component: 'AssistantMessage', props: { text, isFirstOfReply: true } }) as const

const say = (text: string) => ({ text, origin: { kind: 'composer' as const }, wait: false })

// A thread's tag in a drawing: its name in capitals on the terminal, a picture elsewhere.
async function tagOf(
  drawing: { findAll: (query: { type?: string }) => Promise<{ props: Record<string, unknown>; text: string }[]> },
  name: string,
) {
  const texts = await drawing.findAll({ type: 'Text' })
  const pictures = await drawing.findAll({ type: 'Svg' })
  return texts.find(t => t.text === name.toUpperCase()) ?? pictures.find(p => p.props.alt === name)
}

test('headings with or without the space open threads; ## and fenced lines do not', async () => {
  const text = ['intro', '# Design', 'a', '## detail', '#perf', 'b', '```', '# not a thread', '```'].join('\n')
  expect(headingsIn(text)).toEqual(['Design', 'perf'])

  const sections = splitSections(text, () => true)
  expect(sections.map(s => s.thread)).toEqual([null, 'Design', 'perf'])
  expect(sections[1]?.text).toContain('## detail')
  expect(sections[2]?.text).toContain('# not a thread')
})

test('a heading that is not a thread drops back to the unthreaded conversation', async () => {
  const known = new Set(['design'])
  const sections = splitSections('# design\nx\n# Summary\ny', name => known.has(name.toLowerCase()))
  expect(sections.map(s => s.thread)).toEqual(['design', null])
  expect(sections[1]?.text).toBe('# Summary\ny')
})

test('a typed name finds the thread it most likely means', async () => {
  const names = ['threads', 'multitasking', 'auth']
  expect(closestThread('Thrads', names)).toBe('threads')
  expect(closestThread('multi', names)).toBe('multitasking')
  expect(closestThread('Multi-Tasking', names)).toBe('multitasking')
  expect(closestThread('multitaskng', names)).toBe('multitasking')
  expect(closestThread('mulitaskin', names)).toBe('multitasking')
  expect(closestThread('perf', names)).toBeUndefined()
  expect(closestThread('aut', ['auth', 'autumn'])).toBeUndefined()

  const fixed = rewriteHeadings('#thrads\nx\n# +ideas\ny\n#auth\nz', raw =>
    raw === 'thrads' ? 'threads' : raw.replace(/^\+/, ''),
  )
  expect(fixed).toBe('# threads\nx\n# ideas\ny\n#auth\nz')
})

test('a mistyped or partial heading means its thread, decided at send and told to the model', async ($, on) => {
  const prompts = engine(on)
  await $.prompt.submit(say('# Threads\na\n# Multitasking\nb'))
  expect(prompts.at(-1)).toBe('# Threads\na\n# Multitasking\nb')

  // the text goes on as typed; a note beside it says what the headings mean
  await $.prompt.submit(say('#thrads\nc\n#multi\nd'))
  expect(prompts.at(-1)).toBe(
    '#thrads\nc\n#multi\nd\n--\nThread headings in this message, as the user meant them: "#thrads" is the thread "Threads"; "#multi" is the thread "Multitasking".',
  )

  await $.prompt.submit(say('#+Thread\ne'))
  expect(prompts.at(-1)).toContain('"#+Thread" starts the new thread "Thread"')
  const band = await $.ui.mount({ plugin: 'thread-chat', surface: 'terminal', ...BAND })
  expect(await band.find({ key: 'thread:thread' })).toBeDefined()
  expect(await band.find({ key: 'thread:thrads' })).toBeUndefined()

  for (const surface of ['terminal', 'desktop'] as const) {
    const row = await $.ui.mount({ plugin: 'thread-chat', surface, ...userRow('#thrads\nc\n#multi\nd') })
    expect(await tagOf(row, 'Threads')).toBeDefined()
    expect(await tagOf(row, 'Multitasking')).toBeDefined()
    await row.unmount()
  }
})

test('a merged thread draws as the one it joined', async ($, on) => {
  engine(on)
  await $.prompt.submit(say('# design\na\n# perf\nb'))
  const merged = await $.command.run({
    command: 'merge-threads',
    args: 'perf into design',
    origin: { kind: 'composer' },
    presentation: {} as never,
  })
  expect(merged.text).toContain('Merged thread "perf" into "design"')

  const band = await $.ui.mount({ plugin: 'thread-chat', surface: 'terminal', ...BAND })
  expect(await band.find({ key: 'thread:perf' })).toBeUndefined()
  const old = await $.ui.mount({ plugin: 'thread-chat', surface: 'terminal', ...assistantRow('# perf\nfast') })
  expect(await tagOf(old, 'design')).toBeDefined()
})

test('the filter shows everything with none picked, and only the picked threads otherwise', async ($, on) => {
  engine(on)
  await $.prompt.submit(say('# design\nhello\n#perf\nfast?'))

  for (const surface of ['terminal', 'desktop'] as const) {
    const band = await $.ui.mount({ plugin: 'thread-chat', surface, ...BAND })
    // A chip on the desktop is clicked; a Button on the terminal is pressed.
    const pick = async (name: string) => {
      if (surface === 'desktop') await band.pointer({ type: 'down', x: 1, y: 0, button: 'left', in: `thread:${name}` })
      else await band.press({ key: `thread:${name}` })
    }

    expect(await band.find({ key: 'thread:design' })).toBeDefined()
    expect(await band.find({ key: 'thread:perf' })).toBeDefined()
    expect(await band.find({ text: /start a thread/ })).toBeUndefined()

    const reply = await $.ui.mount({
      plugin: 'thread-chat',
      surface,
      ...assistantRow('top line\n# design\nuse a queue\n# perf\nit is fine'),
    })
    const plain = await $.ui.mount({ plugin: 'thread-chat', surface, ...assistantRow('just chatting') })
    const mine = await $.ui.mount({ plugin: 'thread-chat', surface, ...userRow('# perf\nmine') })

    expect(await reply.find({ text: /top line/ })).toBeDefined()
    expect(await tagOf(reply, 'perf')).toBeDefined()
    expect(await plain.find({ text: /just chatting/ })).toBeDefined()
    expect(await tagOf(mine, 'perf')).toBeDefined()

    await pick('design')
    for (const row of [reply, plain, mine]) await row.redraw()
    expect(await tagOf(reply, 'design')).toBeDefined()
    expect(await tagOf(reply, 'perf')).toBeUndefined()
    expect(await reply.find({ text: /top line/ })).toBeUndefined()
    expect(await plain.find({ text: /just chatting/ })).toBeUndefined()
    expect(await mine.find({ text: /mine/ })).toBeUndefined()

    await pick('perf')
    for (const row of [reply, mine]) await row.redraw()
    expect(await tagOf(reply, 'perf')).toBeDefined()
    expect(await mine.find({ text: /mine/ })).toBeDefined()

    await pick('design')
    await pick('perf')
    await reply.redraw()
    expect(await reply.find({ text: /top line/ })).toBeDefined()

    for (const site of [band, reply, plain, mine]) await site.unmount()
  }
})

test('with no threads the band says how to start one; the agent switch gates the tool', async ($, on) => {
  engine(on)
  await $.session.start({ cwd: '.', surface: 'desktop', isInteractive: true })
  const tool = 'mcp__thread-chat__create_thread'

  const band = await $.ui.mount({ plugin: 'thread-chat', surface: 'desktop', ...BAND })
  expect(await band.find({ text: /start a thread with # name/ })).toBeDefined()
  expect(await band.find({ type: 'Svg' })).toBeDefined()
  expect(await band.find({ text: /Agent may start threads: off/ })).toBeDefined()

  const refused = await $.tool.call({ tool, tool_use_id: 't1', name: 'ideas' })
  expect(refused.deny).toBeDefined()

  await band.pointer({ type: 'down', x: 1, y: 0, button: 'left', in: 'agent-switch' })
  await band.pointer({ type: 'up', x: 1, y: 0, button: 'left', in: 'agent-switch' })
  const made = await $.tool.call({ tool, tool_use_id: 't2', name: 'ideas' })
  expect(made.deny).toBeUndefined()
  await band.redraw()
  expect(await band.find({ text: /Agent may start threads: on/ })).toBeDefined()
  expect(await band.find({ key: 'thread:ideas' })).toBeDefined()
  expect(await band.find({ text: /start a thread/ })).toBeUndefined()
})

test("the person's message stays the engine's drawing, its headings swapped for tags above", async ($, on) => {
  engine(on)
  const text = 'look at this\n# design\nthe pills are tall\n# perf\nslow'
  await $.prompt.submit(say(text))
  await $.prompt.submit(say('#perf\nstill slow'))

  for (const surface of ['terminal', 'desktop'] as const) {
    const row = await $.ui.mount({ plugin: 'thread-chat', surface, ...userRow(text) })
    expect(await tagOf(row, 'design')).toBeDefined()
    expect(await tagOf(row, 'perf')).toBeDefined()
    // several sections share the bubble: a plain marker starts each thread's part
    expect((await row.find({ type: 'Text', text: /look at this/ }))?.text).toBe(
      'look at this\n\n▸ design\nthe pills are tall\n\n▸ perf\nslow',
    )
    await row.unmount()

    // one thread alone: the heading simply goes
    const single = await $.ui.mount({ plugin: 'thread-chat', surface, ...userRow('#perf\nstill slow') })
    expect((await single.find({ type: 'Text', text: /still slow/ }))?.text).toBe('still slow')
    expect(await tagOf(single, 'perf')).toBeDefined()
    await single.unmount()
  }

  // A filter hands the engine only the picked threads' sections.
  const band = await $.ui.mount({ plugin: 'thread-chat', surface: 'terminal', ...BAND })
  await band.press({ key: 'thread:perf' })
  const row = await $.ui.mount({ plugin: 'thread-chat', surface: 'terminal', ...userRow(text) })
  expect((await row.find({ type: 'Text', text: /slow/ }))?.text).toBe('slow')
  expect(await tagOf(row, 'design')).toBeUndefined()
})

test('a heading snapped at send still draws as its thread where the screen shows it as typed', async ($, on) => {
  engine(on)
  await $.prompt.submit(say('# Threads\na'))
  await $.prompt.submit(say('#thr\nwhy so tall?'))

  for (const surface of ['terminal', 'desktop'] as const) {
    // the desktop shows the message as typed, not as it was sent
    const row = await $.ui.mount({ plugin: 'thread-chat', surface, ...userRow('#thr\nwhy so tall?') })
    expect(await tagOf(row, 'Threads')).toBeDefined()
    expect((await row.find({ type: 'Text', text: /tall/ }))?.text).toBe('why so tall?')
    await row.unmount()
  }

  const band = await $.ui.mount({ plugin: 'thread-chat', surface: 'terminal', ...BAND })
  expect(await band.find({ key: 'thread:thr' })).toBeUndefined()
  await band.press({ key: 'thread:threads' })
  const row = await $.ui.mount({ plugin: 'thread-chat', surface: 'terminal', ...userRow('#thr\nwhy so tall?') })
  expect(await row.find({ type: 'Text', text: /tall/ })).toBeDefined()

  // a heading naming no thread stays as typed
  const stray = await $.ui.mount({ plugin: 'thread-chat', surface: 'terminal', ...userRow('# zz\nhm') })
  await band.press({ key: 'thread:threads' })
  await stray.redraw()
  expect((await stray.find({ type: 'Text', text: /hm/ }))?.text).toBe('# zz\nhm')
})

test('a session keeps its threads and what its headings meant for its next run', async ($, on) => {
  const kept: Record<string, unknown> = {}
  on('store.get', ($, e) => ({ value: kept[e.key] }))
  on('store.set', ($, e) => {
    kept[e.key] = e.value
    return { value: undefined }
  })
  engine(on, null)
  await $.prompt.submit(say('# Threads\na'))
  await $.prompt.submit(say('#thr\nb'))
  const saved = kept['session:session-1'] as { threads: { name: string }[]; snaps: Record<string, string> }
  expect(saved.threads.map(t => t.name)).toEqual(['Threads'])
  expect(saved.snaps).toEqual({ thr: 'threads' })
})

test('a restarted session takes up the threads it kept', async ($, on) => {
  engine(on, {
    'session:session-1': {
      threads: [{ name: 'Threads', color: '#4fa3e0', isSelected: true, createdBy: 'user' }],
      aliases: {},
      snaps: { thr: 'threads' },
    },
  })
  await $.session.start({ cwd: '.', surface: 'desktop', isInteractive: true })
  const band = await $.ui.mount({ plugin: 'thread-chat', surface: 'terminal', ...BAND })
  expect(await band.find({ key: 'thread:threads' })).toBeDefined()
  const row = await $.ui.mount({ plugin: 'thread-chat', surface: 'terminal', ...userRow('#thr\nwhy so tall?') })
  expect(await tagOf(row, 'Threads')).toBeDefined()
})

const toolRow = (id: string) =>
  ({
    component: 'ToolUse',
    requestId: id,
    props: { tool_use_id: id, tool: 'Read', input: {}, isRunning: false, isErrored: false, isInterrupted: false },
  }) as const

const isHidden = async (drawing: { drawn: () => Promise<unknown> }) =>
  ((await drawing.drawn()) as { props?: { display?: string } }).props?.display === 'none'

test('while filtering, rows of no thread show only since the last message', async ($, on) => {
  engine(on)
  await $.prompt.submit(say('# design\nhello'))

  const model = { kind: 'model', model: 'test' } as const
  const stored = (uuid: string, door: 'prompt' | 'response', content: { type: string; [field: string]: unknown }[]) =>
    $.session.append({
      message: door === 'prompt' ? { type: 'user', role: 'user', content } : { type: 'assistant', role: 'assistant', content },
      door,
      origin: door === 'prompt' ? { kind: 'composer' } : model,
      uuid,
    }).catch(() => undefined) // the kit has no transcript to store the row in
  // an earlier exchange
  await stored('p1', 'prompt', [{ type: 'text', text: '# design\nhello' }])
  await stored('a1', 'response', [{ type: 'text', text: 'just chatting' }])
  await stored('a2', 'response', [{ type: 'tool_use', id: 'toolu_old', name: 'Read', input: {} }])
  // the latest
  await stored('p2', 'prompt', [{ type: 'text', text: 'what now?' }])
  await stored('a3', 'response', [{ type: 'tool_use', id: 'toolu_new', name: 'Read', input: {} }])
  await stored('a4', 'response', [{ type: 'text', text: 'here goes\n# design\nnext step' }])

  const mount = <T extends object>(target: T) => $.ui.mount({ plugin: 'thread-chat', surface: 'terminal', ...target } as never)
  const oldChat = await mount({ ...assistantRow('just chatting'), requestId: 'a1' })
  const oldTool = await mount(toolRow('toolu_old'))
  const newTool = await mount(toolRow('toolu_new'))
  const ask = await mount({ ...userRow('what now?'), requestId: 'p2' })
  const reply = await mount({ ...assistantRow('here goes\n# design\nnext step'), requestId: 'a4' })
  const band = await $.ui.mount({ plugin: 'thread-chat', surface: 'terminal', ...BAND })

  // (the kit has no chat to scroll, so the move to its end goes unseen here)
  await band.press({ key: 'thread:design' })

  for (const row of [oldChat, oldTool, newTool, ask, reply]) await row.redraw()
  expect(await oldChat.find({ text: /just chatting/ })).toBeUndefined()
  expect(await isHidden(oldTool)).toBe(true)
  expect(await isHidden(newTool)).toBe(false)
  expect(await ask.find({ text: /what now/ })).toBeDefined()
  expect(await reply.find({ text: /here goes/ })).toBeDefined()
  expect(await tagOf(reply, 'design')).toBeDefined()

  // dropping the filter shows everything again
  await band.press({ key: 'thread:design' })
  for (const row of [oldChat, oldTool]) await row.redraw()
  expect(await oldChat.find({ text: /just chatting/ })).toBeDefined()
  expect(await isHidden(oldTool)).toBe(false)
})
