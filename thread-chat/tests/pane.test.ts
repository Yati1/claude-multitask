import type { On, SessionMessage } from 'claude-code'
import { expect, test } from 'claude-code/testing'

import type { ViewRow } from '../types'
import { markOf, rowsUpTo, viewsKept, withTextKept, withViewRow } from '../hooks/pane'

type Block = { type: string; [field: string]: unknown }

// The test stands in for the engine beneath the plugin, keeping the rows stored
// as the conversation `$.session.messages()` reads (`transcript`, which a test may
// rewrite as a compaction does), and the mod store (`kept`, seeded with `store`).
function engine(on: On, store: Record<string, unknown> = {}) {
  const opened: string[] = []
  const transcript: SessionMessage[] = []
  const kept: Record<string, unknown> = { ...store }
  on('store.get', ($, e) => ({ value: kept[e.key] }))
  on('store.set', ($, e) => {
    kept[e.key] = JSON.parse(JSON.stringify(e.value)) as unknown
    return { value: undefined }
  })
  on('store.delete', ($, e) => {
    delete kept[e.key]
    return { value: undefined }
  })
  on('store.keys', () => ({ value: Object.keys(kept) }))
  on('session.id', () => ({ value: 'session-1' }))
  on('session.start', ($, e) => ({ cwd: e.cwd }))
  on('prompt.submit', ($, e) => ({ text: e.text }))
  on('tool.register', ($, e) => ({ value: { tool: `mcp__thread-chat__${e.name}` } }))
  on('command.register', ($, e) => ({ value: { command: e.name } }))
  on('ui.render', ($, e) => {
    if (e.component !== 'UserMessage' && e.component !== 'AssistantMessage') return { type: 'engine', ref: 0 }
    const { Text } = $.ui.resolve(e)
    return Text({ children: [e.props.text] })
  })
  on('ui.message', () => ({}))
  on('ui.open', ($, e) => {
    opened.push(e.id)
    return { value: { isPlaced: true as const } }
  })
  on('ui.scroll', () => ({}))
  on('turn.complete', () => ({ text: '' }))
  on('session.messages', () => ({ value: [...transcript] }))
  // A row is kept in the transcript; the kit has no store beneath to keep it in, so
  // `next` (which an append hook must call) rejects, and each append catches it.
  on('session.append', ($, e, next) => {
    const role = e.message.role
    if (role !== undefined) {
      const text = e.message.content.flatMap(b => (b.type === 'text' && typeof b.text === 'string' ? [b.text] : [])).join('\n')
      const toolUses = e.message.content.flatMap(b => (b.type === 'tool_use' ? [{ tool_use_id: String(b.id), tool: String(b.name), input: {} }] : []))
      const toolResults = e.message.content.flatMap(b =>
        b.type === 'tool_result' ? [{ tool_use_id: String(b.tool_use_id), text: String(b.content), isError: false }] : [],
      )
      transcript.push({ role, text, toolUses, ...(toolResults.length > 0 ? { toolResults } : {}) } as SessionMessage)
    }
    return next(e)
  })
  return { opened, transcript, kept }
}

const say = (text: string) => ({ text, origin: { kind: 'composer' as const }, wait: false })

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

const PANE = {
  component: 'Pane',
  requestId: 'thread-view',
  props: {
    title: 'Thread view',
    isFocused: false,
    bodyColumns: 80,
    placement: 'dock',
    scroll: { offset: 0, bodyRows: 20 },
    view: {},
  },
} as const

const model = { kind: 'model', model: 'test' } as const

type Drawing = {
  findAll: (query: { type?: string; text?: string | RegExp }) => Promise<{ props: Record<string, unknown>; text: string }[]>
}

// What the view shows, in order: who wrote each section, and its text.
async function sectionsOf(pane: Drawing) {
  const who = (await pane.findAll({ type: 'Text', text: /^(you|Claude)$/ })).map(t => t.text)
  const said = (await pane.findAll({ type: 'Markdown' })).map(m => String(m.props.text))
  return who.map((name, i) => `${name}: ${said[i]}`)
}

