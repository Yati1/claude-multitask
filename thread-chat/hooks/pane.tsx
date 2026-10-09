import type { Args, ElementTable, RenderElement, RenderSurface, SessionMessage } from 'claude-code'

import type { Thread, ViewImage, ViewRow } from '../types'
import { isOthersPrompt, isPluginFramed, keyOf, splitSections } from './parse'
import type { Section } from './parse'

// The thread view: a pane of the picked threads' conversation alone, the person's
// messages and each turn's last reply a section at a time, with no tool rows, no
// quiet replies or others' prompts, and no gaps where the chat hides a row. It looks
// as the transcript does: the person's sections in bubbles under the pictures they
// pasted (read from the files Claude Code saved them to), replies as text, and each
// thread's tags and borders drawn by the code that draws the transcript's
// (register.tsx).
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

// Characters a file of kept rows holds at most: under the 4 MiB a file read or
// write takes, however many bytes each character comes to.
const CHUNK_CHARS = 1_000_000
// A long text is kept in pieces of this many characters, a line each, so one line
// fits a file however its characters are escaped.
const PIECE_CHARS = 100_000
// Sections drawn at once; the newest are drawn.
const SECTIONS_DRAWN = 200
const MARK_LENGTH = 80

// The person's sections are bubbles, as the chat draws their messages. On a page
// the fill is grey a tenth opaque: a shade lighter than a dark page (#151515 to
// about #212121, the desktop's own bubble), a shade darker than a light one. The
// theme's key for the bubble (`userMessageBackground`) is the page's own colour
// there; the terminal fills it with that key.
const BUBBLE_FILL = '#8888881a'
const TERMINAL_BUBBLE_FILL = 'userMessageBackground'
// A round border is what rounds a Box's corners on a page; drawn clear, the fill
// alone shows.
const CLEAR = '#00000000'
// What a bubble leaves free at its left: the desktop's stop at about 85% of the
// transcript's width.
const BUBBLE_ROOM = '15%'
// Rows between sections, half a line each on a page (about 10px): a message's or
// reply's own sections as close as the chat's parts of a reply, separate ones as
// far apart as the chat's messages (about 40px). The terminal leaves a line.
const PART_GAP = 1
const MESSAGE_GAP = 4

// Rows short of its end the view's window may stand and still keep to its end as new
// messages come.
const NEAR_END_ROWS = 3

type WindowMove = { offset: number; bodyRows: number; contentRows: number }

// Whether a move left the view's window at or near the end of what it shows.
export const isNearEnd = (move: WindowMove) => move.contentRows - move.bodyRows - move.offset <= NEAR_END_ROWS

// Where the person left the view's window: at its end (or near it), or this many rows
// from its top.
export type ViewPlace = 'end' | number

export const viewPlaceOf = (move: WindowMove): ViewPlace => (isNearEnd(move) ? 'end' : move.offset)

// How the view's window is put back where the person left it, as a surface draws the
// view with its window `offset` rows down; `back` a row it is still to go back to. A
// surface that draws the view afresh (on opening it, on coming back to its tab) starts
// at the top, and the engine does not move it back:
// - at the top though the person left it elsewhere: to the end, and on to their row
//   (`back`) where they left it short of it, once the surface has measured its rows;
// - away from the top with a row to go back to: to that row;
// - else nothing.
export function viewMoveOf(
  place: ViewPlace,
  back: number | undefined,
  offset: number,
): { to: 'end'; back?: number } | { to: number } | undefined {
  if (back !== undefined && offset > 0) return { to: back }
  if (offset !== 0 || place === 0) return undefined
  return place === 'end' ? { to: 'end' } : { to: 'end', back: place }
}

// Where the store notes how a session's view rows are kept between runs of the app
// (KeptView); an earlier version kept the rows themselves there.
export const viewKey = (sessionId: string) => `view:${sessionId}`

// A text's start with its spacing dropped: the same however a row's text blocks
// were joined.
export const markOf = (text: string) => text.replace(/\s+/g, '').slice(0, MARK_LENGTH)

