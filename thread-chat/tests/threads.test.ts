import type { On } from 'claude-code'
import { expect, mock, test } from 'claude-code/testing'

import { markOf } from '../hooks/pane'
import { PALETTE, closestThread, headingsIn, rewriteHeadings, splitSections } from '../hooks/parse'

// The test stands in for the engine beneath the plugin, and records the prompts
// that reach it, each with the notes beside it.
// `store` seeds the mod store; `null` leaves the store to the test. A message whose
// text `isHidden` names is drawn as nothing, as a plugin beneath (multitask) may.
function engine(on: On, store: Record<string, unknown> | null = {}, isHidden: (text: string) => boolean = () => false): string[] {
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
    const { Box, Text } = $.ui.resolve(e)
    if (isHidden(e.props.text)) return Box({ display: 'none' })
    return Text({ children: [e.props.text] })
  })
  on('ui.message', () => ({}))
  on('turn.complete', () => ({ text: '' }))
  on('session.compact', () => ({ messages: [{ role: 'user' as const, text: 'the summary', toolUses: [] }] }))
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
  // the first threads bring how threads work, once, beside the message
  expect(prompts.at(-1)).toStartWith('# Threads\na\n# Multitasking\nb\n--\n# Conversation threads\n')
  expect(prompts.at(-1)).toContain('Threads so far: "Threads", "Multitasking".')

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

