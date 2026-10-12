import type { On } from 'claude-code'
import { expect, mock, test } from 'claude-code/testing'
import type { Engine } from 'claude-code/testing'

// The test stands in for the engine beneath the plugin. A command's output row draws as
// its text, so a test sees what it was asked to draw.
function engine(on: On) {
  // the welcome line dismissed: welcome.test.ts covers it
  mock.store(on, { welcome: ['thread-chat'] })
  on('session.id', () => ({ value: 'session-1' }))
  on('session.start', ($, e) => ({ cwd: e.cwd }))
  on('prompt.submit', ($, e) => ({ text: e.text }))
  on('tool.register', ($, e) => ({ value: { tool: `mcp__thread-chat__${e.name}` } }))
  on('command.register', ($, e) => ({ value: { command: e.name } }))
  on('ui.render', ($, e) => {
    if (e.component !== 'CommandOutput') return { type: 'engine', ref: 0 }
    const { Text } = $.ui.resolve(e)
    return Text({ children: [e.props.text] })
  })
  on('ui.message', () => ({}))
  on('ui.close', () => ({ value: undefined }))
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

const say = (text: string) => ({ text, origin: { kind: 'composer' as const }, wait: false })

const threads = async ($: Engine, args: string) =>
  (await $.command.run({ command: 'threads', args, origin: { kind: 'composer' }, presentation: {} as never })).text ?? ''

// An output row of /threads manage, as the transcript draws it: `text` what the run said.
const outputRow = (text: string, requestId: string, args = 'manage') =>
  ({ component: 'CommandOutput', props: { command: 'threads', args, text, isErrored: false }, requestId }) as const

// The thread names the picker above the prompt offers.
async function pickerChoices(band: { find: (q: { key: string }) => Promise<{ props: Record<string, unknown> } | undefined> }) {
  const options = ((await band.find({ key: 'thread-picker' }))?.props.options ?? []) as { value: string; label?: string }[]
  return options.flatMap(o => (o.value.startsWith('thread:') ? [o.label] : []))
}

test('/threads manage says the threads, and its output row draws the panel: archive, unarchive, delete, done', async ($, on) => {
  engine(on)
  await $.session.start({ cwd: '.', surface: 'desktop', isInteractive: true })
  expect(await threads($, 'manage')).toBe('Threads are off in this chat; /threads turns them on.')
  await threads($, 'on')
  expect(await threads($, 'manage')).toBe('No threads yet: start one with a # name heading.')
  await $.prompt.submit(say('# design\na\n# perf\nb'))

  const text = await threads($, 'manage')
  expect(text).toBe('Threads: design, perf.')
  const row = await $.ui.mount({ plugin: 'thread-chat', surface: 'desktop', ...outputRow(text, 'out-1') })
  for (const key of ['threads:done', 'threads:merge:design', 'threads:archive:design', 'threads:delete:design', 'threads:archive:perf']) {
    expect(await row.find({ key })).toBeDefined()
  }
  expect(await row.find({ type: 'Text', text: 'design' })).toBeDefined()

  // archived, a thread leaves the picker and moves to the panel's archived threads
  await row.press({ key: 'threads:archive:perf' })
  await row.redraw()
  expect(await row.find({ key: 'threads:unarchive:perf' })).toBeDefined()
  expect(await row.find({ key: 'threads:archive:perf' })).toBeUndefined()
  expect(await row.find({ type: 'Text', text: 'archived' })).toBeDefined()
  // one thread left to post to, so nothing to merge into
  expect(await row.find({ key: 'threads:merge:design' })).toBeUndefined()
  const band = await $.ui.mount({ plugin: 'thread-chat', surface: 'desktop', ...BAND })
  expect(await pickerChoices(band)).toEqual(['design'])

  // delete asks first; cancel goes back; delete drops the thread
  await row.press({ key: 'threads:delete:perf' })
  await row.redraw()
  expect(await row.find({ type: 'Text', text: 'delete perf?' })).toBeDefined()
  await row.press({ key: 'threads:cancel' })
  await row.redraw()
  expect(await row.find({ key: 'threads:delete:perf' })).toBeDefined()
  await row.press({ key: 'threads:delete:perf' })
  await row.redraw()
  await row.press({ key: 'threads:delete-yes' })
  await row.redraw()
  expect(await row.find({ key: 'threads:unarchive:perf' })).toBeUndefined()
  expect(await row.find({ key: 'threads:archive:design' })).toBeDefined()

  // done: the row is text again, saying where the threads stand now
  await row.press({ key: 'threads:done' })
  await row.redraw()
  expect(await row.find({ key: 'threads:archive:design' })).toBeUndefined()
  expect(await row.drawn()).toMatchObject({ type: 'Text', children: ['Threads: design.'] })
})

test('only the row of the latest /threads manage draws the panel; an earlier one, or one while threads are off, is its text', async ($, on) => {
  engine(on)
  await $.session.start({ cwd: '.', surface: 'terminal', isInteractive: true })
  await threads($, 'on')
  await $.prompt.submit(say('# design\na\n# perf\nb'))

  // a row drawn before the run, such as one from an earlier run of the app, stays text
  const older = await $.ui.mount({ plugin: 'thread-chat', surface: 'terminal', ...outputRow('Threads: design.', 'out-old') })
  expect(await older.drawn()).toMatchObject({ type: 'Text', children: ['Threads: design.'] })

  const text = await threads($, 'manage')
  const row = await $.ui.mount({ plugin: 'thread-chat', surface: 'terminal', ...outputRow(text, 'out-new') })
  expect(await row.find({ key: 'threads:done' })).toBeDefined()
  await older.redraw()
  expect(await older.find({ key: 'threads:done' })).toBeUndefined()
  // another command's row, or another /threads row, is the engine's drawing
  const status = await $.ui.mount({ plugin: 'thread-chat', surface: 'terminal', ...outputRow('Threads: on', 'out-status', 'status') })
  expect(await status.find({ key: 'threads:done' })).toBeUndefined()

  // merge lists the threads to merge into; the picked one joins it
  await row.press({ key: 'threads:merge:perf' })
  await row.redraw()
  expect(await row.find({ type: 'Text', text: 'merge perf into' })).toBeDefined()
  await row.press({ key: 'threads:merge-into:design' })
  await row.redraw()
  expect(await row.find({ key: 'threads:archive:perf' })).toBeUndefined()
  expect(await row.find({ key: 'threads:archive:design' })).toBeDefined()

  // threads off, the row is its text; on again, the panel is back
  await threads($, 'off')
  await row.redraw()
  expect(await row.find({ key: 'threads:done' })).toBeUndefined()
  await threads($, 'on')
  await row.redraw()
  expect(await row.find({ key: 'threads:done' })).toBeDefined()
})