type Blocks = readonly { type: string; [field: string]: unknown }[]

function textBlocks(content: Blocks): string[] {
  return content.flatMap(block => (block.type === 'text' && typeof block.text === 'string' ? [block.text] : []))
}

// Whether a row of Claude's holds a tool call.
export const hasToolCall = (content: Blocks) => content.some(block => block.type === 'tool_use')

// What the multitask plugin's voice replies when it has nothing to say, and what such a
// reply is kept as (the react plugin keeps a reply it made a reaction as that too).
const QUIET = /^(?:\(quiet\)|No response requested\.)$/
// The engine's own rows in the person's place, known by the tag their text opens with:
// a command's echo or output (the multitask plugin's wake-up is one), a background
// task's notice, a reminder.
const ENGINE_TAGGED =
  /^\s*<(?:command-(?:name|message|args)|local-command-(?:stdout|stderr|caveat)|task-notification|system-reminder|bash-(?:input|stdout|stderr))>/
// Another Claude session's message, a thought's hand-back among them.
const PEER_FRAME = /^\s*Another Claude session sent a message/

// Whether a row's text is a message the view shows: Claude's words to the person, or
// the person's own; not a quiet reply, nor another party's prompt in their place.
const isMessageText = (role: 'user' | 'assistant', text: string) =>
  role === 'assistant' ? !QUIET.test(text.trim()) : !isOthersPrompt(text) && !ENGINE_TAGGED.test(text) && !PEER_FRAME.test(text)

// The media types a picture's bytes are drawn for, and the most base64 characters of one
// drawn: what fits in the desktop's largest Svg (131072 characters) around it.
const IMAGE_TYPES = new Set(['image/png', 'image/jpeg', 'image/gif', 'image/webp'])
export const IMAGE_DATA_MAX = 130_000
const BASE64 = /^[A-Za-z0-9+/]+={0,2}$/
// The first base64 characters of a JPEG read for its size: 64 KiB, past the metadata
// that may come before its start-of-frame segment.
const JPEG_HEAD = 87_384

// A picture's size in pixels, read from its header (PNG, GIF, JPEG); none where unread.
export function imageSizeOf(type: string, data: string): { width?: number; height?: number } {
  try {
    const bytes = atob(type === 'image/jpeg' ? data.slice(0, JPEG_HEAD) : data.slice(0, 32))
    const at = (i: number) => bytes.charCodeAt(i)
    const word = (i: number) => (at(i) << 8) | at(i + 1)
    if (type === 'image/png') return { width: word(16) * 65536 + word(18), height: word(20) * 65536 + word(22) }
    if (type === 'image/gif') return { width: at(6) | (at(7) << 8), height: at(8) | (at(9) << 8) }
    // a JPEG's size is in its first start-of-frame segment
    for (let i = 2; type === 'image/jpeg' && i + 9 < bytes.length && at(i) === 0xff; i += 2 + word(i + 2)) {
      const marker = at(i + 1)
      if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc) {
        return { width: word(i + 7), height: word(i + 5) }
      }
    }
  } catch {
    // not base64 after all: no size
  }
  return {}
}

// A picture's media type, known by its first bytes (PNG, JPEG, GIF, WebP); none for another.
export function imageTypeOf(data: string): string | undefined {
  if (data.startsWith('iVBORw0KGgo')) return 'image/png'
  if (data.startsWith('/9j/')) return 'image/jpeg'
  if (data.startsWith('R0lGOD')) return 'image/gif'
  if (data.startsWith('UklGR') && data.slice(11, 16) === 'XRUJQ') return 'image/webp'
  return undefined
}

// A picture's bytes as the view draws them: whole, of a type drawn, and few enough.
export const isDrawable = (type: string, data: string) => IMAGE_TYPES.has(type) && data.length <= IMAGE_DATA_MAX && BASE64.test(data)

