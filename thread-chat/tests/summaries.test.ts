import type { On } from 'claude-code'
import { expect, mock, test } from 'claude-code/testing'
import type { Engine } from 'claude-code/testing'

import type { ViewRow } from '../types'
import { chunksOf, fingerprintOf, marksOf } from '../hooks/pane'
import {
  CUT,
  MAX_INPUT_CHARS,
  START_POS,
  advancedPos,
  catchUpNote,
  catchUpPointer,
  compactedPos,
  packParts,
  parsePack,
  readThreadText,
  verbatimOf,
  withStamps,
} from '../hooks/summaries'
import type { SummaryEntry } from '../hooks/summaries'

type Block = { type: string; [field: string]: unknown }

// Where the plugin keeps sessions' files under the test's configuration folder.
const VIEWS = '/config/plugins/data/thread-chat-inline/views'

type ModelRequest = { model: string; prompt: string; system?: string; systemBlocks?: readonly { text: string; cache?: true }[]; maxTokens?: number; effort?: string }
type ModelAnswer =
  | { isAnswered: true; text: string; usage: Usage }
  | { isAnswered: false; reason: 'api-error'; status: number | null; error: string; usage: Usage }
  | { isAnswered: false; reason: 'empty-reply' | 'aborted'; usage: Usage }
type Usage = { input_tokens: number; output_tokens: number; cache_read_input_tokens: number; cache_creation_input_tokens: number }

const USAGE: Usage = { input_tokens: 2000, output_tokens: 500, cache_read_input_tokens: 900, cache_creation_input_tokens: 0 }

// A pack's reply as the summary model writes it, naming the thread in each part.
const packReply = (name: string, n = 1) =>
  `<short>${name} short ${n}</short>
<long>${name} long ${n}</long>
<line>${name} line ${n}</line>`

// The thread a pack's request is for.
const threadOfRequest = (r: ModelRequest) => /^Thread: (.*)$/m.exec(r.prompt)?.[1] ?? ''

// The threads a one-line request is for, in order.
const threadsOfRequest = (r: ModelRequest) => [...r.prompt.matchAll(/^Thread: (.*)$/gm)].map(m => m[1] ?? '')

// Whether a request is for one-line summaries, not a pack.
const isLineRequest = (r: ModelRequest) => (r.system ?? '').includes('one-line summaries')

// The test stands in for the engine beneath the plugin: the mod store (`kept`, seeded with
// `store`), the files it reads and writes (`files`, seeded with `seed`), the context size
// the engine reports (`usage.tokens`, none until set), the prompts that reach the model, each
// with the notes beside it, and the summary model: the packs it was asked for (`requests`),
// each answered by `answer` (a pack's reply naming its thread, unless a test says otherwise),
// or refused where it throws; and the one-line requests (`lineRequests`), each answered by
// `answerLines` (`<name> turn line <n>` for each thread).
function engine(on: On, store: Record<string, unknown> = {}, seed: Record<string, string> = {}) {
  const kept: Record<string, unknown> = { ...store }
  const files: Record<string, string> = { ...seed }
  const usage: { tokens: number | undefined } = { tokens: undefined }
  const prompts: string[] = []
  const registered: string[] = []
  const requests: ModelRequest[] = []
  const lineRequests: ModelRequest[] = []
  const model: { answer: (r: ModelRequest) => ModelAnswer; answerLines: (r: ModelRequest) => ModelAnswer } = {
    answer: r => ({ isAnswered: true, text: packReply(threadOfRequest(r), requests.length), usage: USAGE }),
    answerLines: r => ({
      isAnswered: true,
      text: threadsOfRequest(r)
        .map(name => `<thread name="${name}">${name} turn line ${lineRequests.length}</thread>`)
        .join('\n'),
      usage: { ...USAGE, input_tokens: 600, output_tokens: 60 },
    }),
  }
  const clock = mock.clock(on, { now: 1_000_000 })
  on('model.complete', ($, e) => {
    if (isLineRequest(e)) {
      lineRequests.push(e)
      return { value: model.answerLines(e) as never }
    }
    requests.push(e)
    return { value: model.answer(e) as never }
  })
  mock.env(on, { CLAUDE_CONFIG_DIR: '/config' })
  const pathOf = (path: string) => path.replace(/\\/g, '/').replace(/^[A-Za-z]:/, '')
  on('fs.read', ($, e) => {
    const text = files[pathOf(e.path)]
    if (text === undefined) throw new Error(`ENOENT: ${e.path}`)
    return { value: text }
  })
  on('fs.write', ($, e) => {
    files[pathOf(e.path)] = e.text
    return { value: undefined }
  })
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
  on('session.messages', () => ({ value: [] }))
  on('session.usage', () => ({
    value: { startedAt: 0, context: usage.tokens === undefined ? { window: 1_000_000 } : { tokens: usage.tokens, window: 1_000_000 }, rateLimits: [] },
  }))
  on('prompt.submit', ($, e) => {
    prompts.push([e.text, ...(e.context ?? [])].join('\n--\n'))
    return { text: e.text }
  })
  on('tool.register', ($, e) => {
    registered.push(`${e.name}${e.isDeferred === false ? '' : ' (deferred)'}`)
    return { value: { tool: `mcp__thread-chat__${e.name}` } }
  })
  on('command.register', ($, e) => ({ value: { command: e.name } }))
  on('turn.complete', () => ({ text: '' }))
  on('session.compact', () => ({ messages: [{ role: 'user' as const, text: 'the summary', toolUses: [] }] }))
  on('ui.render', () => ({ type: 'engine', ref: 0 }))
  on('ui.message', () => ({}))
  return { kept, files, usage, prompts, registered, requests, lineRequests, model, clock }
}

