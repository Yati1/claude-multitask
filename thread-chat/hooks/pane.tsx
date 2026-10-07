import type { Args, ElementTable, RenderElement, SessionMessage } from 'claude-code'

import type { Thread, ViewRow } from '../types'
import { isPluginFramed, keyOf, splitSections } from './parse'
import type { Section } from './parse'

// The thread view: a pane of the picked threads' conversation alone, the person's
// messages and Claude's replies a section at a time, with no tool rows and no gaps
// where the chat hides a row.
//
// It draws from the rows it kept as the session stored them (`session.append`),
// each with its id and text: the transcript as the person sees it. A compaction
// rewrites the conversation `$.session.messages()` reads (its summary in place of
// what it replaced) but not the stored rows, so the view keeps what came before
// it. That read only fills in rows kept without their text, and stands in for a
// session the view kept no rows of.
//
// Here are its rules and its layout, as plain functions; register.tsx owns every
// hook and every call on `$`. A plugin hooks an event once without a matcher, and
// the engine follows `$` only into functions of the file that uses it.

type Links = Record<string, string>

// What the view borrows from register.tsx, which owns these rules, so a section
// lands in the view where the chat draws it.
export type ViewDeps = {
  threadOf: (name: string, list: Thread[], links: Links) => Thread | undefined
  personThreadOf: (name: string, list: Thread[], links: Links) => Thread | undefined
  personSectionsOf: (text: string, list: Thread[], snapped: Links, merged: Links) => Section[]
  placeSection: (
    s: Section,
    row: string,
    moves: Links,
    resolve: (name: string) => Thread | undefined,
    list: Thread[],
    links: Links,
  ) => Section
  stemOf: (id: string) => string
}

// Rows remembered by id; the newest are kept.
const ROWS_KEPT = 1000
// Characters of text a session's rows keep in all; the newest rows keep theirs,
// older ones their id and mark alone.
const TEXT_KEPT = 256_000
// Characters of JSON the store keeps of all sessions' rows; the most recently kept
// sessions' stay. The store holds 4 MiB in all, the threads' records included.
const VIEWS_KEPT = 2_000_000
// Sections drawn at once; the newest are drawn.
const SECTIONS_DRAWN = 200
const MARK_LENGTH = 80
// The marker beside the person's sections of no thread.
const NO_THREAD_COLOR = '#8c8c8c'

// Where a session's view rows are kept between runs of the app.
export const viewKey = (sessionId: string) => `view:${sessionId}`

// A text's start with its spacing dropped: the same however a row's text blocks
// were joined.
export const markOf = (text: string) => text.replace(/\s+/g, '').slice(0, MARK_LENGTH)

function textBlocks(content: readonly { type: string; [field: string]: unknown }[]): string[] {
  return content.flatMap(block => (block.type === 'text' && typeof block.text === 'string' ? [block.text] : []))
}

// A stored row of the main conversation as the view knows it: a person's message
// or a reply's text, with the text the transcript shows; none else. A compaction's
// summary is the engine's (door `compaction`), not the person's.
export function viewRowOf(e: Args<'session.append'>, person: ReadonlySet<string>): ViewRow | undefined {
  if (e.agentId !== undefined) return undefined
  const blocks = textBlocks(e.message.content)
  const text = blocks.join('\n')
  if (text.trim() === '') return undefined
  if (e.message.type === 'assistant') return { id: e.uuid, role: 'assistant', mark: markOf(text), text }
  const isPerson =
    e.message.type === 'user' &&
    e.message.isMeta !== true &&
    person.has(e.origin.kind) &&
    (e.door === 'prompt' || e.door === 'delivery')
  if (!isPerson || isPluginFramed(text)) return undefined
  // Notes for the model follow the prompt as typed, a block each; the transcript
  // shows the prompt alone.
  const typed = blocks[0] ?? ''
  return blocks.length > 1
    ? { id: e.uuid, role: 'user', mark: markOf(text), text: typed, typed: typed.length }
    : { id: e.uuid, role: 'user', mark: markOf(text), text }
}