// The pictures in a row's blocks, in order: each one's media type and size. Their bytes
// stay in the transcript; the files they were saved to come in a row of their own
// (imagePathsOf).
function imagesOf(content: Blocks): ViewImage[] {
  return content.flatMap((block): ViewImage[] => {
    if (block.type !== 'image') return []
    const source = (block.source ?? {}) as { type?: unknown; media_type?: unknown; data?: unknown }
    const type = typeof source.media_type === 'string' ? source.media_type : 'image'
    const data = source.type === 'base64' && typeof source.data === 'string' ? source.data : undefined
    return [data === undefined ? { type } : { type, ...imageSizeOf(type, data) }]
  })
}

// The line Claude Code stores for a picture the person pasted, naming the file it saved
// it to: in a hidden row of its own after their message, a text block a picture.
const IMAGE_SOURCE = /^\[Image: source: (.+)\]$/

// The files a stored row names for the pictures pasted with the person's message before
// it, in order; none for any other row.
export function imagePathsOf(e: Args<'session.append'>): string[] | undefined {
  if (e.agentId !== undefined || e.message.type !== 'user' || e.message.isMeta !== true) return undefined
  const paths: string[] = []
  for (const block of e.message.content) {
    const path = block.type === 'text' && typeof block.text === 'string' ? IMAGE_SOURCE.exec(block.text.trim())?.[1]?.trim() : undefined
    if (path === undefined || path === '') return undefined
    paths.push(path)
  }
  return paths.length > 0 ? paths : undefined
}

// The rows known once row `id`'s pictures are known by their files, in order.
export function withImagePaths(all: ViewRow[], id: string, paths: readonly string[]): ViewRow[] {
  return all.map(row =>
    row.id !== id || row.images === undefined
      ? row
      : { ...row, images: row.images.map((image, i) => (paths[i] === undefined ? image : { ...image, path: paths[i] })) },
  )
}

// The rows known once the same rows as a session's files hold them (`kept`) lend them
// the pictures' files they lack: a picture's file noted there since. `all` itself when
// they lend none.
export function withKeptPaths(all: ViewRow[], kept: readonly ViewRow[]): ViewRow[] {
  const lent = new Map(kept.flatMap(row => (row.images?.some(image => image.path !== undefined) === true ? [[row.id, row.images]] : [])))
  if (lent.size === 0) return all
  let isChanged = false
  const rows = all.map(row => {
    const from = lent.get(row.id)
    if (from === undefined || row.role !== 'user') return row
    if (row.images === undefined || row.images.length === 0) {
      isChanged = true
      return { ...row, images: from }
    }
    const images = row.images.map((image, i) => {
      const path = from[i]?.path
      if (image.path !== undefined || path === undefined) return image
      isChanged = true
      return { ...image, path }
    })
    return { ...row, images }
  })
  return isChanged ? rows : all
}

// A stored row of the main conversation as the view knows it: a person's message
// (with the pictures they pasted) or a reply's text, with the text the transcript
// shows; none else. A compaction's summary is the engine's (door `compaction`), not
// the person's.
export function viewRowOf(e: Args<'session.append'>, person: ReadonlySet<string>): ViewRow | undefined {
  if (e.agentId !== undefined) return undefined
  const blocks = textBlocks(e.message.content)
  const text = blocks.join('\n')
  if (e.message.type === 'assistant') {
    if (text.trim() === '') return undefined
    const row: ViewRow = { id: e.uuid, role: 'assistant', mark: markOf(text), text }
    return hasToolCall(e.message.content) ? { ...row, interim: true } : row
  }
  const isPerson =
    e.message.type === 'user' &&
    e.message.isMeta !== true &&
    person.has(e.origin.kind) &&
    (e.door === 'prompt' || e.door === 'delivery')
  if (!isPerson || isPluginFramed(text)) return undefined
  const images = imagesOf(e.message.content)
  if (text.trim() === '' && images.length === 0) return undefined
  // Notes for the model follow the prompt as typed, a block each; the transcript
  // shows the prompt alone.
  const typed = blocks[0] ?? ''
  const row: ViewRow =
    blocks.length > 1
      ? { id: e.uuid, role: 'user', mark: markOf(text), text: typed, typed: typed.length }
      : { id: e.uuid, role: 'user', mark: markOf(text), text }
  return images.length > 0 ? { ...row, images } : row
}