const model = { kind: 'model', model: 'test' } as const
type Origin = Parameters<Engine['session']['append']>[0]['origin']

// Stores rows as the engine does: the person's message, Claude's reply, Claude's tool call
// with its result; and ends a turn of the main conversation.
function storer($: Engine) {
  let calls = 0
  const append = (uuid: string, door: 'prompt' | 'response' | 'tool-result', content: Block[], origin: Origin) =>
    $.session
      .append({
        message: door === 'response' ? { type: 'assistant', role: 'assistant', content } : { type: 'user', role: 'user', content },
        door,
        origin,
        uuid,
      })
      .catch(() => undefined)
  return {
    person: (uuid: string, text: string) => append(uuid, 'prompt', [{ type: 'text', text }], { kind: 'composer' }),
    reply: (uuid: string, text: string) => append(uuid, 'response', [{ type: 'text', text }], model),
    call: async (uuid: string) => {
      const id = `toolu_${++calls}`
      await append(uuid, 'response', [{ type: 'tool_use', id, name: 'Bash', input: {} }], model)
      await append(`${uuid}-result`, 'tool-result', [{ type: 'tool_result', tool_use_id: id, content: 'ok' }], { kind: 'tool', tool: 'Bash' })
    },
    done: () => $.turn.complete({ answer: '', durationMs: 1, isAborted: false, turnId: 't1', reason: 'answer' }),
  }
}

const say = (text: string) => ({ text, origin: { kind: 'composer' as const }, wait: false })

const BAND = {
  component: 'AbovePrompt',
  props: { hasSurvey: false, isWorking: false, maxRows: 10, bodyColumns: 100, scroll: { offset: 0, bodyRows: 10 }, view: {} },
} as const

const flipThreads = ($: Engine) => $.command.run({ command: 'threads', args: '', origin: { kind: 'composer' }, presentation: {} as never })

// The summaries part of `/thread-view trace`.
async function summaryTrace($: Engine): Promise<string> {
  const run = await $.command.run({ command: 'thread-view', args: 'trace', origin: { kind: 'composer' }, presentation: {} as never })
  const text = (run as { text?: string }).text ?? ''
  return text.slice(text.indexOf('Thread summaries:'))
}

// A session's rows as the plugin keeps them: its files, and the store's note of them.
function keptAs(id: string, rows: ViewRow[]) {
  const chunks = chunksOf(rows)
  const files = Object.fromEntries(chunks.map((text, i) => [`${VIEWS}/${id}/${i}.jsonl`, text]))
  return { note: { chunks: chunks.map(fingerprintOf) }, files: { ...files, [`${VIEWS}/${id}/marks.txt`]: marksOf(rows) } }
}

test('the token position counts the context growing, never its shrinking, from the first reading', () => {
  let at = advancedPos(START_POS, 20_000)
  expect(at).toEqual({ pos: 0, last: 20_000, epoch: 0 })
  at = advancedPos(at, 50_000)
  expect(at).toEqual({ pos: 30_000, last: 50_000, epoch: 0 })
  // a compaction shrank it: the drop is not counted
  at = advancedPos(compactedPos(at), 12_000)
  expect(at).toEqual({ pos: 30_000, last: 12_000, epoch: 1 })
  at = advancedPos(at, 20_000)
  expect(at).toEqual({ pos: 38_000, last: 20_000, epoch: 1 })
  // no reading leaves it be
  expect(advancedPos(at, undefined)).toBe(at)

  const rows: ViewRow[] = [
    { id: 'a', role: 'user', mark: 'a', pos: 5, epoch: 0 },
    { id: 'b', role: 'assistant', mark: 'b' },
  ]
  expect(withStamps(rows, at)).toEqual([rows[0], { ...rows[1], pos: 38_000, epoch: 1 }])
  const stamped = withStamps(rows, at)
  expect(withStamps(stamped, START_POS)).toBe(stamped)
})