// The rows known once `row` is: the newest ROWS_KEPT, one per id (a row stored
// again replaces itself), the newest of them with their text, up to TEXT_KEPT.
export function withViewRow(all: ViewRow[], row: ViewRow): ViewRow[] {
  const at = all.findIndex(known => known.id === row.id)
  const rows = at < 0 ? [...all, row] : all.map((known, i) => (i === at ? row : known))
  return withTextKept(rows.slice(-ROWS_KEPT))
}

// The rows with the newest texts kept, up to `budget` characters in all: older
// rows keep their id and mark (and length as typed), by which a transcript that
// still holds them fills their text in.
export function withTextKept(rows: readonly ViewRow[], budget = TEXT_KEPT): ViewRow[] {
  let left = budget
  const kept = [...rows]
  for (let i = kept.length - 1; i >= 0; i--) {
    const row = kept[i]
    if (row?.text === undefined) continue
    left -= row.text.length
    if (left < 0) {
      const { id, role, mark, typed } = row
      kept[i] = typed === undefined ? { id, role, mark } : { id, role, mark, typed }
    }
  }
  return kept
}

// Each transcript message's stored row (its index in `known`), matched in order by
// role and mark; none for a message stored before the view kept rows, or not the
// person's or a reply (a compaction's summary).
function alignRows(messages: readonly SessionMessage[], known: readonly ViewRow[]): (number | undefined)[] {
  const byMark = new Map<string, number[]>()
  for (const [i, row] of known.entries()) {
    const at = `${row.role}|${row.mark}`
    const list = byMark.get(at)
    if (list === undefined) byMark.set(at, [i])
    else list.push(i)
  }
  let next = 0
  return messages.map(m => {
    if (m.text.trim() === '') return undefined
    const list = byMark.get(`${m.role}|${markOf(m.text)}`)
    while (list !== undefined && (list[0] ?? Infinity) < next) list.shift()
    const i = list?.shift()
    if (i === undefined) return undefined
    next = i + 1
    return i
  })
}

// The rows a session rewound or forked from another takes up of that one's: up to
// the last one its own transcript holds, as those after it were rewound away. All
// of them where the transcript holds none (it may not be read yet).
export function rowsUpTo(rows: readonly ViewRow[], messages: readonly SessionMessage[]): ViewRow[] {
  const last = alignRows(messages, rows).reduce<number>((max, i) => (i === undefined ? max : Math.max(max, i)), -1)
  return last < 0 ? [...rows] : rows.slice(0, last + 1)
}

// A session's rows as the store keeps them, by size: characters of JSON.
export type ViewSize = { id: string; size: number }

// Which sessions' rows the store keeps once `id`'s are kept at `size`: the most
// recently kept, up to `budget` characters in all, `id`'s last (`index`, oldest
// first); `dropped` the sessions whose rows go, oldest first.
export function viewsKept(index: readonly ViewSize[], id: string, size: number, budget = VIEWS_KEPT) {
  const others = index.filter(view => view.id !== id)
  let total = others.reduce((sum, view) => sum + view.size, size)
  let cut = 0
  while (cut < others.length && total > budget) {
    total -= others[cut]?.size ?? 0
    cut++
  }
  return { index: [...others.slice(cut), { id, size }], dropped: others.slice(0, cut).map(view => view.id) }
}

// Whether a user message with no stored row reads as one the person typed: not a
// tool's result, a plugin's prompt, or the engine's tagged text (a reminder, a notice).
const looksTyped = (m: SessionMessage) =>
  (m.toolResults?.length ?? 0) === 0 && !isPluginFramed(m.text) && !/^\s*</.test(m.text)

// The id each reply was last drawn under in the chat, with its text's mark: the
// desktop knows a reply by its API message's id, and moves of its parts are kept
// under that id.
const drawnMarks = new Map<string, string>()
const DRAWN_KEPT = 2000

// As a reply draws in the chat, before it is split: the id the screen knows it by,
// with its whole text's mark.
export function noteDrawnReply(requestId: string, text: string) {
  drawnMarks.delete(requestId)
  drawnMarks.set(requestId, markOf(text))
  if (drawnMarks.size > DRAWN_KEPT) {
    const oldest = drawnMarks.keys().next().value
    if (oldest !== undefined) drawnMarks.delete(oldest)
  }
}