// The rows known once `row` is: every one, one per id (a row stored again replaces
// itself, still interim if it was).
export function withViewRow(all: ViewRow[], row: ViewRow): ViewRow[] {
  const at = all.findIndex(known => known.id === row.id)
  if (at < 0) return [...all, row]
  return all.map((known, i) => (i !== at ? known : known.interim === true ? { ...row, interim: true } : row))
}

// The rows known once those of `ids` are known as interim: replies a tool call
// followed in their turn, which the view leaves out (it shows a turn's last reply).
export function withInterim(all: ViewRow[], ids: ReadonlySet<string>): ViewRow[] {
  return all.map(row => (ids.has(row.id) && row.interim !== true ? { ...row, interim: true } : row))
}

// How the store notes a session's kept rows: a fingerprint of each of its files'
// text, in order. The files are written before the note, and only those whose text
// changed; the note's count is how many there are.
export type KeptView = { chunks: string[] }

export const isKeptView = (value: unknown): value is KeptView =>
  typeof value === 'object' &&
  value !== null &&
  Array.isArray((value as { chunks?: unknown }).chunks) &&
  (value as { chunks: unknown[] }).chunks.every(chunk => typeof chunk === 'string')

// A 32-bit FNV-1a hash, in hex.
function hashOf(text: string) {
  let hash = 0x811c9dc5
  for (let i = 0; i < text.length; i++) {
    hash ^= text.charCodeAt(i)
    hash = Math.imul(hash, 0x01000193)
  }
  return (hash >>> 0).toString(16).padStart(8, '0')
}

// A file's text as the store notes it: its length and hash.
export const fingerprintOf = (text: string) => `${text.length.toString(36)}.${hashOf(text)}`

// A session's rows as files: a JSON line a row, its text's first piece with it, a
// line `{ id, more }` for each further piece of a long text, and a line `{ id, image }`
// for each picture; as many lines a file as fit in `size` characters.
export function chunksOf(rows: readonly ViewRow[], size = CHUNK_CHARS, piece = PIECE_CHARS): string[] {
  const chunks: string[] = []
  let lines: string[] = []
  let length = 0
  const put = (line: string) => {
    if (lines.length > 0 && length + line.length + 1 > size) {
      chunks.push(`${lines.join('\n')}\n`)
      lines = []
      length = 0
    }
    lines.push(line)
    length += line.length + 1
  }
  for (const { images, ...row } of rows) {
    const text = row.text
    if (text === undefined || text.length <= piece) {
      put(JSON.stringify(row))
    } else {
      put(JSON.stringify({ ...row, text: text.slice(0, piece) }))
      for (let at = piece; at < text.length; at += piece) put(JSON.stringify({ id: row.id, more: text.slice(at, at + piece) }))
    }
    for (const image of images ?? []) put(JSON.stringify({ id: row.id, image }))
  }
  if (lines.length > 0) chunks.push(`${lines.join('\n')}\n`)
  return chunks
}

// The rows a session's files hold, in order (chunksOf). A line that does not read
// as a row (a write cut short) is passed over.
export function rowsOfChunks(chunks: readonly string[]): ViewRow[] {
  const rows: ViewRow[] = []
  for (const chunk of chunks) {
    for (const line of chunk.split('\n')) {
      if (line.trim() === '') continue
      let value: Partial<ViewRow> & { more?: unknown; image?: Partial<ViewImage> }
      try {
        value = JSON.parse(line) as Partial<ViewRow> & { more?: unknown; image?: Partial<ViewImage> }
      } catch {
        continue
      }
      if (typeof value !== 'object' || value === null || typeof value.id !== 'string') continue
      const last = rows[rows.length - 1]
      if (typeof value.more === 'string') {
        if (last?.id === value.id) rows[rows.length - 1] = { ...last, text: (last.text ?? '') + value.more }
        continue
      }
      if (typeof value.image === 'object' && value.image !== null) {
        const image = value.image
        if (last?.id === value.id && typeof image.type === 'string') {
          rows[rows.length - 1] = { ...last, images: [...(last.images ?? []), image as ViewImage] }
        }
        continue
      }
      if ((value.role === 'user' || value.role === 'assistant') && typeof value.mark === 'string') rows.push(value as ViewRow)
    }
  }
  return rows
}

