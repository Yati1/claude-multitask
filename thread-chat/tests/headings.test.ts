import type { On, SessionMessage } from 'claude-code'
import { expect, mock, test } from 'claude-code/testing'
import type { Engine } from 'claude-code/testing'

import { headingStart, splitRunOns, splitSections } from '../hooks/parse'

// A heading typed with its section's first line on the same line: `#Threads Lets fix
// the view`, where "Threads" is a thread, is the heading `# Threads` over the line
// "Lets fix the view".

// The test stands in for the engine beneath the plugin: it records the prompts that
// reach it, each with the notes beside it, draws a message as its text, and keeps
// the rows stored as the transcript the thread view reads.
function engine(on: On): string[] {
  const prompts: string[] = []
  const transcript: SessionMessage[] = []
  mock.store(on, {})
  on('session.id', () => ({ value: 'session-1' }))
  on('session.start', ($, e) => ({ cwd: e.cwd }))
  on('prompt.submit', ($, e) => {
    prompts.push([e.text, ...(e.context ?? [])].join('\n--\n'))
    return { text: e.text }
  })
  on('tool.register', ($, e) => ({ value: { tool: `mcp__thread-chat__${e.name}` } }))
  on('command.register', ($, e) => ({ value: { command: e.name } }))
  on('ui.render', ($, e) => {
    if (e.component !== 'UserMessage' && e.component !== 'AssistantMessage') return { type: 'engine', ref: 0 }
    const { Text } = $.ui.resolve(e)
    return Text({ children: [e.props.text] })
  })
  on('ui.message', () => ({}))
  on('ui.open', () => ({ value: { isPlaced: true as const } }))
  on('ui.scroll', () => ({}))
  on('turn.complete', () => ({ text: '' }))
  on('session.messages', () => ({ value: [...transcript] }))
  on('session.append', ($, e, next) => {
    const role = e.message.role
    if (role !== undefined) {
      const text = e.message.content.flatMap(b => (b.type === 'text' && typeof b.text === 'string' ? [b.text] : [])).join('\n')
      transcript.push({ role, text, toolUses: [] } as SessionMessage)
    }
    return next(e)
  })
  return prompts
}

const say = (text: string) => ({ text, origin: { kind: 'composer' as const }, wait: false })

// The person's /threads, which turns threads on in the chat, or off again.
const flipThreads = ($: Engine) =>
  $.command.run({ command: 'threads', args: '', origin: { kind: 'composer' }, presentation: {} as never })

const userRow = (text: string) =>
  ({ component: 'UserMessage', props: { text, origin: { kind: 'composer' }, isExpanded: false } }) as const