test('the model is told how threads work once, of merges and the agent switch as they change, and all again after a compaction', async ($, on) => {
  const prompts = engine(on)
  await $.session.start({ cwd: '.', surface: 'terminal', isInteractive: true })
  // With no threads there is nothing to tell.
  await $.prompt.submit(say('hello'))
  expect(prompts.at(-1)).toBe('hello')
  await $.prompt.submit(say('# design\na\n# perf\nb'))
  expect(prompts.at(-1)).toContain('\n--\n# Conversation threads\n')
  await $.prompt.submit(say('more'))
  expect(prompts.at(-1)).toBe('more')

  // A merge and the agent switch reach the model beside the next message, once.
  await $.command.run({ command: 'merge-threads', args: 'perf into design', origin: { kind: 'composer' }, presentation: {} as never })
  const band = await $.ui.mount({ plugin: 'thread-chat', surface: 'terminal', ...BAND })
  await band.press({ key: 'agent-may-create' })
  await $.prompt.submit(say('next'))
  const changed = prompts.at(-1) ?? ''
  expect(changed).toStartWith('next\n--\nThe threads changed. Threads so far: "design".')
  expect(changed).toContain('"perf" is now "design"')
  expect(changed).toContain('You may start a new thread')
  expect(changed).not.toContain('# Conversation threads')
  await $.prompt.submit(say('and then'))
  expect(prompts.at(-1)).toBe('and then')

  // A compaction may summarise it away: all of it again, once.
  await $.session.compact({ trigger: 'manual', messages: [{ role: 'user', text: 'more', toolUses: [] }] })
  await $.prompt.submit(say('where were we'))
  expect(prompts.at(-1)).toContain('# Conversation threads')
  expect(prompts.at(-1)).toContain('"perf" is now "design"')
  await $.prompt.submit(say('go on'))
  expect(prompts.at(-1)).toBe('go on')
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

test("a plugin's prompt is not the person's, though the desktop names its row theirs", async ($, on) => {
  engine(on)
  // As the engine stores a plugin's prompt, and as the desktop shows it: framed.
  const framed =
    'The multitask plugin sent a message:\nThought updates. Reply (quiet) unless something here needs you.\n\n## voice-tone (idle)\nfound it'
  const drawRow = async (text: string) => {
    const row = await $.ui.mount({
      plugin: 'thread-chat',
      surface: 'desktop',
      component: 'UserMessage',
      props: { text, origin: { kind: 'sdk' }, isExpanded: false },
    })
    const plusThread = await row.find({ type: 'Button', key: 'tag:' })
    const drawn = (await row.drawn()) as { type: string }
    await row.unmount()
    return { plusThread, drawn }
  }
  // the person's own message offers "+ thread"; the plugin's is the engine's drawing alone
  expect((await drawRow('hello')).plusThread).toBeDefined()
  const relay = await drawRow(framed)
  expect(relay.plusThread).toBeUndefined()
  expect(relay.drawn.type).toBe('Text')
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

test('a rewound session, under a new id, takes up the threads of the session it came from', async ($, on) => {
  const said = ['# Threads\nwhy is the band two rows high?', 'It wraps because both mods share one row.', '# Meta\nhow long do the tests take?']
  const rows = (texts: string[]) => texts.map((text, i) => ({ id: `row-${i}`, role: 'user', mark: markOf(text) }))
  const store: Record<string, unknown> = {
    'session:old': {
      threads: [
        { name: 'Threads', color: '#4fa3e0', isSelected: false, createdBy: 'user' },
        { name: 'Meta', color: '#9b6fd6', isSelected: false, createdBy: 'user' },
      ],
      aliases: { threading: 'threads' },
      snaps: {},
    },
    'view:old': rows(said),
    'session:unrelated': { threads: [{ name: 'Elsewhere', color: '#58b36b', isSelected: false, createdBy: 'user' }] },
    'view:unrelated': rows(['a different conversation altogether', 'with nothing in common at all']),
  }
  engine(on, store)
  on('session.messages', () => ({ value: said.map(text => ({ role: 'user' as const, text, toolUses: [] })) }))
  await $.session.start({ cwd: '.', surface: 'desktop', isInteractive: true })

  const band = await $.ui.mount({ plugin: 'thread-chat', surface: 'terminal', ...BAND })
  expect(await band.find({ key: 'thread:threads' })).toBeDefined()
  expect(await band.find({ key: 'thread:meta' })).toBeDefined()
  expect(await band.find({ key: 'thread:elsewhere' })).toBeUndefined()
  const row = await $.ui.mount({ plugin: 'thread-chat', surface: 'terminal', ...userRow('# Threading\nstill means Threads') })
  expect(await tagOf(row, 'Threads')).toBeDefined()
})

test('a reload joins the threads saved for the session to those it holds', async ($, on) => {
  const kept: Record<string, unknown> = {}
  on('store.get', ($, e) => ({ value: kept[e.key] }))
  on('store.set', ($, e) => {
    kept[e.key] = e.value
    return { value: undefined }
  })
  on('store.keys', () => ({ value: Object.keys(kept) }))
  engine(on, null)
  await $.session.start({ cwd: '.', surface: 'desktop', isInteractive: true })
  await $.prompt.submit(say('# Fresh\nx'))
  // A restored record put back for the session while it runs.
  kept['session:session-1'] = {
    threads: [
      { name: 'Threads', color: '#4fa3e0', isSelected: false, createdBy: 'user' },
      { name: 'Meta', color: '#9b6fd6', isSelected: false, createdBy: 'user' },
    ],
    aliases: {},
    snaps: {},
  }
  await $.session.start({ cwd: '.', surface: 'desktop', isInteractive: true })
  const saved = kept['session:session-1'] as { threads: { name: string }[] }
  expect(saved.threads.map(t => t.name)).toEqual(['Threads', 'Meta', 'Fresh'])
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
  await stored('a5', 'response', [{ type: 'text', text: 'one more thing' }])

  const mount = <T extends object>(target: T) => $.ui.mount({ plugin: 'thread-chat', surface: 'terminal', ...target } as never)
  const oldChat = await mount({ ...assistantRow('just chatting'), requestId: 'a1' })
  const oldTool = await mount(toolRow('toolu_old'))
  const newTool = await mount(toolRow('toolu_new'))
  const ask = await mount({ ...userRow('what now?'), requestId: 'p2' })
  const reply = await mount({ ...assistantRow('here goes\n# design\nnext step'), requestId: 'a4' })
  // the desktop knows a reply by its API message's id, so it is matched by its text
  const aside = await mount({ ...assistantRow('one more thing'), requestId: 'msg_01abc-t0' })
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
  await aside.redraw()
  expect(await aside.find({ text: /one more thing/ })).toBeDefined()

  // dropping the filter shows everything again
  await band.press({ key: 'thread:design' })
  for (const row of [oldChat, oldTool]) await row.redraw()
  expect(await oldChat.find({ text: /just chatting/ })).toBeDefined()
  expect(await isHidden(oldTool)).toBe(false)
})

test('with one thread picked, a message with no heading goes to that thread', async ($, on) => {
  const prompts = engine(on)
  await $.prompt.submit(say('# design\nhello\n# perf\nfast?'))
  const band = await $.ui.mount({ plugin: 'thread-chat', surface: 'terminal', ...BAND })
  await band.press({ key: 'thread:perf' })

  await $.prompt.submit(say('and the cache?'))
  expect(prompts.at(-1)).toContain('This message belongs to the thread "perf"')
  await $.session
    .append({
      message: { type: 'user', role: 'user', content: [{ type: 'text', text: 'and the cache?' }] },
      door: 'prompt',
      origin: { kind: 'composer' },
      uuid: 'p9',
    })
    .catch(() => undefined) // the kit has no transcript to store the row in

  const row = await $.ui.mount({ plugin: 'thread-chat', surface: 'terminal', ...userRow('and the cache?'), requestId: 'p9' })
  expect(await tagOf(row, 'perf')).toBeDefined()
  // it belongs to perf alone: picking design instead hides it
  await band.press({ key: 'thread:perf' })
  await band.press({ key: 'thread:design' })
  await row.redraw()
  expect(await row.find({ text: /cache/ })).toBeUndefined()

  // with two picked, a message with no heading stays unthreaded
  await band.press({ key: 'thread:perf' })
  await $.prompt.submit(say('both?'))
  expect(prompts.at(-1)).toBe('both?')
})

test('a reply to a selected part of a reply goes to the thread that part is in', async ($, on) => {
  const prompts = engine(on)
  // The transcript the plugin reads replies from, oldest first; the desktop's
  // selection is of the drawn text, its Markdown marks and link targets gone.
  on('session.messages', () => ({
    value: [
      { role: 'user', text: '# design\na\n# perf\nb', toolUses: [] },
      { role: 'assistant', text: '# design\nit is fast to draw', toolUses: [] },
      {
        role: 'assistant',
        text: 'intro words\n# design\nthe pills are **invisible** on light\n# perf\nit is fast enough\n\nsee [the profile](docs/profile.md)\nfor more',
        toolUses: [],
      },
    ],
  }))
  await $.prompt.submit(say('# design\na\n# perf\nb'))
  const note = (name: string) =>
    `This message belongs to the thread "${name}": the user replied to part of your message in that thread. Reply under that thread's heading.`

  // the desktop's marker and quote, then the person's words
  const reply = '<!-- reply 1 -->\n> invisible on light\n\nThis is a test of replying'
  await $.prompt.submit(say(reply))
  expect(prompts.at(-1)).toBe(`${reply}\n--\n${note('design')}`)
  await $.session
    .append({
      message: { type: 'user', role: 'user', content: [{ type: 'text', text: reply }] },
      door: 'prompt',
      origin: { kind: 'composer' },
      uuid: 'q1',
    })
    .catch(() => undefined) // the kit has no transcript to store the row in
  for (const surface of ['terminal', 'desktop'] as const) {
    const row = await $.ui.mount({ plugin: 'thread-chat', surface, ...userRow(reply), requestId: 'q1' })
    expect(await tagOf(row, 'design')).toBeDefined()
    // the engine draws it as sent: the desktop still shows its quote
    expect((await row.find({ type: 'Text', text: /invisible/ }))?.text).toBe(reply)
    await row.unmount()
  }

  // the newest reply holding the quote decides; two quotes from one thread agree,
  // one across a link and a line break; a quote found nowhere is passed over
  const two = '<!-- reply 3 -->\n> it is fast\n\nsure?\n\n<!-- reply -->\n> see the profile for more\n\nwhere?\n\n<!-- reply -->\n> not said\n\nhm'
  await $.prompt.submit(say(two))
  expect(prompts.at(-1)).toBe(`${two}\n--\n${note('perf')}`)

  // a quote wins over the one picked thread
  const band = await $.ui.mount({ plugin: 'thread-chat', surface: 'terminal', ...BAND })
  await band.press({ key: 'thread:design' })
  await $.prompt.submit(say('<!-- reply 1 -->\n> fast enough\n\nreally?'))
  expect(prompts.at(-1)).toContain(note('perf'))
  await band.press({ key: 'thread:design' })

  // quotes from different threads speak to both, so the message goes to neither;
  // so does a quote of text in no thread, or found nowhere
  for (const text of [
    '<!-- reply 2 -->\n> invisible\n\nfix it\n\n<!-- reply -->\n> fast enough\n\nreally?',
    '<!-- reply 1 -->\n> intro words\n\nwhy?',
    '<!-- reply 1 -->\n> never written\n\nwhy?',
  ]) {
    await $.prompt.submit(say(text))
    expect(prompts.at(-1)).toBe(text)
  }

  // a heading of the message's own decides, as ever
  const headed = '<!-- reply 1 -->\n> invisible\n\n# perf\nabout speed'
  await $.prompt.submit(say(headed))
  expect(prompts.at(-1)).toBe(headed)
})

test('a reply of several sections draws one by the engine and the rest as markdown', async ($, on) => {
  engine(on)
  await $.prompt.submit(say('# design\na\n# perf\nb'))
  const reply = await $.ui.mount({
    plugin: 'thread-chat',
    surface: 'desktop',
    ...assistantRow('# design\nuse a queue\n# perf\nit is fine'),
  })
  expect(await reply.find({ type: 'Text', text: /use a queue/ })).toBeDefined()
  const markdown = await reply.findAll({ type: 'Markdown' })
  expect(markdown.map(m => m.props.text)).toEqual(['it is fine'])
  expect(await tagOf(reply, 'perf')).toBeDefined()
})

test('the pill of the one picked thread shows that messages with no heading go there', async ($, on) => {
  engine(on)
  await $.prompt.submit(say('# design\na\n# perf\nb'))
  const desktop = await $.ui.mount({ plugin: 'thread-chat', surface: 'desktop', ...BAND })
  const terminal = await $.ui.mount({ plugin: 'thread-chat', surface: 'terminal', ...BAND })
  const marked = async () => ({
    desktop: (await desktop.findAll({ type: 'Svg' })).filter(p => /go here/.test(String(p.props.alt))).map(p => p.props.alt),
    terminal: (await terminal.findAll({ type: 'Button' })).filter(b => /➤/.test(String(b.props.label))).map(b => b.props.label),
  })

  expect(await marked()).toEqual({ desktop: [], terminal: [] })
  await terminal.press({ key: 'thread:perf' })
  await desktop.redraw()
  await terminal.redraw()
  expect(await marked()).toEqual({ desktop: ['perf: messages with no heading go here'], terminal: ['perf ➤'] })

  await terminal.press({ key: 'thread:design' })
  await desktop.redraw()
  await terminal.redraw()
  expect(await marked()).toEqual({ desktop: [], terminal: [] })
})

test('a message or a reply part moves to another thread from its tag, and the model is told', async ($, on) => {
  const prompts = engine(on)
  await $.prompt.submit(say('# design\na\n# perf\nb'))
  const click = (drawing: { pointer: (p: never) => Promise<unknown> }, key: string) =>
    drawing.pointer({ type: 'down', x: 1, y: 0, button: 'left', in: key } as never)

  // the person's message, on the desktop: its tag's button opens the picker; a pill moves it
  const mine = await $.ui.mount({ plugin: 'thread-chat', surface: 'desktop', ...userRow('# design\nhi'), requestId: 'u1' })
  expect(await mine.find({ key: 'pick:perf' })).toBeUndefined()
  await mine.press({ key: 'tag:design' })
  await mine.redraw()
  expect(await mine.find({ key: 'pick:perf' })).toBeDefined()
  expect(await mine.find({ key: 'pick:design' })).toBeUndefined()
  await click(mine, 'pick:perf')
  await mine.redraw()
  expect(await tagOf(mine, 'perf')).toBeDefined()
  expect(await tagOf(mine, 'design')).toBeUndefined()
  expect(await mine.find({ key: 'pick:perf' })).toBeUndefined()

  // a message of no thread offers "+ thread"
  const plain = await $.ui.mount({ plugin: 'thread-chat', surface: 'desktop', ...userRow('plain words'), requestId: 'u2' })
  await plain.press({ key: 'tag:' })
  await plain.redraw()
  await click(plain, 'pick:design')
  await plain.redraw()
  expect(await tagOf(plain, 'design')).toBeDefined()

  // a part of a reply, on the terminal, moves to no thread
  const reply = await $.ui.mount({ plugin: 'thread-chat', surface: 'terminal', ...assistantRow('# design\nuse a queue'), requestId: 'r1' })
  expect(await tagOf(reply, 'design')).toBeDefined()
  await reply.press({ key: 'tag:design' })
  await reply.redraw()
  await reply.press({ key: 'pick:' })
  await reply.redraw()
  expect(await tagOf(reply, 'design')).toBeUndefined()
  expect(await reply.find({ text: /use a queue/ })).toBeDefined()

  // the moves reach the model beside the next message, once
  await $.prompt.submit(say('next'))
  expect(prompts.at(-1)).toContain('The user moved their message "hi" from the thread "design" to the thread "perf".')
  expect(prompts.at(-1)).toContain('The user moved their message "plain words" from no thread to the thread "design".')
  expect(prompts.at(-1)).toContain('The user moved part of your reply "use a queue" from the thread "design" to no thread.')
  await $.prompt.submit(say('again'))
  expect(prompts.at(-1)).toBe('again')
})

test('the move picker starts a new thread from a typed name, even with no threads yet', async ($, on) => {
  const prompts = engine(on)
  const fillOf = async (drawing: Parameters<typeof tagOf>[0], name: string) =>
    /fill="(#[0-9a-f]+)"/.exec(String((await tagOf(drawing, name))?.props.source))?.[1]

  // with no threads, a message and a reply of no thread still offer "+ thread"
  const mine = await $.ui.mount({ plugin: 'thread-chat', surface: 'desktop', ...userRow('plain words'), requestId: 'u1' })
  const reply = await $.ui.mount({ plugin: 'thread-chat', surface: 'desktop', ...assistantRow('plain reply'), requestId: 'r1' })
  for (const row of [mine, reply]) expect(await row.find({ type: 'Button', key: 'tag:' })).toBeDefined()

  const click = (drawing: { pointer: (p: never) => Promise<unknown> }, key: string) =>
    drawing.pointer({ type: 'down', x: 1, y: 0, button: 'left', in: key } as never)

  // its picker holds just the "+" pill, a plain outline with no dot; "+" swaps it for
  // the field, in the same row, and "×" swaps back
  await mine.press({ key: 'tag:' })
  await mine.redraw()
  const plus = await mine.findAll({ type: 'Svg' })
  expect(plus.map(p => p.props.alt)).toEqual(['new thread'])
  expect(String(plus[0]?.props.source)).not.toContain('stroke-dasharray')
  expect(String(plus[0]?.props.source)).not.toContain('<circle')
  expect(await mine.find({ key: 'new-thread' })).toBeUndefined()
  await click(mine, 'pick-new')
  await mine.redraw()
  expect(await mine.findAll({ type: 'Svg' })).toHaveLength(0)
  expect((await mine.find({ key: 'new-thread' }))?.props.autoFocus).toBe(true)
  await mine.press({ key: 'pick-cancel' })
  await mine.redraw()
  expect(await mine.find({ key: 'new-thread' })).toBeUndefined()
  expect(await mine.find({ key: 'pick-new' })).toBeDefined()

  // a blank name starts nothing and leaves the field open
  await click(mine, 'pick-new')
  await mine.redraw()
  await mine.input({ key: 'new-thread', text: '   ' })
  await mine.redraw()
  expect(await mine.find({ key: 'new-thread' })).toBeDefined()

  // a name starts the thread in the next colour, and the message moves into it
  await mine.input({ key: 'new-thread', text: 'ideas' })
  await mine.redraw()
  expect(await mine.find({ key: 'new-thread' })).toBeUndefined()
  expect(await fillOf(mine, 'ideas')).toBe(PALETTE[0])

  // a reply's part: beside the pill of the thread that now exists, a heading's `#+` is dropped
  await reply.redraw()
  await reply.press({ key: 'tag:' })
  await reply.redraw()
  expect(await reply.find({ key: 'pick:ideas' })).toBeDefined()
  await click(reply, 'pick-new')
  await reply.redraw()
  await reply.input({ key: 'new-thread', text: '#+ later on' })
  await reply.redraw()
  expect(await fillOf(reply, 'later on')).toBe(PALETTE[1])

  // a name that is already a thread's moves there and starts no other
  const more = await $.ui.mount({ plugin: 'thread-chat', surface: 'desktop', ...userRow('more words'), requestId: 'u2' })
  await more.press({ key: 'tag:' })
  await more.redraw()
  await click(more, 'pick-new')
  await more.redraw()
  await more.input({ key: 'new-thread', text: 'Ideas' })
  await more.redraw()
  expect(await tagOf(more, 'ideas')).toBeDefined()
  const band = await $.ui.mount({ plugin: 'thread-chat', surface: 'desktop', ...BAND })
  expect((await band.findAll({ type: 'Svg' })).map(p => p.props.alt).slice(0, -1)).toEqual(['ideas', 'later on'])

  // the terminal's picker has the "+" and its field too; mobile draws neither
  const terminal = await $.ui.mount({ plugin: 'thread-chat', surface: 'terminal', ...assistantRow('# ideas\nx'), requestId: 'r2' })
  await terminal.press({ key: 'tag:ideas' })
  await terminal.redraw()
  await terminal.press({ key: 'pick-new' })
  await terminal.redraw()
  expect(await terminal.find({ key: 'new-thread' })).toBeDefined()
  const mobile = await $.ui.mount({ plugin: 'thread-chat', surface: 'mobile', ...assistantRow('# ideas\nx'), requestId: 'r3' })
  await mobile.press({ key: 'tag:ideas' })
  await mobile.redraw()
  expect(await mobile.find({ key: 'pick:' })).toBeDefined()
  expect(await mobile.find({ key: 'pick-new' })).toBeUndefined()
  expect(await mobile.find({ key: 'new-thread' })).toBeUndefined()

  // the model is told of each new thread with the move
  await $.prompt.submit(say('next'))
  expect(prompts.at(-1)).toContain('The user moved their message "plain words" from no thread to the new thread "ideas" they started for it.')
  expect(prompts.at(-1)).toContain('The user moved part of your reply "plain reply" from no thread to the new thread "later on" they started for it.')
  expect(prompts.at(-1)).toContain('The user moved their message "more words" from no thread to the thread "ideas".')
})

type Drawn ={ type?: string; props?: Record<string, unknown>; hover?: Record<string, unknown>; children?: unknown[] }

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

// The "+ thread" button of a part of no thread.
const isAddThread = (n: Drawn) => n.type === 'Button' && n.props?.label === '+ thread'

// Where a drawing's "+ thread" sits against the part it is for, seen from where
// their branches part: before it, in flow (an absolute Box is laid over its
// parent, the part included), in a branch of a fixed height, revealed by hover.
function addPlacement(tree: unknown, part: RegExp) {
  const add = pathTo(tree, isAddThread)
  const text = pathTo(tree, n => n.type === 'Text' && part.test((n.children ?? []).join('')))
  if (add === undefined || text === undefined) return undefined
  let at = 0
  while (add[at] === text[at]) at++
  const siblings = add[at - 1]?.children ?? []
  const own = add.slice(at)
  return {
    isAbove: siblings.indexOf(add[at]) < siblings.indexOf(text[at]),
    isLaidOver: own.some(n => n.props?.position === 'absolute'),
    hasRoom: typeof add[at]?.props?.height === 'number',
    isRevealed: own.some(n => n.props?.display === 'none' && n.hover?.display === 'flex'),
  }
}

test('"+ thread" has a row of its own above the part it is for, never over it', async ($, on) => {
  engine(on)
  await $.prompt.submit(say('# design\na'))
  const kept = { isAbove: true, isLaidOver: false, hasRoom: true, isRevealed: true }

  const plain = await $.ui.mount({ plugin: 'thread-chat', surface: 'desktop', ...userRow('plain words') })
  expect(addPlacement(await plain.drawn(), /plain words/)).toEqual(kept)

  // beside a tag, it takes the side away from the edge, so showing it moves no tag
  const mixed = await $.ui.mount({ plugin: 'thread-chat', surface: 'desktop', ...userRow('look\n# design\nthis') })
  const tree = await mixed.drawn()
  expect(addPlacement(tree, /look/)).toEqual(kept)
  const row = pathTo(tree, isAddThread)?.at(-4)?.children ?? []
  const shown = (child: unknown) => pathTo(child, n => n.type === 'Svg' || isAddThread(n))?.at(-1)?.props
  expect(row.flatMap(child => shown(child)?.alt ?? shown(child)?.label ?? [])).toEqual([
    '+ thread',
    'design',
  ])

  const reply = await $.ui.mount({ plugin: 'thread-chat', surface: 'desktop', ...assistantRow('plain reply') })
  expect(addPlacement(await reply.drawn(), /plain reply/)).toEqual(kept)
})

// What a drawing puts round its row: a "+ thread", and a Box of a fixed height (room for one).
function chromeIn(tree: unknown) {
  return {
    hasAdd: pathTo(tree, isAddThread) !== undefined,
    hasRoom: pathTo(tree, n => n.type === 'Box' && typeof n.props?.height === 'number') !== undefined,
  }
}

const noChrome = { hasAdd: false, hasRoom: false }

// A row the desktop names the person's that another party sent.
const sdkRow = (text: string) =>
  ({ component: 'UserMessage', props: { text, origin: { kind: 'sdk' }, isExpanded: false } }) as const

type Row = ReturnType<typeof userRow> | ReturnType<typeof assistantRow> | ReturnType<typeof sdkRow>

// The multitask plugin's relay of its thoughts' updates, as it now words it.
const RELAY = 'Thought updates:\nvoice-tone: found it\nperf (done): it is fine'

test('a row with nothing of its own to show gets no "+ thread" and no room for one', async ($, on) => {
  // Beneath, a plugin draws some rows as nothing, as the multitask plugin draws "(quiet)".
  engine(on, {}, text => text === 'hidden by a plugin')
  await $.prompt.submit(say('# design\na'))
  const chromeOf = async (row: Row) => {
    const drawing = await $.ui.mount({ plugin: 'thread-chat', surface: 'desktop', ...row })
    const chrome = chromeIn(await drawing.drawn())
    await drawing.unmount()
    return chrome
  }
  const blank: Row[] = [
    // the voice saying nothing
    assistantRow('(quiet)'),
    assistantRow('  (quiet)\n'),
    // a relay: framed as the desktop holds it, under another origin or the person's, or bare
    sdkRow(`The multitask plugin sent a message:\r\n${RELAY}`),
    userRow(`The multitask plugin sent a message while you were working:\n${RELAY}`),
    userRow(RELAY),
    userRow('Thought updates. Reply (quiet) unless something here needs you.\n\n## voice-tone (idle)\nfound it'),
    // no words
    userRow(''),
    userRow('  \n'),
    assistantRow(''),
    assistantRow('\n\n'),
    // drawn as nothing beneath
    userRow('hidden by a plugin'),
    assistantRow('hidden by a plugin'),
  ]
  for (const row of blank) expect({ text: row.props.text, ...(await chromeOf(row)) }).toEqual({ text: row.props.text, ...noChrome })

  // the person's own words that start as a relay does are still theirs
  expect(await chromeOf(userRow('Thought updates: none today'))).toEqual({ hasAdd: true, hasRoom: true })

  // of a reply, the part of no thread drawn as nothing goes; its thread's part stays
  const mixed = await $.ui.mount({
    plugin: 'thread-chat',
    surface: 'desktop',
    ...assistantRow('hidden by a plugin\n# design\nuse a queue'),
  })
  expect(chromeIn(await mixed.drawn())).toEqual(noChrome)
  expect(await tagOf(mixed, 'design')).toBeDefined()
  expect(await mixed.find({ text: /use a queue/ })).toBeDefined()
})

test('while filtering, a quiet, relay or empty row from before the last message draws nothing', async ($, on) => {
  engine(on)
  await $.prompt.submit(say('# design\na'))
  const band = await $.ui.mount({ plugin: 'thread-chat', surface: 'terminal', ...BAND })
  await band.press({ key: 'thread:design' })
  const rows: Row[] = [assistantRow('(quiet)'), assistantRow(''), userRow(RELAY), sdkRow(RELAY), userRow(''), userRow('plain words')]
  for (const row of rows) {
    const drawing = await $.ui.mount({ plugin: 'thread-chat', surface: 'desktop', ...row, requestId: 'old' })
    expect({ text: row.props.text, isHidden: await isHidden(drawing) }).toEqual({ text: row.props.text, isHidden: true })
    expect(chromeIn(await drawing.drawn())).toEqual(noChrome)
    await drawing.unmount()
  }
})

// The pictures under `node`, by alt, in drawing order.
function picturesIn(node: unknown): string[] {
  if (typeof node !== 'object' || node === null) return []
  const n = node as Drawn
  if (n.type === 'Svg') return [String(n.props?.alt)]
  return (n.children ?? []).flatMap(picturesIn)
}

// Where a drawing's open move picker sits against the part it is for, seen as
// addPlacement sees "+ thread", and the pictures in its branch: its pills, and
// the tag it sits beside.
function pickerPlacement(tree: unknown, part: RegExp) {
  const picker = pathTo(tree, n => n.type === 'Text' && (n.children ?? []).join('') === 'move to')
  const text = pathTo(tree, n => n.type === 'Text' && part.test((n.children ?? []).join('')))
  if (picker === undefined || text === undefined) return undefined
  let at = 0
  while (picker[at] === text[at]) at++
  const siblings = picker[at - 1]?.children ?? []
  return {
    isAbove: siblings.indexOf(picker[at]) < siblings.indexOf(text[at]),
    isLaidOver: picker.slice(at).some(n => n.props?.position === 'absolute'),
    isFixed: typeof picker[at]?.props?.height === 'number',
    pictures: picturesIn(picker[at]),
  }
}

test('the move picker opens at the top of its part, beside its tag or in place of "+ thread"', async ($, on) => {
  engine(on)
  await $.prompt.submit(say('# design\na\n# perf\nb'))
  const open = async (drawing: { press: (p: { key: string }) => Promise<unknown>; redraw: () => Promise<unknown> }, key: string) => {
    await drawing.press({ key })
    await drawing.redraw()
  }
  const inFlow = { isAbove: true, isLaidOver: false, isFixed: false }

  // the person's message: the picker sits left of its tag, on the right
  const mine = await $.ui.mount({ plugin: 'thread-chat', surface: 'desktop', ...userRow('# design\nhi'), requestId: 'u1' })
  await open(mine, 'tag:design')
  expect(pickerPlacement(await mine.drawn(), /hi/)).toEqual({ ...inFlow, pictures: ['perf', 'none', 'new thread', 'design'] })

  // a message of no thread: the picker takes the row "+ thread" held
  const plain = await $.ui.mount({ plugin: 'thread-chat', surface: 'desktop', ...userRow('plain words'), requestId: 'u2' })
  await open(plain, 'tag:')
  expect(pickerPlacement(await plain.drawn(), /plain words/)).toEqual({ ...inFlow, pictures: ['design', 'perf', 'new thread'] })

  // a reply's thread part: inside its border, after its tag
  const part = await $.ui.mount({ plugin: 'thread-chat', surface: 'desktop', ...assistantRow('# design\nuse a queue'), requestId: 'r1' })
  await open(part, 'tag:design')
  expect(pickerPlacement(await part.drawn(), /use a queue/)).toEqual({ ...inFlow, pictures: ['design', 'perf', 'none', 'new thread'] })

  // a reply's part of no thread: where its "+ thread" was
  const loose = await $.ui.mount({ plugin: 'thread-chat', surface: 'desktop', ...assistantRow('plain reply'), requestId: 'r2' })
  await open(loose, 'tag:')
  expect(pickerPlacement(await loose.drawn(), /plain reply/)).toEqual({ ...inFlow, pictures: ['design', 'perf', 'new thread'] })

  // the terminal draws it at the top too, its tag a capitals Text, not a picture
  const terminal = await $.ui.mount({ plugin: 'thread-chat', surface: 'terminal', ...assistantRow('# perf\nit is fine'), requestId: 'r3' })
  await terminal.press({ key: 'tag:perf' })
  await terminal.redraw()
  expect(pickerPlacement(await terminal.drawn(), /it is fine/)).toEqual({ ...inFlow, pictures: [] })
})

test('a tag\'s "▾" sits right after its name, alike in messages and replies', async ($, on) => {
  engine(on)
  await $.prompt.submit(say('# design\na'))
  const rows = [
    await $.ui.mount({ plugin: 'thread-chat', surface: 'desktop', ...userRow('# design\nhi'), requestId: 'u1' }),
    await $.ui.mount({ plugin: 'thread-chat', surface: 'desktop', ...assistantRow('# design\nuse a queue'), requestId: 'r1' }),
  ]
  for (const row of rows) {
    const path = pathTo(await row.drawn(), n => n.type === 'Button' && n.props?.label === '▾')
    const box = path?.at(-2)
    // the tag and its "▾" side by side with no gap, the tag's picture ending where its name does
    expect(box?.props?.columnGap).toBe(0)
    const [tag, button] = box?.children as Drawn[]
    expect(button?.props?.label).toBe('▾')
    const source = String(tag?.props?.source)
    const textLength = Number(/textLength="([\d.]+)"/.exec(source)?.[1])
    // set from its start edge, the picture's room left of the text is its inset alone
    const inset = /text-anchor="end"/.test(source) ? 0 : Number(/<text x="([\d.]+)"/.exec(source)?.[1])
    expect(Number(tag?.props?.width) - inset).toBe(textLength + 1)
  }
})

test('the "none" pill has no dot and a dashed outline; off the desktop it is dim', async ($, on) => {
  engine(on)
  await $.prompt.submit(say('# design\na\n# perf\nb'))

  const desktop = await $.ui.mount({ plugin: 'thread-chat', surface: 'desktop', ...assistantRow('# design\nx'), requestId: 'r1' })
  await desktop.press({ key: 'tag:design' })
  await desktop.redraw()
  const pictures = await desktop.findAll({ type: 'Svg' })
  const none = String(pictures.find(p => p.props.alt === 'none')?.props.source)
  const perf = String(pictures.find(p => p.props.alt === 'perf')?.props.source)
  expect([/<circle/.test(none), /stroke-dasharray/.test(none)]).toEqual([false, true])
  expect([/<circle/.test(perf), /stroke-dasharray/.test(perf)]).toEqual([true, false])

  const terminal = await $.ui.mount({ plugin: 'thread-chat', surface: 'terminal', ...assistantRow('# design\nx'), requestId: 'r2' })
  await terminal.press({ key: 'tag:design' })
  await terminal.redraw()
  expect((await terminal.find({ key: 'pick:' }))?.props.dimColor).toBe(true)
  expect((await terminal.find({ key: 'pick:perf' }))?.props.dimColor).toBeUndefined()
})

test("a reply part's border pads it alike on every side, and its tag meets its text", async ($, on) => {
  engine(on)
  await $.prompt.submit(say('# design\na\n# perf\nb'))
  const text = '# design\nuse a queue\n# perf\nit is fine'
  // The padding props of each thread border, so a lone shorthand shows every side alike.
  const paddingOf = async (drawing: { findAll: (query: { type?: string }) => Promise<{ props: Record<string, unknown> }[]> }) =>
    (await drawing.findAll({ type: 'Box' }))
      .filter(box => box.props.borderStyle === 'round')
      .map(box => Object.fromEntries(Object.entries(box.props).filter(([k]) => k.startsWith('padding'))))

  // the desktop sets all four sides as one; the terminal, whose rows are whole lines, only the sides
  const desktop = await $.ui.mount({ plugin: 'thread-chat', surface: 'desktop', ...assistantRow(text) })
  expect(await paddingOf(desktop)).toEqual([{ padding: 1 }, { padding: 1 }])
  const terminal = await $.ui.mount({ plugin: 'thread-chat', surface: 'terminal', ...assistantRow(text) })
  expect(await paddingOf(terminal)).toEqual([{ paddingX: 1 }, { paddingX: 1 }])

  // the engine's part has the prose's inset, so its tag moves in to meet it; a markdown part's does not
  const tagX = async (name: string) => /<text x="([\d.]+)"/.exec(String((await tagOf(desktop, name))?.props.source))?.[1]
  expect([await tagX('design'), await tagX('perf')]).toEqual(['5', '0'])
})

// Every Client of a plugin shares one frame on the desktop, which is torn down for all
// of them when one is slow to draw: a transcript's rows must not add one per message.
test('a long desktop transcript draws Clients only in the band and the one open picker', async ($, on) => {
  engine(on)
  await $.prompt.submit(say('# design\na\n# perf\nb'))
  const threadCount = 2
  const users = ['plain words', '# design\nhi', 'look\n# perf\nthis']
  const replies = ['plain reply', '# design\nuse a queue', 'intro\n# design\nx\n# perf\ny']
  const rows: {
    redraw: () => Promise<unknown>
    press: (target: { key: string }) => Promise<unknown>
    findAll: (query: { type: string }) => Promise<unknown[]>
  }[] = []
  for (let i = 0; i < 60; i++) {
    const row = i % 2 === 0 ? userRow(users[i % 3] ?? '') : assistantRow(replies[i % 3] ?? '')
    rows.push(await $.ui.mount({ plugin: 'thread-chat', surface: 'desktop', ...row, requestId: `row${i}` }))
  }
  const clientsInRows = async () => {
    let count = 0
    for (const row of rows) {
      await row.redraw()
      count += (await row.findAll({ type: 'Client' })).length
    }
    return count
  }
  expect(await clientsInRows()).toBe(0)

  // the band: one per thread and the agent switch
  const band = await $.ui.mount({ plugin: 'thread-chat', surface: 'desktop', ...BAND })
  expect(await band.findAll({ type: 'Client' })).toHaveLength(threadCount + 1)

  // an open picker adds its pills, at most one per thread and "none"; opening another closes it
  await rows[1]?.press({ key: 'tag:design' })
  expect(await clientsInRows()).toBeLessThanOrEqual(threadCount + 1)
  await rows[0]?.press({ key: 'tag:' })
  expect(await clientsInRows()).toBeLessThanOrEqual(threadCount + 1)
})

// Every element of a drawing, outermost first.
function elementsOf(node: unknown): Drawn[] {
  if (typeof node !== 'object' || node === null) return []
  const n = node as Drawn
  return [n, ...(n.children ?? []).flatMap(elementsOf)]
}

// How two branches of a drawing size in the row they share: from the Box where
// their paths part, the child each one is drawn under.
function shareOf(a: Drawn[] | undefined, b: Drawn[] | undefined) {
  if (a === undefined || b === undefined) return undefined
  let at = 0
  while (a[at] === b[at]) at++
  return { row: a[at - 1]?.props, a: a[at]?.props, b: b[at]?.props }
}

const isPill = (n: Drawn) => String(n.props?.key ?? '').startsWith('thread:')

test('the band keeps one row with 12 threads beside another mod, and nothing the pointer shows takes room', async ($, on) => {
  // another mod's controls, drawn beneath, as multitask's are
  on('ui.render', { component: 'AbovePrompt' }, ($, e) => {
    const { Box, Text } = $.ui.resolve(e)
    return Box({ flexDirection: 'row', children: [Text({ children: ['other mod'] })] })
  })
  engine(on)
  const names = ['threads', 'multitasking', 'design', 'perf', 'auth', 'billing', 'search', 'onboarding', 'analytics', 'docs', 'release', 'security']
  await $.prompt.submit(say(names.map(n => `# ${n}\nx`).join('\n')))
  const isOther = (n: Drawn) => n.type === 'Text' && (n.children ?? []).join('') === 'other mod'

  for (const surface of ['desktop', 'terminal'] as const) {
    const band = await $.ui.mount({ plugin: 'thread-chat', surface, ...BAND })
    const tree = await band.drawn()
    const all = elementsOf(tree)
    expect(all.filter(isPill)).toHaveLength(12)
    const pill = pathTo(tree, isPill)
    const other = pathTo(tree, isOther)
    const controls = [surface === 'desktop' ? 'agent-switch' : 'agent-may-create', 'thread-view'].map(key =>
      pathTo(tree, n => n.props?.key === key),
    )

    // the other mod shares the row and keeps its width; the threads give way
    expect(shareOf(pill, other)).toMatchObject({ a: { flexShrink: 1, minWidth: 0 }, b: { flexShrink: 0 } })
    expect(shareOf(pill, other)?.row?.flexWrap).toBeUndefined()
    // so does each control, after the threads
    for (const control of controls) {
      expect(shareOf(pill, control)).toMatchObject({ a: { flexShrink: 1, minWidth: 0 }, b: { flexShrink: 0 } })
      expect(shareOf(pill, control)?.row?.flexWrap).toBeUndefined()
    }
    const wrapping = all.filter(n => n.props?.flexWrap === 'wrap' || n.props?.flexWrap === 'wrap-reverse')
    if (surface === 'desktop') {
      // nothing wraps: the pills clip where the room ends
      expect(wrapping).toEqual([])
      expect(pill?.find(n => n.props?.overflow === 'hidden')?.props).toMatchObject({ flexShrink: 1, minWidth: 0 })
    } else {
      // the terminal wraps the pills alone, in their own part of the row
      expect(wrapping.every(n => elementsOf(n).every(m => !isOther(m) && !controls.some(c => c?.includes(m))))).toBe(true)
    }

    // every Box the pointer reveals is out of the flow, so showing it moves nothing
    const reveals = all.filter(n => n.hover?.display === 'flex')
    expect(reveals.filter(n => n.props?.position !== 'absolute')).toEqual([])
    if (surface === 'desktop') expect(reveals).toHaveLength(2)
    await band.unmount()
  }
})