// A row's mark as another session's rows are matched to it, without reading their
// text: a file of these, a line a row, is kept beside a session's rows.
export const markHashOf = (mark: string) => hashOf(mark)
export const marksOf = (rows: readonly ViewRow[]) => rows.map(row => markHashOf(row.mark)).join('\n')

// The folder Claude Code names for a plugin's data, under its configuration folder:
// `<name>-<marketplace>` for one installed from a marketplace (beneath
// `plugins/cache/<marketplace>/`, whose configuration folder it takes),
// `<name>-inline` for one loaded from a folder as it is. None where neither tells
// the configuration folder.
export function dataFolderOf(root: string, name: string, config: string | undefined): string | undefined {
  const installed = /^(.*)[\\/]plugins[\\/]cache[\\/]([^\\/]+)[\\/]/.exec(root)
  const base = installed?.[1] ?? config
  if (base === undefined || base === '') return undefined
  const folder = `${name}-${installed?.[2] ?? 'inline'}`.replace(/[^A-Za-z0-9_-]/g, '-')
  return `${base.replace(/[\\/]+$/, '')}/plugins/data/${folder}`
}

// The name of a picture's smaller copy, kept under the plugin's data folder: one per
// file, made again when the file changes.
export const thumbNameOf = (path: string, size: number, mtimeMs: number) =>
  `${hashOf(path)}-${size.toString(36)}-${Math.floor(mtimeMs).toString(36)}.jpg`

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

// The conversation's replies a tool call followed in their turn (by index): a turn's
// words before its last reply. A message of the person's, or another's prompt, starts
// a turn; a tool's result does not.
function interimIn(messages: readonly SessionMessage[]): Set<number> {
  const interim = new Set<number>()
  let said: number[] = []
  for (const [i, m] of messages.entries()) {
    if (m.role === 'user') {
      if ((m.toolResults?.length ?? 0) === 0) said = []
      continue
    }
    if (m.text.trim() !== '') said.push(i)
    if (m.toolUses.length > 0) {
      for (const at of said) interim.add(at)
      said = []
    }
  }
  return interim
}

// The messages the view draws, oldest first: the rows kept as the session stored
// them, each with its text. A row an earlier version kept without its text draws
// while the conversation still holds it, as that version drew it. For a session
// with no rows kept, the conversation as it reads now. Only messages: the person's
// own and each turn's last reply, never a quiet one.
function sourcesOf(known: readonly ViewRow[], messages: readonly SessionMessage[]): Source[] {
  if (known.length === 0) {
    const interim = interimIn(messages)
    return messages
      .filter((m, i) => m.text.trim() !== '' && !interim.has(i) && (m.role === 'assistant' || looksTyped(m)) && isMessageText(m.role, m.text))
      .map(m => ({ row: undefined, role: m.role, text: m.text }))
  }
  const held = new Map<number, SessionMessage>()
  if (known.some(row => row.text === undefined)) {
    for (const [i, at] of alignRows(messages, known).entries()) {
      const m = messages[i]
      if (at !== undefined && m !== undefined) held.set(at, m)
    }
  }
  const sources: Source[] = []
  for (const [i, row] of known.entries()) {
    if (row.interim === true) continue
    const m = held.get(i)
    const text = row.text ?? (m === undefined ? undefined : row.typed === undefined ? m.text : m.text.slice(0, row.typed))
    const hasImages = (row.images?.length ?? 0) > 0
    if (text !== undefined && (text.trim() !== '' || hasImages) && isMessageText(row.role, text)) sources.push({ row, role: row.role, text })
  }
  return sources
}

// One section the view draws; `id` its row's, where one was kept; `images` the
// pictures pasted with its message, on the first of its sections drawn.
type Entry = { id: string | undefined; role: 'user' | 'assistant'; thread: Thread | undefined; text: string; images?: ViewImage[] }