// The id the person's moves of a row's parts are kept under: the row's own (as
// the screen knows it, by its first characters), or the id a screen drew it by.
function movedRowOf(moves: Links, id: string | undefined, marks: Set<string>, stemOf: (id: string) => string) {
  for (const key of Object.keys(moves)) {
    const row = key.slice(0, key.indexOf('|'))
    if (id !== undefined && stemOf(row) === stemOf(id)) return row
    const drawn = drawnMarks.get(row)
    if (drawn !== undefined && marks.has(drawn)) return row
  }
  return id
}

// What the view is drawn from, as read while drawing it. `messages` is the
// conversation as `$.session.messages()` reads it, needed only while a kept row
// lacks its text or none is kept (`needsMessages`); else it may be left empty.
export type ViewInputs = {
  list: Thread[]
  merged: Links
  snapped: Links
  sent: Links
  moves: Links
  known: ViewRow[]
  messages: SessionMessage[]
}

// Whether the view reads the conversation as `$.session.messages()` has it: for a
// session it kept no rows of, or to fill in rows kept without their text.
export const needsMessages = (known: readonly ViewRow[]) => known.length === 0 || known.some(row => row.text === undefined)

// One message the view draws: its row where one was kept (its id: where its moves
// and sends are kept, and where the transcript shows it), who wrote it, and the
// text the transcript shows.
type Source = { row: ViewRow | undefined; role: 'user' | 'assistant'; text: string }

// The messages the view draws, oldest first: the rows kept as the session stored
// them, each with its text, or the text of the message the conversation still holds
// for it (a row kept without its text); `missing` the rows with neither, which a
// compaction summarised away before their text was kept. For a session with no rows
// kept, the conversation as it reads now.
function sourcesOf(known: readonly ViewRow[], messages: readonly SessionMessage[]) {
  if (known.length === 0) {
    const sources: Source[] = messages
      .filter(m => m.text.trim() !== '' && (m.role === 'assistant' || looksTyped(m)))
      .map(m => ({ row: undefined, role: m.role, text: m.text }))
    return { sources, missing: 0 }
  }
  const held = new Map<number, SessionMessage>()
  if (known.some(row => row.text === undefined)) {
    for (const [i, at] of alignRows(messages, known).entries()) {
      const m = messages[i]
      if (at !== undefined && m !== undefined) held.set(at, m)
    }
  }
  const sources: Source[] = []
  let missing = 0
  for (const [i, row] of known.entries()) {
    const m = held.get(i)
    const text = row.text ?? (m === undefined ? undefined : row.typed === undefined ? m.text : m.text.slice(0, row.typed))
    if (text === undefined || text.trim() === '') missing++
    else sources.push({ row, role: row.role, text })
  }
  return { sources, missing }
}

// One section the view draws; `id` its row's, where one was kept.
type Entry = { id: string | undefined; role: 'user' | 'assistant'; thread: Thread | undefined; text: string }