test("each thread is as far behind as Claude's context grew since its last message's turn ended", async ($, on) => {
  const { usage } = engine(on)
  await $.session.start({ cwd: '.', surface: 'desktop', isInteractive: true })
  await flipThreads($)
  const { person, reply, call, done } = storer($)

  usage.tokens = 20_000
  await $.prompt.submit(say('# design\nhello'))
  await person('p1', '# design\nhello')
  await reply('a1', '# design\nhi')
  await done()
  usage.tokens = 50_000
  await $.prompt.submit(say('# perf\nfast?'))
  await person('p2', '# perf\nfast?')
  await call('a2')
  await reply('a3', '# perf\nyes')
  await done()
  // (the threads' one-line summaries are made as each turn ends, so the trace goes on)
  expect(await summaryTrace($)).toStartWith(
    [
      'Thread summaries: token position 30.0k, context 50.0k, 0 compactions; catch up after 75.0k',
      '  design: 30.0k since its last message',
      '  perf: 0 since its last message',
    ].join('\n'),
  )

  // tool output counts as much as words: a big turn in perf puts design past catching up
  usage.tokens = 140_000
  await $.prompt.submit(say('# perf\nmore'))
  await person('p3', '# perf\nmore')
  await call('a4')
  await reply('a5', '# perf\nok')
  await done()
  expect(await summaryTrace($)).toContain('  design: 120.0k since its last message, past catching up')
  expect(await summaryTrace($)).toContain('  perf: 0 since its last message')

  // the context shrinking is not counted back; growing again is
  usage.tokens = 40_000
  await done()
  usage.tokens = 70_000
  await done()
  expect(await summaryTrace($)).toContain('  perf: 30.0k since its last message')

  // after a compaction, every thread is past catching up
  await $.session.compact({ trigger: 'manual', messages: [{ role: 'user', text: 'more', toolUses: [] }] })
  const trace = await summaryTrace($)
  expect(trace).toContain('1 compaction;')
  expect(trace).toContain('  perf: 30.0k since its last message, compacted since, past catching up')
})

test('a restarted session keeps its token position, and rows an earlier version kept count from then', async ($, on) => {
  const rows: ViewRow[] = [
    { id: 'p1', role: 'user', mark: '#designhello', text: '# design\nhello' },
    { id: 'a1', role: 'assistant', mark: '#designhi', text: '# design\nhi' },
  ]
  const { note, files } = keptAs('session-1', rows)
  const record = {
    isOn: true,
    threads: [{ name: 'design', color: '#e06c75', createdBy: 'user' }],
    aliases: {},
    snaps: {},
    current: 'design',
    deleted: [],
    sentTo: {},
    moved: {},
    untold: [],
    briefed: null,
    viewThreads: [],
    tokenPos: { pos: 500_000, last: 90_000, epoch: 2 },
  }
  const { usage, kept } = engine(on, { 'session:session-1': record, 'view:session-1': note }, files)
  await $.session.start({ cwd: '.', surface: 'desktop', isInteractive: true })
  expect(await summaryTrace($)).toBe(
    [
      'Thread summaries: token position 500.0k, context 90.0k, 2 compactions; catch up after 75.0k',
      '  design: 0 since its last message',
      '  model claude-haiku-5-5; no calls yet; read_thread offered',
    ].join('\n'),
  )
  usage.tokens = 100_000
  await storer($).done()
  expect(await summaryTrace($)).toContain('  design: 10.0k since its last message')
  expect((kept['session:session-1'] as { tokenPos?: unknown }).tokenPos).toEqual({ pos: 510_000, last: 100_000, epoch: 2 })
})

const DESIGN = { name: 'design', color: '#e06c75', createdBy: 'user' as const }
const PERF = { name: 'perf', color: '#61afef', createdBy: 'user' as const }
const entry = (id: string, role: 'user' | 'assistant', thread: typeof DESIGN | undefined, text: string): SummaryEntry => ({ id, role, thread, text })