// The conversation's sections, in order, where the person last placed them, kept
// to the picked threads (all of them while none is picked).
export function viewEntries(inputs: ViewInputs, deps: ViewDeps) {
  const { list, merged, snapped, sent, moves, known, messages } = inputs
  const picked = list.filter(t => t.isSelected)
  const selected = new Set(picked.map(t => keyOf(t.name)))
  const sources = sourcesOf(known, messages)

  const entries: Entry[] = []
  // Whether the section is drawn: in a picked thread, or none picked, and with words
  // or pictures to show.
  const keep = (id: string | undefined, role: Entry['role'], s: Section, resolve: (name: string) => Thread | undefined, images?: ViewImage[]) => {
    const thread = s.thread === null ? undefined : resolve(s.thread)
    if (selected.size > 0 && (thread === undefined || !selected.has(keyOf(thread.name)))) return false
    // a heading that names no thread stays as typed
    const text = thread === undefined && s.thread !== null ? `# ${s.thread}\n${s.text}`.trim() : s.text
    if (text === '' && images === undefined) return false
    entries.push(images === undefined ? { id, role, thread, text } : { id, role, thread, text, images })
    return true
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
    // The pictures pasted with it go with its first section drawn; a message of
    // pictures alone is one section of no words.
    let images = (row?.images?.length ?? 0) > 0 ? row?.images : undefined
    for (const s of sections.length > 0 ? sections : [{ thread: null, text: '' }]) {
      const placed = at === undefined ? s : deps.placeSection(s, at, moves, resolve, list, merged)
      if (keep(row?.id, 'user', placed, resolve, images)) images = undefined
    }
  }
  return { entries, picked }
}

// How the pane draws, as the chat draws the same: the surface and its elements; a
// reply's text as markdown (kept to what a Markdown element takes); the row holding a
// thread's tag above a person's message, at the side their messages sit; and a
// reply's part of a thread, in a border of its colour under its tag.
export type ViewDrawing = {
  surface: RenderSurface
  ui: ElementTable
  markdown: (text: string) => RenderElement
  tagRow: (thread: Thread) => RenderElement
  threadPart: (thread: Thread, body: RenderElement) => RenderElement
  // a pasted picture's bytes to draw, read from its file (or a smaller copy of it):
  // `loading` while they are read, none where they cannot be
  picture: (image: ViewImage) => Picture | 'loading' | undefined
}

// A picture's bytes as drawn, base64, few enough for an Svg, with its media type and
// its size in pixels where its header tells it.
export type Picture = { type: string; data: string; width?: number; height?: number }

// A text as a drawn string may hold it: no control characters but tab and newline.
const drawableOf = (text: string) => text.replace(/[\u0000-\u0008\u000b-\u001f\u007f]/g, '')

// The desktop's reply to a selected part of a message, as parse.ts's replyQuotesOf
// reads it: a marker line, then the selection quoted line by line (`> `).
const REPLY_MARKER = /^<!-- reply(?: [1-9][0-9]?)? -->$/
const QUOTED = /^>(?: |$)/

// A person's text as their bubble shows it: each selection they replied to, on one
// line, and their own words, without the markers.
function bubbleOf(text: string): { quotes: string[]; words: string } {
  const lines = drawableOf(text).split('\n')
  const quotes: string[] = []
  const words: string[] = []
  for (let at = 0; at < lines.length; at++) {
    const line = lines[at] ?? ''
    if (!REPLY_MARKER.test(line)) {
      words.push(line)
      continue
    }
    const quoted: string[] = []
    while (QUOTED.test(lines[at + 1] ?? '')) quoted.push((lines[++at] ?? '').replace(/^> ?/, ''))
    const quote = quoted.join(' ').replace(/\s+/g, ' ').trim()
    if (quote !== '') quotes.push(quote)
  }
  return { quotes, words: words.join('\n').trim() }
}