// The conversation's sections, in order, where the person last placed them, kept
// to the picked threads (all of them while none is picked); `missing` the messages
// whose text is no longer kept.
export function viewEntries(inputs: ViewInputs, deps: ViewDeps) {
  const { list, merged, snapped, sent, moves, known, messages } = inputs
  const picked = list.filter(t => t.isSelected)
  const selected = new Set(picked.map(t => keyOf(t.name)))
  const { sources, missing } = sourcesOf(known, messages)

  const entries: Entry[] = []
  const keep = (id: string | undefined, role: Entry['role'], s: Section, resolve: (name: string) => Thread | undefined) => {
    const thread = s.thread === null ? undefined : resolve(s.thread)
    if (selected.size > 0 && (thread === undefined || !selected.has(keyOf(thread.name)))) return
    // a heading that names no thread stays as typed
    const text = thread === undefined && s.thread !== null ? `# ${s.thread}\n${s.text}`.trim() : s.text
    if (text !== '') entries.push({ id, role, thread, text })
  }

  for (const { row, role, text } of sources) {
    if (role === 'assistant') {
      const resolve = (name: string) => deps.threadOf(name, list, merged)
      const written = splitSections(text, name => resolve(name) !== undefined)
      const marks = new Set([markOf(text), ...written.map(s => markOf(s.text))])
      const at = movedRowOf(moves, row?.id, marks, deps.stemOf)
      for (const s of written) {
        keep(row?.id, 'assistant', at === undefined ? s : deps.placeSection(s, at, moves, resolve, list, merged), resolve)
      }
      continue
    }
    const resolve = (name: string) => deps.personThreadOf(name, list, { ...snapped, ...merged })
    const typed = deps.personSectionsOf(text, list, snapped, merged)
    // A message with no heading may have gone to the one thread picked as it was sent.
    const sentKey =
      row === undefined || typed.some(s => s.thread !== null)
        ? undefined
        : (sent[row.id] ?? Object.entries(sent).find(([id]) => deps.stemOf(id) === deps.stemOf(row.id))?.[1])
    const sentThread = sentKey === undefined ? undefined : deps.threadOf(sentKey, list, merged)
    const sections = sentThread === undefined ? typed : [{ thread: sentThread.name, text }]
    const at = movedRowOf(moves, row?.id, new Set([markOf(text)]), deps.stemOf)
    for (const s of sections) keep(row?.id, 'user', at === undefined ? s : deps.placeSection(s, at, moves, resolve, list, merged), resolve)
  }
  return { entries, picked, missing }
}

// How the pane draws: the surface's elements, a thread's tag in its colour, and
// text as markdown (kept to what a Markdown element takes), as the chat draws them.
export type ViewDrawing = {
  ui: ElementTable
  tag: (thread: Thread) => RenderElement
  markdown: (text: string) => RenderElement
}

// One section: who wrote it, its thread's tag, and its text as markdown. The
// person's sections carry a marker down their left side in their thread's colour;
// Claude's name is dim, its text unmarked.
function drawEntry(draw: ViewDrawing, entry: Entry): RenderElement {
  const { Box, Text } = draw.ui
  const isPerson = entry.role === 'user'
  const head = (
    <Box flexDirection="row" columnGap={1} alignItems="center">
      {isPerson ? <Text bold>you</Text> : <Text bold dimColor>Claude</Text>}
      {entry.thread !== undefined && draw.tag(entry.thread)}
    </Box>
  )
  const body = draw.markdown(entry.text)
  if (!isPerson) {
    return (
      <Box flexDirection="column">
        {head}
        {body}
      </Box>
    )
  }
  return (
    <Box flexDirection="row" columnGap={1}>
      <Box width={1} flexShrink={0} backgroundColor={entry.thread?.color ?? NO_THREAD_COLOR} />
      <Box flexDirection="column" flexGrow={1} flexShrink={1}>
        {head}
        {body}
      </Box>
    </Box>
  )
}

// The pane's body: the picked threads' sections, oldest first, the newest at the bottom.
export function drawView(draw: ViewDrawing, inputs: ViewInputs, deps: ViewDeps): RenderElement {
  const { Box, Text } = draw.ui
  const { entries, picked, missing } = viewEntries(inputs, deps)
  const shown = entries.slice(-SECTIONS_DRAWN)
  const hidden = entries.length - shown.length
  const names = picked.map(t => t.name).join(', ')

  return (
    <Box flexDirection="column" rowGap={1}>
      {picked.length === 0 && <Text dimColor>All threads. Pick threads above the prompt to follow just those.</Text>}
      {hidden > 0 && <Text dimColor>{`${hidden} earlier sections not shown`}</Text>}
      {hidden === 0 && missing > 0 && (
        <Text dimColor>{missing === 1 ? '1 earlier message is no longer kept' : `${missing} earlier messages are no longer kept`}</Text>
      )}
      {shown.length === 0 && <Text dimColor>{picked.length === 0 ? 'Nothing here yet.' : `Nothing in ${names} yet.`}</Text>}
      {shown.map(entry => drawEntry(draw, entry))}
    </Box>
  )
}

// The picked threads of a `threads` value, as one key: another pick differs.
export const pickedOf = (value: unknown) =>
  Array.isArray(value)
    ? (value as Partial<Thread>[])
        .filter(t => t.isSelected === true)
        .map(t => keyOf(String(t.name)))
        .join('|')
    : ''