test("the summariser reads a thread's messages, with the message either side from elsewhere and […] for the rest", () => {
  const entries = [
    entry('o1', 'user', undefined, 'unthreaded start'),
    entry('p1', 'user', DESIGN, 'make it blue'),
    entry('a1', 'assistant', DESIGN, 'done, blue'),
    entry('a1', 'assistant', PERF, `perf part of the same reply ${'x'.repeat(500)}`),
    entry('p2', 'user', PERF, 'faster?'),
    entry('a2', 'assistant', PERF, 'yes'),
    entry('p3', 'user', undefined, 'by the way'),
    entry('p4', 'user', DESIGN, 'and green'),
  ]
  const [part] = packParts(entries, 'design')
  expect(part?.lastRow).toBe('p4')
  expect(part?.text).toBe(
    [
      '[context: user, no thread]\nunthreaded start',
      '[user]\nmake it blue',
      '[agent]\ndone, blue',
      `[context: agent, thread "perf"]\nperf part of the same reply ${'x'.repeat(372)} ${CUT}`,
      CUT,
      '[context: user, no thread]\nby the way',
      '[user]\nand green',
    ].join('\n\n'),
  )
  // after a row, from the thread's sections after it
  expect(packParts(entries, 'design', 'a1')[0]?.text).toBe('[context: user, no thread]\nby the way\n\n[user]\nand green')
  expect(packParts(entries, 'design', 'p4')).toEqual([])
  expect(packParts(entries, 'gone')).toEqual([])

  // too long with its neighbours: without them; too long even so: in parts that each fit
  const big = 'y'.repeat(MAX_INPUT_CHARS / 2 - 300)
  const other = 'z'.repeat(1000)
  const long = [
    entry('o0', 'user', PERF, other),
    entry('p1', 'user', DESIGN, big),
    entry('o1', 'user', PERF, other),
    entry('a1', 'assistant', DESIGN, big),
    entry('o2', 'user', PERF, other),
  ]
  const bare = packParts(long, 'design')
  expect(bare).toHaveLength(1)
  expect(bare[0]?.text).toBe(`[user]\n${big}\n\n${CUT}\n\n[agent]\n${big}`)
  const longer = [...long, entry('p2', 'user', DESIGN, big), entry('a2', 'assistant', DESIGN, big)]
  const parts = packParts(longer, 'design')
  expect(parts.length).toBeGreaterThan(1)
  expect(parts.every(p => p.text.length <= MAX_INPUT_CHARS)).toBe(true)
  expect(parts.at(-1)?.lastRow).toBe('a2')
})

test("a pack's reply gives each part it holds; one it lacks is left out", () => {
  expect(parsePack('<short> s </short>\n<long>l\nmore</long><line>a  line\nhere</line>')).toEqual({ short: 's', long: 'l\nmore', line: 'a line here' })
  expect(parsePack('<short>s</short>')).toEqual({ short: 's' })
  expect(parsePack('no tags at all')).toEqual({})
  expect(parsePack(`<line>${'w'.repeat(200)}</line>`).line).toHaveLength(118)
})

// A thread's messages in turns, the context growing by `grow` tokens at each turn's end.
async function talk($: Engine, usage: { tokens: number | undefined }, turns: [string, string, string, string][], grow = 10_000) {
  const { person, reply, done } = storer($)
  for (const [p, said, a, replied] of turns) {
    await $.prompt.submit(say(said))
    await person(p, said)
    await reply(a, replied)
    usage.tokens = (usage.tokens ?? 20_000) + grow
    await done()
  }
}