test('the thread view shows the picked threads alone, earlier replies too, and no tool rows', async ($, on) => {
  engine(on)
  await $.prompt.submit(say('# design\nhello\n# perf\nfast?'))
  const store = (uuid: string, door: 'prompt' | 'response' | 'tool-result', content: Block[]) =>
    $.session
      .append({
        message:
          door === 'response' ? { type: 'assistant', role: 'assistant', content } : { type: 'user', role: 'user', content },
        door,
        origin: door === 'prompt' ? { kind: 'composer' } : door === 'response' ? model : { kind: 'tool', tool: 'Read' },
        uuid,
      })
      .catch(() => undefined)
  await store('p1', 'prompt', [{ type: 'text', text: '# design\nhello\n# perf\nfast?' }])
  await store('a1', 'response', [{ type: 'text', text: 'on it' }])
  await store('a2', 'response', [{ type: 'tool_use', id: 'toolu_1', name: 'Read', input: {} }])
  await store('t1', 'tool-result', [{ type: 'tool_result', tool_use_id: 'toolu_1', content: 'file contents' }])
  await store('a3', 'response', [{ type: 'text', text: 'the plan\n# design\nuse a queue\n# perf\nit is fine' }])
  await store('p2', 'prompt', [{ type: 'text', text: 'what now?' }])
  await store('a4', 'response', [{ type: 'text', text: '# design\nnext step' }])

  for (const surface of ['terminal', 'desktop'] as const) {
    const pane = await $.ui.mount({ plugin: 'thread-chat', surface, ...PANE })
    // none picked: the whole conversation, without its tool rows
    expect(await sectionsOf(pane)).toEqual([
      'you: hello',
      'you: fast?',
      'Claude: on it',
      'Claude: the plan',
      'Claude: use a queue',
      'Claude: it is fine',
      'you: what now?',
      'Claude: next step',
    ])
    expect(await pane.findAll({ text: /file contents|Read/ })).toEqual([])

    // design picked: its sections alone, before the last message too
    const band = await $.ui.mount({ plugin: 'thread-chat', surface: 'terminal', ...BAND })
    // (no redraw asked for: the pick draws the view again)
    await band.press({ key: 'thread:design' })
    expect(await sectionsOf(pane)).toEqual(['you: hello', 'Claude: use a queue', 'Claude: next step'])
    expect(await pane.find({ type: 'Text', text: /All threads/ })).toBeUndefined()

    // each section's tag; the person's sections carry a marker in the thread's colour
    const tags =
      surface === 'terminal'
        ? (await pane.findAll({ type: 'Text', text: 'DESIGN' })).length
        : (await pane.findAll({ type: 'Svg' })).filter(p => p.props.alt === 'design').length
    expect(tags).toBe(3)
    const markers = (await pane.findAll({ type: 'Box' })).filter(b => b.props.backgroundColor !== undefined)
    expect(markers.map(b => b.props.backgroundColor)).toEqual(['#4fa3e0'])
    // no Client: every overlay on the desktop shares their one frame
    expect(await pane.findAll({ type: 'Client' })).toEqual([])

    await band.press({ key: 'thread:design' })
    for (const site of [band, pane]) await site.unmount()
  }

  // a new reply's row draws the view again
  const pane = await $.ui.mount({ plugin: 'thread-chat', surface: 'terminal', ...PANE })
  await store('a5', 'response', [{ type: 'text', text: '# design\nlater still' }])
  expect((await sectionsOf(pane)).at(-1)).toBe('Claude: later still')
})

