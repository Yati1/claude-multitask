import type { On } from 'claude-code'
import { expect, mock, test } from 'claude-code/testing'
import type { Engine } from 'claude-code/testing'

import { markOf } from '../hooks/pane'
import {
  PALETTE,
  closestThread,
  headingsIn,
  leadingQuoteOf,
  rewriteHeadings,
  splitSections,
  withOpeningQuote,
} from '../hooks/parse'

// The test stands in for the engine beneath the plugin, and records the prompts
// that reach it, each with the notes beside it, and in `registered` the tools the mod
// offers the model. `store` seeds the mod store; `null` leaves the store to the test.
// A message whose text `isHidden` names is drawn as nothing, as a plugin beneath
// (multitask) may.
function engine(
  on: On,
  store: Record<string, unknown> | null = {},
  isHidden: (text: string) => boolean = () => false,
  registered: string[] = [],
): string[] {
  const prompts: string[] = []
  // the welcome line dismissed: welcome.test.ts covers it
  if (store !== null) mock.store(on, { welcome: ['thread-chat'], ...store })
  on('session.id', () => ({ value: 'session-1' }))
  on('session.start', ($, e) => ({ cwd: e.cwd }))
  on('prompt.submit', ($, e) => {
    prompts.push([e.text, ...(e.context ?? [])].join('\n--\n'))
    return { text: e.text }
  })
  on('tool.register', ($, e) => {
    registered.push(e.name)
    return { value: { tool: `mcp__thread-chat__${e.name}` } }
  })
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

// The settings `/threads` sets by name: whether the agent may start threads, and whether
// the chat is filtered to the picked thread; each by its label in `/threads status`.
const AGENT_SWITCH = 'agent'
const FILTER_SWITCH = 'filter'
const SETTING_LABELS: Record<string, string> = { agent: 'Agent may start threads', filter: 'Filter the chat' }

type Band = {
  find: (query: { key: string }) => Promise<{ props: Record<string, unknown> } | undefined>
  press: (target: { key: string }) => Promise<unknown>
  redraw: () => Promise<unknown>
}

// A setting as `/threads status` says it: 'on' or 'off'.
async function switchOf($: Engine, word: string) {
  const { text = '' } = await runThreads($, 'status')
  return new RegExp(`${SETTING_LABELS[word]}: (on|off)`).exec(text)?.[1]
}

// Flips a setting, with `/threads <word> on|off`.
async function flipSwitch($: Engine, word: string) {
  return runThreads($, `${word} ${(await switchOf($, word)) === 'on' ? 'off' : 'on'}`)
}

// `/threads manage`, and its output row drawn: the threads' panel.
let manageRuns = 0
async function managePanel($: Engine, surface: 'terminal' | 'desktop' = 'terminal') {
  const { text = '' } = await runThreads($, 'manage')
  manageRuns += 1
  const props = { command: 'threads', args: 'manage', text, isErrored: false }
  return $.ui.mount({ plugin: 'thread-chat', surface, component: 'CommandOutput', props, requestId: `manage-${manageRuns}` })
}

// The band's `+`, pressed: a Button on the terminal, a click on its hit area on the desktop.
async function pressNew(band: Band & { pointer: (p: never) => Promise<unknown> }, surface: 'terminal' | 'desktop') {
  if (surface === 'terminal') return band.press({ key: 'threads:new' })
  return band.pointer({ type: 'down', x: 1, y: 0, button: 'left', in: 'band:threads:new' } as never)
}

// The band's thread picker: a Select of the threads to post to, then "No thread"; a
// thread's option is `thread:` and its key. Not drawn while there are no threads to post to.
const PICKER = 'thread-picker'
type Option = { value: string; label?: string }
type Picker = { find: (query: { key: string }) => Promise<{ props: Record<string, unknown> } | undefined> }
const optionsOf = async (band: Picker) => ((await band.find({ key: PICKER }))?.props.options ?? []) as Option[]

// The keys of the threads the picker offers, in order.
const choiceKeys = async (band: Picker) =>
  (await optionsOf(band)).flatMap(o => (o.value.startsWith('thread:') ? [o.value.slice('thread:'.length)] : []))

// The names of the threads the picker offers, in order.
const choicesIn = async (band: Picker) =>
  (await optionsOf(band)).flatMap(o => (o.value.startsWith('thread:') ? [String(o.label)] : []))

// The picker's face: the label of the option it shows; undefined where it is not drawn.
async function pickerLabel(band: Picker) {
  const value = (await band.find({ key: PICKER }))?.props.value
  return (await optionsOf(band)).find(o => o.value === value)?.label
}

// Picks a thread in the band's thread picker ('' no thread): messages with no heading go
// to it.
async function pickIn(band: { select: (target: { key: string; value: string }) => Promise<unknown> }, surface: 'terminal' | 'desktop', key: string) {
  void surface
  await band.select({ key: PICKER, value: key === '' ? 'none' : `thread:${key}` })
}

// The person's /threads, which turns threads on in the chat, or off again.
const flipThreads = ($: Engine) =>
  $.command.run({ command: 'threads', args: 'toggle', origin: { kind: 'composer' }, presentation: {} as never })

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

test('a quoted selection opening a message, right before a thread heading, joins that thread', async () => {
  const isThread = (name: string) => name !== 'Summary'
  const split = (text: string) => withOpeningQuote(splitSections(text, () => true), isThread)
  // two selections back to back, as the desktop writes them on Windows
  const quotes = '<!-- reply 2 -->\r\n> invisible\r\n>\r\n> on light\r\n<!-- reply -->\r\n> fast'
  expect(split(`\r\n${quotes}\r\n\r\n# perf\r\nabout speed\r\n# design\r\nmore`)).toEqual([
    { thread: 'perf', text: `${quotes}\n\nabout speed` },
    { thread: 'design', text: 'more' },
  ])
  expect(split('<!-- reply 1 -->\n> invisible\n\n# perf')).toEqual([{ thread: 'perf', text: '<!-- reply 1 -->\n> invisible' }])

  // words of the person's own, a quote of their own with no marker, a heading that is
  // no thread's, or no heading at all: the opening text stays unthreaded
  for (const text of [
    '<!-- reply 1 -->\n> invisible\n\nfix it\n# perf\nb',
    '<!-- reply 1 -->\n> invisible\nfix it\n# perf\nb',
    '> invisible\n\n# perf\nb',
    'intro\n# perf\nb',
    '<!-- reply 1 -->\n> invisible\n\n# Summary\nb',
    '<!-- reply 1 -->\n> invisible',
  ]) {
    expect(split(text)).toEqual(splitSections(text, () => true))
  }

  expect(leadingQuoteOf('<!-- reply 1 -->\r\n> use a\r\n> queue\r\n**why** a queue?')).toEqual({
    quote: '<!-- reply 1 -->\r\n> use a\r\n> queue',
    rest: '**why** a queue?',
  })
  expect(leadingQuoteOf('> mine\n\nwords')).toBeUndefined()
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
  await flipThreads($)
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
  expect(await choiceKeys(band)).toContain('thread')
  expect(await choiceKeys(band)).not.toContain('thrads')

  for (const surface of ['terminal', 'desktop'] as const) {
    const row = await $.ui.mount({ plugin: 'thread-chat', surface, ...userRow('#thrads\nc\n#multi\nd') })
    expect(await tagOf(row, 'Threads')).toBeDefined()
    expect(await tagOf(row, 'Multitasking')).toBeDefined()
    await row.unmount()
  }
})

test('a merged thread draws as the one it joined', async ($, on) => {
  engine(on)
  await flipThreads($)
  await $.prompt.submit(say('# design\na\n# perf\nb'))
  const merged = await $.command.run({
    command: 'merge-threads',
    args: 'perf into design',
    origin: { kind: 'composer' },
    presentation: {} as never,
  })
  expect(merged.text).toContain('Merged thread "perf" into "design"')

  const band = await $.ui.mount({ plugin: 'thread-chat', surface: 'terminal', ...BAND })
  expect(await choiceKeys(band)).not.toContain('perf')
  const old = await $.ui.mount({ plugin: 'thread-chat', surface: 'terminal', ...assistantRow('# perf\nfast') })
  expect(await tagOf(old, 'design')).toBeDefined()
})

test("with the chat's filter off, as at first, the chat shows every row and every thread whichever thread is picked", async ($, on) => {
  engine(on)
  await flipThreads($)
  await $.prompt.submit(say('# design\nhello\n#perf\nfast?'))

  for (const surface of ['terminal', 'desktop'] as const) {
    const band = await $.ui.mount({ plugin: 'thread-chat', surface, ...BAND })
    expect(await switchOf($, FILTER_SWITCH)).toBe('off')
    const reply = await $.ui.mount({
      plugin: 'thread-chat',
      surface,
      ...assistantRow('top line\n# design\nuse a queue\n# perf\nit is fine'),
    })
    const plain = await $.ui.mount({ plugin: 'thread-chat', surface, ...assistantRow('just chatting') })
    const mine = await $.ui.mount({ plugin: 'thread-chat', surface, ...userRow('# perf\nmine') })
    const call = await $.ui.mount({ plugin: 'thread-chat', surface, ...toolRow('toolu_1') })

    for (const key of ['', 'design', 'perf']) {
      if (key !== '') await pickIn(band, surface, key)
      for (const row of [reply, plain, mine, call]) await row.redraw()
      expect(await reply.find({ text: /top line/ })).toBeDefined()
      expect(await tagOf(reply, 'design')).toBeDefined()
      expect(await tagOf(reply, 'perf')).toBeDefined()
      expect(await plain.find({ text: /just chatting/ })).toBeDefined()
      expect(await tagOf(mine, 'perf')).toBeDefined()
      expect(await mine.find({ text: /mine/ })).toBeDefined()
      // tool rows are the engine's own, never hidden
      expect(((await call.drawn()) as { type: string }).type).toBe('engine')
    }
    await pickIn(band, surface, '')
    for (const site of [band, reply, plain, mine, call]) await site.unmount()
  }
})

const isHidden = async (drawing: { drawn: () => Promise<unknown> }) =>
  ((await drawing.drawn()) as { props?: { display?: string } }).props?.display === 'none'

test("with the chat's filter on, the chat keeps to the picked thread, and rows of no thread show only since the last message", async ($, on) => {
  engine(on)
  await flipThreads($)
  await $.prompt.submit(say('# design\nhello\n# perf\nfast?'))

  const model = { kind: 'model', model: 'test' } as const
  const stored = (uuid: string, door: 'prompt' | 'response', content: { type: string; [field: string]: unknown }[]) =>
    $.session.append({
      message: door === 'prompt' ? { type: 'user', role: 'user', content } : { type: 'assistant', role: 'assistant', content },
      door,
      origin: door === 'prompt' ? { kind: 'composer' } : model,
      uuid,
    })
  // an earlier exchange
  await stored('p1', 'prompt', [{ type: 'text', text: '# design\nhello\n# perf\nfast?' }])
  await stored('a1', 'response', [{ type: 'text', text: 'just chatting' }])
  await stored('a2', 'response', [{ type: 'tool_use', id: 'toolu_old', name: 'Read', input: {} }])
  await stored('a3', 'response', [{ type: 'text', text: 'top line\n# design\nuse a queue\n# perf\nit is fine' }])
  // the latest
  await stored('p2', 'prompt', [{ type: 'text', text: 'what now?' }])
  await stored('a4', 'response', [{ type: 'tool_use', id: 'toolu_new', name: 'Read', input: {} }])
  await stored('a5', 'response', [{ type: 'text', text: 'here goes\n# design\nnext step' }])
  await stored('a6', 'response', [{ type: 'text', text: 'one more thing' }])

  for (const surface of ['terminal', 'desktop'] as const) {
    const mount = <T extends object>(target: T) => $.ui.mount({ plugin: 'thread-chat', surface, ...target } as never)
    const mine = await mount({ ...userRow('# design\nhello\n# perf\nfast?'), requestId: 'p1' })
    const oldChat = await mount({ ...assistantRow('just chatting'), requestId: 'a1' })
    const oldTool = await mount(toolRow('toolu_old'))
    const oldReply = await mount({ ...assistantRow('top line\n# design\nuse a queue\n# perf\nit is fine'), requestId: 'a3' })
    const ask = await mount({ ...userRow('what now?'), requestId: 'p2' })
    const newTool = await mount(toolRow('toolu_new'))
    const reply = await mount({ ...assistantRow('here goes\n# design\nnext step'), requestId: 'a5' })
    // the desktop knows a reply by its API message's id, so it is matched by its text
    const aside = await mount({ ...assistantRow('one more thing'), requestId: 'msg_01abc-t0' })
    const rows = [mine, oldChat, oldTool, oldReply, ask, newTool, reply, aside]
    const band = await $.ui.mount({ plugin: 'thread-chat', surface, ...BAND })
    const redraw = async () => {
      for (const row of rows) await row.redraw()
    }
    // Whether every row of the chat shows: none hidden, every section drawn.
    const isWhole = async () =>
      (await mine.find({ text: /fast/ })) !== undefined &&
      (await oldChat.find({ text: /just chatting/ })) !== undefined &&
      !(await isHidden(oldTool)) &&
      (await oldReply.find({ text: /top line/ })) !== undefined &&
      (await tagOf(oldReply, 'perf')) !== undefined

    // the filter on with no thread picked (the message's last heading picked perf): every row shows
    await pickIn(band, surface, '')
    await flipSwitch($, FILTER_SWITCH)
    await band.redraw()
    expect(await switchOf($, FILTER_SWITCH)).toBe('on')
    await redraw()
    expect(await isWhole()).toBe(true)

    // design picked: other threads' parts go, and rows of no thread before the last message
    // (the kit has no chat to scroll, so the move to its end goes unseen here)
    await pickIn(band, surface, 'design')
    await redraw()
    expect(await mine.find({ text: /hello/ })).toBeDefined()
    expect(await mine.find({ text: /fast/ })).toBeUndefined()
    expect(await oldChat.find({ text: /just chatting/ })).toBeUndefined()
    expect(await isHidden(oldTool)).toBe(true)
    expect(await oldReply.find({ text: /top line/ })).toBeUndefined()
    expect(await tagOf(oldReply, 'design')).toBeDefined()
    expect(await tagOf(oldReply, 'perf')).toBeUndefined()
    expect(await ask.find({ text: /what now/ })).toBeDefined()
    expect(await isHidden(newTool)).toBe(false)
    expect(await reply.find({ text: /here goes/ })).toBeDefined()
    expect(await tagOf(reply, 'design')).toBeDefined()
    expect(await aside.find({ text: /one more thing/ })).toBeDefined()

    // perf picked: the chat follows the picker
    await pickIn(band, surface, 'perf')
    await redraw()
    expect(await tagOf(oldReply, 'design')).toBeUndefined()
    expect(await tagOf(oldReply, 'perf')).toBeDefined()
    expect(await mine.find({ text: /hello/ })).toBeUndefined()

    // the filter off again, the pick standing: every row shows
    await flipSwitch($, FILTER_SWITCH)
    await band.redraw()
    expect(await switchOf($, FILTER_SWITCH)).toBe('off')
    await redraw()
    expect(await isWhole()).toBe(true)

    for (const site of [...rows, band]) await site.unmount()
  }
})

test('the model is told how threads work once they are on, of merges and the agent switch as they change, and all again after a compaction', async ($, on) => {
  const prompts = engine(on)
  await $.session.start({ cwd: '.', surface: 'terminal', isInteractive: true })
  // With threads off there is nothing to tell.
  await $.prompt.submit(say('hello'))
  expect(prompts.at(-1)).toBe('hello')
  await flipThreads($)
  await $.prompt.submit(say('# design\na\n# perf\nb'))
  expect(prompts.at(-1)).toContain('\n--\n# Conversation threads\n')
  // its last heading picked perf; with no thread picked, nothing goes beside a message with no heading
  const band = await $.ui.mount({ plugin: 'thread-chat', surface: 'terminal', ...BAND })
  await pickIn(band, 'terminal', '')
  await $.prompt.submit(say('more'))
  expect(prompts.at(-1)).toBe('more')

  // A merge and the agent switch reach the model beside the next message, once.
  await $.command.run({ command: 'merge-threads', args: 'perf into design', origin: { kind: 'composer' }, presentation: {} as never })
  await flipSwitch($, AGENT_SWITCH)
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

test('with no threads the band says how to start one; /threads agent gates the tool', async ($, on) => {
  engine(on)
  await flipThreads($)
  await $.session.start({ cwd: '.', surface: 'desktop', isInteractive: true })
  const tool = 'mcp__thread-chat__create_thread'

  const band = await $.ui.mount({ plugin: 'thread-chat', surface: 'desktop', ...BAND })
  expect(await band.find({ text: /start a thread with # name/ })).toBeDefined()
  expect(await switchOf($, AGENT_SWITCH)).toBe('off')

  const refused = await $.tool.call({ tool, tool_use_id: 't1', name: 'ideas' })
  expect(refused.deny).toBeDefined()

  await flipSwitch($, AGENT_SWITCH)
  const made = await $.tool.call({ tool, tool_use_id: 't2', name: 'ideas' })
  expect(made.deny).toBeUndefined()
  await band.redraw()
  expect(await switchOf($, AGENT_SWITCH)).toBe('on')
  expect(await choiceKeys(band)).toContain('ideas')
  expect(await band.find({ text: /start a thread/ })).toBeUndefined()
})

test('until /threads turns threads on, a session is left as it is: its rows, its prompts, its band, and its tools', async ($, on) => {
  // what the mod offers the model
  const registered: string[] = []
  const prompts = engine(on, {}, undefined, registered)
  await $.session.start({ cwd: '.', surface: 'desktop', isInteractive: true })
  expect(registered).toEqual([])

  // its rows are the engine's drawing alone: no tag, no "+ thread", no room for one
  const drawnAlone = async (row: Row) => {
    const drawing = await $.ui.mount({ plugin: 'thread-chat', surface: 'desktop', ...row })
    const tree = await drawing.drawn()
    await drawing.unmount()
    return { type: (tree as { type: string }).type, ...chromeIn(tree) }
  }
  for (const row of [userRow('plain words'), userRow('# design\na'), assistantRow('plain reply')]) {
    expect(await drawnAlone(row)).toEqual({ type: 'Text', ...noChrome })
  }
  // its prompts go on as typed, with nothing beside them: a heading is plain text
  await $.prompt.submit(say('# design\na'))
  expect(prompts.at(-1)).toBe('# design\na')
  // its band is the engine's alone, nothing of the mod's in it, on every surface; the model starts no thread
  for (const surface of ['terminal', 'mobile'] as const) {
    const drawing = await $.ui.mount({ plugin: 'thread-chat', surface, ...BAND })
    expect(await drawing.drawn()).toEqual({ type: 'engine', ref: 0 })
    await drawing.unmount()
  }
  const band = await $.ui.mount({ plugin: 'thread-chat', surface: 'desktop', ...BAND })
  expect(await band.drawn()).toEqual({ type: 'engine', ref: 0 })
  expect((await $.tool.call({ tool: 'mcp__thread-chat__create_thread', tool_use_id: 't1', name: 'ideas' })).deny).toContain('off')

  // /threads turns them on: the model is told how threads work, and every row offers
  // "+ thread", with no thread yet
  expect((await flipThreads($)).text).toContain('Threads are on')
  await $.prompt.submit(say('hello'))
  expect(prompts.at(-1)).toContain('# Conversation threads')
  expect((await drawnAlone(userRow('plain words'))).hasAdd).toBe(true)
  expect((await drawnAlone(assistantRow('plain reply'))).hasAdd).toBe(true)
  await band.redraw()
  expect(await band.find({ text: /start a thread with # name/ })).toBeDefined()
  expect(await choiceKeys(band)).not.toContain('design')

  // the agent setting offers the model create_thread
  expect(await threadsShown(band)).toBe(true)
  await flipSwitch($, AGENT_SWITCH)
  expect(registered).toEqual(['create_thread'])
})

test('/threads again turns threads off, keeping them, and the model is told once each way', async ($, on) => {
  const prompts = engine(on)
  await $.session.start({ cwd: '.', surface: 'desktop', isInteractive: true })
  await flipThreads($)
  await $.prompt.submit(say('# design\na'))
  const band = await $.ui.mount({ plugin: 'thread-chat', surface: 'desktop', ...BAND })
  await pickIn(band, 'desktop', 'design')
  const mine = await $.ui.mount({ plugin: 'thread-chat', surface: 'desktop', ...userRow('# design\nmine') })
  const plain = await $.ui.mount({ plugin: 'thread-chat', surface: 'desktop', ...assistantRow('just chatting') })
  expect(await tagOf(mine, 'design')).toBeDefined()
  expect(await plain.find({ text: /just chatting/ })).toBeDefined()

  // Off: the band is the engine's alone, no tags, a heading plain text; the model is told once
  expect((await flipThreads($)).text).toContain('Threads are off')
  for (const site of [band, mine, plain]) await site.redraw()
  expect(await band.drawn()).toEqual({ type: 'engine', ref: 0 })
  expect(await tagOf(mine, 'design')).toBeUndefined()
  expect(await mine.find({ text: /# design\nmine/ })).toBeDefined()
  expect(await plain.find({ text: /just chatting/ })).toBeDefined()
  await $.prompt.submit(say('# perf\nb'))
  expect(prompts.at(-1)).toStartWith('# perf\nb\n--\nThe user turned conversation threads off.')
  await $.prompt.submit(say('more'))
  expect(prompts.at(-1)).toBe('more')
  const merge = await $.command.run({ command: 'merge-threads', args: 'design into perf', origin: { kind: 'composer' }, presentation: {} as never })
  expect(merge.text).toBe('Threads are off in this chat; /threads turns them on.')

  // On again: the threads and the pick are as they were, and the model is told all again
  await flipThreads($)
  for (const site of [band, mine]) await site.redraw()
  expect(await choiceKeys(band)).toContain('design')
  expect(await choiceKeys(band)).not.toContain('perf')
  expect(await tagOf(mine, 'design')).toBeDefined()
  await $.prompt.submit(say('back'))
  expect(prompts.at(-1)).toContain('# Conversation threads')
})

test("another agent's loop (an engine fork, a subagent) cannot start a thread, the agent switch on or off", async ($, on) => {
  engine(on)
  await flipThreads($)
  await $.session.start({ cwd: '.', surface: 'desktop', isInteractive: true })
  const tool = 'mcp__thread-chat__create_thread'
  const band = await $.ui.mount({ plugin: 'thread-chat', surface: 'desktop', ...BAND })

  expect((await $.tool.call({ tool, tool_use_id: 'f1', name: 'stray', agentId: 'fork-1' })).deny).toContain('another agent')
  await flipSwitch($, AGENT_SWITCH)
  expect((await $.tool.call({ tool, tool_use_id: 'f2', name: 'stray', agentId: 'fork-1' })).deny).toContain('another agent')
  await band.redraw()
  expect(await choiceKeys(band)).not.toContain('stray')

  // The main conversation's own call still starts one.
  expect((await $.tool.call({ tool, tool_use_id: 'm1', name: 'ideas' })).deny).toBeUndefined()
  await band.redraw()
  expect(await choiceKeys(band)).toContain('ideas')
  expect(await choiceKeys(band)).not.toContain('stray')
})

test("a plugin's prompt is not the person's, though the desktop names its row theirs", async ($, on) => {
  engine(on)
  await flipThreads($)
  await $.prompt.submit(say('# design\na'))
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
  await flipThreads($)
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

  // A picked thread hides nothing: the engine still draws every section.
  const band = await $.ui.mount({ plugin: 'thread-chat', surface: 'terminal', ...BAND })
  await pickIn(band, 'terminal', 'perf')
  const row = await $.ui.mount({ plugin: 'thread-chat', surface: 'terminal', ...userRow(text) })
  expect((await row.find({ type: 'Text', text: /slow/ }))?.text).toBe('look at this\n\n▸ design\nthe pills are tall\n\n▸ perf\nslow')
  expect(await tagOf(row, 'design')).toBeDefined()
})

test('a heading snapped at send still draws as its thread where the screen shows it as typed', async ($, on) => {
  engine(on)
  await flipThreads($)
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
  expect(await choiceKeys(band)).not.toContain('thr')
  await band.select({ key: 'thread-picker', value: 'thread:threads' })
  const row = await $.ui.mount({ plugin: 'thread-chat', surface: 'terminal', ...userRow('#thr\nwhy so tall?') })
  expect(await row.find({ type: 'Text', text: /tall/ })).toBeDefined()

  // a heading naming no thread stays as typed
  const stray = await $.ui.mount({ plugin: 'thread-chat', surface: 'terminal', ...userRow('# zz\nhm') })
  await band.select({ key: 'thread-picker', value: 'thread:threads' })
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
  await flipThreads($)
  await $.prompt.submit(say('# Threads\na'))
  await $.prompt.submit(say('#thr\nb'))
  const saved = kept['session:session-1'] as { threads: { name: string }[]; snaps: Record<string, string> }
  expect(saved.threads.map(t => t.name)).toEqual(['Threads'])
  expect(saved.snaps).toEqual({ thr: 'threads' })
})

test('a session keeps whether threads are on for its next run', async ($, on) => {
  const kept: Record<string, unknown> = {}
  on('store.get', ($, e) => ({ value: kept[e.key] }))
  on('store.set', ($, e) => {
    kept[e.key] = e.value
    return { value: undefined }
  })
  on('store.keys', () => ({ value: Object.keys(kept) }))
  engine(on, null)
  const isOnKept = () => (kept['session:session-1'] as { isOn?: unknown } | undefined)?.isOn
  await $.session.start({ cwd: '.', surface: 'desktop', isInteractive: true })
  expect(isOnKept()).toBe(false)
  await flipThreads($)
  expect(isOnKept()).toBe(true)
  await flipThreads($)
  expect(isOnKept()).toBe(false)
})

// Whether threads were on, as a session kept it: a record kept before /threads has no
// switch, and counts as on where it has threads.
const KEPT_SWITCHES = [
  [undefined, 'kept before /threads'],
  [true, 'on'],
  [false, 'off'],
] as const

for (const [isOn, kept] of KEPT_SWITCHES) {
  test(`a restarted session takes up the threads it kept, on or off as they were (${kept})`, async ($, on) => {
    engine(on, {
      'session:session-1': {
        ...(isOn === undefined ? {} : { isOn }),
        threads: [{ name: 'Threads', color: '#4fa3e0', isSelected: true, createdBy: 'user' }],
        aliases: {},
        snaps: { thr: 'threads' },
      },
    })
    await $.session.start({ cwd: '.', surface: 'desktop', isInteractive: true })
    const band = await $.ui.mount({ plugin: 'thread-chat', surface: 'terminal', ...BAND })
    expect((await choiceKeys(band)).includes('threads')).toBe(isOn !== false)
    // kept off, the threads come back with /threads
    if (isOn === false) {
      await flipThreads($)
      await band.redraw()
    }
    expect(await choiceKeys(band)).toContain('threads')
    const row = await $.ui.mount({ plugin: 'thread-chat', surface: 'terminal', ...userRow('#thr\nwhy so tall?') })
    expect(await tagOf(row, 'Threads')).toBeDefined()
  })

  test(`a rewound session, under a new id, takes up the threads of the session it came from, on or off as they were (${kept})`, async ($, on) => {
    const said = ['# Threads\nwhy is the band two rows high?', 'It wraps because both mods share one row.', '# Meta\nhow long do the tests take?']
    const rows = (texts: string[]) => texts.map((text, i) => ({ id: `row-${i}`, role: 'user', mark: markOf(text) }))
    const store: Record<string, unknown> = {
      'session:old': {
        ...(isOn === undefined ? {} : { isOn }),
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
    expect((await choiceKeys(band)).includes('threads')).toBe(isOn !== false)
    if (isOn === false) {
      await flipThreads($)
      await band.redraw()
    }
    expect(await choiceKeys(band)).toContain('threads')
    expect(await choiceKeys(band)).toContain('meta')
    expect(await choiceKeys(band)).not.toContain('elsewhere')
    const row = await $.ui.mount({ plugin: 'thread-chat', surface: 'terminal', ...userRow('# Threading\nstill means Threads') })
    expect(await tagOf(row, 'Threads')).toBeDefined()
  })
}

// The person's `/threads <args>`.
const runThreads = ($: Engine, args: string) =>
  $.command.run({ command: 'threads', args, origin: { kind: 'composer' }, presentation: {} as never })

// A store the test reads back, as the mod kept it, seeded with `seed`.
function keptStore(on: On, seed: Record<string, unknown> = {}): Record<string, unknown> {
  // the welcome line dismissed: welcome.test.ts covers it
  const kept: Record<string, unknown> = { welcome: ['thread-chat'], ...seed }
  on('store.get', ($, e) => ({ value: kept[e.key] }))
  on('store.set', ($, e) => {
    kept[e.key] = e.value
    return { value: undefined }
  })
  on('store.keys', () => ({ value: Object.keys(kept) }))
  return kept
}

// Whether threads are on, as the band shows it: on, its `☰`; off, nothing of the mod's.
const threadsShown = async (band: Band) => (await band.find({ key: 'thread-view' })) !== undefined

test('/threads default on|off sets whether threads are on in new chats, kept for every session, and says what it is now', async ($, on) => {
  const kept = keptStore(on)
  const prompts = engine(on, null)
  await $.session.start({ cwd: '.', surface: 'desktop', isInteractive: true })
  const band = await $.ui.mount({ plugin: 'thread-chat', surface: 'desktop', ...BAND })
  const record = () => kept['session:session-1'] as { isOn: boolean; choice: boolean | null }
  const where = 'as do chats where you have not turned them on or off.'
  expect(await band.drawn()).toEqual({ type: 'engine', ref: 0 })
  expect(record()).toMatchObject({ isOn: false, choice: null })

  // This chat, never switched, follows the default: threads come on, and the model is told
  expect((await runThreads($, 'default on')).text).toBe(`New chats now start with threads on, ${where}`)
  expect(kept.isOnByDefault).toBe(true)
  await band.redraw()
  expect(await threadsShown(band)).toBe(true)
  await $.prompt.submit(say('hello'))
  expect(prompts.at(-1)).toContain('# Conversation threads')
  expect(record()).toMatchObject({ isOn: true, choice: null })
  // and off again with it
  expect((await runThreads($, 'Default Off')).text).toBe(`New chats now start with threads off, ${where}`)
  expect(kept.isOnByDefault).toBe(false)
  await band.redraw()
  expect(await band.drawn()).toEqual({ type: 'engine', ref: 0 })

  // Turned off with /threads, it keeps its own choice whatever the default
  await runThreads($, 'default enable')
  await band.redraw()
  expect(await threadsShown(band)).toBe(true)
  await runThreads($, 'off')
  expect(record()).toMatchObject({ isOn: false, choice: false })
  expect((await runThreads($, 'default disable')).text).toBe(`New chats now start with threads off, ${where}`)
  expect((await runThreads($, 'default on')).text).toBe(`New chats now start with threads on, ${where} This chat keeps them off; /threads on turns them on here.`)
  await band.redraw()
  expect(await band.drawn()).toEqual({ type: 'engine', ref: 0 })

  // and turned on with /threads, likewise
  expect((await flipThreads($)).text).toContain('Threads are on')
  expect((await runThreads($, 'default off')).text).toBe(`New chats now start with threads off, ${where} This chat keeps them on; /threads off turns them off here.`)
  await band.redraw()
  expect(await threadsShown(band)).toBe(true)
  expect(record()).toMatchObject({ isOn: true, choice: true })
  expect(kept.isOnByDefault).toBe(false)
})

test('a new chat starts with threads on where the default is on, with no choice of its own', async ($, on) => {
  const kept = keptStore(on, { isOnByDefault: true })
  const registered: string[] = []
  const prompts = engine(on, null, undefined, registered)
  await $.session.start({ cwd: '.', surface: 'desktop', isInteractive: true })
  const band = await $.ui.mount({ plugin: 'thread-chat', surface: 'desktop', ...BAND })
  expect(await threadsShown(band)).toBe(true)
  expect(await band.find({ text: /start a thread with # name/ })).toBeDefined()
  expect(registered).toEqual(['read_thread'])
  await $.prompt.submit(say('hello'))
  expect(prompts.at(-1)).toContain('# Conversation threads')
  expect(kept['session:session-1']).toMatchObject({ isOn: true, choice: null })
})

// A session's record, the default kept for every session, and whether threads come on as
// it restarts: the person's own choice wins; with none, the default as it is now. A record
// kept before choices were chose on if it was on, and off if it was off with threads.
const KEPT_DESIGN = [{ name: 'design', color: '#4fa3e0', createdBy: 'user' }]
const KEPT_CHOICES = [
  [{ isOn: false, choice: false, threads: KEPT_DESIGN }, true, false, 'chose off, the default on'],
  [{ isOn: true, choice: true, threads: KEPT_DESIGN }, false, true, 'chose on, the default off'],
  [{ isOn: true, choice: null, threads: KEPT_DESIGN }, false, false, 'never chose, the default now off'],
  [{ isOn: false, choice: null, threads: [] }, true, true, 'never chose, the default now on'],
  [{ isOn: false, threads: KEPT_DESIGN }, true, false, 'kept off with threads before choices were, the default on'],
  [{ isOn: false, threads: [] }, true, true, 'kept off with none before choices were, the default on'],
] as const

for (const [record, isOnByDefault, isShown, kept] of KEPT_CHOICES) {
  test(`a restarted session is on as the person chose there, else as the default (${kept})`, async ($, on) => {
    engine(on, { isOnByDefault, 'session:session-1': { ...record, aliases: {}, snaps: {} } })
    await $.session.start({ cwd: '.', surface: 'desktop', isInteractive: true })
    const band = await $.ui.mount({ plugin: 'thread-chat', surface: 'desktop', ...BAND })
    expect(await threadsShown(band)).toBe(isShown)
  })
}

test('a rewound session, under a new id, keeps the choice of the session it came from over the default', async ($, on) => {
  const said = ['# design\nwhy is the band two rows high?', 'It wraps because both mods share one row.', '# design\nhow long do the tests take?']
  const kept = keptStore(on, {
    isOnByDefault: true,
    'session:old': { isOn: false, choice: false, threads: KEPT_DESIGN, aliases: {}, snaps: {} },
    'view:old': said.map((text, i) => ({ id: `row-${i}`, role: 'user', mark: markOf(text) })),
  })
  engine(on, null)
  on('session.messages', () => ({ value: said.map(text => ({ role: 'user' as const, text, toolUses: [] })) }))
  await $.session.start({ cwd: '.', surface: 'desktop', isInteractive: true })
  const band = await $.ui.mount({ plugin: 'thread-chat', surface: 'desktop', ...BAND })
  expect(await band.drawn()).toEqual({ type: 'engine', ref: 0 })
  expect(kept['session:session-1']).toMatchObject({ isOn: false, choice: false })
  await flipThreads($)
  await band.redraw()
  expect(await choiceKeys(band)).toContain('design')
})

test('a session keeps the agent and filter settings for its next run', async ($, on) => {
  const kept: Record<string, unknown> = {}
  on('store.get', ($, e) => ({ value: kept[e.key] }))
  on('store.set', ($, e) => {
    kept[e.key] = e.value
    return { value: undefined }
  })
  on('store.keys', () => ({ value: Object.keys(kept) }))
  engine(on, null)
  const switchesKept = () => {
    const saved = kept['session:session-1'] as { agentMayCreate?: unknown; filtersChat?: unknown } | undefined
    return { agentMayCreate: saved?.agentMayCreate, filtersChat: saved?.filtersChat }
  }
  await $.session.start({ cwd: '.', surface: 'desktop', isInteractive: true })
  expect(switchesKept()).toEqual({ agentMayCreate: false, filtersChat: false })
  await flipThreads($)
  // each change is kept at once, with no message sent after it
  await flipSwitch($, FILTER_SWITCH)
  expect(switchesKept()).toEqual({ agentMayCreate: false, filtersChat: true })
  await flipSwitch($, AGENT_SWITCH)
  expect(switchesKept()).toEqual({ agentMayCreate: true, filtersChat: true })
  await flipSwitch($, FILTER_SWITCH)
  expect(switchesKept()).toEqual({ agentMayCreate: true, filtersChat: false })
})

// The agent and filter settings as a session kept them: changed from how a new session
// starts, or absent from a record kept before they were kept.
const KEPT_SETTINGS = [
  [{ agentMayCreate: true, filtersChat: true }, 'flipped'],
  [{}, 'kept before the switches were'],
] as const

for (const [switches, kept] of KEPT_SETTINGS) {
  test(`a restarted session takes up the agent and filter switches it kept (${kept})`, async ($, on) => {
    const registered: string[] = []
    engine(
      on,
      {
        'session:session-1': {
          isOn: true,
          ...switches,
          threads: [
            { name: 'design', color: '#4fa3e0', createdBy: 'user' },
            { name: 'perf', color: '#9b6fd6', createdBy: 'user' },
          ],
          aliases: {},
          snaps: {},
          current: 'design',
        },
      },
      () => false,
      registered,
    )
    await $.session.start({ cwd: '.', surface: 'desktop', isInteractive: true })
    // absent, the agent is kept out and the chat unfiltered, as in a new session
    const mayCreate = 'agentMayCreate' in switches ? switches.agentMayCreate : false
    const filters = 'filtersChat' in switches ? switches.filtersChat : false
    expect(await switchOf($, AGENT_SWITCH)).toBe(mayCreate ? 'on' : 'off')
    expect(await switchOf($, FILTER_SWITCH)).toBe(filters ? 'on' : 'off')
    // the agent let start threads is offered its tool again
    expect(registered.includes('create_thread')).toBe(mayCreate)

    // the picked thread hides another thread's part of a message only while the filter is on
    const mine = await $.ui.mount({ plugin: 'thread-chat', surface: 'desktop', ...userRow('# design\nqueue?\n# perf\nfast?') })
    expect(await mine.find({ text: /queue/ })).toBeDefined()
    expect((await mine.find({ text: /fast/ })) === undefined).toBe(filters)
  })
}

test('a rewound session, under a new id, takes up the agent and filter switches of the session it came from', async ($, on) => {
  const said = ['# design\nwhy is the band two rows high?', 'It wraps because both mods share one row.', '# perf\nhow long do the tests take?']
  const registered: string[] = []
  engine(
    on,
    {
      'session:old': {
        isOn: true,
        agentMayCreate: true,
        filtersChat: true,
        threads: [
          { name: 'design', color: '#4fa3e0', createdBy: 'user' },
          { name: 'perf', color: '#9b6fd6', createdBy: 'user' },
        ],
        aliases: {},
        snaps: {},
      },
      'view:old': said.map((text, i) => ({ id: `row-${i}`, role: 'user', mark: markOf(text) })),
    },
    () => false,
    registered,
  )
  on('session.messages', () => ({ value: said.map(text => ({ role: 'user' as const, text, toolUses: [] })) }))
  await $.session.start({ cwd: '.', surface: 'desktop', isInteractive: true })
  expect(await switchOf($, AGENT_SWITCH)).toBe('on')
  expect(await switchOf($, FILTER_SWITCH)).toBe('on')
  expect(registered).toContain('create_thread')
})

test('a session kept with one thread picked in the old filter takes it up as its picked thread', async ($, on) => {
  const kept: Record<string, unknown> = {}
  on('store.get', ($, e) => ({ value: kept[e.key] }))
  on('store.set', ($, e) => {
    kept[e.key] = e.value
    return { value: undefined }
  })
  on('store.keys', () => ({ value: Object.keys(kept) }))
  const prompts = engine(on, null)
  kept['session:session-1'] = {
    isOn: true,
    threads: [
      { name: 'design', color: '#4fa3e0', isSelected: false, createdBy: 'user' },
      { name: 'perf', color: '#9b6fd6', isSelected: true, createdBy: 'user' },
    ],
    aliases: {},
    snaps: {},
  }
  await $.session.start({ cwd: '.', surface: 'desktop', isInteractive: true })
  await $.prompt.submit(say('and the cache?'))
  expect(prompts.at(-1)).toContain('This message belongs to the thread "perf"')
  const saved = kept['session:session-1'] as { current: string; threads: Record<string, unknown>[] }
  expect(saved.current).toBe('perf')
  expect(saved.threads.every(t => !('isSelected' in t))).toBe(true)
})

test('a session kept with several threads picked in the old filter takes up none', async ($, on) => {
  const prompts = engine(on, {
    'session:session-1': {
      isOn: true,
      threads: [
        { name: 'design', color: '#4fa3e0', isSelected: true, createdBy: 'user' },
        { name: 'perf', color: '#9b6fd6', isSelected: true, createdBy: 'user' },
      ],
      aliases: {},
      snaps: {},
    },
  })
  await $.session.start({ cwd: '.', surface: 'desktop', isInteractive: true })
  await $.prompt.submit(say('and the cache?'))
  expect(prompts.at(-1)).not.toContain('belongs to the thread')
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
  await flipThreads($)
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

test('with a thread picked, a message with no heading goes to it; a heading still wins', async ($, on) => {
  const prompts = engine(on)
  await flipThreads($)
  await $.prompt.submit(say('# design\nhello\n# perf\nfast?'))
  const band = await $.ui.mount({ plugin: 'thread-chat', surface: 'terminal', ...BAND })
  await pickIn(band, 'terminal', 'perf')

  await $.prompt.submit(say('and the cache?'))
  expect(prompts.at(-1)).toContain('This message belongs to the thread "perf": the user posted it there with their thread picker')
  await $.session
    .append({
      message: { type: 'user', role: 'user', content: [{ type: 'text', text: 'and the cache?' }] },
      door: 'prompt',
      origin: { kind: 'composer' },
      uuid: 'p9',
    })

  const row = await $.ui.mount({ plugin: 'thread-chat', surface: 'terminal', ...userRow('and the cache?'), requestId: 'p9' })
  expect(await tagOf(row, 'perf')).toBeDefined()
  // it stays in perf, and in view, whichever thread is picked later
  await pickIn(band, 'terminal', 'design')
  await row.redraw()
  expect(await tagOf(row, 'perf')).toBeDefined()
  expect(await row.find({ text: /cache/ })).toBeDefined()

  // a heading wins over the picked thread
  await $.prompt.submit(say('# perf\nstill slow'))
  expect(prompts.at(-1)).not.toContain('belongs to the thread')

  // with none picked, a message with no heading stays unthreaded
  await pickIn(band, 'terminal', '')
  await $.prompt.submit(say('both?'))
  expect(prompts.at(-1)).toBe('both?')
})

test("a message's last thread heading picks its thread for the next message with no heading, and is kept", async ($, on) => {
  const kept: Record<string, unknown> = {}
  on('store.get', ($, e) => ({ value: kept[e.key] }))
  on('store.set', ($, e) => {
    kept[e.key] = e.value
    return { value: undefined }
  })
  on('store.keys', () => ({ value: Object.keys(kept) }))
  const prompts = engine(on, null)
  await flipThreads($)
  const band = await $.ui.mount({ plugin: 'thread-chat', surface: 'terminal', ...BAND })
  // The picked thread as the band's picker shows it and as the session's record keeps it.
  const picked = async () => {
    await band.redraw()
    return [await pickerLabel(band), (kept['session:session-1'] as { current: string }).current]
  }

  // by its exact name
  await $.prompt.submit(say('# design\na\n# perf\nb'))
  expect(await picked()).toEqual(['perf', 'perf'])
  // a message with no heading goes there, and leaves the pick
  await $.prompt.submit(say('and the cache?'))
  expect(prompts.at(-1)).toContain('This message belongs to the thread "perf"')
  expect(await picked()).toEqual(['perf', 'perf'])

  // a mistyped or abbreviated heading picks the thread it means
  await $.prompt.submit(say('# dezign\nc'))
  expect(await picked()).toEqual(['design', 'design'])
  await $.prompt.submit(say('# per\nd'))
  expect(await picked()).toEqual(['perf', 'perf'])

  // the last heading counts, even where its thread had an earlier one in the message
  await $.prompt.submit(say('# design\ne\n# perf\nf\n# design\ng'))
  expect(await picked()).toEqual(['design', 'design'])

  // `#+name` picks the thread it starts
  await $.prompt.submit(say('#+ideas\nh'))
  expect(await picked()).toEqual(['ideas', 'ideas'])

  // headings of no thread (deeper ones, or in code) leave the pick
  await $.prompt.submit(say('## perf\ni\n```\n# perf\n```'))
  expect(prompts.at(-1)).toContain('This message belongs to the thread "ideas"')
  expect(await picked()).toEqual(['ideas', 'ideas'])
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
  await flipThreads($)
  await $.prompt.submit(say('# design\na\n# perf\nb'))
  const note = (name: string) =>
    `This message belongs to the thread "${name}": the user replied to part of your message in that thread, so your reply most likely belongs under that thread's heading.`

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
  await band.select({ key: 'thread-picker', value: 'thread:design' })
  await $.prompt.submit(say('<!-- reply 1 -->\n> fast enough\n\nreally?'))
  expect(prompts.at(-1)).toContain(note('perf'))
  await band.select({ key: 'thread-picker', value: 'none' })

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

test('a quoted selection opening a message goes with the thread heading right after it, wherever it was quoted from', async ($, on) => {
  const prompts = engine(on)
  // the selection is of a part of a reply in design
  on('session.messages', () => ({
    value: [{ role: 'assistant', text: '# design\nthe two tasks deferred until after this release are due now', toolUses: [] }],
  }))
  await flipThreads($)
  await $.prompt.submit(say('# design\na\n# multitasking\nb'))
  // the model is told the rule the chat draws by
  expect(prompts.at(-1)).toContain("right before a heading, which belongs to that heading's thread")

  // as the desktop writes it on Windows, under a heading that starts a thread's name
  const quote = '<!-- reply 1 -->\r\n> The two tasks deferred until after this release are due now:\r\n>\r\n> reusing a colour'
  const text = `${quote}\r\n\r\n# Multitask\r\nyes`
  await $.prompt.submit(say(text))
  // the heading decides: the model is told what it means, and nothing of design
  expect(prompts.at(-1)).toBe(`${text}\n--\nThread headings in this message, as the user meant them: "#Multitask" is the thread "multitasking".`)
  await $.session.append({
    message: { type: 'user', role: 'user', content: [{ type: 'text', text }] },
    door: 'prompt',
    origin: { kind: 'composer' },
    uuid: 'q1',
  })
  for (const surface of ['terminal', 'desktop'] as const) {
    const row = await $.ui.mount({ plugin: 'thread-chat', surface, ...userRow(text), requestId: 'q1' })
    expect(await tagOf(row, 'multitasking')).toBeDefined()
    expect(await tagOf(row, 'design')).toBeUndefined()
    // no part of no thread, so no "+ thread"
    expect(await row.find({ key: 'tag:' })).toBeUndefined()
    // the engine draws the quote, then the words, with no line marking a thread's part
    expect((await row.find({ type: 'Text', text: /deferred/ }))?.text).toBe(`${quote}\n\nyes`)
    await row.unmount()
  }

  // with a second thread's part after it, the quote stays at the top, above the first part's name
  const two = '<!-- reply 1 -->\n> due now\n\n# Multitask\nyes\n# design\nand this'
  const both = await $.ui.mount({ plugin: 'thread-chat', surface: 'desktop', ...userRow(two), requestId: 'q2' })
  expect((await both.find({ type: 'Text', text: /due now/ }))?.text).toBe(
    '<!-- reply 1 -->\n> due now\n\n▸ multitasking\nyes\n\n▸ design\nand this',
  )
  expect(await both.find({ key: 'tag:' })).toBeUndefined()
  await both.unmount()

  // the chat filtered to design hides it, quote and all
  const band = await $.ui.mount({ plugin: 'thread-chat', surface: 'terminal', ...BAND })
  await flipSwitch($, FILTER_SWITCH)
  await pickIn(band, 'terminal', 'design')
  const picked = await $.ui.mount({ plugin: 'thread-chat', surface: 'desktop', ...userRow(text), requestId: 'q1' })
  expect(await picked.find({ text: /deferred|yes/ })).toBeUndefined()
})

test('a reply of several sections draws one by the engine and the rest as markdown', async ($, on) => {
  engine(on)
  await flipThreads($)
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

test('the picker is a Select of the threads and "No thread", its face the picked thread', async ($, on) => {
  engine(on)
  await flipThreads($)
  await $.prompt.submit(say('# design\na\n# perf\nb'))
  const desktop = await $.ui.mount({ plugin: 'thread-chat', surface: 'desktop', ...BAND })
  const terminal = await $.ui.mount({ plugin: 'thread-chat', surface: 'terminal', ...BAND })
  const faces = async () => {
    await desktop.redraw()
    await terminal.redraw()
    return [await pickerLabel(desktop), await pickerLabel(terminal)]
  }
  // the mark before the picker and the Box that holds the two: for the picked thread, on
  // the desktop a dot of its colour (a picture, filled) on a light tint of it, on the
  // terminal one solid cell of its colour and no tint; for none, a hollow dot (on the
  // desktop a picture of a ring) and no tint
  const lookOf = async (band: { drawn: () => Promise<unknown> }) => {
    const group = pathTo(await band.drawn(), n => n.props?.key === PICKER)?.at(-2)
    const mark = (group?.children as Drawn[] | undefined)?.[0]
    const markOf = () => {
      if (mark?.type === 'Svg') {
        const fill = /fill="([^"]+)"/.exec(String(mark.props?.source))?.[1]
        return fill === 'none' ? 'none' : { dot: fill }
      }
      const text = (mark?.children ?? []).join('')
      return text === '○' ? 'none' : { cell: mark?.props?.backgroundColor, text }
    }
    return { mark: markOf(), tint: group?.props?.backgroundColor, flexShrink: group?.props?.flexShrink }
  }

  // the threads to post to, then "No thread"; no label before the face, and no tick of the
  // mod's own (the desktop ticks the selected row)
  for (const band of [desktop, terminal]) {
    const picker = await band.find({ key: PICKER })
    expect(picker?.type).toBe('Select')
    expect(picker?.props.options).toEqual([
      { value: 'thread:design', label: 'design' },
      { value: 'thread:perf', label: 'perf' },
      { value: 'none', label: 'No thread' },
    ])
    expect(picker?.props.label).toBeUndefined()
    expect((await band.findAll({ type: 'Text' })).filter(t => t.text.includes('✓'))).toEqual([])
  }
  // the message's last heading picked perf; "No thread" leaves none picked
  expect(await faces()).toEqual(['perf', 'perf'])
  await desktop.select({ key: PICKER, value: 'none' })
  const none = { mark: 'none', tint: undefined, flexShrink: 0 }
  expect(await faces()).toEqual(['No thread', 'No thread'])
  for (const band of [desktop, terminal]) expect(await lookOf(band)).toEqual(none)
  // the desktop's tint keeps its shape, clear, with no thread, so picking one moves nothing
  const shapeOf = async () => {
    const props = pathTo(await desktop.drawn(), n => n.props?.key === PICKER)?.at(-2)?.props
    return [props?.borderStyle, props?.borderColor, props?.paddingLeft, props?.paddingRight, props?.paddingY]
  }
  const unpicked = await shapeOf()
  expect(unpicked).toEqual(['single', '#00000000', 0.5, 0, 0])
  await terminal.select({ key: PICKER, value: 'thread:perf' })
  expect(await faces()).toEqual(['perf', 'perf'])
  expect(await lookOf(terminal)).toEqual({ mark: { cell: PALETTE[1], text: ' ' }, tint: undefined, flexShrink: 0 })
  expect(await lookOf(desktop)).toEqual({ mark: { dot: PALETTE[1] }, tint: `${PALETTE[1]}26`, flexShrink: 0 })
  expect(await shapeOf()).toEqual(unpicked)
  // the tint has rounded corners from a clear border, keeps a little room on the left for
  // the dot and none on the right, and leaves the height to the desktop, which sets the picker's own; the dot is
  // a fixed size, so the desktop centres it on the picker
  const tinted = pathTo(await desktop.drawn(), n => n.props?.key === PICKER)?.at(-2)
  expect(tinted?.props).toMatchObject({ borderStyle: 'single', borderColor: '#00000000', paddingLeft: 0.5, paddingRight: 0, paddingY: 0 })
  expect(tinted?.props?.paddingX).toBeUndefined()
  expect(tinted?.props?.height).toBeUndefined()
  expect(tinted?.props?.alignItems).toBe('center')
  expect((tinted?.children as Drawn[] | undefined)?.[0]?.props).toMatchObject({ width: 8, height: 8, alt: 'perf thread' })
  // the terminal's group has no border, which would cost it two rows
  const plain = pathTo(await terminal.drawn(), n => n.props?.key === PICKER)?.at(-2)?.props
  expect(plain?.borderStyle).toBeUndefined()

  // one thread is picked at a time: another takes its place, and "No thread" leaves none
  await desktop.select({ key: PICKER, value: 'thread:design' })
  expect(await faces()).toEqual(['design', 'design'])
  expect(await lookOf(desktop)).toMatchObject({ mark: { dot: PALETTE[0] }, tint: `${PALETTE[0]}26` })
  expect((await lookOf(terminal)).mark).toEqual({ cell: PALETTE[0], text: ' ' })
  await desktop.select({ key: PICKER, value: 'none' })
  expect(await faces()).toEqual(['No thread', 'No thread'])
  for (const band of [desktop, terminal]) expect(await lookOf(band)).toEqual(none)

  // the mobile app, which draws no Select: a button naming the picked thread opens its
  // choices in the band, the picked one ticked; a pick closes them
  const mobile = await $.ui.mount({ plugin: 'thread-chat', surface: 'mobile', ...BAND })
  expect(await mobile.find({ key: PICKER })).toBeDefined()
  expect((await mobile.find({ key: 'picker:open' }))?.props.label).toBe('No thread ▾')
  expect(await mobile.find({ key: 'picker:thread:perf' })).toBeUndefined()
  await mobile.press({ key: 'picker:open' })
  await mobile.redraw()
  const noneRow = pathTo(await mobile.drawn(), n => n.props?.key === 'picker:none')?.at(-2)
  expect((noneRow?.children as Drawn[] | undefined)?.some(c => c.type === 'Text' && (c.children ?? []).join('') === '✓')).toBe(true)
  await mobile.press({ key: 'picker:thread:perf' })
  await mobile.redraw()
  expect((await mobile.find({ key: 'picker:open' }))?.props.label).toBe('perf ▾')
  expect(await mobile.find({ key: 'picker:thread:perf' })).toBeUndefined()
  expect(await faces()).toEqual(['perf', 'perf'])
})

test('a message or a reply part moves to another thread from its tag, and the model is told', async ($, on) => {
  const prompts = engine(on)
  await flipThreads($)
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
  expect(prompts.at(-1)).not.toContain('The user moved')
})

test('the move picker starts a new thread from a typed name, even with no threads yet', async ($, on) => {
  const prompts = engine(on)
  await flipThreads($)
  const fillOf = async (drawing: Parameters<typeof tagOf>[0], name: string) =>
    /fill="(#[0-9a-f]+)"/.exec(String((await tagOf(drawing, name))?.props.source))?.[1]

  // with no threads, once the agent may start them, a message and a reply of no
  // thread offer "+ thread"
  await flipSwitch($, AGENT_SWITCH)
  const mine = await $.ui.mount({ plugin: 'thread-chat', surface: 'desktop', ...userRow('plain words'), requestId: 'u1' })
  const reply = await $.ui.mount({ plugin: 'thread-chat', surface: 'desktop', ...assistantRow('plain reply'), requestId: 'r1' })
  for (const row of [mine, reply]) expect(await row.find({ type: 'Button', key: 'tag:' })).toBeDefined()

  const click = (drawing: { pointer: (p: never) => Promise<unknown> }, key: string) =>
    drawing.pointer({ type: 'down', x: 1, y: 0, button: 'left', in: key } as never)

  // its picker holds just the "+" pill, a plain outline with no dot; "+" swaps it for
  // the field, in the same row, and "×" swaps back
  await mine.press({ key: 'tag:' })
  await mine.redraw()
  const plus = restingPictures(await mine.drawn())
  expect(plus.map(p => p.props?.alt)).toEqual(['new thread'])
  expect(String(plus[0]?.props?.source)).not.toContain('stroke-dasharray')
  expect(String(plus[0]?.props?.source)).not.toContain('<circle')
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
  expect(await choicesIn(band)).toEqual(['ideas', 'later on'])

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
  await flipThreads($)
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
  await flipThreads($)
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

// The pictures under `node` drawn at rest, in drawing order: none from a Box drawn
// "none", which only the pointer reveals (a pill's lit picture over it).
function restingPictures(node: unknown): Drawn[] {
  if (typeof node !== 'object' || node === null) return []
  const n = node as Drawn
  if (n.type === 'Svg') return [n]
  if (n.type === 'Box' && n.props?.display === 'none') return []
  return (n.children ?? []).flatMap(restingPictures)
}

// The pictures under `node` drawn at rest, by alt.
const picturesIn = (node: unknown): string[] => restingPictures(node).map(p => String(p.props?.alt))

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
  await flipThreads($)
  await $.prompt.submit(say('# design\na\n# perf\nb'))
  const open = async (drawing: { press: (p: { key: string }) => Promise<unknown>; redraw: () => Promise<unknown> }, key: string) => {
    await drawing.press({ key })
    await drawing.redraw()
  }
  const inFlow = { isAbove: true, isLaidOver: false, isFixed: false }

  // the person's message: the picker sits left of its tag, on the right
  const mine = await $.ui.mount({ plugin: 'thread-chat', surface: 'desktop', ...userRow('# design\nhi'), requestId: 'u1' })
  await open(mine, 'tag:design')
  expect(pickerPlacement(await mine.drawn(), /^hi$/)).toEqual({ ...inFlow, pictures: ['perf', 'none', 'new thread', 'design'] })

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
  await flipThreads($)
  await $.prompt.submit(say('# design\na'))
  const rows = [
    await $.ui.mount({ plugin: 'thread-chat', surface: 'desktop', ...userRow('# design\nhi'), requestId: 'u1' }),
    await $.ui.mount({ plugin: 'thread-chat', surface: 'desktop', ...assistantRow('# design\nuse a queue'), requestId: 'r1' }),
  ]
  for (const row of rows) {
    const path = pathTo(await row.drawn(), n => n.type === 'Button' && n.props?.label === '▾')
    const box = path?.find(n => n.props?.key === 'tagbox:design')
    // the tag and its "▾" side by side with no gap, the tag's picture ending where its name does
    expect(box?.props?.columnGap).toBe(0)
    const [tag, button] = box?.children as Drawn[]
    // the "▾" in the Box its tip hangs from
    expect(button?.props?.key).toBe('tip:tag:design')
    expect(pathTo(button, n => n.props?.label === '▾')).toBeDefined()
    const source = String(tag?.props?.source)
    const textLength = Number(/textLength="([\d.]+)"/.exec(source)?.[1])
    // set from its start edge, the picture's room left of the text is its inset alone
    const inset = /text-anchor="end"/.test(source) ? 0 : Number(/<text x="([\d.]+)"/.exec(source)?.[1])
    expect(Number(tag?.props?.width) - inset).toBe(textLength + 1)
  }
})

test('the "none" pill has no dot and a dashed outline; off the desktop it is dim', async ($, on) => {
  engine(on)
  await flipThreads($)
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

// A desktop pill's pictures, at rest and lit, from the keyed Box that holds it. Lit
// on hover: revealed in place over the picture at rest, in the flow of a Box out of
// the flow and always shown; an out-of-flow Box the pointer reveals, the desktop
// lifts into a card away from the pill, as it does a tip.
function pillPictures(tree: unknown, key: string) {
  return pillPicturesOf(pathTo(tree, n => n.props?.key === key)?.at(-1))
}

function pillPicturesOf(box: Drawn | undefined) {
  const [rest, over] = (box?.children ?? []) as Drawn[]
  const lit = over?.children?.[0] as Drawn | undefined
  const hot = lit?.children?.[0] as Drawn | undefined
  return {
    isLitOnHover:
      over?.props?.position === 'absolute' &&
      over?.props?.display === undefined &&
      over?.hover === undefined &&
      lit?.props?.display === 'none' &&
      lit?.hover?.display === 'flex' &&
      lit?.props?.position === undefined,
    rest: rest?.props,
    hot: hot?.type === 'Svg' ? hot.props : undefined,
  }
}

test('what opens the picker or picks a thread lights under the pointer', async ($, on) => {
  engine(on)
  await flipThreads($)
  await $.prompt.submit(say('# design\na\n# perf\nb'))
  const design = PALETTE[0]

  // a tag's "▾" lights in its thread's colour with the pointer anywhere on the tag, its
  // name included (the keyed Box round both, in one hover group with the tag's filter
  // button); "+ thread" brightens
  const mine = await $.ui.mount({ plugin: 'thread-chat', surface: 'desktop', ...userRow('# design\nhi'), requestId: 'u1' })
  const tagPath = pathTo(await mine.drawn(), n => n.props?.key === 'tag:design')
  const tagBox = tagPath?.find(n => n.props?.key === 'tagbox:design')
  const scope = tagBox?.hover?.scope
  expect(typeof scope).toBe('string')
  expect(tagPath?.at(-1)?.hover).toEqual({ color: design, scope })
  expect(picturesIn(tagBox)).toEqual(['design'])
  const plain = await $.ui.mount({ plugin: 'thread-chat', surface: 'desktop', ...userRow('plain words'), requestId: 'u2' })
  expect(pathTo(await plain.drawn(), isAddThread)?.at(-1)?.hover).toEqual({ color: 'text' })

  // so does each of the move picker's pills, "+" included
  await mine.press({ key: 'tag:design' })
  await mine.redraw()
  const tree = await mine.drawn()
  for (const key of ['choice:pick:perf', 'choice:pick:', 'choice:pick-new']) {
    const pill = pillPictures(tree, key)
    expect({ key, isLitOnHover: pill.isLitOnHover, alt: pill.hot?.alt }).toEqual({ key, isLitOnHover: true, alt: pill.rest?.alt })
  }
})

// A tag button's tip, from the drawing it is in: the keyed Box round the button, the
// card the pointer on it reveals, the card's words, and which side of the button it is
// set against (hung from a Box of no width there, its near edge against that Box).
function tipOf(tree: unknown, key: string) {
  const holder = pathTo(tree, n => n.props?.key === key)?.at(-2)
  const children = (holder?.children ?? []) as Drawn[]
  const button = children.find(child => child.props?.key === key)
  // the card hangs from a Box of no width at the button's near edge
  const anchor = children.find(child => child !== button)
  const at = anchor === undefined ? -1 : children.indexOf(anchor)
  const card = anchor?.children?.[0] as Drawn | undefined
  const text = card?.children?.[0] as Drawn | undefined
  return {
    holder: holder?.props?.key,
    button: button?.props?.key,
    isRevealed:
      card?.props?.position === 'absolute' &&
      card?.props?.display === 'none' &&
      // the pointer on the button alone: no hover group, which would share it with the tag
      JSON.stringify(card?.hover) === JSON.stringify({ display: 'flex' }),
    // on the button's line, never above or below it, where its row would clip it
    top: card?.props?.top,
    side:
      anchor?.props?.width !== 0
        ? undefined
        : at === 0 && card?.props?.right === 0
          ? 'before'
          : at === 1 && card?.props?.left === 0
            ? 'after'
            : undefined,
    words: (text?.children ?? []).join(''),
    // as wide as its words and a column either side: no width guessed from their count,
    // and words that never wrap, which would narrow it to a column of letters
    fits: card?.props?.width === undefined && card?.props?.paddingX === 1 && text?.props?.wrap === 'truncate',
  }
}

test("a tag's buttons say what they do in a tip on the desktop, on their own line, toward its middle", async ($, on) => {
  engine(on)
  await flipThreads($)
  await $.prompt.submit(say('# design\na\n# perf\nb'))
  const tip = (key: string, words: string, side: 'before' | 'after') => ({
    holder: `tip:${key}`,
    button: key,
    isRevealed: true,
    top: 0,
    side,
    words,
    fits: true,
  })
  const move = 'Move to another thread'
  const view = 'Show this thread in the thread view'

  // a person's message, its tags on the right: the "▾" tip to its left, over the tag's
  // name; the filter buttons, at the line's left, theirs to the right
  const mine = await (
    await $.ui.mount({ plugin: 'thread-chat', surface: 'desktop', ...userRow('# design\nhi\n# perf\nfast?'), requestId: 'u1' })
  ).drawn()
  expect(tipOf(mine, 'tag:design')).toEqual(tip('tag:design', move, 'before'))
  expect(tipOf(mine, 'tag-filter:design')).toEqual(tip('tag-filter:design', view, 'after'))
  expect(tipOf(mine, 'tag-filter:perf')).toEqual(tip('tag-filter:perf', view, 'after'))
  // each filter button's tip is drawn after the buttons it reaches over: last first,
  // laid out right to left, so they read in the tags' order
  const ends = pathTo(mine, n => n.props?.key === 'tip:tag-filter:design')?.at(-2)
  expect(ends?.props?.flexDirection).toBe('row-reverse')
  expect(((ends?.children ?? []) as Drawn[]).map(child => child.props?.key)).toEqual(['tip:tag-filter:perf', 'tip:tag-filter:design'])

  // a reply's part, its tag on the left and its filter button on the right: the other way
  const reply = await (
    await $.ui.mount({ plugin: 'thread-chat', surface: 'desktop', ...assistantRow('# design\nuse a queue'), requestId: 'r1' })
  ).drawn()
  expect(tipOf(reply, 'tag:design')).toEqual(tip('tag:design', move, 'after'))
  expect(tipOf(reply, 'tag-filter:design')).toEqual(tip('tag-filter:design', view, 'before'))

  // "+ thread" says what it does: no tip
  const plain = await (await $.ui.mount({ plugin: 'thread-chat', surface: 'desktop', ...userRow('plain words'), requestId: 'u2' })).drawn()
  expect(pathTo(plain, isAddThread)).toBeDefined()
  expect(pathTo(plain, n => String(n.props?.key).startsWith('tip:'))).toBeUndefined()

  // with no pointer to show one, the terminal and the mobile app draw the buttons alone
  for (const surface of ['terminal', 'mobile'] as const) {
    for (const row of [userRow('# design\nhi'), assistantRow('# design\nuse a queue')]) {
      const drawn = await (await $.ui.mount({ plugin: 'thread-chat', surface, ...row, requestId: `${surface}-${row.component}` })).drawn()
      expect(pathTo(drawn, n => n.props?.key === 'tag:design')).toBeDefined()
      expect(pathTo(drawn, n => String(n.props?.key).startsWith('tip:'))).toBeUndefined()
    }
  }
})

test("a reply part's border pads it alike on every side, and its tag meets its text", async ($, on) => {
  engine(on)
  await flipThreads($)
  await $.prompt.submit(say('# design\na\n# perf\nb'))
  const text = '# design\nuse a queue\n# perf\nit is fine'
  // The padding props of each thread border, so a lone shorthand shows every side alike;
  // not a tip's card, which only the pointer shows.
  const paddingOf = async (drawing: { findAll: (query: { type?: string }) => Promise<{ props: Record<string, unknown> }[]> }) =>
    (await drawing.findAll({ type: 'Box' }))
      .filter(box => box.props.borderStyle === 'round' && box.props.display !== 'none')
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
test('a long desktop transcript draws Clients only in the one open move picker', async ($, on) => {
  engine(on)
  await flipThreads($)
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

  // the band: one per button (`+` and `☰`); the thread picker is a Select
  const band = await $.ui.mount({ plugin: 'thread-chat', surface: 'desktop', ...BAND })
  expect(await band.findAll({ type: 'Client' })).toHaveLength(2)

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

test('the band keeps one row with 12 threads beside another mod, and nothing the pointer shows takes room', async ($, on) => {
  // another mod's controls, drawn beneath, as multitask's are
  on('ui.render', { component: 'AbovePrompt' }, ($, e) => {
    const { Box, Text } = $.ui.resolve(e)
    return Box({ flexDirection: 'row', children: [Text({ children: ['other mod'] })] })
  })
  engine(on)
  await flipThreads($)
  const names = ['threads', 'multitasking', 'design', 'perf', 'auth', 'billing', 'search', 'onboarding', 'analytics', 'docs', 'release', 'security']
  await $.prompt.submit(say(names.map(n => `# ${n}\nx`).join('\n')))
  const isOther = (n: Drawn) => n.type === 'Text' && (n.children ?? []).join('') === 'other mod'
  const isPicker = (n: Drawn) => n.props?.key === PICKER

  for (const surface of ['desktop', 'terminal'] as const) {
    const band = await $.ui.mount({ plugin: 'thread-chat', surface, ...BAND })
    const tree = await band.drawn()
    const all = elementsOf(tree)
    // one picker, a Select of every thread
    expect(all.filter(isPicker).map(n => n.type)).toEqual(['Select'])
    expect(await choiceKeys(band)).toEqual(names)
    const picker = pathTo(tree, isPicker)
    const other = pathTo(tree, isOther)
    // `+` then `☰` after the picker: on the desktop each a keyed Box its label's card hangs
    // from, elsewhere a Button
    const newPath = pathTo(tree, n => n.props?.key === 'threads:new')
    const viewPath = pathTo(tree, n => n.props?.key === 'thread-view')
    expect([newPath?.at(-1)?.type, viewPath?.at(-1)?.type]).toEqual(surface === 'desktop' ? ['Box', 'Box'] : ['Button', 'Button'])
    expect(all.indexOf(newPath?.at(-1) as Drawn)).toBeGreaterThan(all.indexOf(picker?.at(-1) as Drawn))
    expect(all.indexOf(viewPath?.at(-1) as Drawn)).toBeGreaterThan(all.indexOf(newPath?.at(-1) as Drawn))
    const inButtons = [...elementsOf(newPath?.at(-1)), ...elementsOf(viewPath?.at(-1))]

    // the other mod shares the row and keeps its width; the threads' controls give way
    expect(shareOf(picker, other)).toMatchObject({ a: { flexShrink: 1, minWidth: 0 }, b: { flexShrink: 0 } })
    expect(shareOf(picker, other)?.row?.flexWrap).toBeUndefined()
    // so do the buttons, after the picker, which keeps its own width beside its dot
    expect(shareOf(picker, newPath)).toMatchObject({ a: { flexShrink: 1, minWidth: 0 }, b: { flexShrink: 0 } })
    expect(picker?.at(-2)?.props?.flexShrink).toBe(0)
    // nothing wraps
    expect(all.filter(n => n.props?.flexWrap === 'wrap' || n.props?.flexWrap === 'wrap-reverse')).toEqual([])

    // every Box the pointer reveals is out of the flow, or in a Box that is, so showing
    // it moves nothing: on the desktop, the buttons' cards alone, which the desktop lifts
    const reveals = all.filter(n => n.hover?.display === 'flex')
    const isPlaced = (n: Drawn) => n.props?.position === 'absolute'
    expect(reveals.filter(n => !pathTo(tree, m => m === n)?.some(isPlaced))).toEqual([])
    const cards = reveals.filter(isPlaced)
    expect(cards.map(card => inButtons.includes(card))).toEqual(surface === 'desktop' ? [true, true] : [])
    await band.unmount()
  }
})

test("the band's `+` starts a thread from a typed name and picks it", async ($, on) => {
  const prompts = engine(on)
  await flipThreads($)
  await $.prompt.submit(say('# design\na'))
  for (const surface of ['desktop', 'terminal'] as const) {
    const band = await $.ui.mount({ plugin: 'thread-chat', surface, ...BAND })
    // `+` swaps itself for the move picker's field, focused; "×" goes back
    await pressNew(band, surface)
    await band.redraw()
    expect((await band.find({ key: 'threads:name' }))?.props.autoFocus).toBe(true)
    expect(await band.find({ key: 'threads:new' })).toBeUndefined()
    // the picker and `☰` stay as they were
    expect(await choiceKeys(band)).toEqual(['design'])
    expect(await band.find({ key: 'thread-view' })).toBeDefined()
    await band.press({ key: 'threads:name-cancel' })
    await band.redraw()
    expect(await band.find({ key: 'threads:name' })).toBeUndefined()
    expect(await band.find({ key: 'threads:new' })).toBeDefined()
    await band.unmount()
  }

  const band = await $.ui.mount({ plugin: 'thread-chat', surface: 'desktop', ...BAND })
  await pressNew(band, 'desktop')
  await band.redraw()
  // a blank name starts nothing and leaves the field open
  await band.input({ key: 'threads:name', text: '   ' })
  await band.redraw()
  expect(await band.find({ key: 'threads:name' })).toBeDefined()
  // a name starts the thread in the next colour and picks it; the `+` is back
  await band.input({ key: 'threads:name', text: 'ideas' })
  await band.redraw()
  expect(await band.find({ key: 'threads:name' })).toBeUndefined()
  expect(await band.find({ key: 'threads:new' })).toBeDefined()
  expect(await choicesIn(band)).toEqual(['design', 'ideas'])
  expect(await pickerLabel(band)).toBe('ideas')
  expect(String((await band.findAll({ type: 'Svg' })).find(p => p.props.alt === 'ideas thread')?.props.source)).toContain(
    `fill="${PALETTE[1]}"`,
  )
  await $.prompt.submit(say('first thought'))
  expect(prompts.at(-1)).toContain('This message belongs to the thread "ideas"')

  // a name that is already a thread's picks it and starts no other
  await pressNew(band, 'desktop')
  await band.redraw()
  await band.input({ key: 'threads:name', text: '#Design' })
  await band.redraw()
  expect(await choicesIn(band)).toEqual(['design', 'ideas'])
  expect(await pickerLabel(band)).toBe('design')
})

test('archiving a thread hides it from the pickers but keeps its tags; unarchiving or a heading brings it back', async ($, on) => {
  const prompts = engine(on)
  await flipThreads($)
  await $.prompt.submit(say('# design\na\n# perf\nb'))
  const band = await $.ui.mount({ plugin: 'thread-chat', surface: 'terminal', ...BAND })
  await pickIn(band, 'terminal', 'perf')

  // `/threads manage` lists each thread's actions; archiving the picked thread leaves none picked
  const panel = await managePanel($)
  await panel.press({ key: 'threads:archive:perf' })
  await panel.redraw()
  expect(await panel.find({ key: 'threads:unarchive:perf' })).toBeDefined()
  expect(await panel.find({ key: 'threads:archive:perf' })).toBeUndefined()
  await panel.press({ key: 'threads:done' })
  await band.redraw()
  expect(await choicesIn(band)).toEqual(['design'])
  expect(await pickerLabel(band)).toBe('No thread')

  // its messages keep their tags; the move picker no longer offers it
  const old = await $.ui.mount({ plugin: 'thread-chat', surface: 'terminal', ...assistantRow('# perf\nslow\n# design\nq'), requestId: 'r1' })
  expect(await tagOf(old, 'perf')).toBeDefined()
  await old.press({ key: 'tag:design' })
  await old.redraw()
  expect(await old.find({ key: 'pick:perf' })).toBeUndefined()
  expect(await old.find({ key: 'pick:' })).toBeDefined()

  // the model is told, and its threads list the archived one apart
  await $.prompt.submit(say('next'))
  expect(prompts.at(-1)).toContain('The user archived the thread "perf": it is hidden from their thread picker but kept.')

  // unarchived from /threads manage, it is offered again, and the model is told
  const again = await managePanel($)
  await again.press({ key: 'threads:unarchive:perf' })
  await again.redraw()
  await again.press({ key: 'threads:archive:design' })
  await again.press({ key: 'threads:done' })
  await band.redraw()
  expect(await choicesIn(band)).toEqual(['perf'])
  await $.prompt.submit(say('again'))
  expect(prompts.at(-1)).toContain('The user brought back the archived thread "perf".')

  // a heading naming an archived thread brings it back
  await $.prompt.submit(say('# design\nback to it'))
  await band.redraw()
  expect(await choicesIn(band)).toEqual(['design', 'perf'])
})

test('deleting a thread asks first, then drops its tags and heading lines from every message', async ($, on) => {
  const prompts = engine(on)
  await flipThreads($)
  await $.prompt.submit(say('# design\na\n# perf\nb\n# perf tools\nc'))
  const band = await $.ui.mount({ plugin: 'thread-chat', surface: 'terminal', ...BAND })
  await pickIn(band, 'terminal', 'perf')
  const rows = async (surface: 'terminal' | 'desktop', id: string = surface) => ({
    mine: await $.ui.mount({ plugin: 'thread-chat', surface, ...userRow('# perf\nslow'), requestId: `u-${id}` }),
    reply: await $.ui.mount({ plugin: 'thread-chat', surface, ...assistantRow('intro\n# perf\nfast\n# design\nq'), requestId: `r-${id}` }),
  })
  const before = await rows('terminal', 'before')
  expect(await tagOf(before.mine, 'perf')).toBeDefined()

  // delete asks first; cancel keeps the thread
  const panel = await managePanel($)
  await panel.press({ key: 'threads:delete:perf' })
  await panel.redraw()
  expect(await panel.find({ text: 'delete perf?' })).toBeDefined()
  await panel.press({ key: 'threads:cancel' })
  await panel.redraw()
  expect(await panel.find({ key: 'threads:delete:perf' })).toBeDefined()
  await panel.press({ key: 'threads:delete:perf' })
  await panel.redraw()
  await panel.press({ key: 'threads:delete-yes' })
  await panel.redraw()
  await panel.press({ key: 'threads:done' })
  await band.redraw()
  expect(await choicesIn(band)).toEqual(['design', 'perf tools'])
  expect(await pickerLabel(band)).toBe('No thread')

  for (const surface of ['terminal', 'desktop'] as const) {
    const { mine, reply } = await rows(surface)
    // no tag, and its heading line gone; not handed to the thread of a close name either
    expect(await tagOf(mine, 'perf')).toBeUndefined()
    expect(await tagOf(mine, 'perf tools')).toBeUndefined()
    expect((await mine.find({ type: 'Text', text: /slow/ }))?.text).toBe('slow')
    expect(await tagOf(reply, 'perf')).toBeUndefined()
    expect(await tagOf(reply, 'perf tools')).toBeUndefined()
    expect(await reply.find({ text: /# perf/ })).toBeUndefined()
    expect(await reply.find({ text: /fast/ })).toBeDefined()
    expect(await tagOf(reply, 'design')).toBeDefined()
  }
  await before.mine.redraw()
  expect(await tagOf(before.mine, 'perf')).toBeUndefined()

  // the model is told, and no longer offered it among the threads
  await $.prompt.submit(say('next'))
  expect(prompts.at(-1)).toContain('The user deleted the thread "perf": its messages no longer belong to any thread.')
  // a heading naming it starts it again
  await $.prompt.submit(say('# perf\nfresh start'))
  await band.redraw()
  expect(await choicesIn(band)).toEqual(['design', 'perf tools', 'perf'])
})

test('merging from /threads manage joins the chosen thread, and the picked thread follows', async ($, on) => {
  const prompts = engine(on)
  await flipThreads($)
  await $.prompt.submit(say('# design\na\n# perf\nb'))
  await $.prompt.submit(say('settled'))
  const band = await $.ui.mount({ plugin: 'thread-chat', surface: 'desktop', ...BAND })
  await pickIn(band, 'desktop', 'perf')
  const panel = await managePanel($, 'desktop')
  await panel.press({ key: 'threads:merge:perf' })
  await panel.redraw()
  // the threads it may join: every other one, and a way back
  expect((await panel.findAll({ type: 'Button' })).flatMap(b => (/^threads:merge-into:/.test(b.key ?? '') ? [b.key] : []))).toEqual([
    'threads:merge-into:design',
  ])
  expect(await panel.find({ key: 'threads:cancel' })).toBeDefined()
  await panel.press({ key: 'threads:merge-into:design' })
  await panel.redraw()
  // back at the threads, where one alone has nothing to merge into
  expect(await panel.find({ key: 'threads:archive:design' })).toBeDefined()
  expect(await panel.find({ key: 'threads:merge:design' })).toBeUndefined()
  await panel.press({ key: 'threads:done' })
  await band.redraw()
  expect(await choicesIn(band)).toEqual(['design'])
  expect(await pickerLabel(band)).toBe('design')
  const old = await $.ui.mount({ plugin: 'thread-chat', surface: 'desktop', ...assistantRow('# perf\nfast') })
  expect(await tagOf(old, 'design')).toBeDefined()
  await $.prompt.submit(say('next'))
  expect(prompts.at(-1)).toContain('The threads changed.')
  expect(prompts.at(-1)).toContain('"perf" is now "design"')
  expect(prompts.at(-1)).toContain('This message belongs to the thread "design"')
})