test("a thread's summary is made ahead, at 80% of catching up, by the summary model, and kept", async ($, on) => {
  const { usage, requests, clock, files } = engine(on)
  await $.session.start({ cwd: '.', surface: 'desktop', isInteractive: true })
  await flipThreads($)
  usage.tokens = 20_000
  await talk($, usage, [
    ['p1', '# design\nmake it blue', 'a1', '# design\ndone, blue'],
    ['p2', '# perf\nfaster?', 'a2', '# perf\nyes'],
  ])
  await clock.settle()
  expect(requests).toHaveLength(0)

  // 59k behind: not yet; 60k: made ahead
  await talk($, usage, [['p3', '# perf\nmore', 'a3', '# perf\nok']], 49_000)
  await clock.settle()
  expect(requests).toHaveLength(0)
  await talk($, usage, [['p4', '# perf\nstill', 'a4', '# perf\nyes']], 1_000)
  await clock.settle()
  expect(requests.map(threadOfRequest)).toEqual(['design'])
  const [ask] = requests
  expect(ask?.model).toBe('claude-haiku-5-5')
  expect(ask?.effort).toBe('low')
  expect(ask?.maxTokens).toBe(4000)
  expect(ask?.systemBlocks).toEqual([{ text: expect.stringContaining('running summary of one thread') as never, cache: true }])
  expect(ask?.prompt).toContain('Previous summary:\n(none)')
  expect(ask?.prompt).toContain('[user]\nmake it blue\n\n[agent]\ndone, blue\n\n[context: user, thread "perf"]\nfaster?')

  const trace = await summaryTrace($)
  expect(trace).toContain('  design: 60.0k since its last message; summary current\n    design line 1')
  expect(trace).toMatch(/\d\d:\d\d:\d\d pack design: 2\.0k in, 900 cache read, 0 cache written, 500 out/)
  const kept = JSON.parse(files[`${VIEWS}/session-1/summaries.json`] ?? '{}') as { summaries: Record<string, { short?: string; coversRow?: string }> }
  expect(kept.summaries.design).toMatchObject({ short: 'design short 1', long: 'design long 1', line: 'design line 1', coversRow: 'a1' })

  // current, it is not made again; a new message, and catching up again, makes it again
  await talk($, usage, [['p5', '# perf\nagain', 'a5', '# perf\nyes']], 5_000)
  await clock.settle()
  expect(requests).toHaveLength(1)
  await talk($, usage, [['p6', '# design\nand green', 'a6', '# design\ngreen']], 61_000)
  await talk($, usage, [['p7', '# perf\nsure', 'a7', '# perf\nyes']], 61_000)
  await clock.settle()
  expect(requests.map(threadOfRequest)).toEqual(['design', 'perf', 'design'])
})

test('a summary call that fails in passing is tried again later; a model refused is tried as haiku, then summaries stop', async ($, on) => {
  const { usage, requests, model, clock } = engine(on)
  await $.session.start({ cwd: '.', surface: 'desktop', isInteractive: true })
  await flipThreads($)
  let overloaded = 2
  model.answer = r =>
    overloaded-- > 0
      ? { isAnswered: false, reason: 'api-error', status: 529, error: 'overloaded', usage: { ...USAGE, input_tokens: 0, output_tokens: 0, cache_read_input_tokens: 0 } }
      : { isAnswered: true, text: packReply(threadOfRequest(r)), usage: USAGE }
  usage.tokens = 20_000
  await talk($, usage, [['p1', '# design\nblue', 'a1', '# design\nok']])
  await talk($, usage, [['p2', '# perf\nfast', 'a2', '# perf\nok']], 70_000)
  await clock.settle()
  expect(requests).toHaveLength(1)
  await clock.advance(5_000)
  expect(requests).toHaveLength(2)
  await clock.advance(30_000)
  expect(requests).toHaveLength(3)
  expect(await summaryTrace($)).toContain('summary current')
  expect(await summaryTrace($)).toContain('calls (2 failed)')

  // the model set refused: haiku in its place; refused too, no more calls this run
  model.answer = r => {
    if (r.model !== 'haiku') throw new Error('model not allowed')
    throw new Error('haiku not allowed either')
  }
  await talk($, usage, [['p3', '# design\ngreen', 'a3', '# design\nok']], 1_000)
  await talk($, usage, [['p4', '# perf\nfaster', 'a4', '# perf\nok']], 70_000)
  await clock.settle()
  const trace = await summaryTrace($)
  expect(trace).toContain('model haiku;')
  expect(trace).toContain('stopped: the model haiku was refused')
  const asked = requests.length
  await talk($, usage, [['p5', '# perf\nmore', 'a5', '# perf\nok']], 90_000)
  await clock.settle()
  expect(requests).toHaveLength(asked)
})

test("a restarted session takes up its threads' summaries from their file", async ($, on) => {
  const rows: ViewRow[] = [
    { id: 'p1', role: 'user', mark: '#designhello', text: '# design\nhello', pos: 0, epoch: 0 },
    { id: 'a1', role: 'assistant', mark: '#designhi', text: '# design\nhi', pos: 0, epoch: 0 },
  ]
  const { note, files } = keptAs('session-1', rows)
  const record = {
    isOn: true,
    threads: [DESIGN],
    aliases: {},
    snaps: {},
    current: 'design',
    deleted: [],
    sentTo: {},
    moved: {},
    untold: [],
    briefed: null,
    viewThreads: [],
    tokenPos: { pos: 0, last: 30_000, epoch: 0 },
  }
  const summary = { name: 'design', short: 'kept short', long: 'kept long', line: 'kept line', coversRow: 'a1', coversPos: 0, madeAt: 5 }
  const { usage, requests, clock } = engine(on, { 'session:session-1': record, 'view:session-1': note }, {
    ...files,
    [`${VIEWS}/session-1/summaries.json`]: JSON.stringify({ summaries: { design: summary } }),
  })
  await $.session.start({ cwd: '.', surface: 'desktop', isInteractive: true })
  usage.tokens = 100_000
  await storer($).done()
  await clock.settle()
  // 70k behind, but its summary is current: no call
  expect(requests).toHaveLength(0)
  expect(await summaryTrace($)).toContain('  design: 70.0k since its last message; summary current\n    kept line')
})