test('the view puts a message sent to the one picked thread, and a moved part, where the chat does', async ($, on) => {
  engine(on)
  await $.prompt.submit(say('# design\na\n# perf\nb'))
  const band = await $.ui.mount({ plugin: 'thread-chat', surface: 'terminal', ...BAND })
  await band.press({ key: 'thread:perf' })

  // sent with no heading while perf alone was picked; the note to the model is stored beside it
  await $.prompt.submit(say('and the cache?'))
  const reply = (uuid: string, text: string) =>
    $.session
      .append({
        message: { type: 'assistant', role: 'assistant', content: [{ type: 'text', text }] },
        door: 'response',
        origin: model,
        uuid,
      })
      .catch(() => undefined)
  await $.session
    .append({
      message: {
        type: 'user',
        role: 'user',
        content: [
          { type: 'text', text: 'and the cache?' },
          { type: 'text', text: 'This message belongs to the thread "perf".' },
        ],
      },
      door: 'prompt',
      origin: { kind: 'composer' },
      uuid: 'p9',
    })
    .catch(() => undefined)
  await reply('a9', '# design\nuse a queue')
  await reply('a10', '# design\nnext step')

  const pane = await $.ui.mount({ plugin: 'thread-chat', surface: 'desktop', ...PANE })
  expect(await sectionsOf(pane)).toEqual(['you: and the cache?'])

  // the person moves two reply parts from design to perf, with everything in view;
  // the terminal knows a reply by its row's id, the desktop by its API message's
  await band.press({ key: 'thread:perf' })
  const terminal = await $.ui.mount({
    plugin: 'thread-chat',
    surface: 'terminal',
    component: 'AssistantMessage',
    requestId: 'a9',
    props: { text: '# design\nuse a queue', isFirstOfReply: true },
  })
  await terminal.press({ key: 'tag:design' })
  await terminal.redraw()
  await terminal.press({ key: 'pick:perf' })
  const desktop = await $.ui.mount({
    plugin: 'thread-chat',
    surface: 'desktop',
    component: 'AssistantMessage',
    requestId: 'msg_01abc-t0',
    props: { text: '# design\nnext step', isFirstOfReply: true },
  })
  await desktop.press({ key: 'tag:design' })
  await desktop.redraw()
  await desktop.pointer({ type: 'down', x: 1, y: 0, button: 'left', in: 'pick:perf' } as never)

  await band.press({ key: 'thread:perf' })
  expect(await sectionsOf(pane)).toEqual(['you: and the cache?', 'Claude: use a queue', 'Claude: next step'])
})

test('a long section draws as markdown in pieces a Markdown element takes', async ($, on) => {
  engine(on)
  await $.prompt.submit(say('# design\nhello'))
  // 250 lines of 100 characters, the last without its newline: 24999 characters
  const long = Array.from({ length: 250 }, () => 'x'.repeat(99)).join('\n')
  await $.session
    .append({
      message: { type: 'assistant', role: 'assistant', content: [{ type: 'text', text: `# design\n${long}` }] },
      door: 'response',
      origin: model,
      uuid: 'a1',
    })
    .catch(() => undefined)

  for (const surface of ['terminal', 'desktop'] as const) {
    const pane = await $.ui.mount({ plugin: 'thread-chat', surface, ...PANE })
    // the reply alone is stored, so its pieces are all the Markdown drawn
    const pieces = (await pane.findAll({ type: 'Markdown' })).map(m => String(m.props.text))
    expect(pieces.map(piece => piece.length <= 10000)).toEqual([true, true, true])
    expect(pieces.join('\n') === long).toBe(true)
    await pane.unmount()
  }
})

test('/thread-view and the band button open the view', async ($, on) => {
  const { opened } = engine(on)
  await $.session.start({ cwd: '.', surface: 'desktop', isInteractive: true })
  const ran = await $.command.run({ command: 'thread-view', args: '', origin: { kind: 'composer' }, presentation: {} as never })
  expect(ran.text).toBe('Thread view opened.')
  expect(opened).toEqual(['thread-view'])

  for (const surface of ['terminal', 'desktop'] as const) {
    // the band offers it once there is a thread
    const band = await $.ui.mount({ plugin: 'thread-chat', surface, ...BAND })
    expect(await band.find({ key: 'thread-view' })).toBeUndefined()
    await band.unmount()
  }
  await $.prompt.submit(say('# design\nhello'))
  for (const surface of ['terminal', 'desktop'] as const) {
    const band = await $.ui.mount({ plugin: 'thread-chat', surface, ...BAND })
    await band.press({ key: 'thread-view' })
    await band.unmount()
  }
  expect(opened).toEqual(['thread-view', 'thread-view', 'thread-view'])
})

// A compaction's summary, as the engine stores it and the conversation then reads it.
const SUMMARY = 'This session is being continued from a previous conversation. Summary: hello, and fast?'

const DESIGN = { name: 'design', color: '#4fa3e0', isSelected: false, createdBy: 'user' } as const