// A person's section as the chat's bubble: their words as typed (the chat draws no
// markdown in them), under a dim line for each selection they replied to. On a
// page it sits at the right, rounded and a shade off the page; on the terminal it
// spans the pane in the theme's fill.
function drawBubble(draw: ViewDrawing, isPage: boolean, text: string): RenderElement {
  const { Box, Text } = draw.ui
  const { quotes, words } = bubbleOf(text)
  const body = [
    ...quotes.map(quote => (
      <Box flexDirection="row" columnGap={1}>
        <Text dimColor>│</Text>
        <Text dimColor wrap="truncate-end">
          {quote}
        </Text>
      </Box>
    )),
    words !== '' && <Text>{words}</Text>,
  ]
  if (!isPage) {
    return (
      <Box flexDirection="column" backgroundColor={TERMINAL_BUBBLE_FILL} paddingX={1}>
        {body}
      </Box>
    )
  }
  return (
    <Box flexDirection="row" justifyContent="flex-end">
      <Box minWidth={BUBBLE_ROOM} flexShrink={0} />
      <Box
        flexDirection="column"
        flexShrink={1}
        minWidth={0}
        borderStyle="round"
        borderColor={CLEAR}
        backgroundColor={BUBBLE_FILL}
        paddingX={2}
        paddingY={1}
      >
        {body}
      </Box>
    </Box>
  )
}

// A pasted picture as the chat's thumbnail on a page: a card of at most THUMB_WIDTH
// pixels across with rounded corners and a thin border, as tall as the picture's shape
// gives within its bounds (THUMB_HEIGHT where its shape is not known).
const THUMB_WIDTH = 200
const THUMB_HEIGHT = 150
const THUMB_MIN = 40
const THUMB_MAX_HEIGHT = 300
const THUMB_RADIUS = 8
const THUMB_BORDER = '#8888884d'

// A picture's thumbnail as SVG markup, with its size in pixels: its card, the bytes
// drawn in it; an empty card while they are read. As tall as its shape gives, from its
// own size or else the bytes'.
function thumbOf(image: ViewImage, picture: Picture | 'loading'): { source: string; width: number; height: number } {
  const known: { width?: number; height?: number } =
    image.width !== undefined && image.height !== undefined ? image : picture === 'loading' ? {} : picture
  const { width, height } = known
  const isSized = width !== undefined && height !== undefined && width > 0 && height > 0
  const w = isSized ? Math.max(THUMB_MIN, Math.min(THUMB_WIDTH, width)) : THUMB_WIDTH
  const h = isSized ? Math.max(THUMB_MIN, Math.min(THUMB_MAX_HEIGHT, Math.round((w * height) / width))) : THUMB_HEIGHT
  const source = [
    `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}" viewBox="0 0 ${w} ${h}">`,
    picture !== 'loading' && `<clipPath id="card"><rect width="${w}" height="${h}" rx="${THUMB_RADIUS}"/></clipPath>`,
    picture !== 'loading' &&
      `<image href="data:${picture.type};base64,${picture.data}" width="${w}" height="${h}" preserveAspectRatio="xMidYMid slice" clip-path="url(#card)"/>`,
    `<rect x="0.5" y="0.5" width="${w - 1}" height="${h - 1}" rx="${THUMB_RADIUS - 0.5}" fill="none" stroke="${THUMB_BORDER}"/>`,
    '</svg>',
  ]
    .filter(part => part !== false)
    .join('')
  return { source, width: w, height: h }
}

// A picture's bytes as the view draws them: those a row of an earlier version kept, or
// those read from its file; none where neither is to be had.
function pictureOf(draw: ViewDrawing, image: ViewImage): Picture | 'loading' | undefined {
  const { type, data, width, height } = image
  if (data !== undefined && isDrawable(type, data)) return { type, data, width, height }
  return image.path === undefined ? undefined : draw.picture(image)
}