const READ = 'mcp__thread-chat__read_thread'

test('the catch-up note gives a few messages whole, else the summary, marked as a small model\'s, and how to read more', () => {
  const gap = { key: 'design', name: 'design', lastRow: 'a2', gap: 140_400, isCompacted: false }
  const few = [entry('p1', 'user', DESIGN, 'make it blue'), entry('a1', 'assistant', DESIGN, 'done')]
  expect(catchUpNote({ ...gap, lastRow: 'a1' }, undefined, few, READ)).toBe(
    'Catch-up for thread "design": about 140k tokens of other conversation since its last message. Its messages so far:\n[user]\nmake it blue\n\n[agent]\ndone',
  )
  const many = [...few, entry('o1', 'user', PERF, 'other'), entry('p2', 'user', DESIGN, 'w'.repeat(1000)), entry('a2', 'assistant', DESIGN, 'ok')]
  const current = { name: 'design', short: 'Blue, then green; waiting on the user.', coversRow: 'a2' }
  expect(catchUpNote(gap, current, many, READ)).toBe(
    [
      'Catch-up for thread "design": about 140k tokens of other conversation since its last message. Summary written by a small model from the thread\'s messages; it may miss detail:',
      'Blue, then green; waiting on the user.',
      'For the fuller history call mcp__thread-chat__read_thread with {"thread":"design"}.',
    ].join('\n'),
  )
  // an earlier summary, and the messages since it whole; no tool offered, no pointer
  const earlier = { ...current, coversRow: 'p2' }
  expect(catchUpNote({ ...gap, isCompacted: true }, earlier, many, undefined)).toBe(
    [
      'Catch-up for thread "design": the conversation was compacted since its last message. Summary written by a small model from the thread\'s earlier messages; it may miss detail:',
      'Blue, then green; waiting on the user.',
      'Its messages since that summary:\n[agent]\nok',
    ].join('\n'),
  )
  // none yet: its latest messages, the oldest cut where they are many
  const none = catchUpNote(gap, undefined, [...many, entry('p3', 'user', DESIGN, 'v'.repeat(5000))], READ)
  expect(none).toStartWith(`Catch-up for thread "design": about 140k tokens of other conversation since its last message. Its latest messages:\n${CUT}\n\n[user]\nvvv`)
  expect(none).toEndWith(`${CUT}\nFor the fuller history call mcp__thread-chat__read_thread with {"thread":"design"}.`)
  expect(catchUpPointer(gap, READ)).toBe(
    'Thread "design" is behind too: about 140k tokens of other conversation since its last message. For the fuller history call mcp__thread-chat__read_thread with {"thread":"design"}.',
  )

  // read_thread: the long summary and the messages since it
  expect(readThreadText('design', 'design', gap, { ...earlier, long: 'The long story.' }, many)).toBe(
    [
      'Summary of thread "design", written by a small model from its messages; it may miss detail:',
      '',
      'The long story.',
      '',
      'Messages since that summary (oldest first):',
      '',
      '[agent]\nok',
      '',
      '(About 140k tokens of other conversation since its last message.)',
    ].join('\n'),
  )
  expect(readThreadText('design', 'design', undefined, undefined, few)).toBe('Messages of thread "design" (oldest first):\n\n[user]\nmake it blue\n\n[agent]\ndone')
  expect(verbatimOf(many, 'design', undefined, 30)).toEqual({ text: `${CUT}\n\n[agent]\nok`, isCut: true })
})

// The record of a session with threads on, and `design` and `perf` among them.
const recordOn = (extra: Record<string, unknown> = {}) => ({
  isOn: true,
  threads: [DESIGN, PERF],
  aliases: {},
  snaps: {},
  current: '',
  deleted: [],
  sentTo: {},
  moved: {},
  untold: [],
  briefed: { merged: {}, mayCreate: false },
  viewThreads: [],
  ...extra,
})

