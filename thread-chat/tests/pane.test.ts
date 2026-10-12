import type { On, SessionMessage } from 'claude-code'
import { expect, mock, test } from 'claude-code/testing'
import type { Engine } from 'claude-code/testing'

import type { ViewImage, ViewRow } from '../types'
import { PALETTE } from '../hooks/parse'
import {
  EARLIER_KEY,
  FILTER_THREAD_KEY,
  PICTURE_CHARS_DRAWN,
  chunksOf,
  dataFolderOf,
  drawnFromOf,
  fingerprintOf,
  grownOffsetOf,
  isKeptView,
  isNearEnd,
  markOf,
  marksOf,
  messagesBefore,
  nudgeOf,
  picturesNear,
  reactionOn,
  rowsOfChunks,
  rowsUpTo,
  viewMoveOf,
  viewPlaceOf,
  withViewRow,
} from '../hooks/pane'

type Block = { type: string; [field: string]: unknown }

// Where the plugin keeps sessions' view rows under the test's configuration folder:
// the test loads it from its folder, as it is.
const VIEWS = '/config/plugins/data/thread-chat-inline/views'

// The test stands in for the engine beneath the plugin, keeping the rows stored
// as the conversation `$.session.messages()` reads (`transcript`, which a test may
// rewrite as a compaction does), the mod store (`kept`, seeded with `store`), and
// the files it reads and writes (`files`, seeded with `seed`; `writes` the paths
// written, in order), binary files as base64 (`bytes`), and the commands it runs
// (`runs`): PowerShell makes each picture it is given smaller, a JPEG (`THUMB`).
function engine(on: On, store: Record<string, unknown> = {}, seed: Record<string, string> = {}) {
  const opened: string[] = []
  const closed: string[] = []
  const transcript: SessionMessage[] = []
  const kept: Record<string, unknown> = { ...store }
  const files: Record<string, string> = { ...seed }
  const bytes: Record<string, string> = {}
  const writes: string[] = []
  const runs: { argv: readonly string[]; env: Record<string, string> }[] = []
  // the moves the plugin's scroll hook passes on
  const scrolls: { offset: number }[] = []
  mock.env(on, { CLAUDE_CONFIG_DIR: '/config' })
  // the engine hands a path on resolved (on Windows, `C:\config\...`)
  const pathOf = (path: string) => path.replace(/\\/g, '/').replace(/^[A-Za-z]:/, '')
  on('fs.read', ($, e) => {
    if (e.as === 'bytes') {
      const base64 = bytes[pathOf(e.path)]
      if (base64 === undefined) throw new Error(`ENOENT: ${e.path}`)
      return { value: { base64 } }
    }
    const text = files[pathOf(e.path)]
    if (text === undefined) throw new Error(`ENOENT: ${e.path}`)
    return { value: text }
  })
  on('fs.write', ($, e) => {
    files[pathOf(e.path)] = e.text
    writes.push(pathOf(e.path))
    return { value: undefined }
  })
  on('fs.stat', ($, e) => {
    const base64 = bytes[pathOf(e.path)]
    const text = files[pathOf(e.path)]
    if (base64 === undefined && text === undefined) throw new Error(`ENOENT: ${e.path}`)
    const size = base64 === undefined ? (text ?? '').length : Math.floor((base64.length * 3) / 4)
    return { value: { kind: 'file' as const, size, mtimeMs: 1000, isLink: false } }
  })
  on('fs.exists', ($, e) => ({ value: bytes[pathOf(e.path)] !== undefined || files[pathOf(e.path)] !== undefined }))
  on('process.run', ($, e) => {
    const env = e.init?.env ?? {}
    runs.push({ argv: e.argv, env })
    const jobs = JSON.parse(env.THREAD_CHAT_THUMBS ?? '[]') as { from: string; to: string }[]
    for (const job of jobs) if (bytes[pathOf(job.from)] !== undefined) bytes[pathOf(job.to)] = THUMB
    return { value: { exitCode: 0, stdout: '', stderr: '', isStdoutTruncated: false, isStderrTruncated: false } }
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
  on('ui.close', ($, e) => {
    closed.push(e.id)
    return { value: undefined }
  })
  on('ui.scroll', ($, e) => {
    scrolls.push(e)
    return {}
  })
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
  return { opened, closed, transcript, kept, files, bytes, writes, runs, scrolls }
}

// The rows a session's files hold, as the store notes them.
function rowsIn(kept: Record<string, unknown>, files: Record<string, string>, id: string): ViewRow[] {
  const note = kept[`view:${id}`]
  if (!isKeptView(note)) throw new Error(`no note of ${id}'s rows: ${JSON.stringify(note)}`)
  return rowsOfChunks(note.chunks.map((print, i) => {
    const text = files[`${VIEWS}/${id}/${i}.jsonl`] ?? ''
    expect(fingerprintOf(text)).toBe(print)
    return text
  }))
}

// A session's rows as the plugin keeps them: its files, and the store's note of them.
function keptAs(id: string, rows: ViewRow[]) {
  const chunks = chunksOf(rows)
  const files = Object.fromEntries(chunks.map((text, i) => [`${VIEWS}/${id}/${i}.jsonl`, text]))
  return {
    note: { chunks: chunks.map(fingerprintOf) },
    files: { ...files, [`${VIEWS}/${id}/marks.txt`]: marksOf(rows) },
  }
}

const say = (text: string) => ({ text, origin: { kind: 'composer' as const }, wait: false })

// The person's /threads, which turns threads on in the chat, or off again.
const flipThreads = ($: Engine) =>
  $.command.run({ command: 'threads', args: 'toggle', origin: { kind: 'composer' }, presentation: {} as never })

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
  drawn: () => Promise<unknown>
}

type Drawn = { type?: string; props?: Record<string, unknown>; children?: unknown[] }

// The element of a drawing with a key, its hover included.
function keyedIn(node: unknown, key: string): (Drawn & { hover?: unknown }) | undefined {
  if (typeof node !== 'object' || node === null) return undefined
  const drawn = node as Drawn & { hover?: unknown }
  if (drawn.props?.key === key) return drawn
  for (const child of drawn.children ?? []) {
    const found = keyedIn(child, key)
    if (found !== undefined) return found
  }
  return undefined
}

// The element of a drawing with a child that passes `isChild`.
function parentIn(node: unknown, isChild: (child: Drawn) => boolean): Drawn | undefined {
  if (typeof node !== 'object' || node === null) return undefined
  const children = (node as Drawn).children ?? []
  if (children.some(child => typeof child === 'object' && child !== null && isChild(child as Drawn))) return node as Drawn
  for (const child of children) {
    const found = parentIn(child, isChild)
    if (found !== undefined) return found
  }
  return undefined
}

// The strings an element shows, its own and its children's, in order.
const shownIn = (node: unknown): string =>
  typeof node === 'string' ? node : ((node as Drawn | undefined)?.children ?? []).map(shownIn).join('')

// What the view shows, in order: who wrote each section, and its text. The person's
// sections are filled bubbles, their words the last Text in them; Claude's are markdown.
// (On a page the divider above the filter is filled too, but holds nothing.)
async function sectionsOf(pane: Drawing) {
  const sections: string[] = []
  const walk = (node: unknown) => {
    if (typeof node !== 'object' || node === null) return
    const { type, props = {}, children = [] } = node as Drawn
    if (type === 'Markdown') {
      sections.push(`Claude: ${String(props.text)}`)
      return
    }
    if (type === 'Box' && props.backgroundColor !== undefined && children.length > 0) {
      const words = children.filter(child => (child as Drawn).type === 'Text').at(-1)
      sections.push(`you: ${shownIn(words)}`)
      return
    }
    for (const child of children) walk(child)
  }
  walk(await pane.drawn())
  return sections
}

// The view's filter as drawn: each thread's name, starred where it is picked. A Button's
// label is the name in capitals, picked in brackets at full strength, else between spaces
// and dim; on the desktop, the tag's picture (named "<name>: on" or "off") is picked in a
// border of a colour, else in one drawn clear. One drawn half picked is marked "?".
const FILTER_BOX = 'thread-view-filter-box:'
const CLEAR = '#00000000'
async function filterOf(pane: Drawing) {
  const names: string[] = []
  const walk = (node: unknown) => {
    if (typeof node !== 'object' || node === null) return
    const { props = {}, children = [] } = node as Drawn
    if (!String(props.key).startsWith(FILTER_BOX)) {
      for (const child of children) walk(child)
      return
    }
    const mark = (isPicked: boolean, isMarkedPicked: boolean) => (isPicked !== isMarkedPicked ? ' ?' : isPicked ? ' *' : '')
    const name = children.map(child => child as Drawn).find(child => child.type === 'Button' || child.type === 'Svg')
    if (name?.type === 'Button') {
      const label = String(name.props?.label)
      const isPicked = label.startsWith('[')
      names.push(`${label.replace(/[[\]]/g, '').trim().toLowerCase()}${mark(isPicked, name.props?.dimColor !== true)}`)
    } else {
      const [shown, state] = String(name?.props?.alt).split(': ')
      names.push(`${shown}${mark(props.borderColor !== CLEAR, state === 'on')}`)
    }
  }
  walk(await pane.drawn())
  return names
}

// A press on a thread's switch in the view's filter: its Button, or where it has one (the
// desktop) a click on the hit area over its name.
async function pressFilter(
  pane: {
    find: (query: { key: string }) => Promise<{ type: string } | undefined>
    press: (query: { key: string }) => Promise<unknown>
    pointer: (p: never) => Promise<unknown>
  },
  thread: string,
) {
  const key = `${FILTER_THREAD_KEY}${thread}`
  if ((await pane.find({ key }))?.type === 'Client') await pane.pointer({ type: 'down', x: 1, y: 0, button: 'left', in: key } as never)
  else await pane.press({ key })
}

test('the thread view shows the threads its own filter picks, earlier replies too, and no tool rows; the picker above the prompt leaves it be', async ($, on) => {
  engine(on)
  await flipThreads($)
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
    // none picked: the whole conversation, without its tool rows or the words a tool call followed
    const everything = [
      'you: hello',
      'you: fast?',
      'Claude: the plan',
      'Claude: use a queue',
      'Claude: it is fine',
      'you: what now?',
      'Claude: next step',
    ]
    expect(await sectionsOf(pane)).toEqual(everything)
    expect(await pane.findAll({ text: /file contents|Read/ })).toEqual([])
    // its filter: a switch for each thread, none picked; no label before them, no "All", no
    // "No thread". On the desktop each is the thread's tag, the picture the chat draws, in a
    // round border drawn clear, the thread's colour faint under the pointer, a hit area over
    // it; elsewhere a plain Button, the name in capitals between spaces, dim, in the
    // thread's colour under the pointer
    expect(await filterOf(pane)).toEqual(['design', 'perf'])
    const designSwitch = keyedIn(await pane.drawn(), `${FILTER_THREAD_KEY}design`)
    const designBox = keyedIn(await pane.drawn(), `${FILTER_BOX}design`)
    if (surface === 'desktop') {
      expect(designSwitch?.type).toBe('Client')
      expect(String(designSwitch?.props?.module)).toEndWith('switch.tsx')
      expect(designSwitch?.props).toMatchObject({ props: { isOn: false }, width: '100%', height: '100%' })
      const [tag, over] = (designBox?.children ?? []) as Drawn[]
      expect(tag?.type).toBe('Svg')
      expect(tag?.props?.alt).toBe('design: off')
      const partTag = (await pane.findAll({ type: 'Svg' })).find(
        p => p.props.alt === 'design' && String(p.props.source).includes('text-anchor="start"'),
      )
      expect(tag?.props).toMatchObject({ source: partTag?.props.source, width: partTag?.props.width, height: partTag?.props.height })
      expect(over?.props).toMatchObject({ position: 'absolute', top: 0, left: 0, width: '100%', height: '100%' })
      expect(designBox?.props).toMatchObject({ flexShrink: 0, borderStyle: 'round', borderColor: CLEAR })
      expect(designBox?.hover).toEqual({ borderColor: '#4fa3e073' })
    } else {
      expect(designSwitch?.props).toMatchObject({ label: ' DESIGN ', plain: true, dimColor: true })
      expect(designSwitch?.hover).toEqual({ color: '#4fa3e0' })
    }
    expect(await pane.find({ type: 'Text', text: 'Show' })).toBeUndefined()
    // a faint line between the newest section and the filter: on the desktop a hairline
    // across the pane, a row either side; on the terminal a dim run of `─` cut to one row,
    // the filter right under it
    const tree = await pane.drawn()
    const switches = parentIn(tree, child => String(child.props?.key).startsWith(FILTER_BOX))
    const filterBlock = parentIn(tree, child => child === switches)
    expect(switches?.props?.flexWrap).toBe('wrap')
    const [divider, below] = (filterBlock?.children ?? []) as Drawn[]
    expect(below).toBe(switches)
    if (surface === 'desktop') {
      expect(filterBlock?.props?.rowGap).toBe(1)
      expect(divider).toMatchObject({ type: 'Box', props: { height: 0.1, backgroundColor: '#8888884d' } })
      expect(divider?.children ?? []).toEqual([])
    } else {
      expect(filterBlock?.props?.rowGap).toBe(0)
      expect(divider).toMatchObject({ type: 'Box', props: { height: 1, overflow: 'hidden' } })
      const [line] = (divider?.children ?? []) as Drawn[]
      expect(line?.props?.dimColor).toBe(true)
      expect(shownIn(line)).toMatch(/^─{200,}$/)
    }

    // a thread picked above the prompt, where messages go, leaves the view as it was
    const band = await $.ui.mount({ plugin: 'thread-chat', surface: 'terminal', ...BAND })
    await band.select({ key: 'thread-picker', value: 'thread:perf' })
    expect(await sectionsOf(pane)).toEqual(everything)

    // design picked in the view's filter: its sections, before the last message too, and as
    // the chat's filter shows them, those of no thread since the person's last message; the
    // picker above the prompt as it was (no redraw asked for: the pick draws the view again)
    await pressFilter(pane, 'design')
    expect(await sectionsOf(pane)).toEqual(['you: hello', 'Claude: use a queue', 'you: what now?', 'Claude: next step'])
    expect(await filterOf(pane)).toEqual(['design *', 'perf'])
    expect((await band.find({ key: 'thread-picker' }))?.props.value).toBe('thread:perf')
    // picked, its switch takes the same room: on the desktop the border takes the thread's
    // colour, nothing else of it changes; elsewhere brackets take the spaces' place
    const pickedBox = keyedIn(await pane.drawn(), `${FILTER_BOX}design`)
    if (surface === 'desktop') {
      expect({ ...pickedBox?.props, borderColor: '#4fa3e0' }).toEqual({ ...designBox?.props, borderColor: '#4fa3e0' })
      expect(pickedBox?.props?.borderColor).toBe('#4fa3e0')
      expect(pickedBox?.hover).toBeUndefined()
      const [was, now] = [designBox, pickedBox].map(box => (box?.children?.[0] as Drawn | undefined)?.props)
      expect({ ...now, alt: '' }).toEqual({ ...was, alt: '' })
      expect(now?.alt).toBe('design: on')
    } else {
      const label = keyedIn(await pane.drawn(), `${FILTER_THREAD_KEY}design`)?.props?.label
      expect(label).toBe('[DESIGN]')
      expect(String(label).length).toBe(String(designSwitch?.props?.label).length)
    }

    // each section's tag; the person's section a bubble in the surface's fill, and each
    // reply part in its thread's border, as the chat draws them (on the desktop, the picked
    // switch too); nothing filled in it, but on the desktop the divider
    const tags =
      surface === 'terminal'
        ? (await pane.findAll({ type: 'Text', text: 'DESIGN' })).length
        : (await pane.findAll({ type: 'Svg' })).filter(p => p.props.alt === 'design').length
    expect(tags).toBe(3)
    const filled = (await pane.findAll({ type: 'Box' })).filter(b => b.props.backgroundColor !== undefined)
    const fill = surface === 'terminal' ? 'userMessageBackground' : '#8888881a'
    expect(filled.map(b => b.props.backgroundColor)).toEqual(surface === 'terminal' ? [fill, fill] : [fill, fill, '#8888884d'])
    const bordered = (await pane.findAll({ type: 'Box' })).filter(b => PALETTE.some(color => b.props.borderColor === color))
    expect(bordered.map(b => [b.props.borderStyle, b.props.borderColor])).toEqual([
      ['round', '#4fa3e0'],
      ['round', '#4fa3e0'],
      ...(surface === 'desktop' ? [['round', '#4fa3e0']] : []),
    ])
    // no Client but the filter's hit areas, one per thread: every overlay on the desktop
    // shares their one frame
    const clients = (await pane.findAll({ type: 'Client' })).map(c => c.key)
    expect(clients).toEqual(surface === 'desktop' ? [`${FILTER_THREAD_KEY}design`, `${FILTER_THREAD_KEY}perf`] : [])

    // perf picked too: both threads' sections, each picked
    await pressFilter(pane, 'perf')
    expect(await sectionsOf(pane)).toEqual([
      'you: hello',
      'you: fast?',
      'Claude: use a queue',
      'Claude: it is fine',
      'you: what now?',
      'Claude: next step',
    ])
    expect(await filterOf(pane)).toEqual(['design *', 'perf *'])
    // each pressed again, the last leaving: every section
    await pressFilter(pane, 'design')
    expect(await sectionsOf(pane)).toEqual(['you: fast?', 'Claude: it is fine', 'you: what now?'])
    await pressFilter(pane, 'perf')
    expect(await sectionsOf(pane)).toEqual(everything)
    expect(await filterOf(pane)).toEqual(['design', 'perf'])
    expect((await band.find({ key: 'thread-picker' }))?.props.value).toBe('thread:perf')

    await band.select({ key: 'thread-picker', value: 'none' })
    for (const site of [band, pane]) await site.unmount()
  }

  // a new reply's row draws the view again
  const pane = await $.ui.mount({ plugin: 'thread-chat', surface: 'terminal', ...PANE })
  await store('a5', 'response', [{ type: 'text', text: '# design\nlater still' }])
  expect((await sectionsOf(pane)).at(-1)).toBe('Claude: later still')
})