// The pictures pasted with a person's message, above their words as the chat draws
// them: on a page, thumbnails side by side at the right; on the terminal, which draws
// none in the pane, a dim mark for each, as for a picture whose file is gone.
function drawImages(draw: ViewDrawing, isPage: boolean, images: readonly ViewImage[], gapBelow: number): RenderElement {
  const { Box, Text } = draw.ui
  const Svg = isPage ? (draw.ui as Partial<ElementTable<'desktop'>>).Svg : undefined
  const marks = images.map(image => {
    const picture = Svg === undefined ? undefined : pictureOf(draw, image)
    if (Svg === undefined || picture === undefined) return <Text dimColor>[image]</Text>
    const thumb = thumbOf(image, picture)
    return <Svg source={thumb.source} alt="Pasted image" width={thumb.width} height={thumb.height} />
  })
  return (
    <Box flexDirection="row" flexWrap="wrap" justifyContent={isPage ? 'flex-end' : 'flex-start'} columnGap={1} rowGap={1} marginBottom={gapBelow}>
      {marks}
    </Box>
  )
}

// One section, `gap` rows below the one before, its thread marked as the chat marks
// it. Claude's is its text as markdown, as the chat draws a reply's, in its thread's
// border under its tag; the person's a bubble under its thread's tag and the pictures
// they pasted with it.
function drawEntry(draw: ViewDrawing, isPage: boolean, entry: Entry, gap: number): RenderElement {
  const { Box } = draw.ui
  const { thread } = entry
  if (entry.role === 'assistant') {
    const body = draw.markdown(entry.text)
    return (
      <Box flexDirection="column" marginTop={gap}>
        {thread === undefined ? body : draw.threadPart(thread, body)}
      </Box>
    )
  }
  const hasWords = entry.text.trim() !== ''
  return (
    <Box flexDirection="column" marginTop={gap}>
      {thread !== undefined && draw.tagRow(thread)}
      {entry.images !== undefined && drawImages(draw, isPage, entry.images, hasWords && isPage ? PART_GAP : 0)}
      {hasWords && drawBubble(draw, isPage, entry.text)}
    </Box>
  )
}

// The pane's body: the picked threads' sections, oldest first, the newest at the bottom.
export function drawView(draw: ViewDrawing, inputs: ViewInputs, deps: ViewDeps): RenderElement {
  const { Box, Text } = draw.ui
  const { entries, picked } = viewEntries(inputs, deps)
  const shown = entries.slice(-SECTIONS_DRAWN)
  const hidden = entries.length - shown.length
  const names = picked.map(t => t.name).join(', ')
  // An app lays the view out as a page (the desktop, the phone, an editor), a row
  // there half a line; the terminal lays it out in cells.
  const isPage = draw.surface !== 'terminal'
  const gapBefore = (entry: Entry, i: number) => {
    const before = shown[i - 1]
    if (before === undefined) return 0
    if (!isPage) return 1
    return entry.id !== undefined && entry.id === before.id ? PART_GAP : MESSAGE_GAP
  }

  return (
    <Box flexDirection="column" rowGap={1}>
      {picked.length === 0 && <Text dimColor>All threads. Pick threads above the prompt to follow just those.</Text>}
      {hidden > 0 && <Text dimColor>{`${hidden} earlier sections not shown`}</Text>}
      {shown.length === 0 && <Text dimColor>{picked.length === 0 ? 'Nothing here yet.' : `Nothing in ${names} yet.`}</Text>}
      {shown.length > 0 && <Box flexDirection="column">{shown.map((entry, i) => drawEntry(draw, isPage, entry, gapBefore(entry, i)))}</Box>}
    </Box>
  )
}

// What the pane says when drawing it failed: the failure, so the view never goes blank
// without saying why (the engine would draw its own, an empty pane, in its place).
const FAILURE_CHARS = 500

export function drawViewFailure(ui: ElementTable, error: unknown): RenderElement {
  const { Box, Text } = ui
  const said = error instanceof Error ? `${error.name}: ${error.message}` : String(error)
  const reason = drawableOf(said).replace(/[\u0080-\u009f\ud800-\udfff]/g, '').slice(0, FAILURE_CHARS)
  return (
    <Box flexDirection="column" rowGap={1}>
      <Text dimColor>{`The thread view could not be drawn: ${reason}`}</Text>
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