test('a message to a thread past catching up brings the agent its summary; to one not, nothing', async ($, on) => {
  const { usage, prompts, registered, clock } = engine(on, { 'session:session-1': recordOn() })
  await $.session.start({ cwd: '.', surface: 'desktop', isInteractive: true })
  // threads on as the run started: read_thread is in the tools the model is sent from the start
  expect(registered).toEqual(['read_thread'])
  usage.tokens = 20_000
  await talk($, usage, [
    ['p1', '# design\nmake it blue', 'a1', `# design\n${'done, blue. '.repeat(100)}`],
    ['p2', '# perf\nfaster?', 'a2', '# perf\nyes'],
  ])
  await talk($, usage, [['p3', '# perf\nmore', 'a3', '# perf\nok']], 80_000)
  await clock.settle()

  await $.prompt.submit(say('# perf\nand now?'))
  expect(prompts.at(-1)).toBe('# perf\nand now?')
  await $.prompt.submit(say('# design\nand green'))
  expect(prompts.at(-1)).toBe(
    [
      '# design\nand green',
      '--',
      'Catch-up for thread "design": about 90k tokens of other conversation since its last message. Summary written by a small model from the thread\'s messages; it may miss detail:',
      'design short 1',
      'For the fuller history call mcp__thread-chat__read_thread with {"thread":"design"}.',
    ].join('\n'),
  )
  // sent with no heading to the thread picked above the prompt, likewise
  const band = await $.ui.mount({ plugin: 'thread-chat', surface: 'desktop', ...BAND })
  await band.select({ key: 'thread-picker', value: 'thread:design' })
  await $.prompt.submit(say('and red'))
  expect(prompts.at(-1)).toContain('Catch-up for thread "design"')

  // summaries off in the menu: no note, no call
  await band.press({ key: 'thread-summaries' })
  await $.prompt.submit(say('and red'))
  expect(prompts.at(-1)).not.toContain('Catch-up')
  expect(await summaryTrace($)).toContain('; off in this chat')
})

test('read_thread is offered only as a run starts with threads on, and answers for the main conversation', async ($, on) => {
  const { usage, prompts, registered, requests, clock } = engine(on)
  await $.session.start({ cwd: '.', surface: 'desktop', isInteractive: true })
  // threads come on mid-session: no tool now (the model's tools stay as they were); the
  // note carries the thread's messages and no pointer
  await flipThreads($)
  expect(registered).toEqual([])
  usage.tokens = 20_000
  await talk($, usage, [['p1', '# design\nmake it blue', 'a1', '# design\ndone']])
  await talk($, usage, [['p2', '# perf\nfaster?', 'a2', '# perf\nyes']], 80_000)
  await clock.settle()
  await $.prompt.submit(say('# design\nand green'))
  expect(prompts.at(-1)).toContain('Its messages so far:\n[user]\nmake it blue')
  expect(prompts.at(-1)).not.toContain(READ)

  // the tool, as a run that started with threads on serves it: refused to another agent
  const denied = await $.tool.call({ tool: READ, tool_use_id: 'r1', thread: 'design', agentId: 'fork-1' } as never)
  expect((denied as { deny?: string }).deny).toContain('another agent')
  // design, summarised ahead, by its summary; perf, just written in, word for word
  const read = await $.tool.call({ tool: READ, tool_use_id: 'r2', thread: 'desgn' } as never)
  expect(JSON.stringify(read)).toContain('Summary of thread \\"design\\"')
  const recent = await $.tool.call({ tool: READ, tool_use_id: 'r5', thread: '# Perf' } as never)
  expect(JSON.stringify(recent)).toContain('Messages of thread \\"perf\\" (oldest first)')
  const unknown = await $.tool.call({ tool: READ, tool_use_id: 'r3', thread: 'nothing like it' } as never)
  expect(JSON.stringify(unknown)).toContain('No thread is named \\"nothing like it\\". Threads: \\"design\\", \\"perf\\".')

  // a long thread with no current summary has one made as it is read
  const asked = requests.length
  await talk($, usage, [['p3', `# perf\n${'q'.repeat(20_000)}`, 'a3', '# perf\nnoted']], 1_000)
  const long = await $.tool.call({ tool: READ, tool_use_id: 'r4', thread: 'perf' } as never)
  expect(requests.length).toBe(asked + 1)
  expect(JSON.stringify(long)).toContain('perf long')
})

