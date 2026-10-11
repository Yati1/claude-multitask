import type { On } from 'claude-code'
import { expect, mock, test } from 'claude-code/testing'
import type { Engine } from 'claude-code/testing'

import type { ViewRow } from '../types'
import { chunksOf, fingerprintOf, marksOf } from '../hooks/pane'
import { START_POS, advancedPos, compactedPos, withStamps } from '../hooks/summaries'

type Block = { type: string; [field: string]: unknown }

// Where the plugin keeps sessions' files under the test's configuration folder.
const VIEWS = '/config/plugins/data/thread-chat-inline/views'

// The test stands in for the engine beneath the plugin: the mod store (`kept`, seeded with
// `store`), the files it reads and writes (`files`, seeded with `seed`), the context size
// the engine reports (`usage.tokens`, none until set), and the prompts that reach the model,
// each with the notes beside it.
function engine(on: On, store: Record<string, unknown> = {}, seed: Record<string, string> = {}) {
  const kept: Record<string, unknown> = { ...store }
  const files: Record<string, string> = { ...seed }
  const usage: { tokens: number | undefined } = { tokens: undefined }
  const prompts: string[] = []
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
  on('tool.register', ($, e) => ({ value: { tool: `mcp__thread-chat__${e.name}` } }))
  on('command.register', ($, e) => ({ value: { command: e.name } }))
  on('turn.complete', () => ({ text: '' }))
  on('session.compact', () => ({ messages: [{ role: 'user' as const, text: 'the summary', toolUses: [] }] }))
  return { kept, files, usage, prompts }
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
  expect(await summaryTrace($)).toBe(
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
    ].join('\n'),
  )
  usage.tokens = 100_000
  await storer($).done()
  expect(await summaryTrace($)).toContain('  design: 10.0k since its last message')
  expect((kept['session:session-1'] as { tokenPos?: unknown }).tokenPos).toEqual({ pos: 510_000, last: 100_000, epoch: 2 })
})