test('the view keeps what a compaction summarised away, and never shows the summary', async ($, on) => {
  const { transcript, kept } = engine(on)
  await $.prompt.submit(say('# design\nhello'))
  const store = (uuid: string, door: 'prompt' | 'response' | 'compaction', text: string) =>
    $.session
      .append({
        message:
          door === 'response'
            ? { type: 'assistant', role: 'assistant', content: [{ type: 'text', text }] }
            : { type: 'user', role: 'user', content: [{ type: 'text', text }] },
        door,
        origin: door === 'prompt' ? { kind: 'composer' } : door === 'response' ? model : { kind: 'engine' },
        uuid,
      })
      .catch(() => undefined)
  await store('p1', 'prompt', '# design\nhello')
  await store('a1', 'response', 'on it\n# design\nuse a queue')
  await $.prompt.submit(say('# perf\nfast?'))
  await store('p2', 'prompt', '# perf\nfast?')
  await store('a2', 'response', '# perf\nit is fine')
  // the compaction stores its summary as a row of its own; a row stored again draws once
  await store('s1', 'compaction', SUMMARY)
  await store('a2', 'response', '# perf\nit is fine')
  // the conversation then reads as the summary and the rows it kept
  transcript.splice(
    0,
    transcript.length,
    { role: 'user', text: SUMMARY, toolUses: [] },
    { role: 'user', text: '# perf\nfast?', toolUses: [] },
    { role: 'assistant', text: '# perf\nit is fine', toolUses: [] },
  )

  for (const surface of ['terminal', 'desktop'] as const) {
    const pane = await $.ui.mount({ plugin: 'thread-chat', surface, ...PANE })
    expect(await sectionsOf(pane)).toEqual(['you: hello', 'Claude: on it', 'Claude: use a queue', 'you: fast?', 'Claude: it is fine'])
    expect(await pane.findAll({ text: /continued from a previous/ })).toEqual([])
    expect(await pane.find({ type: 'Text', text: /no longer kept/ })).toBeUndefined()
    await pane.unmount()
  }

  // the rows are kept with their text as the turn ends, for the session's next run
  await $.turn.complete({ answer: '', durationMs: 1, isAborted: false, turnId: 't1', reason: 'answer' })
  const rows = kept['view:session-1'] as ViewRow[]
  expect(rows.map(row => `${row.id}: ${row.text ?? ''}`)).toEqual([
    'p1: # design\nhello',
    'a1: on it\n# design\nuse a queue',
    'p2: # perf\nfast?',
    'a2: # perf\nit is fine',
  ])
})

test('a restarted session draws the rows it kept; rows kept without text draw while the conversation holds them', async ($, on) => {
  const { transcript } = engine(on, {
    'session:session-1': { threads: [DESIGN], aliases: {}, snaps: {} },
    'view:session-1': [
      // kept by an earlier version, without text: one the compaction summarised away,
      // one the conversation still holds, and one with a note for the model beside it
      { id: 'p0', role: 'user', mark: markOf('# design\nlong ago') },
      { id: 'a0', role: 'assistant', mark: markOf('# design\nuse a queue') },
      { id: 'p1', role: 'user', mark: markOf('and?\nThis message belongs to the thread "design".'), typed: 4 },
      // kept with its text
      { id: 'a1', role: 'assistant', mark: markOf('# design\nnext step'), text: '# design\nnext step' },
    ],
  })
  transcript.push(
    { role: 'user', text: SUMMARY, toolUses: [] },
    { role: 'assistant', text: '# design\nuse a queue', toolUses: [] },
    { role: 'user', text: 'and?\nThis message belongs to the thread "design".', toolUses: [] },
  )
  await $.session.start({ cwd: '.', surface: 'desktop', isInteractive: true })

  const pane = await $.ui.mount({ plugin: 'thread-chat', surface: 'terminal', ...PANE })
  expect(await sectionsOf(pane)).toEqual(['Claude: use a queue', 'you: and?', 'Claude: next step'])
  expect(await pane.findAll({ text: /continued from a previous/ })).toEqual([])
  expect((await pane.find({ type: 'Text', text: /no longer kept/ }))?.text).toBe('1 earlier message is no longer kept')
})