test("a compaction starting has every thread's summary made, and after it every thread is caught up on", async ($, on) => {
  const { usage, prompts, requests, clock } = engine(on, { 'session:session-1': recordOn() })
  await $.session.start({ cwd: '.', surface: 'desktop', isInteractive: true })
  usage.tokens = 20_000
  await talk($, usage, [
    ['p1', '# design\nmake it blue', 'a1', `# design\n${'done, blue. '.repeat(100)}`],
    ['p2', '# perf\nfaster?', 'a2', `# perf\n${'yes, faster. '.repeat(100)}`],
  ])
  await clock.settle()
  expect(requests).toHaveLength(0)

  // a precompute, or a subagent's compaction, makes none
  await $.session.compact({ trigger: 'precompute', messages: [{ role: 'user', text: 'old', toolUses: [] }] })
  await $.session.compact({ trigger: 'auto', agentId: 'sub-1', messages: [{ role: 'user', text: 'old', toolUses: [] }] })
  await clock.settle()
  expect(requests).toHaveLength(0)

  await $.session.compact({ trigger: 'auto', messages: [{ role: 'user', text: 'old', toolUses: [] }] })
  await clock.settle()
  expect(requests.map(threadOfRequest).sort()).toEqual(['design', 'perf'])
  await $.prompt.submit(say('# perf\nand now?'))
  expect(prompts.at(-1)).toContain(
    'Catch-up for thread "perf": the conversation was compacted since its last message. Summary written by a small model from the thread\'s messages; it may miss detail:\nperf short',
  )
})

test("each turn's threads get their one-line summaries in one call, from their line so far and the turn's messages", async ($, on) => {
  const { usage, lineRequests, clock } = engine(on, { 'session:session-1': recordOn() })
  await $.session.start({ cwd: '.', surface: 'desktop', isInteractive: true })
  usage.tokens = 20_000
  await talk($, usage, [['p1', '# design\nmake it blue\n# perf\nfaster?', 'a1', '# design\nblue\n# perf\nyes']])
  await clock.settle()
  expect(lineRequests.map(threadsOfRequest)).toEqual([['design', 'perf']])
  const [first] = lineRequests
  expect(first?.systemBlocks?.[0]?.cache).toBe(true)
  expect(first?.maxTokens).toBe(1500)
  expect(first?.prompt).toBe(
    [
      'Thread: design\nCurrent line: (none)\nLatest summary: (none)\nNewest messages (oldest first):\n[user]\nmake it blue\n\n[agent]\nblue',
      'Thread: perf\nCurrent line: (none)\nLatest summary: (none)\nNewest messages (oldest first):\n[user]\nfaster?\n\n[agent]\nyes',
    ].join('\n\n---\n\n'),
  )
  expect(await summaryTrace($)).toContain('  design: 0 since its last message\n    design turn line 1')

  // the next turn, perf alone: from its line so far
  await talk($, usage, [['p2', '# perf\nhow fast?', 'a2', '# perf\ntwice']])
  await clock.settle()
  expect(lineRequests.at(-1)?.prompt).toBe(
    'Thread: perf\nCurrent line: perf turn line 1\nLatest summary: (none)\nNewest messages (oldest first):\n[user]\nhow fast?\n\n[agent]\ntwice',
  )
  // a turn in no thread (none picked above the prompt): no call
  const band = await $.ui.mount({ plugin: 'thread-chat', surface: 'desktop', ...BAND })
  await band.select({ key: 'thread-picker', value: 'none' })
  await talk($, usage, [['p3', 'thanks', 'a3', 'you are welcome']])
  await clock.settle()
  expect(lineRequests).toHaveLength(2)
})

test("the band's line shows the picked thread's one-line summary, or the latest turn's thread's, while its switch is on", async ($, on) => {
  const { usage, clock } = engine(on, { 'session:session-1': recordOn() })
  await $.session.start({ cwd: '.', surface: 'desktop', isInteractive: true })
  usage.tokens = 20_000
  await talk($, usage, [
    ['p1', '# design\nmake it blue', 'a1', '# design\nblue'],
    ['p2', '# perf\nfaster?', 'a2', '# perf\nyes'],
  ])
  await clock.settle()
  for (const surface of ['terminal', 'desktop'] as const) {
    const band = await $.ui.mount({ plugin: 'thread-chat', surface, ...BAND })
    // off at first
    expect(await band.find({ key: 'summary-line-row' })).toBeUndefined()
    if ((await band.find({ key: 'summary-line' })) === undefined) {
      await band.press({ key: 'threads' })
      await band.redraw()
    }
    await band.press({ key: 'summary-line' })
    await band.redraw()
    // no thread picked: the thread the latest turn touched
    expect((await band.find({ key: 'summary-line-row' }))?.text).toBe('perf turn line 1')
    await band.select({ key: 'thread-picker', value: 'thread:design' })
    await band.redraw()
    expect((await band.find({ key: 'summary-line-row' }))?.text).toBe('design turn line 1')
    await band.press({ key: 'summary-line' })
    await band.redraw()
    expect(await band.find({ key: 'summary-line-row' })).toBeUndefined()
    await band.select({ key: 'thread-picker', value: 'none' })
    await band.unmount()
  }
})