const BAND = {
  component: 'AbovePrompt',
  props: { hasSurvey: false, isWorking: false, maxRows: 10, bodyColumns: 100, scroll: { offset: 0, bodyRows: 10 }, view: {} },
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

type Drawing = {
  findAll: (query: { type?: string; text?: string | RegExp }) => Promise<{ props: Record<string, unknown>; text: string }[]>
}

// A thread's tag in a drawing: its name in capitals on the terminal, a picture elsewhere.
async function tagOf(drawing: Drawing, name: string) {
  const texts = await drawing.findAll({ type: 'Text' })
  const pictures = await drawing.findAll({ type: 'Svg' })
  return texts.find(t => t.text === name.toUpperCase()) ?? pictures.find(p => p.props.alt === name)
}

// The thread names on the band, as its buttons are keyed.
async function threadsOn(band: Drawing & { find: (q: { key: string }) => Promise<unknown> }, keys: string[]) {
  const on: string[] = []
  for (const key of keys) if ((await band.find({ key: `picker:thread:${key}` })) !== undefined) on.push(key)
  return on
}

// The note beside the last prompt that says what its headings meant.
const noteOf = (prompt: string | undefined) =>
  (prompt ?? '').split('\n--\n').find(part => part.startsWith('Thread headings in this message')) ?? ''

test('a heading starts with a name as whole words, the longest, in any case, with words after it', async () => {
  const names = ['Threads', 'view', 'View transcript']
  expect(headingStart('Threads Lets fix the view', names)).toEqual({ name: 'Threads', rest: 'Lets fix the view' })
  expect(headingStart('threads lets fix', names)).toEqual({ name: 'threads', rest: 'lets fix' })
  expect(headingStart('view  transcript is broken', names)).toEqual({ name: 'view transcript', rest: 'is broken' })
  expect(headingStart('view is broken', names)).toEqual({ name: 'view', rest: 'is broken' })
  expect(headingStart('Threads: lets fix', names)).toEqual({ name: 'Threads', rest: 'lets fix' })
  expect(headingStart('Threads - lets fix', names)).toEqual({ name: 'Threads', rest: 'lets fix' })
  // not as a whole word, nothing after it, or only marks after it
  expect(headingStart('Threadsy stuff', names)).toBeUndefined()
  expect(headingStart('Threads-view', names)).toBeUndefined()
  expect(headingStart('Threads', names)).toBeUndefined()
  expect(headingStart('Threads ?', names)).toBeUndefined()
  expect(headingStart('Ideas for later', names)).toBeUndefined()
})

test('a heading line of any length splits where asked, outside code fences only', async () => {
  const long = `#Threads ${'and the view '.repeat(6)}too`
  const text = ['intro', long, 'more', '```', '#Threads in a fence', '```', '## Threads not level one'].join('\n')
  const split = splitRunOns(text, typed => headingStart(typed, ['Threads']))
  expect(split.split('\n').slice(0, 4)).toEqual(['intro', '# Threads', `${'and the view '.repeat(6)}too`, 'more'])
  expect(split).toContain('#Threads in a fence')
  expect(split).toContain('## Threads not level one')
  const sections = splitSections(split, () => true)
  expect(sections.map(s => s.thread)).toEqual([null, 'Threads'])
  expect(sections[1]?.text).toStartWith('and the view')
})

test("a heading typed with its first line on the heading's line is split, told to the model and drawn so", async ($, on) => {
  const prompts = engine(on)
  await flipThreads($)
  await $.prompt.submit(say('# Threads\na\n# perf\nb'))

  const long = '#Threads Lets fix the view so that every section shows up in the pane'
  await $.prompt.submit(say(`${long}\nand keep the tags`))
  expect(noteOf(prompts.at(-1))).toBe(
    'Thread headings in this message, as the user meant them: "#Threads Lets fix the view so that every section…" is the thread "Threads", its first line typed on the heading\'s line.',
  )
  await $.prompt.submit(say('# threads: lets fix\nthe band'))
  expect(noteOf(prompts.at(-1))).toContain('"#threads: lets fix" is the thread "Threads"')

  const band = await $.ui.mount({ plugin: 'thread-chat', surface: 'terminal', ...BAND })
  expect(await threadsOn(band, ['threads', 'perf', 'threads lets fix', 'threads: lets fix'])).toEqual(['threads', 'perf'])

  for (const surface of ['terminal', 'desktop'] as const) {
    // one thread alone: the tag above, the rest of the heading's line the first of the text
    const single = await $.ui.mount({ plugin: 'thread-chat', surface, ...userRow(`${long}\nand keep the tags`) })
    expect(await tagOf(single, 'Threads')).toBeDefined()
    expect((await single.find({ type: 'Text', text: /keep the tags/ }))?.text).toBe(
      'Lets fix the view so that every section shows up in the pane\nand keep the tags',
    )
    await single.unmount()

    // several sections: the plain marker, then that line
    const several = await $.ui.mount({ plugin: 'thread-chat', surface, ...userRow('intro\n#Threads lets fix\nmore\n# perf\nb') })
    expect(await tagOf(several, 'Threads')).toBeDefined()
    expect((await several.find({ type: 'Text', text: /intro/ }))?.text).toBe('intro\n\n▸ Threads\nlets fix\nmore\n\n▸ perf\nb')
    await several.unmount()
  }
})

test('the longest thread name a heading starts with is its thread; a merged name counts', async ($, on) => {
  const prompts = engine(on)
  await flipThreads($)
  await $.prompt.submit(say('# Threads\na\n# view\nb\n# view transcript\nc\n# threading\nd'))
  await $.command.run({ command: 'merge-threads', args: 'threading into Threads', origin: { kind: 'composer' }, presentation: {} as never })

  await $.prompt.submit(say('# View transcript is broken\nagain'))
  expect(noteOf(prompts.at(-1))).toContain('"#View transcript is broken" is the thread "view transcript"')
  const row = await $.ui.mount({ plugin: 'thread-chat', surface: 'terminal', ...userRow('# View transcript is broken\nagain') })
  expect(await tagOf(row, 'view transcript')).toBeDefined()
  expect(await tagOf(row, 'view')).toBeUndefined()
  expect((await row.find({ type: 'Text', text: /again/ }))?.text).toBe('is broken\nagain')
  await row.unmount()

  // a merged thread's old name, as a heading alone or with the first line after it
  await $.prompt.submit(say('# threading\ne'))
  expect(noteOf(prompts.at(-1))).toBe('Thread headings in this message, as the user meant them: "#threading" is the thread "Threads".')
  await $.prompt.submit(say('#threading lets fix\nf'))
  expect(noteOf(prompts.at(-1))).toContain('"#threading lets fix" is the thread "Threads", its first line')
  const merged = await $.ui.mount({ plugin: 'thread-chat', surface: 'desktop', ...userRow('#threading lets fix\nf') })
  expect(await tagOf(merged, 'Threads')).toBeDefined()
  expect((await merged.find({ type: 'Text', text: /lets fix/ }))?.text).toBe('lets fix\nf')
})

test('a heading that is a name, starts with none, asks for a new thread or abbreviates another stays a heading', async ($, on) => {
  const prompts = engine(on)
  await flipThreads($)
  await $.prompt.submit(say('# Threads\na\n# Threads fixes\nb'))

  // exactly a thread's name: nothing to tell
  await $.prompt.submit(say('# Threads fixes\nc'))
  expect(noteOf(prompts.at(-1))).toBe('')
  // another thread's name abbreviated: that thread, not "Threads" with "fix" after it
  await $.prompt.submit(say('# Threads fix\nd'))
  expect(noteOf(prompts.at(-1))).toContain('"#Threads fix" is the thread "Threads fixes"')
  // a name that is not a whole word of the heading: a new thread, as before
  await $.prompt.submit(say('# Threadsy stuff\ne'))
  // `+` asks for a new thread by the whole heading
  await $.prompt.submit(say('#+Threads lets fix\nf'))
  expect(noteOf(prompts.at(-1))).toContain('"#+Threads lets fix" starts the new thread "Threads lets fix"')
  // a heading starting with no thread's name: a new thread; too long for one, plain text
  await $.prompt.submit(say('# Ideas for later\ng'))
  await $.prompt.submit(say('# Notes on a thing that has no thread and runs on far too long to be one\nh'))

  const band = await $.ui.mount({ plugin: 'thread-chat', surface: 'terminal', ...BAND })
  expect(
    await threadsOn(band, ['threads', 'threads fixes', 'threadsy stuff', 'threads lets fix', 'ideas for later', 'notes on a thing']),
  ).toEqual(['threads', 'threads fixes', 'threadsy stuff', 'threads lets fix', 'ideas for later'])

  // as drawn, each still means what it meant at send
  for (const [text, thread] of [
    ['# Threads fix\nd', 'Threads fixes'],
    ['#+Threads lets fix\nf', 'Threads lets fix'],
  ] as const) {
    const row = await $.ui.mount({ plugin: 'thread-chat', surface: 'terminal', ...userRow(text) })
    expect(await tagOf(row, thread)).toBeDefined()
    expect(await tagOf(row, 'Threads')).toBeUndefined()
    await row.unmount()
  }
})

test('a split heading is not recorded, so an abbreviation still means its thread', async ($, on) => {
  const prompts = engine(on)
  await flipThreads($)
  await $.prompt.submit(say('# design\na'))
  await $.prompt.submit(say('#design the pills are tall\nb'))
  await $.prompt.submit(say('# desi\nc'))
  expect(noteOf(prompts.at(-1))).toContain('"#desi" is the thread "design"')
  const band = await $.ui.mount({ plugin: 'thread-chat', surface: 'terminal', ...BAND })
  expect(await threadsOn(band, ['design', 'desi', 'design the pills are tall'])).toEqual(['design'])
})

test('the thread view shows the rest of a split heading as the first line of its thread', async ($, on) => {
  engine(on)
  await flipThreads($)
  await $.prompt.submit(say('# Threads\na\n# perf\nb'))
  const text = '#Threads Lets fix the view\nand the tags'
  await $.prompt.submit(say(text))
  const store = (uuid: string, role: 'user' | 'assistant', said: string) =>
    $.session
      .append({
        message:
          role === 'assistant'
            ? { type: 'assistant', role, content: [{ type: 'text', text: said }] }
            : { type: 'user', role, content: [{ type: 'text', text: said }] },
        door: role === 'assistant' ? 'response' : 'prompt',
        origin: role === 'assistant' ? { kind: 'model', model: 'test' } : { kind: 'composer' },
        uuid,
      })
      .catch(() => undefined)
  await store('p1', 'user', text)
  await store('a1', 'assistant', '# Threads\non it')

  const band = await $.ui.mount({ plugin: 'thread-chat', surface: 'terminal', ...BAND })
  await band.press({ key: 'picker:thread:threads' })
  const pane = await $.ui.mount({ plugin: 'thread-chat', surface: 'terminal', ...PANE })
  // the person's section a bubble of their words, the reply's markdown
  expect((await pane.findAll({ type: 'Text' })).map(t => t.text)).toContain('Lets fix the view\nand the tags')
  expect((await pane.findAll({ type: 'Markdown' })).map(m => String(m.props.text))).toEqual(['on it'])
  expect(await tagOf(pane, 'Threads')).toBeDefined()
})