test('a rewound session draws the rows of the session it came from up to where it was rewound', async ($, on) => {
  const said = [
    { id: 'p1', role: 'user', text: '# design\nwhy is the band two rows high?' },
    { id: 'a1', role: 'assistant', text: '# design\nIt wraps because both mods share one row.' },
    { id: 'p2', role: 'user', text: '# design\nhow long do the tests take?' },
    // rewound away: the new session holds the rows before these
    { id: 'a2', role: 'assistant', text: '# design\nAbout five seconds in all.' },
    { id: 'p3', role: 'user', text: '# design\nand the store?' },
  ] as const
  const { transcript, kept } = engine(on, {
    'session:old': { threads: [DESIGN], aliases: {}, snaps: {} },
    'view:old': said.map(row => ({ ...row, mark: markOf(row.text) })),
  })
  transcript.push(...said.slice(0, 3).map(row => ({ role: row.role, text: row.text, toolUses: [] })))
  await $.session.start({ cwd: '.', surface: 'desktop', isInteractive: true })

  const pane = await $.ui.mount({ plugin: 'thread-chat', surface: 'terminal', ...PANE })
  expect(await sectionsOf(pane)).toEqual([
    'you: why is the band two rows high?',
    'Claude: It wraps because both mods share one row.',
    'you: how long do the tests take?',
  ])
  expect((kept['view:session-1'] as ViewRow[]).map(row => row.id)).toEqual(['p1', 'a1', 'p2'])
})

test('the store keeps the rows of the sessions kept most recently, within its size', async ($, on) => {
  const big = (id: string, length: number) => [{ id, role: 'assistant', mark: 'x', text: 'x'.repeat(length) }]
  const { kept } = engine(on, { 'view:old1': big('o1', 1_200_000), 'view:old2': big('o2', 700_000) })
  await $.session
    .append({
      message: { type: 'assistant', role: 'assistant', content: [{ type: 'text', text: 'y'.repeat(200_000) }] },
      door: 'response',
      origin: model,
      uuid: 'a1',
    })
    .catch(() => undefined)
  await $.turn.complete({ answer: '', durationMs: 1, isAborted: false, turnId: 't1', reason: 'answer' })

  expect(kept['view:old1']).toBeUndefined()
  expect(kept['view:old2']).toBeDefined()
  expect(kept['view:session-1']).toBeDefined()
  expect((kept.views as { id: string }[]).map(view => view.id)).toEqual(['old2', 'session-1'])
})

test('rows keep their newest texts within a budget, one row per id', async () => {
  const row = (id: string, text: string): ViewRow => ({ id, role: 'assistant', mark: markOf(text), text })
  const rows = [row('a', '12345'), { ...row('b', '67890'), role: 'user' as const, typed: 3 }, row('c', 'abcde')]
  // the newest that fit keep their text; from the first that does not, none older does
  expect(withTextKept(rows, 12)).toEqual([{ id: 'a', role: 'assistant', mark: '12345' }, rows[1], rows[2]])
  expect(withTextKept(rows, 9)).toEqual([
    { id: 'a', role: 'assistant', mark: '12345' },
    { id: 'b', role: 'user', mark: '67890', typed: 3 },
    row('c', 'abcde'),
  ])
  // a row stored again takes its own place, not another
  expect(withViewRow(rows, row('b', 'again')).map(known => `${known.id}: ${known.text ?? ''}`)).toEqual(['a: 12345', 'b: again', 'c: abcde'])

  // the sessions kept longest ago go first; keeping one again makes it the newest
  const index = [
    { id: 'a', size: 100 },
    { id: 'b', size: 100 },
    { id: 'c', size: 100 },
  ]
  expect(viewsKept(index, 'd', 150, 300)).toEqual({
    index: [
      { id: 'c', size: 100 },
      { id: 'd', size: 150 },
    ],
    dropped: ['a', 'b'],
  })
  expect(viewsKept(index, 'a', 50, 300)).toEqual({
    index: [
      { id: 'b', size: 100 },
      { id: 'c', size: 100 },
      { id: 'a', size: 50 },
    ],
    dropped: [],
  })

  // a conversation that holds none of the rows (not read yet) cuts none
  expect(rowsUpTo(rows, [])).toEqual(rows)
})