test('the view puts a message sent to the one picked thread, and a moved part, where the chat does', async ($, on) => {
  engine(on)
  await flipThreads($)
  await $.prompt.submit(say('# design\na\n# perf\nb'))
  const band = await $.ui.mount({ plugin: 'thread-chat', surface: 'terminal', ...BAND })
  await band.select({ key: 'thread-picker', value: 'thread:perf' })

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
  await pressFilter(pane, 'perf')
  expect(await sectionsOf(pane)).toEqual(['you: and the cache?'])

  // the person moves two reply parts from design to perf, with everything in view;
  // the terminal knows a reply by its row's id, the desktop by its API message's
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

  expect(await sectionsOf(pane)).toEqual(['you: and the cache?', 'Claude: use a queue', 'Claude: next step'])
})

test('a long section draws as markdown in pieces a Markdown element takes', async ($, on) => {
  engine(on)
  await flipThreads($)
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

test("the person's messages draw as the chat's bubbles: their words as typed, a quote they replied to dim above them", async ($, on) => {
  engine(on)
  await flipThreads($)
  // a reply to a selection, as the desktop writes one, typed on Windows
  const typed = '<!-- reply 1 -->\r\n> use a\r\n> queue\r\n**why** a queue?\r\n- not a list'
  await $.session
    .append({
      message: { type: 'user', role: 'user', content: [{ type: 'text', text: typed }] },
      door: 'prompt',
      origin: { kind: 'composer' },
      uuid: 'p1',
    })
    .catch(() => undefined)

  for (const surface of ['terminal', 'desktop'] as const) {
    const pane = await $.ui.mount({ plugin: 'thread-chat', surface, ...PANE })
    expect(await sectionsOf(pane)).toEqual(['you: **why** a queue?\n- not a list'])
    expect(await pane.findAll({ type: 'Markdown' })).toEqual([])
    // the selection on one dim line beside a bar; no marker
    const dim = (await pane.findAll({ type: 'Text' })).filter(t => t.props.dimColor === true).map(t => t.text)
    expect(dim).toEqual(['│', 'use a queue'])
    expect(await pane.findAll({ text: /<!--/ })).toEqual([])
    // on the desktop, at the right, rounded
    if (surface === 'desktop') {
      const bubble = (await pane.findAll({ type: 'Box' })).find(b => b.props.backgroundColor !== undefined)
      expect(bubble?.props.borderStyle).toBe('round')
      expect((await pane.findAll({ type: 'Box' })).some(b => b.props.justifyContent === 'flex-end')).toBe(true)
    }
    await pane.unmount()
  }
})

test("a bubble keeps the person's quotes and words in the order they typed them", async ($, on) => {
  engine(on)
  await flipThreads($)
  // three replies to selections in one message, each quote followed by words on it
  const typed = [
    '<!-- reply 3 -->',
    '> quoted A',
    '',
    'Text A',
    '',
    '<!-- reply -->',
    '> quoted',
    '> B',
    'Text B',
    '<!-- reply -->',
    '> quoted C',
    'Text C',
  ].join('\r\n')
  await $.session
    .append({
      message: { type: 'user', role: 'user', content: [{ type: 'text', text: typed }] },
      door: 'prompt',
      origin: { kind: 'composer' },
      uuid: 'p1',
    })
    .catch(() => undefined)

  // The filled bubble's parts in order: a quote's row as `> ` and its dim line, words
  // as typed, each with the rows above it.
  const partsOf = (node: unknown): string[] => {
    if (typeof node !== 'object' || node === null) return []
    const { type, props = {}, children = [] } = node as Drawn
    if (type !== 'Box' || props.backgroundColor === undefined) return children.flatMap(partsOf)
    return children.map(child => {
      const { type: kind, props: row = {}, children: inner = [] } = child as Drawn
      if (kind === 'Text') return shownIn(child)
      return `${'\n'.repeat(Number(row.marginTop ?? 0))}> ${shownIn(inner.at(-1))}`
    })
  }
  for (const surface of ['terminal', 'desktop'] as const) {
    const pane = await $.ui.mount({ plugin: 'thread-chat', surface, ...PANE })
    expect(partsOf(await pane.drawn())).toEqual(['> quoted A', 'Text A', '\n> quoted B', 'Text B', '\n> quoted C', 'Text C'])
    await pane.unmount()
  }
})

test('the view files a quoted selection opening a message under the thread heading right after it', async ($, on) => {
  engine(on)
  await flipThreads($)
  await $.prompt.submit(say('# design\na\n# multitasking\nb'))
  const typed = '<!-- reply 1 -->\r\n> due now\r\n\r\n# Multitask\r\nyes'
  await $.prompt.submit(say(typed))
  await $.session
    .append({
      message: { type: 'user', role: 'user', content: [{ type: 'text', text: typed }] },
      door: 'prompt',
      origin: { kind: 'composer' },
      uuid: 'p1',
    })
    .catch(() => undefined)

  const pane = await $.ui.mount({ plugin: 'thread-chat', surface: 'desktop', ...PANE })
  const dim = async () => (await pane.findAll({ type: 'Text' })).filter(t => t.props.dimColor === true).map(t => t.text)
  // one bubble, the quote dim above the words
  expect(await sectionsOf(pane)).toEqual(['you: yes'])
  expect(await dim()).toContain('due now')
  // the view filtered to its thread, it stays; filtered to another, it goes, quote and all
  await pressFilter(pane, 'multitasking')
  expect(await sectionsOf(pane)).toEqual(['you: yes'])
  expect(await dim()).toContain('due now')
  await pressFilter(pane, 'multitasking')
  await pressFilter(pane, 'design')
  expect(await sectionsOf(pane)).toEqual([])
})

// How a drawing marks each of a thread's tags, in order: the tag, the row it sits in
// above a person's message, and the border round it in a reply's part.
function tagLooksIn(tree: unknown, name: string) {
  const looks: { tag: Drawn; row: Drawn['props']; frame: Drawn['props'] }[] = []
  const walk = (node: unknown, above: Drawn[]) => {
    if (typeof node !== 'object' || node === null) return
    const el = node as Drawn
    if ((el.type === 'Text' && shownIn(el) === name.toUpperCase()) || (el.type === 'Svg' && el.props?.alt === name)) {
      const nearest = (has: (props: Record<string, unknown>) => boolean) =>
        above.findLast(box => box.type === 'Box' && has(box.props ?? {}))?.props
      looks.push({
        tag: { type: el.type, props: el.props },
        row: nearest(props => props.justifyContent !== undefined),
        frame: nearest(props => props.borderColor !== undefined),
      })
      return
    }
    for (const child of el.children ?? []) walk(child, [...above, el])
  }
  walk(tree, [])
  return looks
}

test("the view draws a thread's tags and borders as the chat does", async ($, on) => {
  engine(on)
  await flipThreads($)
  const typed = '# design\nhello'
  // the reply's thread part is drawn as markdown in the chat too, as every part is in the view
  const replied = 'the plan\n# design\nuse a queue'
  await $.prompt.submit(say(typed))
  const store = (uuid: string, door: 'prompt' | 'response', text: string) =>
    $.session
      .append({
        message:
          door === 'response'
            ? { type: 'assistant', role: 'assistant', content: [{ type: 'text', text }] }
            : { type: 'user', role: 'user', content: [{ type: 'text', text }] },
        door,
        origin: door === 'prompt' ? { kind: 'composer' } : model,
        uuid,
      })
      .catch(() => undefined)
  await store('p1', 'prompt', typed)
  await store('a1', 'response', replied)

  for (const surface of ['terminal', 'desktop'] as const) {
    const view = await $.ui.mount({ plugin: 'thread-chat', surface, ...PANE })
    const message = await $.ui.mount({
      plugin: 'thread-chat',
      surface,
      component: 'UserMessage',
      requestId: 'p1',
      props: { text: typed, origin: { kind: 'composer' }, isExpanded: false },
    })
    const reply = await $.ui.mount({
      plugin: 'thread-chat',
      surface,
      component: 'AssistantMessage',
      requestId: 'a1',
      props: { text: replied, isFirstOfReply: true },
    })

    const [mine, part, ...more] = tagLooksIn(await view.drawn(), 'design')
    expect(more).toEqual([])
    // the person's tag: the same picture in the same row above their message, at its side
    expect(mine).toEqual(tagLooksIn(await message.drawn(), 'design')[0])
    expect(mine?.row?.justifyContent).toBe(surface === 'terminal' ? 'flex-start' : 'flex-end')
    expect(mine?.frame).toBeUndefined()
    // the reply part's: the same picture in the same border of the thread's colour
    expect(part).toEqual(tagLooksIn(await reply.drawn(), 'design')[0])
    expect(part?.frame?.borderColor).toBe('#4fa3e0')
    if (surface === 'desktop') {
      expect(String(mine?.tag.props?.source)).toContain('text-anchor="end"')
      expect(String(part?.tag.props?.source)).toContain('text-anchor="start"')
    }
    for (const drawing of [view, message, reply]) await drawing.unmount()
  }
})

// The react mod's reactions a drawing shows, in order: each one's emoji and the words of
// the person's bubble it is on or under (the bubble last drawn before it). On a page a
// picture named "Reaction: <emoji>"; on the terminal the emoji between dim brackets.
async function reactionsOf(pane: Drawing) {
  const found: { on: string; emoji: string }[] = []
  let words = ''
  const walk = (node: unknown) => {
    if (typeof node !== 'object' || node === null) return
    const { type, props = {}, children = [] } = node as Drawn
    if (type === 'Box' && props.backgroundColor !== undefined) {
      words = shownIn(children.filter(child => (child as Drawn).type === 'Text').at(-1))
    }
    if (type === 'Svg' && String(props.alt).startsWith('Reaction: ')) found.push({ on: words, emoji: String(props.alt).slice(10) })
    const texts = children.map(child => child as Drawn)
    if (type === 'Box' && texts.length === 3 && texts.every(t => t.type === 'Text') && shownIn(texts[0]) === '(' && shownIn(texts[2]) === ')') {
      expect([texts[0]?.props?.dimColor, texts[2]?.props?.dimColor]).toEqual([true, true])
      found.push({ on: words, emoji: shownIn(texts[1]) })
      return
    }
    for (const child of children) walk(child)
  }
  walk(await pane.drawn())
  return found
}

test("the view draws react's reaction on the person's message as the chat does, and not the reply it stands for", async ($, on) => {
  engine(on)
  // react's values as the view reads them; none, as without react, until the test sets them
  let react: { isOn: boolean; reactions: { id: string; mark: string; emoji: string }[] } | undefined
  on('state.get', { plugin: 'react' }, ($, e) => ({
    value: {
      value: react === undefined ? undefined : e.key === 'isOn' ? react.isOn : react.reactions,
      version: react === undefined ? 0 : 1,
    },
  }))
  await flipThreads($)
  const typed = '# design\nhello\n# perf\nfast?'
  await $.prompt.submit(say(typed))
  const store = (uuid: string, door: 'prompt' | 'response', text: string) =>
    $.session
      .append({
        message:
          door === 'response'
            ? { type: 'assistant', role: 'assistant', content: [{ type: 'text', text }] }
            : { type: 'user', role: 'user', content: [{ type: 'text', text }] },
        door,
        origin: door === 'prompt' ? { kind: 'composer' } : model,
        uuid,
      })
      .catch(() => undefined)
  // the agent's emoji reply, which react kept as a reply of nothing and put on the message
  await store('p1', 'prompt', typed)
  await store('a1', 'response', 'No response requested.')
  await store('p2', 'prompt', 'what now?')
  await store('a2', 'response', 'next step')

  for (const surface of ['terminal', 'desktop'] as const) {
    const pane = await $.ui.mount({ plugin: 'thread-chat', surface, ...PANE })
    const sections = ['you: hello', 'you: fast?', 'you: what now?', 'Claude: next step']
    // without react: no reaction, and the reply react kept is no section
    expect(await sectionsOf(pane)).toEqual(sections)
    expect(await reactionsOf(pane)).toEqual([])

    // react on, with a reaction on the first message: on its last section alone, the
    // sections as they were
    react = { isOn: true, reactions: [{ id: 'p1', mark: markOf(typed), emoji: '👍' }] }
    await pane.redraw()
    expect(await sectionsOf(pane)).toEqual(sections)
    expect(await reactionsOf(pane)).toEqual([{ on: 'fast?', emoji: '👍' }])
    const pill = (await pane.findAll({ type: 'Svg' })).find(p => p.props.alt === 'Reaction: 👍')
    if (surface === 'desktop') {
      // a solid pill floating over the bubble's bottom-right corner, a column in and across
      // its bottom edge; the bubble keeps a row below it for the pill
      expect(String(pill?.props.source)).toContain('class="base"')
      const tree = await pane.drawn()
      const bubbles = boxesIn(tree, props => props.backgroundColor === '#8888881a')
      expect(bubbles.map(b => pathTo(b, 'Svg')?.map(box => box.props))).toEqual([
        undefined,
        [{ position: 'absolute', right: 1, bottom: -1 }],
        undefined,
      ])
      const rows = boxesIn(tree, props => props.justifyContent === 'flex-end' && props.marginBottom !== undefined)
      expect(rows.map(row => row.props?.marginBottom)).toEqual([1])
    } else {
      expect(pill).toBeUndefined()
    }

    // the filter narrowed to the message's first thread: on the section shown
    await pressFilter(pane, 'design')
    expect(await reactionsOf(pane)).toEqual([{ on: 'hello', emoji: '👍' }])
    await pressFilter(pane, 'design')

    // react off: none, as react draws none in the chat
    react = { ...react, isOn: false }
    await pane.redraw()
    expect(await reactionsOf(pane)).toEqual([])
    react = undefined
    await pane.unmount()
  }
})

// The Boxes of a drawing whose props pass `is`, in order.
function boxesIn(node: unknown, is: (props: Record<string, unknown>) => boolean): Drawn[] {
  if (typeof node !== 'object' || node === null) return []
  const el = node as Drawn
  const own = el.type === 'Box' && is(el.props ?? {}) ? [el] : []
  return [...own, ...(el.children ?? []).flatMap(child => boxesIn(child, is))]
}

// The elements from an element's child down to its first descendant of `type`, that one
// left out; none where it holds none.
function pathTo(node: unknown, type: string): Drawn[] | undefined {
  const { children = [] } = node as Drawn
  for (const child of children) {
    if (typeof child !== 'object' || child === null) continue
    if ((child as Drawn).type === type) return []
    const below = pathTo(child, type)
    if (below !== undefined) return [child as Drawn, ...below]
  }
  return undefined
}

test("a person's message takes react's newest reaction by its row id or stem, else by a start long enough to know it by", () => {
  const stemOf = (id: string) => id.slice(0, 24)
  const long = 'please look at the build again'
  const stem = 'abcdefghijklmnopqrstuvwx'
  const list = [
    { id: 'p1', mark: markOf('a first message to react to'), emoji: '👍' },
    { id: 'p1', mark: markOf('a first message to react to'), emoji: '✅' },
    { id: `${stem}-0`, mark: '', emoji: '🙏' },
    { id: 'p3', mark: markOf(long), emoji: '🎉' },
    { id: 'p4', mark: markOf('ok'), emoji: '👀' },
  ]
  expect(reactionOn(list, 'p1', 'anything', stemOf)).toBe('✅')
  // a long id the screen knows by its first 24 characters; a short one only as it is
  expect(reactionOn(list, `${stem}-1`, 'anything', stemOf)).toBe('🙏')
  expect(reactionOn(list, 'p', 'anything', stemOf)).toBeUndefined()
  // no id, or one with none: by the start of its text, where that is long enough
  expect(reactionOn(list, undefined, long, stemOf)).toBe('🎉')
  expect(reactionOn(list, 'p9', `  ${long}\n`, stemOf)).toBe('🎉')
  expect(reactionOn(list, undefined, 'ok', stemOf)).toBeUndefined()
  expect(reactionOn([], 'p1', long, stemOf)).toBeUndefined()
})

test("/thread-view and the Threads menu's row open the view, once threads are on; off closes it", async ($, on) => {
  const { opened, closed } = engine(on)
  await $.session.start({ cwd: '.', surface: 'desktop', isInteractive: true })
  const view = () => $.command.run({ command: 'thread-view', args: '', origin: { kind: 'composer' }, presentation: {} as never })
  expect((await view()).text).toBe('Threads are off in this chat; /threads turns them on.')

  for (const surface of ['terminal', 'desktop'] as const) {
    // off, no menu, so no row for the view
    const band = await $.ui.mount({ plugin: 'thread-chat', surface, ...BAND })
    expect(await band.drawn()).toEqual({ type: 'engine', ref: 0 })
    await band.unmount()
  }
  expect(opened).toEqual([])
  await flipThreads($)
  expect((await view()).text).toBe('Thread view opened.')
  expect(opened).toEqual(['thread-view'])
  // the terminal's menu, opened by a press on it, stays open from here on
  const terminal = await $.ui.mount({ plugin: 'thread-chat', surface: 'terminal', ...BAND })
  await terminal.press({ key: 'threads' })
  await terminal.unmount()

  for (const surface of ['terminal', 'desktop'] as const) {
    // on, the menu's row opens it, before any thread starts
    const band = await $.ui.mount({ plugin: 'thread-chat', surface, ...BAND })
    expect((await band.find({ key: 'thread-view' }))?.props.label).toBe('Open thread view')
    await band.press({ key: 'thread-view' })
    await band.unmount()
  }
  expect(opened).toEqual(['thread-view', 'thread-view', 'thread-view'])

  // threads off, by /threads or the menu's switch, close the view
  expect(closed).toEqual([])
  await flipThreads($)
  expect(closed).toEqual(['thread-view'])
  await flipThreads($)
  const band = await $.ui.mount({ plugin: 'thread-chat', surface: 'terminal', ...BAND })
  await band.press({ key: 'threads' })
  await band.redraw()
  await band.press({ key: 'threads-on' })
  expect(closed).toEqual(['thread-view', 'thread-view'])
})

// The chat's rows: a person's message, and a reply.
const userRow = (text: string, requestId: string) =>
  ({ component: 'UserMessage', props: { text, origin: { kind: 'composer' }, isExpanded: false }, requestId }) as const
const replyRow = (text: string, requestId: string) =>
  ({ component: 'AssistantMessage', props: { text, isFirstOfReply: true }, requestId }) as const

test("a thread tag's filter button opens the view on that thread alone; none while threads are off or the thread is archived", async ($, on) => {
  const { opened, kept } = engine(on)
  await flipThreads($)
  await $.prompt.submit(say('# design\na\n# perf\nb\n# docs\nc'))
  const viewThreads = () => (kept['session:session-1'] as { viewThreads?: unknown }).viewThreads
  const pane = await $.ui.mount({ plugin: 'thread-chat', surface: 'desktop', ...PANE })
  await pressFilter(pane, 'design')
  await pressFilter(pane, 'docs')
  expect(await filterOf(pane)).toEqual(['design *', 'perf', 'docs *'])

  for (const surface of ['terminal', 'desktop'] as const) {
    opened.length = 0
    // drawn as the tag's "▾" is (dim, chromeless on the desktop), and in the thread's
    // colour with the pointer on the tag, its "▾" or itself: the three share a hover group
    const mine = await $.ui.mount({ plugin: 'thread-chat', surface, ...userRow('# design\nhi\n# perf\nfast?', `u-${surface}`) })
    const drawn = await mine.drawn()
    const button = keyedIn(drawn, 'tag-filter:perf') as (Drawn & { hover?: { color?: unknown; scope?: unknown } }) | undefined
    const move = keyedIn(drawn, 'tag:perf') as (Drawn & { hover?: { scope?: unknown } }) | undefined
    expect(button?.type).toBe('Button')
    expect(button?.props?.label).toBe('▽')
    expect(button?.hover?.color).toBe(PALETTE[1])
    expect(typeof button?.hover?.scope).toBe('string')
    expect(move?.hover).toEqual(button?.hover)
    expect(keyedIn(drawn, 'tagbox:perf')?.hover).toEqual({ scope: button?.hover?.scope })
    expect((keyedIn(drawn, 'tag-filter:design')?.hover as { scope?: unknown }).scope).not.toBe(button?.hover?.scope)
    const { key: _k, label: _l, ...look } = button?.props ?? {}
    const { key: _mk, label: _ml, ...moveLook } = move?.props ?? {}
    expect(look).toEqual(moveLook)
    // the tag keeps its "▾" beside it; the filter buttons sit at the far end of the tags'
    // line from them: left where the person's messages are on the right, right on the terminal
    const keysOf = (box: Drawn | undefined) =>
      ((box?.children ?? []) as unknown[]).flatMap(child =>
        typeof child === 'object' && child !== null ? [(child as Drawn).props?.key ?? (child as Drawn).type] : [],
      )
    expect(keysOf(keyedIn(drawn, 'tagbox:perf'))).toEqual([surface === 'desktop' ? 'Svg' : 'Text', 'tag:perf'])
    const ends = parentIn(drawn, child => child.props?.key === 'tag-filter:perf')
    expect(keysOf(ends)).toEqual(['tag-filter:design', 'tag-filter:perf'])
    expect(ends?.props?.flexGrow).toBe(1)
    const line = parentIn(drawn, child => child.props?.key === 'tagbox:perf')
    const tagKeys = ['tagbox:design', 'tagbox:perf']
    expect(keysOf(line)).toEqual(surface === 'desktop' ? ['Box', ...tagKeys] : [...tagKeys, 'Box'])

    // a reply's at the far right of its line, at the top of its thread's border
    const replied = await (
      await $.ui.mount({ plugin: 'thread-chat', surface, ...replyRow('# design\nuse a queue', `r-line-${surface}`) })
    ).drawn()
    const head = parentIn(replied, child => child.props?.key === 'tag-filter:design')
    expect(keysOf(head)).toEqual(['Box', 'tag-filter:design'])
    expect(keyedIn((head?.children as Drawn[])[0], 'tagbox:design')).toBeDefined()
    expect((head?.children as Drawn[])[0]?.props?.flexGrow).toBe(1)
    expect(parentIn(replied, child => child === head)?.props?.borderStyle).toBe('round')

    // pressed, it opens the view, its filter picking that thread and no other
    await mine.press({ key: 'tag-filter:perf' })
    expect(opened).toEqual(['thread-view'])
    expect(viewThreads()).toEqual(['perf'])
    expect(await filterOf(pane)).toEqual(['design', 'perf *', 'docs'])

    // a reply's tag has one too
    const reply = await $.ui.mount({ plugin: 'thread-chat', surface, ...replyRow('# design\nuse a queue', `r-${surface}`) })
    await reply.press({ key: 'tag-filter:design' })
    expect(opened).toEqual(['thread-view', 'thread-view'])
    expect(viewThreads()).toEqual(['design'])
    expect(await filterOf(pane)).toEqual(['design *', 'perf', 'docs'])
  }

  // an archived thread, which the view's filter does not offer, keeps its "▾" but has no filter button
  const band = await $.ui.mount({ plugin: 'thread-chat', surface: 'terminal', ...BAND })
  await band.press({ key: 'threads' })
  await band.redraw()
  await band.press({ key: 'threads:manage' })
  await band.redraw()
  await band.press({ key: 'threads:archive:docs' })
  const archived = await $.ui.mount({ plugin: 'thread-chat', surface: 'desktop', ...replyRow('# docs\nc\n# perf\nd', 'r-archived') })
  expect(await archived.find({ key: 'tag:docs' })).toBeDefined()
  expect(await archived.find({ key: 'tag-filter:docs' })).toBeUndefined()
  expect(await archived.find({ key: 'tag-filter:perf' })).toBeDefined()

  // threads off: no tags, so no filter buttons
  await flipThreads($)
  for (const surface of ['terminal', 'desktop'] as const) {
    const row = await $.ui.mount({ plugin: 'thread-chat', surface, ...userRow('# design\nhi', `u-off-${surface}`) })
    expect(await row.find({ key: 'tag-filter:design' })).toBeUndefined()
  }
})

// A drawing that throws leaves the engine to draw its own pane, which for the thread
// view is an empty one: the view went blank, saying nothing. It says why instead.
test('a thread view that fails to draw says why rather than going blank', async ($, on) => {
  engine(on)
  await flipThreads($)
  await $.prompt.submit(say('# design\nhello'))
  for (const surface of ['terminal', 'desktop'] as const) {
    // a pane drawn with no window over its body: reading where it stands throws
    const { scroll: _, ...props } = PANE.props
    const pane = await $.ui.mount({ plugin: 'thread-chat', surface, ...PANE, props: props as never })
    const drawn = (await pane.drawn()) as { type?: string }
    expect(drawn.type).toBe('Box')
    expect((await pane.find({ type: 'Text', text: /^The thread view could not be drawn: TypeError: / }))?.text).toContain('scroll')
    await pane.unmount()
  }
})

test('/thread-view trace tells how the view was last opened and drawn, step by step', async ($, on) => {
  engine(on)
  const trace = async () =>
    (await $.command.run({ command: 'thread-view', args: 'trace', origin: { kind: 'composer' }, presentation: {} as never })).text
  expect(await trace()).toStartWith('The thread view has not been drawn since thread-chat last loaded.\n\nThread summaries:')
  await flipThreads($)
  await $.prompt.submit(say('# design\nhello'))
  await $.command.run({ command: 'thread-view', args: '', origin: { kind: 'composer' }, presentation: {} as never })
  const pane = await $.ui.mount({ plugin: 'thread-chat', surface: 'desktop', ...PANE })
  await pane.drawn()
  const text = await trace()
  expect(text).toContain('open answered: {"isPlaced":true}')
  expect(text).toMatch(/: \d+ms returned a Box near 1\.00 of sections 0 on of 0: 0 picture cards, 0 with 0 characters of picture data/)
  expect(text).toMatch(/\d+ms threads read: 1, filter picked 0/)
})

test("the view's filter follows a merge, lets go of an archived or deleted thread, and is kept for the next run", async ($, on) => {
  const { kept } = engine(on)
  await flipThreads($)
  await $.prompt.submit(say('# design\na\n# perf\nb\n# docs\nc\n# ops\nd'))
  const pane = await $.ui.mount({ plugin: 'thread-chat', surface: 'terminal', ...PANE })
  // with no messages stored yet, it says so above the filter
  expect((await pane.find({ type: 'Text', text: /^Nothing/ }))?.text).toBe('Nothing here yet.')
  for (const key of ['design', 'perf', 'docs']) await pressFilter(pane, key)
  expect((await pane.find({ type: 'Text', text: /^Nothing/ }))?.text).toBe('Nothing in the threads shown yet.')
  expect(await filterOf(pane)).toEqual(['design *', 'perf *', 'docs *', 'ops'])
  expect((kept['session:session-1'] as { viewThreads?: unknown }).viewThreads).toEqual(['design', 'perf', 'docs'])

  // perf merged into ops: ops picked in its place
  await $.command.run({ command: 'merge-threads', args: 'perf into ops', origin: { kind: 'composer' }, presentation: {} as never })
  expect(await filterOf(pane)).toEqual(['design *', 'docs *', 'ops *'])
  // docs archived and design deleted, from the menu: they leave the filter, ops still picked
  const band = await $.ui.mount({ plugin: 'thread-chat', surface: 'terminal', ...BAND })
  await band.press({ key: 'threads' })
  await band.redraw()
  await band.press({ key: 'threads:manage' })
  await band.redraw()
  await band.press({ key: 'threads:archive:docs' })
  await band.redraw()
  await band.press({ key: 'threads:delete:design' })
  await band.redraw()
  await band.press({ key: 'threads:delete-yes' })
  expect(await filterOf(pane)).toEqual(['ops *'])
  expect((kept['session:session-1'] as { viewThreads?: unknown }).viewThreads).toEqual(['ops'])
})

test('a restarted session takes up the filter its thread view kept', async ($, on) => {
  const perf = { name: 'perf', color: PALETTE[1] ?? '#888888', createdBy: 'user' } as const
  engine(on, { 'session:session-1': { isOn: true, threads: [DESIGN, perf], aliases: {}, snaps: {}, viewThreads: ['perf'] } })
  await $.session.start({ cwd: '.', surface: 'desktop', isInteractive: true })
  const pane = await $.ui.mount({ plugin: 'thread-chat', surface: 'desktop', ...PANE })
  expect(await filterOf(pane)).toEqual(['design', 'perf *'])
})

// A compaction's summary, as the engine stores it and the conversation then reads it.
const SUMMARY = 'This session is being continued from a previous conversation. Summary: hello, and fast?'

const DESIGN = { name: 'design', color: '#4fa3e0', isSelected: false, createdBy: 'user' } as const

test('the view keeps what a compaction summarised away, and never shows the summary', async ($, on) => {
  const { transcript, kept, files } = engine(on)
  await flipThreads($)
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

  // every row is kept with its text as the turn ends, for the session's next run: in
  // files of the session's own, the store noting them
  await $.turn.complete({ answer: '', durationMs: 1, isAborted: false, turnId: 't1', reason: 'answer' })
  expect(rowsIn(kept, files, 'session-1').map(row => `${row.id}: ${row.text ?? ''}`)).toEqual([
    'p1: # design\nhello',
    'a1: on it\n# design\nuse a queue',
    'p2: # perf\nfast?',
    'a2: # perf\nit is fine',
  ])
})

test('a restarted session draws every message it kept, from its files', async ($, on) => {
  const rows = Array.from({ length: 1200 }, (_, i): ViewRow => {
    const text = `# design\nmessage ${i}`
    return { id: `r${i}`, role: i % 2 === 0 ? 'user' : 'assistant', mark: markOf(text), text }
  })
  const { note, files } = keptAs('session-1', rows)
  engine(on, { 'session:session-1': { threads: [DESIGN], aliases: {}, snaps: {} }, 'view:session-1': note }, files)
  // the conversation, compacted, holds none of them
  await $.session.start({ cwd: '.', surface: 'desktop', isInteractive: true })

  const pane = await $.ui.mount({ plugin: 'thread-chat', surface: 'terminal', ...PANE })
  // all of them are there; the pane draws the newest 30 sections at first
  expect((await pane.find({ key: EARLIER_KEY }))?.text).toBe('1170 earlier messages')
  const shown = await sectionsOf(pane)
  expect([shown.length, shown[0], shown[shown.length - 1]]).toEqual([30, 'you: message 1170', 'Claude: message 1199'])
})

test('a restarted session draws the rows an earlier version kept; those without text draw while the conversation holds them', async ($, on) => {
  const { transcript } = engine(on, {
    'session:session-1': { threads: [DESIGN], aliases: {}, snaps: {} },
    'view:session-1': [
      // kept by an earlier version, without text: one the compaction summarised away
      // (which that version did not draw either), one the conversation still holds,
      // and one with a note for the model beside it
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
  expect(await pane.find({ type: 'Text', text: /no longer kept/ })).toBeUndefined()
})

for (const form of ['files', 'the store, by an earlier version'] as const) {
  test(`a rewound session draws the rows of the session it came from up to where it was rewound (kept in ${form})`, async ($, on) => {
    const said: ViewRow[] = [
      { id: 'p1', role: 'user', text: '# design\nwhy is the band two rows high?' },
      { id: 'a1', role: 'assistant', text: '# design\nIt wraps because both mods share one row.' },
      { id: 'p2', role: 'user', text: '# design\nhow long do the tests take?' },
      // rewound away: the new session holds the rows before these
      { id: 'a2', role: 'assistant', text: '# design\nAbout five seconds in all.' },
      { id: 'p3', role: 'user', text: '# design\nand the store?' },
    ].map(row => ({ ...row, role: row.role as ViewRow['role'], mark: markOf(row.text) }))
    const old = keptAs('old', said)
    const { transcript, kept, files } = engine(
      on,
      { 'session:old': { threads: [DESIGN], aliases: {}, snaps: {} }, 'view:old': form === 'files' ? old.note : said },
      form === 'files' ? old.files : {},
    )
    transcript.push(...said.slice(0, 3).map(row => ({ role: row.role, text: row.text ?? '', toolUses: [] })))
    await $.session.start({ cwd: '.', surface: 'desktop', isInteractive: true })

    const pane = await $.ui.mount({ plugin: 'thread-chat', surface: 'terminal', ...PANE })
    expect(await sectionsOf(pane)).toEqual([
      'you: why is the band two rows high?',
      'Claude: It wraps because both mods share one row.',
      'you: how long do the tests take?',
    ])
    // kept as the new session's own at once
    expect(rowsIn(kept, files, 'session-1').map(row => row.id)).toEqual(['p1', 'a1', 'p2'])
  })
}

test('every message is kept with its text, however long, writing only the files that changed', async ($, on) => {
  // an earlier version kept the session's rows in the store, without text
  const { kept, files, writes } = engine(on, { 'view:session-1': [{ id: 'p0', role: 'user', mark: markOf('# design\nlong ago') }] })
  await flipThreads($)
  await $.session.start({ cwd: '.', surface: 'desktop', isInteractive: true })
  // a session using threads
  await $.prompt.submit(say('# design\nlong ago'))
  const reply = (uuid: string, text: string) =>
    $.session
      .append({ message: { type: 'assistant', role: 'assistant', content: [{ type: 'text', text }] }, door: 'response', origin: model, uuid })
      .catch(() => undefined)
  const done = () => $.turn.complete({ answer: '', durationMs: 1, isAborted: false, turnId: 't1', reason: 'answer' })
  const huge = 'y'.repeat(2_500_000)
  await reply('a1', huge)
  await reply('a2', 'short')
  await done()

  // the rows move from the store to files, none over what one read or write takes
  const rows = rowsIn(kept, files, 'session-1')
  expect(rows.map(row => row.id)).toEqual(['p0', 'a1', 'a2'])
  expect(rows[1]?.text === huge).toBe(true)
  const last = (kept['view:session-1'] as { chunks: string[] }).chunks.length - 1
  expect(last >= 2).toBe(true)
  const sizes = Object.entries(files).flatMap(([path, text]) => (path.endsWith('.jsonl') ? [text.length] : []))
  expect(sizes.every(size => size <= 1_000_000)).toBe(true)
  // with their marks beside them, by which a rewound session finds them
  expect(files[`${VIEWS}/session-1/marks.txt`]).toBe(marksOf(rows))

  // the next turn writes the file its new row went into, and no other
  writes.length = 0
  await reply('a3', 'another')
  await done()
  expect(writes).toEqual([`${VIEWS}/session-1/${last}.jsonl`, `${VIEWS}/session-1/marks.txt`])
  expect(rowsIn(kept, files, 'session-1').map(row => row.id)).toEqual(['p0', 'a1', 'a2', 'a3'])
  // and a turn with nothing new writes nothing
  writes.length = 0
  await done()
  expect(writes).toEqual([])
})

test('a session keeps no rows on disk until threads are on, then every one, those from before too', async ($, on) => {
  const { kept, files, writes } = engine(on)
  await $.session.start({ cwd: '.', surface: 'desktop', isInteractive: true })
  const reply = (uuid: string, text: string) =>
    $.session
      .append({ message: { type: 'assistant', role: 'assistant', content: [{ type: 'text', text }] }, door: 'response', origin: model, uuid })
      .catch(() => undefined)
  const done = () => $.turn.complete({ answer: '', durationMs: 1, isAborted: false, turnId: 't1', reason: 'answer' })
  // a heading is plain text while threads are off
  await $.prompt.submit(say('# design\nnot yet'))
  await reply('a1', '# design\nbefore threads')
  await done()
  expect(writes).toEqual([])
  expect(kept['view:session-1']).toBeUndefined()

  await flipThreads($)
  await $.prompt.submit(say('# design\nnow'))
  await reply('a2', '# design\nin a thread')
  await done()
  expect(rowsIn(kept, files, 'session-1').map(row => row.id)).toEqual(['a1', 'a2'])
})

// The multitask plugin's wake-up, as it submits it in the person's words.
const WAKE = '<local-command-stdout>Set model to unchanged (multitask wake-up: read the thought updates just above)</local-command-stdout>'

type Origin = Parameters<Engine['session']['append']>[0]['origin']

// Stores rows as the engine does: the person's message, a plugin's prompt in the
// person's words, Claude's reply, Claude's tool call with its result; and ends a turn.
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
    plugin: (uuid: string, text: string) => append(uuid, 'prompt', [{ type: 'text', text }], { kind: 'plugin', name: 'multitask', asUser: true }),
    reply: (uuid: string, text: string) => append(uuid, 'response', [{ type: 'text', text }], model),
    call: async (uuid: string) => {
      const id = `toolu_${++calls}`
      await append(uuid, 'response', [{ type: 'tool_use', id, name: 'Bash', input: {} }], model)
      await append(`${uuid}-result`, 'tool-result', [{ type: 'tool_result', tool_use_id: id, content: 'ok' }], { kind: 'tool', tool: 'Bash' })
    },
    done: () => $.turn.complete({ answer: '', durationMs: 1, isAborted: false, turnId: 't1', reason: 'answer' }),
  }
}

test("the view shows messages alone: each turn's last reply, not a quiet one, nor another party's prompt", async ($, on) => {
  const { kept, files } = engine(on)
  await flipThreads($)
  await $.prompt.submit(say('# design\nhello'))
  const { person, plugin, reply, call, done } = storer($)
  // the words before a turn's tool calls, of a thread or not, lead up to its last reply
  await person('p1', '# design\nhello')
  await reply('a1', 'Testing the fix live:')
  await call('a2')
  await reply('a3', '# design\nchecking the queue')
  await call('a4')
  await reply('a5', 'It works.\n# design\nthe queue holds')
  await done()
  // the voice saying nothing, and kept as saying nothing (as a reaction is too)
  await person('p2', 'thanks')
  await reply('a6', '(quiet)')
  await done()
  await plugin('w1', WAKE)
  await reply('a7', 'No response requested.')
  await done()
  // a turn's last reply stays though the next turn calls a tool
  await person('p3', 'and now?')
  await reply('a8', 'On it.')
  await done()
  await plugin('w2', WAKE)
  await call('a9')
  await reply('a10', 'Done.')
  await done()
  // others' prompts, though stored as the person's
  await person('o1', 'Thought updates:\n- fix: done')
  await person('o2', WAKE)
  await person('o3', '<task-notification>\n<task-id>b1</task-id>\n</task-notification>')
  await person('o4', 'Another Claude session sent a message:\n[Subagent hand-back] all done')
  await person('o5', '<command-name>/threads</command-name>')
  // a reply a tool call followed, stored again, is still left out
  await reply('a1', 'Testing the fix live:')
  await done()

  for (const surface of ['terminal', 'desktop'] as const) {
    const pane = await $.ui.mount({ plugin: 'thread-chat', surface, ...PANE })
    // none picked: every message, its parts of no thread too
    expect(await sectionsOf(pane)).toEqual([
      'you: hello',
      'Claude: It works.',
      'Claude: the queue holds',
      'you: thanks',
      'you: and now?',
      'Claude: On it.',
      'Claude: Done.',
    ])
    // design picked: its parts alone (the last message the person's /threads, after which
    // the rows of no thread came before it)
    await pressFilter(pane, 'design')
    expect(await sectionsOf(pane)).toEqual(['you: hello', 'Claude: the queue holds'])
    await pressFilter(pane, 'design')
    await pane.unmount()
  }
  // kept so for the session's next run
  expect(rowsIn(kept, files, 'session-1').flatMap(row => (row.interim === true ? [row.id] : []))).toEqual(['a1', 'a3'])
})

test('a session with no rows kept shows the messages its conversation holds, and no others', async ($, on) => {
  const { transcript } = engine(on, { 'session:session-1': { threads: [DESIGN], aliases: {}, snaps: {} } })
  const call = (id: string) => [{ tool_use_id: id, tool: 'Bash', input: {} }]
  const result = (id: string) => [{ tool_use_id: id, text: 'ok' }]
  transcript.push(
    ...([
      { role: 'user', text: '# design\nhello', toolUses: [] },
      { role: 'assistant', text: 'Testing the fix live:', toolUses: call('toolu_1') },
      { role: 'user', text: '', toolUses: [], toolResults: result('toolu_1') },
      { role: 'assistant', text: '# design\nchecking the queue', toolUses: [] },
      { role: 'assistant', text: '', toolUses: call('toolu_2') },
      { role: 'user', text: '', toolUses: [], toolResults: result('toolu_2') },
      { role: 'assistant', text: 'It works.\n# design\nthe queue holds', toolUses: [] },
      { role: 'user', text: 'Thought updates:\n- fix: done', toolUses: [] },
      { role: 'user', text: WAKE, toolUses: [] },
      { role: 'assistant', text: '(quiet)', toolUses: [] },
      { role: 'user', text: 'Another Claude session sent a message:\n[Subagent hand-back] all done', toolUses: [] },
      { role: 'assistant', text: 'No response requested.', toolUses: [] },
    ] as SessionMessage[]),
  )
  await $.session.start({ cwd: '.', surface: 'desktop', isInteractive: true })

  const pane = await $.ui.mount({ plugin: 'thread-chat', surface: 'terminal', ...PANE })
  expect(await sectionsOf(pane)).toEqual(['you: hello', 'Claude: It works.', 'Claude: the queue holds'])
})

// (The kit answers none of the plugin's own scrolls, so the view's move to its end
// as a message comes goes unseen here; where a move leaves it decides whether it does.)
test('the thread view keeps to its end as messages come only while the person has it at or near the end', () => {
  // a window of 20 rows over 60: its end is at row 40
  const at = (offset: number) => isNearEnd({ offset, bodyRows: 20, contentRows: 60 })
  expect([at(40), at(37), at(36), at(10), at(0)]).toEqual([true, true, false, false, false])
  // a tree that fits shows its end wherever the window stands
  expect(isNearEnd({ offset: 0, bodyRows: 20, contentRows: 12 })).toBe(true)
  // where the person leaves it: its end, or their row
  expect([viewPlaceOf({ offset: 38, bodyRows: 20, contentRows: 60 }), viewPlaceOf({ offset: 10, bodyRows: 20, contentRows: 60 })]).toEqual(['end', 10])
})

test('a surface that draws the view afresh at its top is taken back where the person left it', () => {
  // a window of 20 rows; opened, or back on its tab, at the end: to the end
  expect(viewMoveOf('end', undefined, 0, 20)).toEqual({ to: 'end' })
  // left at row 30: to the end first, where the surface measures its rows, then back to row 30
  expect(viewMoveOf(30, undefined, 0, 20)).toEqual({ to: 'end', back: 30 })
  expect(viewMoveOf(30, 30, 40, 20)).toEqual({ to: 30 })
  // nothing where it stands away from the top, or at the top the person left it at
  expect(viewMoveOf('end', undefined, 40, 20)).toBeUndefined()
  expect(viewMoveOf(30, undefined, 30, 20)).toBeUndefined()
  expect(viewMoveOf(0, undefined, 0, 20)).toBeUndefined()
  // nor within a window of the top, where earlier sections come as the person scrolls up
  expect([viewMoveOf(10, undefined, 0, 20), viewMoveOf(20, undefined, 0, 20)]).toEqual([undefined, undefined])
})

// The runtime's own timer, which the kit's typings leave out.
const { setTimeout: later } = globalThis as unknown as { setTimeout: (run: () => void, ms: number) => void }

// (The kit answers none of the plugin's own scrolls; the view's moves back show as the
// waits it asks the clock for, each a move once it is due. The test holds each wait
// itself, as the kit's clock would, so a move of the person's can come before it ends.)
test('the view is taken back where the person left it on opening and on coming back to its tab', async ($, on) => {
  engine(on)
  let moves = 0
  let due: (() => void)[] = []
  on('clock.after', () => {
    moves += 1
    return new Promise(resolve => due.push(() => resolve({ value: undefined })))
  })
  // ends the waits so far, and lets the moves they were for run
  const advance = async () => {
    const now = due
    due = []
    for (const end of now) end()
    await new Promise<void>(resolve => later(resolve, 10))
  }
  await flipThreads($)
  const personTo = (offset: number) =>
    $.ui.scroll({ component: 'Pane', requestId: 'thread-view', offset, by: offset - 40, bodyRows: 20, contentRows: 60, origin: { kind: 'person' } })

  // opened, the desktop draws it at its top: it goes to its end
  const pane = await $.ui.mount({ plugin: 'thread-chat', surface: 'desktop', ...PANE })
  const drawAt = (offset: number) => pane.redraw({ ...PANE.props, scroll: { offset, bodyRows: 20 } })
  await advance()
  await drawAt(40)
  expect(moves).toBe(1)

  // left at row 30, back on its tab at the top: to its end, then from there back to row 30
  await personTo(30)
  await drawAt(30)
  await drawAt(0)
  await advance()
  await drawAt(40)
  await advance()
  await drawAt(30)
  expect(moves).toBe(3)

  // the person's move while a move back waits stands, and no move back follows it
  await drawAt(0)
  await personTo(25)
  await advance()
  await drawAt(40)
  expect(moves).toBe(4)

  // left at the top, or within a window of it, it stays there
  await personTo(0)
  await drawAt(0)
  await personTo(5)
  await drawAt(0)
  await advance()
  expect(moves).toBe(4)
})

// (The desktop reports the move it makes as it draws a shorter view as the person's;
// the engine, keeping to the end, hands it on from the new end. The test holds each wait
// the plugin asks the clock for until it advances. The kit answers none of the plugin's
// own scrolls, so its moves to the end go unseen here.)
test('the view at its end stays there as the desktop draws it shorter', async ($, on) => {
  const { scrolls } = engine(on)
  let due: (() => void)[] = []
  on('clock.after', () => new Promise(resolve => due.push(() => resolve({ value: undefined }))))
  const advance = async () => {
    const now = due
    due = []
    for (const end of now) end()
    await new Promise<void>(resolve => later(resolve, 10))
  }
  await flipThreads($)
  const { person, reply, call } = storer($)
  // a window of 20 rows over 60, its end at row 40, moved by the desktop or the person:
  // where the plugin passes the move on to
  const moveBy = async (by: number) => {
    await $.ui.scroll({ component: 'Pane', requestId: 'thread-view', offset: 40 + by, by, bodyRows: 20, contentRows: 60, origin: { kind: 'person' } })
    return scrolls.at(-1)?.offset
  }

  // a reply a tool call follows is hidden: the desktop's window, pulled up, stays at the end
  await person('p1', 'hello')
  await reply('a1', 'Looking into it:')
  await call('a2')
  expect(await moveBy(-6)).toBe(40)
  // the person's move after it is theirs
  expect(await moveBy(-10)).toBe(30)
  // scrolled up, the view stays where the person put it as it changes
  await reply('a3', 'Found it.')
  expect(await moveBy(-6)).toBe(34)
  // back at the end, once a change is drawn, a move up is the person's
  await moveBy(0)
  await reply('a4', 'Fixed.')
  await advance()
  expect(await moveBy(-6)).toBe(34)
})

// (A wider filter shows sections above those in the window, and the desktop, keeping its
// window on them, moves it down short of the new end: a move it reports as the person's,
// with no pointer. The test holds each wait the plugin asks the clock for until it
// advances; the kit answers none of the plugin's own scrolls, so its moves to the end go
// unseen here.)
test("every change to the view's filter takes it to the newest messages, back to everything too", async ($, on) => {
  const { scrolls } = engine(on)
  let due: (() => void)[] = []
  on('clock.after', () => new Promise(resolve => due.push(() => resolve({ value: undefined }))))
  const advance = async () => {
    const now = due
    due = []
    for (const end of now) end()
    await new Promise<void>(resolve => later(resolve, 10))
  }
  await flipThreads($)
  await $.prompt.submit(say('# design\na\n# perf\nb'))
  const { person, reply } = storer($)
  await person('p1', '# design\nhello')
  await reply('a1', 'the plan\n# perf\nfast')
  await person('p2', 'and then?')
  await reply('a2', '# design\nnext')
  const pane = await $.ui.mount({ plugin: 'thread-chat', surface: 'desktop', ...PANE })
  // a window of 20 rows over the view, `contentRows` long as the desktop lays it out:
  // where the plugin passes on a move of the desktop's, or of the person's wheel
  const move = async (offset: number, by: number, contentRows: number, isWheel = false) => {
    const pointer = isWheel ? { pointer: { column: 1, row: 1 } } : {}
    await $.ui.scroll({ component: 'Pane', requestId: 'thread-view', offset, by, bodyRows: 20, contentRows, origin: { kind: 'person' }, ...pointer })
    return scrolls.at(-1)?.offset
  }

  // design picked: the shorter view's move is kept at its end
  await pressFilter(pane, 'design')
  expect(await move(25, -15, 50)).toBe(30)
  await advance()
  // the last pick let go, everything shown: the desktop's moves as it lays out the longer
  // view, down or none, go to its new end
  await pressFilter(pane, 'design')
  expect(await move(35, 5, 90)).toBe(70)
  expect(await move(70, 0, 95)).toBe(75)
  // the person's wheel meanwhile is theirs, and the desktop's moves after it too
  expect(await move(50, -25, 95, true)).toBe(50)
  expect(await move(53, 3, 95)).toBe(53)
  await advance()

  // a pick from there takes it to the end again, and the desktop's move with it
  await pressFilter(pane, 'perf')
  expect(await move(35, 2, 60)).toBe(40)
  await advance()
  // once that settles, a move up is the person's
  expect(await move(34, -6, 60)).toBe(34)
})

test('the view draws from the start of a message, and keeps its window on what it showed as earlier ones come above', () => {
  // a message of two sections, then 41 of one
  const ids = ['a', 'a', ...Array.from({ length: 41 }, (_, i) => `m${i}`)]
  // the newest 30; from a place asked for, back to the start of its message; never fewer
  expect([drawnFromOf(ids, undefined), drawnFromOf(ids, 1), drawnFromOf(ids, 5), drawnFromOf(ids, 40)]).toEqual([13, 0, 5, 13])
  expect(drawnFromOf(['a', 'a', 'a'], undefined)).toBe(0)
  // the messages before them, a message of several sections once; one with no row each
  expect([messagesBefore(ids, 13), messagesBefore([undefined, undefined, 'x', 'x'], 4)]).toEqual([12, 3])
  // a window at row 14 over 120 rows, sections drawn above it: where it stays, once the
  // surface says the rows they added (240 in all), less a row it was nudged by meanwhile
  expect(grownOffsetOf({ rows: 120, nudge: 0 }, 14, 120)).toBeUndefined()
  expect(grownOffsetOf({ rows: 120, nudge: 0 }, 14, 240)).toBe(134)
  expect(grownOffsetOf({ rows: 120, nudge: 1 }, 15, 240)).toBe(134)
  // the nudge that has a desktop say its rows: down where it can, else up short of the
  // top, else none
  expect([nudgeOf(5, 120, 20), nudgeOf(0, 120, 20), nudgeOf(100, 120, 20), nudgeOf(1, 21, 20), nudgeOf(0, 15, 20)]).toEqual([1, 1, -1, 0, 0])
})

// (The kit answers none of the plugin's own scrolls, and the test holds every wait the
// plugin asks the clock for, so the plugin's moves to keep the window where it was go
// unseen here; the person's moves show where the plugin passes them on. Each is a wheel's,
// which a surface drawing the view shorter does not make.)
function lazyView($: Engine, on: On) {
  const { scrolls } = engine(on)
  on('clock.after', () => new Promise(() => {}))
  const settle = () => new Promise<void>(resolve => later(resolve, 10))
  const moveTo = async (offset: number, by: number, contentRows: number) => {
    const pointer = { column: 1, row: 1 }
    await $.ui.scroll({ component: 'Pane', requestId: 'thread-view', offset, by, bodyRows: 20, contentRows, origin: { kind: 'person' }, pointer })
    await settle()
    return scrolls.at(-1)?.offset
  }
  return { moveTo, settle }
}

test('the view draws its newest messages, and earlier ones as the person scrolls near its top or presses the line of them', async ($, on) => {
  const { moveTo, settle } = lazyView($, on)
  await flipThreads($)
  const { person } = storer($)
  for (let i = 0; i < 70; i++) await person(`p${i}`, `message ${i}`)
  const pane = await $.ui.mount({ plugin: 'thread-chat', surface: 'desktop', ...PANE })
  const shown = async () => {
    const sections = await sectionsOf(pane)
    return [sections.length, sections[0], (await pane.find({ key: EARLIER_KEY }))?.text]
  }

  // the newest 30, under a line saying how many messages come before them
  expect(await shown()).toEqual([30, 'you: message 40', '40 earlier messages'])
  // scrolled up, short of the top: as it was
  expect(await moveTo(50, -50, 120)).toBe(50)
  expect(await shown()).toEqual([30, 'you: message 40', '40 earlier messages'])
  // within a window of the top: 30 more above
  expect(await moveTo(15, -35, 120)).toBe(15)
  expect(await shown()).toEqual([60, 'you: message 10', '10 earlier messages'])
  // once the surface says the rows they added, the person's move goes down by them, then
  // as it comes
  expect(await moveTo(14, -1, 240)).toBe(134)
  expect(await moveTo(130, -4, 240)).toBe(130)
  // the line pressed: the rest
  await pane.press({ key: EARLIER_KEY })
  await settle()
  expect(await shown()).toEqual([70, 'you: message 0', undefined])
  // opened again: the newest 30
  await $.command.run({ command: 'thread-view', args: '', origin: { kind: 'composer' }, presentation: {} as never })
  await settle()
  expect(await shown()).toEqual([30, 'you: message 40', '40 earlier messages'])
})

// (As above, the plugin's own scrolls go unseen and every wait is held. A move of the
// window that the plugin times is a wait of 100ms it asks the clock for: the test counts
// those, the move to the end and back a surface drawing the view afresh has among them.)
test('near its top as earlier messages come, the view stays there as the desktop draws it at its top', async ($, on) => {
  const { scrolls } = engine(on)
  let moves = 0
  on('clock.after', ($, e) => {
    if (e.ms === 100) moves += 1
    return new Promise(() => {})
  })
  const settle = () => new Promise<void>(resolve => later(resolve, 10))
  const moveTo = async (offset: number, by: number, contentRows: number) => {
    const pointer = { column: 1, row: 1 }
    await $.ui.scroll({ component: 'Pane', requestId: 'thread-view', offset, by, bodyRows: 20, contentRows, origin: { kind: 'person' }, pointer })
    await settle()
    return scrolls.at(-1)?.offset
  }
  await flipThreads($)
  const { person } = storer($)
  for (let i = 0; i < 70; i++) await person(`p${i}`, `message ${i}`)
  const pane = await $.ui.mount({ plugin: 'thread-chat', surface: 'desktop', ...PANE })
  const drawAt = async (offset: number) => {
    await pane.redraw({ ...PANE.props, scroll: { offset, bodyRows: 20 } })
    await settle()
  }

  // scrolled up within a window of the top: 30 more above, drawn
  await moveTo(50, -50, 120)
  await drawAt(50)
  expect(await moveTo(15, -35, 120)).toBe(15)
  await drawAt(15)
  expect((await sectionsOf(pane)).length).toBe(60)
  const before = moves
  // the desktop draws them with its window at the top, where the person scrolled: it stays
  await drawAt(0)
  expect(moves).toBe(before)
  // the person's move goes down by the rows they added; the desktop draws the view at the
  // top before it takes that move: it stays
  expect(await moveTo(14, -1, 240)).toBe(134)
  await drawAt(0)
  expect(moves).toBe(before)
  // a while later, a drawing at the top is the desktop's afresh: to the end, then back
  await new Promise<void>(resolve => later(resolve, 600))
  await drawAt(0)
  expect(moves).toBe(before + 1)
})

test('scrolled up, the view keeps what it draws as messages come; at its end, the newest', async ($, on) => {
  const { moveTo, settle } = lazyView($, on)
  await flipThreads($)
  const { person } = storer($)
  for (let i = 0; i < 40; i++) await person(`p${i}`, `message ${i}`)
  const pane = await $.ui.mount({ plugin: 'thread-chat', surface: 'desktop', ...PANE })
  const shown = async () => {
    const sections = await sectionsOf(pane)
    return [sections.length, sections[0]]
  }
  expect(await shown()).toEqual([30, 'you: message 10'])
  // at its end, a message: the newest 30
  await person('p40', 'message 40')
  await settle()
  expect(await shown()).toEqual([30, 'you: message 11'])
  // scrolled up: those drawn stay, new ones below them
  await moveTo(40, -20, 120)
  await person('p41', 'message 41')
  await settle()
  expect(await shown()).toEqual([31, 'you: message 11'])
})

// A PNG's first bytes, base64: its signature and the header naming its size.
function pngOf(width: number, height: number) {
  const word = (n: number) => String.fromCharCode((n >>> 24) & 255, (n >>> 16) & 255, (n >>> 8) & 255, n & 255)
  return btoa(`\x89PNG\r\n\x1a\n${word(13)}IHDR${word(width)}${word(height)}\x08\x06\x00\x00\x00`)
}

// A JPEG of 300 by 225 pixels, as small as one goes: its start, its frame's size, its end.
const THUMB = btoa(`\xff\xd8\xff\xc0\x00\x11\x08\x00\xe1\x01\x2c\x03${'\x00'.repeat(9)}\xff\xd9`)

// The clock, answering each wait at once: the view reads pictures once it is drawn.
const waitNot = (on: On) => on('clock.after', () => ({ value: undefined }))

// The view's pictures as drawn once those it waits for are read: each card's size and
// what it holds (the picture's media type, `empty` while it is read), or `[image]`.
async function picturesIn(pane: { findAll: (query: { type: string }) => Promise<{ type: string; props: Record<string, unknown>; text?: string }[]> }) {
  const shown = async () =>
    (await pane.findAll({ type: 'Svg' }))
      .filter(svg => svg.props.alt === 'Pasted image')
      .map(svg => {
        const type = /href="data:([^;]+);base64,/.exec(String(svg.props.source))?.[1] ?? 'empty'
        return `${String(svg.props.width)}x${String(svg.props.height)} ${type}`
      })
  // the files are read in the background, the view drawn again once they are
  for (let i = 0; i < 50 && (await shown()).some(card => card.endsWith('empty')); i++) for (let j = 0; j < 100; j++) await Promise.resolve()
  const marks = (await pane.findAll({ type: 'Text' })).filter(t => t.text === '[image]')
  return [...(await shown()), ...marks.map(() => '[image]')]
}

test('the pictures pasted with a message draw above it from their files: thumbnails on a page, marks on the terminal', async ($, on) => {
  const { kept, files, bytes, runs } = engine(on)
  waitNot(on)
  await flipThreads($)
  const shot = pngOf(400, 300)
  // more than the desktop's largest picture takes
  const huge = `${pngOf(1600, 1200)}${'A'.repeat(140_000)}`
  bytes['/pics/shot.png'] = shot
  bytes['/pics/huge.png'] = huge
  const image = (data: string): Block => ({ type: 'image', source: { type: 'base64', media_type: 'image/png', data } })
  const append = (uuid: string, content: Block[], isMeta?: true) =>
    $.session
      .append({ message: { type: 'user', role: 'user', content, ...(isMeta && { isMeta }) }, door: 'prompt', origin: { kind: 'composer' }, uuid })
      .catch(() => undefined)
  // Claude Code names each picture's file in a hidden row after the message
  const sources = (uuid: string, paths: string[]) => append(uuid, paths.map(path => ({ type: 'text', text: `[Image: source: ${path}]` })), true)
  await append('p1', [image(shot), image(huge), image(shot), { type: 'text', text: 'look at this' }])
  await sources('m1', ['C:\\pics\\shot.png', 'C:\\pics\\huge.png', 'C:\\pics\\gone.png'])
  await append('p2', [image(shot)])
  // a hidden row of other words names no file
  await append('m2', [{ type: 'text', text: '[Image: source: C:\\pics\\other.png] and more' }], true)
  await sources('m3', ['C:\\pics\\shot.png'])
  // nor does one after the message's own
  await sources('m4', ['C:\\pics\\late.png'])

  // kept with their messages for the session's next run: each one's size and file, not its bytes
  await $.turn.complete({ answer: '', durationMs: 1, isAborted: false, turnId: 't1', reason: 'answer' })
  expect(rowsIn(kept, files, 'session-1').map(row => row.images)).toEqual([
    [
      { type: 'image/png', width: 400, height: 300, path: 'C:\\pics\\shot.png' },
      { type: 'image/png', width: 1600, height: 1200, path: 'C:\\pics\\huge.png' },
      { type: 'image/png', width: 400, height: 300, path: 'C:\\pics\\gone.png' },
    ],
    [{ type: 'image/png', width: 400, height: 300, path: 'C:\\pics\\shot.png' }],
  ])

  for (const surface of ['terminal', 'desktop'] as const) {
    const pane = await $.ui.mount({ plugin: 'thread-chat', surface, ...PANE })
    // the words in a bubble; a message of pictures alone has none
    expect(await sectionsOf(pane)).toEqual(['you: look at this'])
    if (surface === 'terminal') {
      expect(await picturesIn(pane)).toEqual(['[image]', '[image]', '[image]', '[image]'])
      expect(runs.length).toBe(0)
    } else {
      // cards 200 pixels across, as tall as the picture's shape, at the right: one too
      // large to draw from a smaller copy; a mark for a file gone
      expect(await picturesIn(pane)).toEqual(['200x150 image/png', '200x150 image/jpeg', '200x150 image/png', '[image]'])
      const cards = (await pane.findAll({ type: 'Svg' })).map(svg => String(svg.props.source))
      expect(cards[0]).toContain(`href="data:image/png;base64,${shot}"`)
      expect(cards[1]).toContain(`href="data:image/jpeg;base64,${THUMB}"`)
      expect((await pane.findAll({ type: 'Box' })).some(b => b.props.flexWrap === 'wrap' && b.props.justifyContent === 'flex-end')).toBe(true)
      // the smaller copy made once, by PowerShell on Windows, under the plugin's data folder
      expect(runs.map(run => [run.argv[0], JSON.parse(run.env.THREAD_CHAT_THUMBS ?? '[]')])).toEqual([
        ['powershell.exe', [{ from: 'C:\\pics\\huge.png', to: expect.stringMatching(/^\/config\/plugins\/data\/thread-chat-inline\/thumbs\/[0-9a-f]{8}-.*\.jpg$/) }]],
      ])
    }
    await pane.unmount()
  }
})

// A PNG of the given size in pixels whose file comes to `chars` base64 characters.
const pngOfChars = (width: number, height: number, chars: number) => {
  const word = (n: number) => String.fromCharCode((n >>> 24) & 255, (n >>> 16) & 255, (n >>> 8) & 255, n & 255)
  const head = `\x89PNG\r\n\x1a\n${word(13)}IHDR${word(width)}${word(height)}\x08\x06\x00\x00\x00`
  return btoa(head + '\x00'.repeat(Math.floor((chars * 3) / 4) - head.length))
}

// The desktop draws nothing of a view whose drawing holds too much picture data, saying
// only that the plugin has not drawn there: the view went blank once it drew a dozen.
test('the view draws the pictures nearest its window within what the desktop draws, the rest as empty cards', async ($, on) => {
  const { bytes } = engine(on)
  waitNot(on)
  await flipThreads($)
  const shot = pngOfChars(400, 300, 24_000)
  const append = (uuid: string, content: Block[], isMeta?: true) =>
    $.session
      .append({ message: { type: 'user', role: 'user', content, ...(isMeta && { isMeta }) }, door: 'prompt', origin: { kind: 'composer' }, uuid })
      .catch(() => undefined)
  for (let i = 0; i < 6; i++) {
    bytes[`/pics/${i}.png`] = shot
    await append(`p${i}`, [{ type: 'image', source: { type: 'base64', media_type: 'image/png', data: shot } }, { type: 'text', text: `look ${i}` }])
    await append(`m${i}`, [{ type: 'text', text: `[Image: source: C:\\pics\\${i}.png]` }], true)
  }

  const pane = await $.ui.mount({ plugin: 'thread-chat', surface: 'desktop', ...PANE })
  // at its end: the newest three fit, oldest first in the view
  expect(await picturesIn(pane)).toEqual([
    '200x150 empty',
    '200x150 empty',
    '200x150 empty',
    '200x150 image/png',
    '200x150 image/png',
    '200x150 image/png',
  ])
  const drawn = (await pane.findAll({ type: 'Svg' })).map(svg => /base64,([^"]*)"/.exec(String(svg.props.source))?.[1]?.length ?? 0)
  expect(drawn.reduce((sum, n) => sum + n, 0)).toBeLessThanOrEqual(PICTURE_CHARS_DRAWN)
})

test('the pictures nearest the window draw first, and those past the room are not read', () => {
  const images = [0, 1, 2, 3].map(i => ({ type: 'image/png', path: `C:\\pics\\${i}.png` }))
  const sections = images.map(image => [image])
  const read: string[] = []
  const pictureOf = (image: ViewImage) => {
    read.push(image.path ?? '')
    return { type: 'image/png', data: 'A'.repeat(40) }
  }
  const at = (near: number) => {
    read.length = 0
    const drawn = picturesNear(sections, near, 80, pictureOf)
    return images.map(image => (drawn.get(image) === 'loading' ? 'empty' : 'drawn'))
  }
  expect(at(1)).toEqual(['empty', 'empty', 'drawn', 'drawn'])
  expect(read).toEqual(['C:\\pics\\3.png', 'C:\\pics\\2.png'])
  expect(at(0)).toEqual(['drawn', 'drawn', 'empty', 'empty'])
  expect(at(1 / 3)).toEqual(['empty', 'drawn', 'drawn', 'empty'])
})

test('pictures kept by an earlier version draw from their bytes; files a repair noted in the kept rows are taken up', async ($, on) => {
  const shot = pngOf(400, 300)
  const rows: ViewRow[] = [
    { id: 'a', role: 'user', mark: 'a', text: 'a', images: [{ type: 'image/png', width: 400, height: 300, data: shot }, { type: 'image/png' }] },
    { id: 'b', role: 'user', mark: 'b', text: 'b' },
    { id: 'c', role: 'assistant', mark: 'c', text: 'c' },
  ]
  const { note, files: seed } = keptAs('session-1', rows)
  const { kept, files, bytes } = engine(on, { 'session:session-1': { isOn: true, threads: [], aliases: {}, snaps: {} }, 'view:session-1': note }, seed)
  waitNot(on)
  bytes['/pics/b.png'] = pngOf(100, 50)
  await $.session.start({ cwd: '.', surface: 'desktop', isInteractive: true })

  const pane = await $.ui.mount({ plugin: 'thread-chat', surface: 'desktop', ...PANE })
  expect(await picturesIn(pane)).toEqual(['200x150 image/png', '[image]'])
  await pane.unmount()

  // a repair of the kept rows names the files of pictures this run's rows lack
  const repaired = keptAs('session-1', [rows[0] as ViewRow, { ...(rows[1] as ViewRow), images: [{ type: 'image/png', path: 'C:\\pics\\b.png' }] }, rows[2] as ViewRow])
  Object.assign(files, repaired.files)
  await $.session
    .append({ message: { type: 'assistant', role: 'assistant', content: [{ type: 'text', text: 'd' }] }, door: 'response', origin: model, uuid: 'd' })
    .catch(() => undefined)
  await $.turn.complete({ answer: '', durationMs: 1, isAborted: false, turnId: 't1', reason: 'answer' })
  // kept, not written over, and drawn: a picture of no known size takes its file's shape
  expect(rowsIn(kept, files, 'session-1').map(row => row.images)).toEqual([
    rows[0]?.images,
    [{ type: 'image/png', path: 'C:\\pics\\b.png' }],
    undefined,
    undefined,
  ])
  const again = await $.ui.mount({ plugin: 'thread-chat', surface: 'desktop', ...PANE })
  expect(await picturesIn(again)).toEqual(['200x150 image/png', '100x50 image/png', '[image]'])
})

test('rows are kept one per id, every one, and read back from their files as written', async () => {
  const row = (id: string, text: string): ViewRow => ({ id, role: 'assistant', mark: markOf(text), text })
  const rows = [row('a', '12345'), { ...row('b', '67890'), role: 'user' as const, typed: 3 }, row('c', 'abcde')]
  // a row stored again takes its own place, not another
  expect(withViewRow(rows, row('b', 'again')).map(known => `${known.id}: ${known.text ?? ''}`)).toEqual(['a: 12345', 'b: again', 'c: abcde'])
  // however many there are, none goes
  let many: ViewRow[] = []
  for (let i = 0; i < 1500; i++) many = withViewRow(many, row(`r${i}`, `text ${i}`))
  expect(many.length).toBe(1500)

  // files of at most `size` characters; a long text in pieces of `piece`, cut even
  // inside a character a pair of code units make
  const long = row('d', `${'x'.repeat(26)}\n"quoted"${'\u{1F600}'.repeat(5)}`)
  const all: ViewRow[] = [...rows, long, { id: 'e', role: 'user', mark: 'e' }]
  const chunks = chunksOf(all, 200, 10)
  expect(chunks.length > 1).toBe(true)
  expect(chunks.every(chunk => chunk.length <= 200)).toBe(true)
  expect(rowsOfChunks(chunks)).toEqual(all)
  // a line cut short is passed over
  expect(rowsOfChunks([...chunks, '{"id":"f","role":"assi'])).toEqual(all)

  // the plugin's data folder: Claude Code's name for it, beside its other plugins'
  expect(dataFolderOf('C:\\Users\\me\\.claude\\plugins\\cache\\claude-multitask\\thread-chat\\0.1.0', 'thread-chat', '/elsewhere')).toBe(
    'C:\\Users\\me\\.claude/plugins/data/thread-chat-claude-multitask',
  )
  expect(dataFolderOf('/home/me/src/thread-chat', 'thread-chat', '/home/me/.claude/')).toBe('/home/me/.claude/plugins/data/thread-chat-inline')
  expect(dataFolderOf('/home/me/src/thread-chat', 'thread-chat', undefined)).toBeUndefined()

  // a conversation that holds none of the rows (not read yet) cuts none
  expect(rowsUpTo(rows, [])).toEqual(rows)
})
