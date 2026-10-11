import { atom, read, update } from 'claude-code'
import type { BoxProps, Elements, EngineInterface, Register, RenderElement, RenderSurface } from 'claude-code'

import type { Brief, Thread, ThreadSummary, TokenPos, ViewImage, ViewRow } from '../types'
import {
  PALETTE,
  closestThread,
  headingStart,
  headingsIn,
  holdsQuote,
  isOthersPrompt,
  keyOf,
  leadingQuoteOf,
  nameOf,
  replyQuotesOf,
  rewriteHeadings,
  splitRunOns,
  splitSections,
  withOpeningQuote,
} from './parse'
import type { RunOn, Section } from './parse'
import {
  FILTER_THREAD_KEY,
  SECTIONS_MORE,
  chunksOf,
  dataFolderOf,
  drawView,
  drawViewFailure,
  fingerprintOf,
  grownOffsetOf,
  hasToolCall,
  imagePathsOf,
  imageSizeOf,
  imageTypeOf,
  isDrawable,
  isKeptView,
  markHashOf,
  markOf,
  marksOf,
  needsMessages,
  noteDrawnReply,
  nudgeOf,
  rowsOfChunks,
  rowsUpTo,
  thumbNameOf,
  toggledShown,
  viewKey,
  viewMoveOf,
  viewPlaceOf,
  viewEntries,
  viewRowOf,
  withImagePaths,
  withInterim,
  withKeptPaths,
  withViewRow,
} from './pane'
import type { Picture, ViewDeps, ViewGrowth, ViewInputs, ViewPlace, ViewSpan } from './pane'
import {
  LINE_SYSTEM,
  NO_USAGE,
  PACK_SYSTEM,
  TOOL_TAIL_CHARS,
  RETRY_MS,
  START_POS,
  advancedPos,
  ageText,
  catchUpNote,
  catchUpPointer,
  compactedPos,
  isCurrent,
  isPackDue,
  isPassing,
  isPast,
  linePrompt,
  packParts,
  packPrompt,
  parseLines,
  parsePack,
  readThreadText,
  summariesOf,
  threadGaps,
  tokenPosOf,
  tokensText,
  turnSectionsOf,
  usageText,
  verbatimOf,
  withStamps,
  withUsage,
} from './summaries'
import type { LineInput } from './summaries'

const isOn = atom({ plugin: 'thread-chat', key: 'isOn' } as const, false)
const threads = atom({ plugin: 'thread-chat', key: 'threads' } as const, [])
const aliases = atom({ plugin: 'thread-chat', key: 'aliases' } as const, {})
// The menu's agent and filter switches, kept with the session's record for its next run;
// a session that never flipped one starts with the agent kept out and the chat unfiltered.
const agentMayCreate = atom({ plugin: 'thread-chat', key: 'agentMayCreate' } as const, false)
const filtersChat = atom({ plugin: 'thread-chat', key: 'filtersChat' } as const, false)
const snaps = atom({ plugin: 'thread-chat', key: 'snaps' } as const, {})
const recent = atom({ plugin: 'thread-chat', key: 'recent' } as const, [])
const recentTexts = atom({ plugin: 'thread-chat', key: 'recentTexts' } as const, [])
const current = atom({ plugin: 'thread-chat', key: 'current' } as const, '')
const deleted = atom({ plugin: 'thread-chat', key: 'deleted' } as const, [])
const sentTo = atom({ plugin: 'thread-chat', key: 'sentTo' } as const, {})
const moved = atom({ plugin: 'thread-chat', key: 'moved' } as const, {})
const picking = atom({ plugin: 'thread-chat', key: 'picking' } as const, '')
const naming = atom({ plugin: 'thread-chat', key: 'naming' } as const, false)
const untold = atom({ plugin: 'thread-chat', key: 'untold' } as const, [])
const briefed = atom({ plugin: 'thread-chat', key: 'briefed' } as const, null)
const viewRows = atom({ plugin: 'thread-chat', key: 'viewRows' } as const, [])
const picturesRead = atom({ plugin: 'thread-chat', key: 'picturesRead' } as const, 0)
const viewFrom = atom({ plugin: 'thread-chat', key: 'viewFrom' } as const, null)
const viewThreads = atom({ plugin: 'thread-chat', key: 'viewThreads' } as const, [])
const menuOpen = atom({ plugin: 'thread-chat', key: 'menuOpen' } as const, false)
const pickerOpen = atom({ plugin: 'thread-chat', key: 'pickerOpen' } as const, false)
const menuMode = atom({ plugin: 'thread-chat', key: 'menuMode' } as const, '')
const tokenPos = atom({ plugin: 'thread-chat', key: 'tokenPos' } as const, START_POS)
const summaries = atom({ plugin: 'thread-chat', key: 'summaries' } as const, {})
const summaryLines = atom({ plugin: 'thread-chat', key: 'summaryLines' } as const, {})
const summaryUsage = atom({ plugin: 'thread-chat', key: 'summaryUsage' } as const, NO_USAGE)
const summariesOn = atom({ plugin: 'thread-chat', key: 'summariesOn' } as const, true)
const readToolOffered = atom({ plugin: 'thread-chat', key: 'readToolOffered' } as const, false)
const hasStarted = atom({ plugin: 'thread-chat', key: 'hasStarted' } as const, false)
const summaryLineShown = atom({ plugin: 'thread-chat', key: 'summaryLineShown' } as const, false)
const activeThread = atom({ plugin: 'thread-chat', key: 'activeThread' } as const, '')
// The react mod's switch and reactions, which the thread view draws as the chat does
// (types/react.d.ts); never written without react, so off and none.
const reactIsOn = atom({ plugin: 'react', key: 'isOn' } as const, false)
const reactReactions = atom({ plugin: 'react', key: 'reactions' } as const, [])

const CREATE_TOOL = 'mcp__thread-chat__create_thread'
// Thread-chat's menu in the band: a "Threads" button, and a row per switch, which a
// press flips: threads on in this chat, and, while on, whether the agent may start them
// and whether the chat is filtered to the picked thread. On the desktop the rows are a
// card shown while the pointer is on the button or it has the focus; on the terminal a
// press on the button shows or hides them in the band.
const MENU = 'threads'
const THREADS_SWITCH = 'threads-on'
const AGENT_SWITCH = 'agent-threads'
const FILTER_SWITCH = 'filter-chat'
const SUMMARIES_SWITCH = 'thread-summaries'
const LINE_SWITCH = 'summary-line'
// A switch's hit area over its picture, keyed by this and the switch's key.
const SWITCH_HIT = 'switch:'
// The thread view's pane id, which is also its command's name and its menu row's key.
const VIEW = 'thread-view'
const VIEW_TITLE = 'Thread view'

// The ways a person's own prompt arrives: typed in the terminal, the desktop
// app (an SDK host) or Remote Control.
const PERSON = new Set(['composer', 'sdk', 'bridge'])

function withThreads(list: Thread[], names: string[], createdBy: Thread['createdBy']): Thread[] {
  const known = new Set(list.map(t => keyOf(t.name)))
  const added = names
    .filter(name => !known.has(keyOf(name)))
    .map((name, i) => ({
      name,
      color: PALETTE[(list.length + i) % PALETTE.length] ?? '#888888',
      createdBy,
    }))
  return added.length === 0 ? list : [...list, ...added]
}

// Starts the threads named that are new, and brings back those named that were
// archived: a heading, the agent's create_thread or a typed name used them. A name of
// a deleted thread starts it again, its key no longer deleted.
async function addThreads($: EngineInterface, names: string[], createdBy: Thread['createdBy']) {
  if (names.length === 0) return
  const keys = new Set(names.map(keyOf))
  await update($, threads, list =>
    withThreads(list, names, createdBy).map(t => (t.isArchived === true && keys.has(keyOf(t.name)) ? withoutArchived(t) : t)),
  )
  if ((await read($, deleted)).some(key => keys.has(key))) await update($, deleted, all => all.filter(key => !keys.has(key)))
}

// A thread as this version keeps it: the fields it draws, and no others (an earlier
// version's filter pick, `isSelected`, goes).
function cleanThread(t: Partial<Thread> & { name: string }): Thread {
  return {
    name: t.name,
    color: t.color ?? '#888888',
    createdBy: t.createdBy ?? 'user',
    ...(t.isArchived === true ? { isArchived: true } : {}),
  }
}

const withoutArchived = (t: Thread): Thread => cleanThread({ ...t, isArchived: false })

// The key of the one thread an earlier version's filter had picked alone, where messages
// with no heading went: this version's picked thread. '' where none or several were.
function pickedByFilter(list: readonly unknown[]): string {
  const picked = list.filter(t => (t as { isSelected?: unknown }).isSelected === true)
  const only = picked.length === 1 ? (picked[0] as { name?: unknown }) : undefined
  return typeof only?.name === 'string' ? keyOf(only.name) : ''
}

// Where a deleted thread's key points in the links a heading is resolved by: a key no
// thread has, so the heading means no thread, never another thread by a close name.
const GONE = '\u0000deleted'

// The links a heading is resolved by: the meanings decided at send, the merges, and each
// deleted thread's key pointing to none.
function linksFor(merged: Record<string, string>, gone: readonly string[], snapped: Record<string, string> = {}) {
  return { ...snapped, ...merged, ...Object.fromEntries(gone.map(key => [key, GONE])) }
}

// Whether a name means a thread the person deleted: its own name, or one a merge or an
// earlier send pointed to it, followed to a deleted thread's key.
function isGone(name: string, list: Thread[], links: Record<string, string>): boolean {
  let key = keyOf(name)
  for (let hop = 0; hop < 8; hop++) {
    if (key === GONE) return true
    if (list.some(t => keyOf(t.name) === key)) return false
    const next = links[key]
    if (next === undefined) return false
    key = next
  }
  return false
}

// Sections under a deleted thread's heading as sections of no thread: the heading line
// goes with the thread, and the text stays.
function withoutGone(sections: Section[], isGoneName: (name: string) => boolean): Section[] {
  return sections.map(s => (s.thread !== null && isGoneName(s.thread) ? { thread: null, text: s.text } : s))
}

// Threads are on in a session from the person's /threads until they run it again. Off,
// the mod leaves the session be: nothing beside the person's messages, whose `#`
// headings are plain text, no tags or "+ thread" round the chat's rows, no band, no
// tool, nothing kept on disk. Turned off, the session keeps its threads for coming on again.
const OFF_TEXT = 'Threads are off in this chat; /threads turns them on.'

// Whether a session kept by a version of this mod from before /threads used threads:
// it had one (or a merge), or the person let the agent start them. It counts as on.
async function wasInUse($: EngineInterface): Promise<boolean> {
  const list = await read($, threads)
  const merged = await read($, aliases)
  return list.length > 0 || Object.keys(merged).length > 0 || (await read($, agentMayCreate))
}

const CREATE_SPEC = {
  name: 'create_thread',
  description:
    'Start a new conversation thread the user can follow and read on its own. Then write to it under a level-1 heading with its exact name. Refused unless the user has enabled agent-created threads.',
  inputSchema: {
    type: 'object',
    properties: { name: { type: 'string', description: 'Short thread name, 1-4 words' } },
    required: ['name'],
  },
}

// create_thread is the model's once threads are on and the person lets the agent start
// them: a session that never does has no tool of this mod's. Registered again, it is replaced.
async function offerCreateTool($: EngineInterface) {
  try {
    await $.tool.register(CREATE_SPEC)
  } catch {
    // the switch stands; the model is told it may, and the next flip tries again
  }
}

// Flips whether the agent may start threads, offering it the tool as it comes on, and
// keeps the switch for the session's next run.
async function flipAgentSwitch($: EngineInterface) {
  let now = false
  await update($, agentMayCreate, may => (now = !may))
  if (now) await offerCreateTool($)
  await save($)
}

// Flips whether the chat is filtered to the picked thread, and keeps it for the
// session's next run.
async function flipFilter($: EngineInterface) {
  await update($, filtersChat, is => !is)
  await save($)
}

// Turns threads on or off, as /threads does, and keeps the switch for the session's
// next run. Coming on where the agent may start threads, it is offered its tool.
async function flipThreads($: EngineInterface): Promise<boolean> {
  let now = false
  await update($, isOn, was => (now = !was))
  if (now && (await read($, agentMayCreate))) await offerCreateTool($)
  await save($)
  return now
}

// Flips whether the chat's threads are summarised and the agent caught up on them, and
// keeps the switch for the session's next run. Off, no summary call is made.
async function flipSummaries($: EngineInterface) {
  await update($, summariesOn, is => !is)
  await save($)
}

// Flips a switch of the band's menu. The agent's switch, the filter's or the summaries'
// while threads are off leaves things be.
async function flipMenuSwitch($: EngineInterface, key: string) {
  if (key === THREADS_SWITCH) await flipThreads($)
  else if (key === AGENT_SWITCH && (await read($, isOn))) await flipAgentSwitch($)
  else if (key === FILTER_SWITCH && (await read($, isOn))) await flipFilter($)
  else if (key === SUMMARIES_SWITCH && (await read($, isOn))) await flipSummaries($)
  else if (key === LINE_SWITCH && (await read($, isOn))) await flipSummaryLine($)
}

// Shows or hides the line under the band's controls with a thread's one-line summary, and
// keeps the switch for the session's next run.
async function flipSummaryLine($: EngineInterface) {
  await update($, summaryLineShown, is => !is)
  await save($)
}

// What a heading means, by one rule for sending and drawing alike: `+name` a new
// thread by that name; else the thread by that name, or the one a merge or an
// earlier send recorded for it; else the closest thread (a typo, another
// spelling, the start of a name); else a new thread by that name.
function resolveHeading(raw: string, list: Thread[], links: Record<string, string>): string {
  const name = nameOf(raw)
  if (raw.startsWith('+')) return name
  const known = threadOf(name, list, links)
  if (known !== undefined) return known.name
  const hit = closestThread(name, [...list.map(t => keyOf(t.name)), ...Object.keys(links)])
  return (hit === undefined ? undefined : threadOf(hit, list, links)?.name) ?? name
}

// Where a heading was typed with its section's first line on the same line: the
// thread name its text starts with (a thread's, or a merged thread's old one; the
// longest, as whole words) and the rest of the line. Never for `+name`, a heading
// that is a thread's or a merged thread's name, or one decided at an earlier send;
// nor where the whole heading is another thread's name abbreviated or mistyped.
// Decided by the threads as they stand, at send and at drawing alike: it is not
// recorded, as a recorded heading would count as a name abbreviations must tell apart.
function runOnOf(
  typed: string,
  list: Thread[],
  links: Record<string, string>,
  merged: Record<string, string>,
): RunOn | undefined {
  if (typed.startsWith('+')) return undefined
  const key = keyOf(typed)
  if (list.some(t => keyOf(t.name) === key) || links[key] !== undefined) return undefined
  const start = headingStart(typed, [...list.map(t => t.name), ...Object.keys(merged)])
  if (start === undefined) return undefined
  const hit = closestThread(typed, [...list.map(t => keyOf(t.name)), ...Object.keys(links)])
  const other = hit === undefined ? undefined : threadOf(hit, list, links)
  if (other !== undefined && other !== threadOf(start.name, list, links)) return undefined
  return start
}

// A person's message in sections, each heading typed with its first line on the
// same line split from it first. A section under a deleted thread's heading is of no
// thread, its heading gone. A quoted selection that opens it, right before its first
// thread heading, goes in that heading's section, whichever thread it came from.
function personSectionsOf(
  text: string,
  list: Thread[],
  snapped: Record<string, string>,
  merged: Record<string, string>,
  gone: readonly string[] = [],
): Section[] {
  const links = linksFor(merged, gone, snapped)
  const sections = splitSections(splitRunOns(text, typed => runOnOf(typed, list, links, merged)), () => true)
  const kept = withoutGone(sections, name => isGone(resolveHeading(name, list, links), list, links))
  return withOpeningQuote(kept, name => personThreadOf(name, list, links) !== undefined)
}

// A reply in sections: a level-1 heading naming a thread starts its section, and one
// naming no thread is the reply's own text. A section under a deleted thread's heading
// is of no thread, its heading gone.
function replySectionsOf(text: string, list: Thread[], merged: Record<string, string>, gone: readonly string[] = []): Section[] {
  const links = linksFor(merged, gone)
  const sections = splitSections(text, name => threadOf(name, list, links) !== undefined || isGone(name, list, links))
  return withoutGone(sections, name => isGone(name, list, links))
}

type Meaning = { typed: string; meant: string; isRunOn?: boolean }

// What the headings of a prompt mean: the thread names, in order, the name its last
// heading means, and each heading not written as its thread's exact name (a typo, a
// start of a name, `+name`, a name with the first line on its line) as typed with the
// thread it means. A heading may also mean a thread introduced earlier in the same prompt.
function decideHeadings(text: string, list: Thread[], links: Record<string, string>, merged: Record<string, string>) {
  let known = list
  const meanings: Meaning[] = []
  const meant: string[] = []
  // A heading with its first line on its line becomes its thread's heading by its
  // exact name, so the headings after are read as they would be on their own.
  const split = splitRunOns(text, typed => {
    const runOn = runOnOf(typed, list, links, merged)
    const thread = runOn === undefined ? undefined : threadOf(runOn.name, list, links)
    if (runOn === undefined || thread === undefined) return undefined
    meanings.push({ typed, meant: thread.name, isRunOn: true })
    return { name: thread.name, rest: runOn.rest }
  })
  const resolved = rewriteHeadings(split, raw => {
    const name = resolveHeading(raw, known, links)
    if (raw.startsWith('+') || keyOf(nameOf(raw)) !== keyOf(name)) meanings.push({ typed: raw, meant: name })
    known = withThreads(known, [name], 'user')
    meant.push(name)
    return name
  })
  return { names: headingsIn(resolved), last: meant.at(-1), meanings }
}

// The thread a name means: the thread by that name, else the one a merge or a
// send-time decision points it to, followed through later merges.
function threadOf(name: string, list: Thread[], links: Record<string, string>): Thread | undefined {
  let key = keyOf(name)
  for (let hop = 0; hop < 8; hop++) {
    const exact = list.find(t => keyOf(t.name) === key)
    if (exact !== undefined) return exact
    const next = links[key]
    if (next === undefined) return undefined
    key = next
  }
  return undefined
}

// The thread a heading in the person's message means, by the rule its send used.
function personThreadOf(name: string, list: Thread[], links: Record<string, string>): Thread | undefined {
  return threadOf(resolveHeading(name, list, links), list, links)
}

// Where a session's threads are kept between runs of the app.
const storeKey = (sessionId: string) => `session:${sessionId}`

type Saved = {
  // absent from a record kept before /threads
  isOn: boolean
  // the menu's agent and filter switches; absent from a record kept before they were kept
  agentMayCreate?: boolean
  filtersChat?: boolean
  threads: Thread[]
  aliases: Record<string, string>
  snaps: Record<string, string>
  // absent from a record kept before the filter switch was
  recent?: string[]
  recentTexts?: string[]
  // absent from a record kept before the thread picker, whose threads may carry the
  // filter's `isSelected`
  current: string
  deleted: string[]
  sentTo: Record<string, string>
  moved: Record<string, string>
  untold: string[]
  briefed: Brief | null
  // absent from a record kept before the thread view's own filter
  viewThreads: string[]
  // absent from a record kept before thread summaries
  tokenPos?: TokenPos
  summariesOn?: boolean
  summaryLineShown?: boolean
  activeThread?: string
}

// Keeps the session's switches, threads, merges, recorded meanings, latest rows, picked
// thread and the thread view's filter for its next run.
async function save($: EngineInterface) {
  const saved: Saved = {
    isOn: await read($, isOn),
    agentMayCreate: await read($, agentMayCreate),
    filtersChat: await read($, filtersChat),
    threads: await read($, threads),
    aliases: await read($, aliases),
    snaps: await read($, snaps),
    recent: await read($, recent),
    recentTexts: await read($, recentTexts),
    current: await read($, current),
    deleted: await read($, deleted),
    sentTo: await read($, sentTo),
    moved: await read($, moved),
    untold: await read($, untold),
    briefed: await read($, briefed),
    viewThreads: await read($, viewThreads),
    tokenPos: await read($, tokenPos),
    summariesOn: await read($, summariesOn),
    summaryLineShown: await read($, summaryLineShown),
    activeThread: await read($, activeThread),
  }
  await $.store.set(storeKey(await $.session.id()), saved)
}

// A mark too short to tell sessions apart ("ok", "(quiet)") does not count.
const MIN_PARENT_MARK = 12

// The session this one was rewound or forked from. Claude Code gives such a session a
// new id and copies the rows it keeps from the other, so it is found as the saved
// session whose thread view knows the most of this one's messages, by a clear margin.
// Its rows' marks are read as hashes: from the file kept beside its rows, or from
// the rows an earlier version kept in the store.
async function parentOf($: EngineInterface, id: string): Promise<string | undefined> {
  const mine = new Set(
    (await $.session.messages())
      .map(m => markOf(m.text))
      .filter(mark => mark.length >= MIN_PARENT_MARK)
      .map(markHashOf),
  )
  if (mine.size === 0) return undefined
  const scores: { id: string; score: number }[] = []
  for (const key of await $.store.keys()) {
    if (!key.startsWith('view:') || key === viewKey(id)) continue
    const other = key.slice('view:'.length)
    const kept = await $.store.get(key)
    let marks: string[] = []
    if (Array.isArray(kept)) marks = (kept as ViewRow[]).map(row => markHashOf(row.mark))
    else if (isKeptView(kept)) {
      const folder = await rowsFolder($, other).catch(() => undefined)
      const text = folder === undefined ? undefined : await $.fs.read(`${folder}/${MARKS_FILE}`).catch(() => undefined)
      marks = text === undefined ? [] : text.split('\n')
    }
    const known = new Set(marks.filter(mark => mine.has(mark)))
    if (known.size > 0) scores.push({ id: other, score: known.size })
  }
  scores.sort((a, b) => b.score - a.score)
  const [best, next] = scores
  if (best === undefined || best.score < 3 || (next !== undefined && next.score * 2 > best.score)) return undefined
  return best.id
}

// Joins a saved record to what this run holds, so neither loses anything: the threads
// either knows (this run's own kept as they are), the merges, deletions and recorded
// meanings of both (this run's winning), and this run's picked thread and the thread
// view's filter when it has them.
// A thread this run holds is not merged away or deleted by an older record. A record
// kept before the thread picker gives the one thread its filter picked alone.
async function takeUp($: EngineInterface, saved: Partial<Saved>) {
  const held = new Set((await read($, threads)).map(t => keyOf(t.name)))
  const older = Object.fromEntries(Object.entries(saved.aliases ?? {}).filter(([key]) => !held.has(key)))
  const links = { ...older, ...(await read($, aliases)) }
  const gone = new Set([...(saved.deleted ?? []).filter(key => !held.has(key)), ...(await read($, deleted))])
  await update($, aliases, () => links)
  await update($, deleted, () => [...gone])
  await update($, threads, list => {
    const mine = new Map(list.map(t => [keyOf(t.name), t]))
    const savedKeys = new Set((saved.threads ?? []).map(t => keyOf(t.name)))
    const ordered = [
      ...(saved.threads ?? []).map(t => mine.get(keyOf(t.name)) ?? cleanThread(t)),
      ...list.filter(t => !savedKeys.has(keyOf(t.name))),
    ]
    return ordered.filter(t => links[keyOf(t.name)] === undefined && !gone.has(keyOf(t.name)))
  })
  await update($, snaps, all => ({ ...(saved.snaps ?? {}), ...all }))
  await update($, sentTo, all => ({ ...(saved.sentTo ?? {}), ...all }))
  await update($, moved, all => ({ ...(saved.moved ?? {}), ...all }))
  await update($, recent, all => (all.length > 0 ? all : (saved.recent ?? [])))
  await update($, recentTexts, all => (all.length > 0 ? all : (saved.recentTexts ?? [])))
  await update($, current, key => key || (saved.current ?? pickedByFilter(saved.threads ?? [])))
  await update($, untold, all => [...(saved.untold ?? []).filter(note => !all.includes(note)), ...all])
  await update($, briefed, brief => brief ?? saved.briefed ?? null)
  await update($, viewThreads, keys => (keys.length > 0 ? keys : (saved.viewThreads ?? [])))
  // this run's token position once it has a reading (a reload), else the record's
  const kept = tokenPosOf(saved.tokenPos)
  await update($, tokenPos, at => (at.last !== undefined || at.pos > 0 || kept === undefined ? at : kept))
}

// A row's id as the screen knows it: blocks of one stored row drawn apart take
// ids that keep the row's first 24 characters.
const stemOf = (id: string) => id.slice(0, 24)

// Whether a drawn row (by any of its ids) came since the person's last message.
async function isRecent($: EngineInterface, ids: string[]): Promise<boolean> {
  const stems = new Set((await read($, recent)).map(stemOf))
  return ids.some(id => stems.has(stemOf(id)))
}

// A reply text's start, as the mark it is matched by: spacing evened out.
const textMarkOf = (text: string) => text.replace(/\s+/g, ' ').trim().slice(0, 160)

// Whether a drawn reply came since the person's last message: by its id, or by its
// text where the screen knows it by an id of its own.
async function isRecentReply($: EngineInterface, id: string, text: string): Promise<boolean> {
  if (await isRecent($, [id])) return true
  return (await read($, recentTexts)).includes(textMarkOf(text))
}

// The marks of a stored reply's text blocks, each as a screen may draw it alone.
function textMarksOf(content: readonly { type: string; [field: string]: unknown }[]): string[] {
  return content.flatMap(block => (block.type === 'text' && typeof block.text === 'string' ? [textMarkOf(block.text)] : []))
}

// The ids of the tool calls a stored row makes; each draws as a row of its own.
function toolCallIds(content: readonly { type: string; [field: string]: unknown }[]): string[] {
  return content.flatMap(block => (block.type === 'tool_use' && typeof block.id === 'string' ? [block.id] : []))
}

// The keys of the threads the chat is filtered to: the picked thread while the menu's
// filter is on, else none, and the chat shows every row. Read while a row draws, so a
// flip or a new pick draws it again.
async function chatFilterKeys($: EngineInterface): Promise<Set<string>> {
  if (!(await read($, filtersChat))) return new Set()
  const cur = await read($, current)
  return cur === '' ? new Set() : new Set([cur])
}

// Whether a row that belongs to no thread is filtered out: while threads are on and the
// chat is filtered to a thread, all but those since the person's last message are.
async function isFilteredOut($: EngineInterface, ids: string[]): Promise<boolean> {
  if (!(await read($, isOn)) || (await chatFilterKeys($)).size === 0) return false
  return !(await isRecent($, ids))
}

// Whether a section stays in view: all of them while the chat is not filtered, else the
// filtered thread's sections, and unthreaded ones in rows since the person's last message.
function isShown(
  s: Section,
  selected: Set<string>,
  resolve: (name: string) => Thread | undefined,
  isRecentRow: boolean,
): boolean {
  if (selected.size === 0) return true
  const thread = s.thread === null ? undefined : resolve(s.thread)
  if (thread === undefined) return isRecentRow
  return selected.has(keyOf(thread.name))
}

// Brings the chat's end into view: the latest row the screen knows by its id.
// Rows that draw nothing of their own (a tool's result, a reminder) are passed over;
// where nothing scrolls (the desktop scrolls its chat for no plugin), the chat stays put.
async function scrollToEnd($: EngineInterface) {
  const ids = (await read($, recent)).slice(-20).reverse()
  try {
    for (const id of ids) {
      const scrolled = await $.ui.scroll({ to: { requestId: id }, block: 'end' })
      if (scrolled.deny === undefined || /person|not scrollable/.test(scrolled.deny)) return
    }
  } catch {
    return
  }
}

// Messages sent with no heading to one thread (the one picked, or the one a reply's
// quotes came from), until their rows are stored.
const unsent: { text: string; key: string }[] = []

// The ids of the main conversation's replies with text in the turn so far, since its
// last tool call: interim if another tool call follows them in the turn.
let turnReplies = new Set<string>()

// The text blocks of a stored row, as one text.
function textOf(content: readonly { type: string; [field: string]: unknown }[]): string {
  return content.flatMap(block => (block.type === 'text' && typeof block.text === 'string' ? [block.text] : [])).join('\n')
}

// The thread a person's message went to without a heading, by its row's id.
async function sentThreadOf(
  $: EngineInterface,
  id: string,
  list: Thread[],
  links: Record<string, string>,
): Promise<Thread | undefined> {
  const all = await read($, sentTo)
  const key = all[id] ?? Object.entries(all).find(([row]) => stemOf(row) === stemOf(id))?.[1]
  return key === undefined ? undefined : threadOf(key, list, links)
}

// Where a quote came from: the place ('' no thread) of the newest reply's part that
// holds it, read as the reply draws (`replies` newest first); undefined where no reply
// holds it, or the newest that does holds it in parts of different places, or across them.
function quotedPlaceOf(
  replies: string[],
  quote: string,
  sectionsOf: (text: string) => Section[],
  resolve: (name: string) => Thread | undefined,
): string | undefined {
  for (const reply of replies) {
    if (!holdsQuote(reply, quote)) continue
    const places = new Set(
      sectionsOf(reply)
        .filter(s => holdsQuote(s.text, quote))
        .map(s => (s.thread === null ? '' : keyOf(resolve(s.thread)?.name ?? s.thread))),
    )
    return places.size === 1 ? [...places][0] : undefined
  }
  return undefined
}

// The thread a message replying to parts of earlier replies belongs to: the one every
// quote that is found came from. Quotes from different threads, or from text of no
// thread, give none: each quote carries the person's own words on it, so such a
// message speaks to several places, and filing it under one would hide it from the rest.
async function quotedThreadOf($: EngineInterface, quotes: string[], list: Thread[]): Promise<Thread | undefined> {
  if (quotes.length === 0) return undefined
  let rows: { role: string; text: string }[]
  try {
    rows = await $.session.messages()
  } catch {
    return undefined
  }
  const merged = await read($, aliases)
  const gone = await read($, deleted)
  const links = linksFor(merged, gone)
  const resolve = (name: string) => threadOf(name, list, links)
  const sectionsOf = (text: string) => replySectionsOf(text, list, merged, gone)
  const replies = rows.filter(r => r.role === 'assistant' && r.text !== '').map(r => r.text).reverse()
  const places = new Set(quotes.flatMap(q => quotedPlaceOf(replies, q, sectionsOf, resolve) ?? []))
  const only = places.size === 1 ? [...places][0] : undefined
  return only === undefined || only === '' ? undefined : threadOf(only, list, links)
}

// The decisions in `meanings` as links from a typed heading's key to its thread's.
// A heading with its first line on its line is decided again where it is drawn.
function linksOf(meanings: Meaning[]): Record<string, string> {
  return Object.fromEntries(
    meanings
      .filter(m => m.isRunOn !== true)
      .map(m => [keyOf(nameOf(m.typed)), keyOf(m.meant)])
      .filter(([typed, meant]) => typed !== meant),
  )
}

// A typed line quoted to the model, cut short where long: the model has it whole.
const clip = (text: string) => (text.length > 48 ? `${text.slice(0, 48).trimEnd()}…` : text)

// What a heading in the person's message means, as the model is told it.
function meaningNote(m: Meaning): string {
  if (m.isRunOn === true) return `"#${clip(m.typed)}" is the thread "${m.meant}", its first line typed on the heading's line`
  if (m.typed.startsWith('+')) return `"#${m.typed}" starts the new thread "${m.meant}"`
  return `"#${m.typed}" is the thread "${m.meant}"`
}

// How threads work, and where they stand. It goes beside the person's message: the
// system prompt cannot carry it, as the engine sends the prompt it recorded at the
// first request until a compaction, and on a machine with managed settings a user
// plugin's prompt.compose hook is skipped.
function protocol(list: Thread[], merged: Record<string, string>, mayCreate: boolean): string {
  return [
    '# Conversation threads',
    'This conversation can hold several threads at once. The user starts or replies to a thread with a level-1 heading in their message: `# name` or `#name` (with or without the space). Text before the first heading is the unthreaded conversation, except a quote of part of your message (a `<!-- reply -->` line and its `>` lines) right before a heading, which belongs to that heading\'s thread. A heading may be abbreviated or mistyped, or written `#+name` to start a new thread; a note beside the message then says which thread each heading means.',
    'Reply the same way, under whichever thread or threads your reply\'s content belongs to: each part under a level-1 heading carrying that thread\'s exact name, one section per thread. The thread the user wrote in, or picked to post to, is usually the right one. A message with no heading may just be missing one: if it clearly continues an existing thread, reply under that thread\'s heading. Keep only material that fits no thread unthreaded, before any thread heading. Use `##` or deeper for structure inside a section: a level-1 heading that is not a thread name drops back into the unthreaded conversation.',
    'This holds for the rest of the conversation; a note beside a later message says when threads are merged, archived or deleted, or your leave to start them changes.',
    threadState(list, merged, mayCreate),
  ].join('\n\n')
}

// Where the threads stand: those so far, those archived, the merges into a thread that
// still stands, and whether the model may start one.
function threadState(list: Thread[], merged: Record<string, string>, mayCreate: boolean): string {
  const active = list.filter(t => t.isArchived !== true)
  const archived = list.filter(t => t.isArchived === true)
  const names = active.length === 0 ? 'none yet' : active.map(t => `"${t.name}"`).join(', ')
  const mergedNames = Object.entries(merged)
    .filter(([from]) => threadOf(from, list, merged) !== undefined)
    .map(([from, to]) => `"${from}" is now "${to}"`)
  return [
    `Threads so far: ${names}.`,
    ...(archived.length === 0
      ? []
      : [
          `Archived threads (hidden from the user's thread picker; write in one only if the user brings it up): ${archived.map(t => `"${t.name}"`).join(', ')}.`,
        ]),
    ...(mergedNames.length === 0 ? [] : [`Merged threads (an old heading means the new one): ${mergedNames.join('; ')}.`]),
    mayCreate
      ? `You may start a new thread with ${CREATE_TOOL} when a distinct topic deserves its own thread, then write to it under its heading. Do it sparingly.`
      : 'Do not start new threads yourself; the user has not enabled that.',
  ].join(' ')
}

const mergesKey = (merged: Record<string, string>) => JSON.stringify(Object.entries(merged).sort())

// What the model is told of the threads beside the person's message while they are on:
// how they work, once they come on (and again after a compaction), then where they
// stand whenever a merge or the agent switch changed it. A thread it sees made (by a
// heading, its own create_thread, a move it is told of) needs no telling.
async function briefing($: EngineInterface): Promise<string[]> {
  const list = await read($, threads)
  const merged = await read($, aliases)
  const mayCreate = await read($, agentMayCreate)
  const was = await read($, briefed)
  if (was !== null && mergesKey(was.merged) === mergesKey(merged) && was.mayCreate === mayCreate) return []
  await update($, briefed, () => ({ merged, mayCreate }))
  await save($)
  return [was === null ? protocol(list, merged, mayCreate) : `The threads changed. ${threadState(list, merged, mayCreate)}`]
}

// Told beside the person's first message once threads go off, if the model was told how
// they work: it is told again, whole, should they come on again.
async function offNote($: EngineInterface): Promise<string | undefined> {
  if ((await read($, briefed)) === null) return undefined
  await update($, briefed, () => null)
  await save($)
  return 'The user turned conversation threads off. Reply without thread headings; a level-1 heading in their messages is plain text now.'
}

// The SVG of a slide switch: a rounded track with the knob to the right when on.
function switchPicture(isOn: boolean): string {
  const track = isOn ? '#3b82f6' : '#8c8c8c'
  const knob = isOn ? 23 : 11
  return `<svg xmlns="http://www.w3.org/2000/svg" width="34" height="20" viewBox="0 0 34 20"><rect x="1" y="2" width="32" height="16" rx="8" fill="${track}"/><circle cx="${knob}" cy="10" r="6" fill="#ffffff"/></svg>`
}

// The desktop's Select caret, a chevron 14px square in the secondary text colour of
// the theme, after a 6px gap: the picture is the gap and the caret.
const CARET_GAP = 6
const CARET_SIZE = 14
const CARET_PICTURE = [
  `<svg xmlns="http://www.w3.org/2000/svg" width="${CARET_GAP + CARET_SIZE}" height="${CARET_SIZE}"`,
  ` viewBox="${-CARET_GAP * (16 / CARET_SIZE)} 0 ${(CARET_GAP + CARET_SIZE) * (16 / CARET_SIZE)} 16">`,
  '<style>.c{stroke:#c3c2b7}@media (prefers-color-scheme: light){.c{stroke:#52514e}}</style>',
  '<path class="c" d="M4 6l4 4 4-4" fill="none" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/>',
  '</svg>',
].join('')

// The menu button's settings cog, 14px square in the theme's text colour: the desktop
// draws an Svg as an image, so it takes no colour from the text around it.
const COG_PICTURE = [
  `<svg xmlns="http://www.w3.org/2000/svg" width="${CARET_SIZE}" height="${CARET_SIZE}" viewBox="0 0 16 16">`,
  '<style>.g{fill:#faf9f5}@media (prefers-color-scheme: light){.g{fill:#141413}}</style>',
  '<path class="g" fill-rule="evenodd" d="M6.81 2.84L6.86 0.79L9.14 0.79L9.19 2.84A5.3 5.3 0 0 1 10.81 3.51L12.29 2.09',
  'L13.91 3.71L12.49 5.19A5.3 5.3 0 0 1 13.16 6.81L15.21 6.86L15.21 9.14L13.16 9.19A5.3 5.3 0 0 1 12.49 10.81L13.91 12.29',
  'L12.29 13.91L10.81 12.49A5.3 5.3 0 0 1 9.19 13.16L9.14 15.21L6.86 15.21L6.81 13.16A5.3 5.3 0 0 1 5.19 12.49L3.71 13.91',
  'L2.09 12.29L3.51 10.81A5.3 5.3 0 0 1 2.84 9.19L0.79 9.14L0.79 6.86L2.84 6.81A5.3 5.3 0 0 1 3.51 5.19L2.09 3.71L3.71 2.09',
  'L5.19 3.51A5.3 5.3 0 0 1 6.81 2.84ZM5.7 8a2.3 2.3 0 1 0 4.6 0a2.3 2.3 0 1 0 -4.6 0Z"/>',
  '</svg>',
].join('')

const CHIP_HEIGHT = 20

const escapeXml = (text: string) =>
  text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')


// Thread names draw as tags: small semibold capitals, a hair apart.
const PILL_TAG_SIZE = 10.5
const CHAT_TAG_SIZE = 9
// On the desktop the engine draws reply text as prose, whose paragraphs sit
// `--cds-assistant-message-text-inset` (4px) in from the left; reply parts drawn
// as Markdown have no such inset.
const PROSE_TEXT_INSET = 4
// Px a reply part's tag moves right to line up with the engine's text: that inset,
// and 1px more seen on screen, the tag's capitals starting a hair left of the prose's.
const REPLY_TAG_INSET = PROSE_TEXT_INSET + 1
// The padding inside a thread's border round its reply part, in cells, on every side.
// The desktop gives a bordered Box 8px above and below and 12px at the sides
// (--cds-pad-md, --cds-pad-lg) unless told otherwise, so paddingX alone left that 8px
// above and below. The `padding` shorthand overrides all four sides as one. A cell
// there is half a line down but one sans `ch` across (about 10px and 8px), so the
// sides are equal in cells and near-equal in px; the engine part's prose inset adds
// to the left. On the terminal a row is a whole line, so it pads only the sides.
const REPLY_BORDER_PADDING = 1
const TAG_SPACING = 0.4
const TAG_FONT = 'font-family="Segoe UI, system-ui, -apple-system, sans-serif"'

// Each capital's advance in a semibold sans-serif, in ems.
const CAP_EMS: Record<string, number> = {
  A: 0.66, B: 0.6, C: 0.62, D: 0.7, E: 0.52, F: 0.5, G: 0.7, H: 0.72, I: 0.28, J: 0.38, K: 0.6, L: 0.49,
  M: 0.87, N: 0.74, O: 0.75, P: 0.58, Q: 0.75, R: 0.61, S: 0.54, T: 0.55, U: 0.7, V: 0.64, W: 0.95,
  X: 0.62, Y: 0.58, Z: 0.58, ' ': 0.27,
}

// How wide a tag draws at its natural spacing, in px: the picture's width, its
// text left as the font sets it.
function tagWidth(label: string, size: number): number {
  let ems = 0
  for (const ch of label) ems += CAP_EMS[ch] ?? (ch >= '0' && ch <= '9' ? 0.56 : 0.6)
  return Math.ceil(ems * size + TAG_SPACING * Math.max(0, label.length - 1)) + 1
}

// The SVG of a thread's tag: its name in small capitals, in its colour, set
// against the edge the tag aligns to, `inset` px in from it. The capitals are set
// to the width guessed for them (`textLength`, the spacing giving way), so the
// picture ends where they do: what follows the tag, its "▾", sits right after
// the name, alike in messages and replies.
function tagPicture(name: string, color: string, align: 'start' | 'end', inset = 0) {
  const label = name.toUpperCase()
  const text = tagWidth(label, CHAT_TAG_SIZE)
  const width = text + inset
  const height = 12
  const x = align === 'end' ? width - inset : inset
  const source =
    `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}">` +
    `<text x="${x}" y="9.5" text-anchor="${align}" ${TAG_FONT} font-size="${CHAT_TAG_SIZE}" font-weight="600"` +
    ` letter-spacing="${TAG_SPACING}" textLength="${text - 1}" lengthAdjust="spacing" fill="${color}">${escapeXml(label)}</text></svg>`
  return { source, width, height }
}

// The SVG of a thread's filter pill: one row high, its coloured dot and tag inside,
// outlined and tinted in the thread's colour when picked, faded when another is,
// and with an arrow after the tag when it alone is picked: messages with no
// heading go to it. With no colour it has no dot; its outline is dashed unless
// told otherwise, as the pill of no thread. Hot, it is the same pill under the
// pointer: its fill and outline stronger and a faded one less faded, as the
// desktop lights its own controls on hover (and leaves the cursor as it is).
function chipPicture(
  name: string,
  color: string | undefined,
  isSelected: boolean,
  isDimmed: boolean,
  isSendTarget: boolean,
  isDashed = color === undefined,
  isHot = false,
) {
  const label = name.toUpperCase()
  const text = tagWidth(label, PILL_TAG_SIZE * (isSelected ? 1.03 : 1))
  const textAt = color === undefined ? 9 : 19
  const arrowAt = textAt + text + 5
  const width = isSendTarget ? arrowAt + 8 + 8 : textAt + text + 9
  const h = CHIP_HEIGHT
  const fill =
    color === undefined
      ? `class="bg"${isDashed ? ' stroke-dasharray="3 2"' : ''}`
      : isSelected
        ? `fill="${color}" fill-opacity="${isHot ? 0.32 : 0.2}" stroke="${color}" stroke-width="1.5"`
        : 'class="bg"'
  const [dark, light] = isHot
    ? ['fill:#ffffff29;stroke:#ffffff73', 'fill:#00000014;stroke:#00000073']
    : ['fill:#ffffff14;stroke:#ffffff38', 'fill:#0000000a;stroke:#00000038']
  const opacity = isDimmed ? ` opacity="${isHot ? 0.75 : 0.45}"` : ''
  const source = [
    `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${h}" viewBox="0 0 ${width} ${h}"${opacity}>`,
    `<style>.bg{${dark}}.t{fill:#e6e6e6}`,
    `@media (prefers-color-scheme: light){.bg{${light}}.t{fill:#1f1f1f}}</style>`,
    `<rect ${fill} x="0.75" y="0.75" width="${width - 1.5}" height="${h - 1.5}" rx="${(h - 1.5) / 2}"/>`,
    color === undefined ? '' : `<circle cx="10.5" cy="${h / 2}" r="3" fill="${color}"/>`,
    `<text class="t" x="${textAt}" y="${h / 2 + 3.8}" ${TAG_FONT} font-size="${PILL_TAG_SIZE}"`,
    ` font-weight="${isSelected ? 700 : 600}" letter-spacing="${TAG_SPACING}">${escapeXml(label)}</text>`,
    isSendTarget
      ? `<path d="M${arrowAt} ${h / 2 - 4}L${arrowAt + 8} ${h / 2}L${arrowAt} ${h / 2 + 4}L${arrowAt + 2} ${h / 2}Z" fill="${color}"/>`
      : '',
    '</svg>',
  ].join('')
  return { source, width }
}

// A pill that is a switch on the desktop, in the keyed Box `key`: its picture, the
// hot one laid over it while the pointer is on the pill, and a hit area over both.
// The light is the surface's own hover, so it adds no Client: still one per pill.
// The hot picture is revealed in the flow of an absolute Box always shown, never
// as one: the desktop lifts an absolute Box the pointer reveals into a floating
// card, as it does a tip, and a hover can only reveal, never hide the picture at rest.
function drawPillSwitch(
  elements: Elements['desktop'],
  key: string,
  hitKey: string,
  isOn: boolean,
  alt: string,
  pictureOf: (isHot: boolean) => { source: string; width: number },
  layout: BoxProps = {},
): RenderElement {
  const { Box, Svg, Client } = elements
  const rest = pictureOf(false)
  const hot = pictureOf(true)
  return (
    <Box key={key} {...layout}>
      <Svg source={rest.source} alt={alt} width={rest.width} height={CHIP_HEIGHT} />
      <Box position="absolute" top={0} left={0}>
        <Box display="none" hover={{ display: 'flex' }}>
          <Svg source={hot.source} alt={alt} width={hot.width} height={CHIP_HEIGHT} />
        </Box>
      </Box>
      <Box position="absolute" top={0} left={0} width="100%" height="100%">
        <Client key={hitKey} module="./switch.tsx" props={{ isOn }} width="100%" height="100%" />
      </Box>
    </Box>
  )
}

// A thread's name as a tag: small capitals in its colour, a picture where the
// surface draws one (`alt` its name, the thread's unless given), its capitals alone
// on the terminal.
function drawTag(
  $: EngineInterface,
  e: Parameters<EngineInterface['ui']['resolve']>[0],
  thread: { name: string; color: string },
  align: 'start' | 'end',
  inset = 0,
  alt = thread.name,
): RenderElement {
  if (e.surface === 'terminal') {
    const { Text } = $.ui.resolve(e)
    return <Text color={thread.color}>{thread.name.toUpperCase()}</Text>
  }
  const { Svg } = $.ui.resolve(e)
  const tag = tagPicture(thread.name, thread.color, align, inset)
  return <Svg source={tag.source} alt={alt} width={tag.width} height={tag.height} />
}

// Whether the surface puts the person's messages, and so their tags, on the right.
const isOnRightOf = (surface: RenderSurface) => surface === 'desktop' || surface === 'mobile'

// The row of thread tags above a person's message, at the side the surface puts the
// message; `side` ("+ thread", or an open move picker) on the side away from the
// edge the tags keep to, so showing it moves none. The thread view draws a person's
// section's tag so too.
function drawTagRow(
  $: EngineInterface,
  e: Parameters<EngineInterface['ui']['resolve']>[0],
  tags: RenderElement[],
  side?: RenderElement,
  fit: BoxProps = {},
): RenderElement {
  const { Box } = $.ui.resolve(e)
  const isOnRight = isOnRightOf(e.surface)
  return (
    <Box flexDirection="row" columnGap={2} justifyContent={isOnRight ? 'flex-end' : 'flex-start'} {...fit}>
      {isOnRight && side}
      {tags}
      {!isOnRight && side}
    </Box>
  )
}

// A reply's part of a thread: in a round border of the thread's colour, the same
// cells off it on every side (REPLY_BORDER_PADDING), `head` (its tag) at the top.
// The thread view draws a reply's section so too.
function drawThreadPart(
  $: EngineInterface,
  e: Parameters<EngineInterface['ui']['resolve']>[0],
  thread: { color: string },
  head: RenderElement,
  body: RenderElement | undefined,
): RenderElement {
  const { Box } = $.ui.resolve(e)
  const padding = e.surface === 'desktop' ? { padding: REPLY_BORDER_PADDING } : { paddingX: REPLY_BORDER_PADDING }
  return (
    <Box flexDirection="column" borderStyle="round" borderColor={thread.color} {...padding}>
      {head}
      {body}
    </Box>
  )
}

// A Markdown element takes at most this many characters.
const MARKDOWN_LIMIT = 10000

// Markdown text in pieces a Markdown element takes, split between lines where it can.
function markdownPieces(text: string): string[] {
  const clean = text.replace(/[\u0000-\u0008\u000b-\u001f\u007f]/g, '')
  const pieces: string[] = []
  let piece = ''
  for (const line of clean.split('\n')) {
    for (let at = 0; at < Math.max(1, line.length); at += MARKDOWN_LIMIT) {
      const part = line.slice(at, at + MARKDOWN_LIMIT)
      const joined = piece === '' ? part : `${piece}\n${part}`
      if (joined.length <= MARKDOWN_LIMIT) {
        piece = joined
      } else {
        pieces.push(piece)
        piece = part
      }
    }
  }
  if (piece !== '') pieces.push(piece)
  return pieces
}

// Part of a reply drawn as markdown, as the screen draws a reply's text.
function drawMarkdown($: EngineInterface, e: Parameters<EngineInterface['ui']['resolve']>[0], text: string): RenderElement {
  const { Box, Markdown } = $.ui.resolve(e)
  return (
    <Box flexDirection="column">
      {markdownPieces(text).map(piece => (
        <Markdown text={piece} />
      ))}
    </Box>
  )
}

// Where a part of a row now sits, as the key of its thread ('' none): where it was
// first placed (`from`), unless the person moved it.
const placeOf = (moves: Record<string, string>, row: string, from: string) => moves[`${row}|${from}`] ?? from

// The moves once the person moves what sits in `from` of a row to `to`.
function withMove(moves: Record<string, string>, row: string, from: string, to: string): Record<string, string> {
  const prefix = `${row}|`
  const next: Record<string, string> = {}
  for (const [k, v] of Object.entries(moves)) next[k] = k.startsWith(prefix) && v === from ? to : v
  if (!(`${prefix}${from}` in moves)) next[`${prefix}${from}`] = to
  // a part back where it was first placed needs no entry
  for (const [k, v] of Object.entries(next)) if (k === `${prefix}${v}`) delete next[k]
  return next
}

// A section where the person last placed it: where it was written or sent, or
// where they moved it. A heading naming no thread stays as typed.
function placeSection(
  s: Section,
  row: string,
  moves: Record<string, string>,
  resolve: (name: string) => Thread | undefined,
  list: Thread[],
  links: Record<string, string>,
): Section {
  const first = s.thread === null ? undefined : resolve(s.thread)
  if (s.thread !== null && first === undefined) return s
  const from = first === undefined ? '' : keyOf(first.name)
  const place = placeOf(moves, row, from)
  if (place === from) return s
  return { ...s, thread: place === '' ? null : (threadOf(place, list, links)?.name ?? null) }
}

// How each movable part was last seen drawn, by `${row}|${place}`, to tell the model
// what the person moved.
const glimpses = new Map<string, string>()

const glimpseOf = (text: string) => {
  const flat = text.replace(/\s+/g, ' ').trim()
  return flat.length > 60 ? `${flat.slice(0, 60)}…` : flat
}

// Opens the move picker for what sits in `place` of a row, or closes it if open.
async function togglePicker($: EngineInterface, row: string, place: string) {
  const id = `${row}|${place}`
  await update($, naming, () => false)
  await update($, picking, open => (open === id ? '' : id))
}

// Moves what the open picker is for to the thread `to` ('' none), to be told to
// the model beside the person's next message; `isNew` when the person started `to` for it.
async function moveTo($: EngineInterface, to: string, isNew = false) {
  const open = await read($, picking)
  const at = open.indexOf('|')
  await update($, picking, () => '')
  await update($, naming, () => false)
  if (at < 0) return
  const row = open.slice(0, at)
  const from = open.slice(at + 1)
  if (to === from) return
  await update($, moved, all => withMove(all, row, from, to))
  const list = await read($, threads)
  const where = (key: string) =>
    key === '' ? 'no thread' : `the thread "${list.find(t => keyOf(t.name) === key)?.name ?? key}"`
  const what = glimpses.get(open) ?? 'a message'
  const into = isNew ? `the new thread "${list.find(t => keyOf(t.name) === to)?.name ?? to}" they started for it` : where(to)
  await update($, untold, all => [...all, `The user moved ${what} from ${where(from)} to ${into}.`])
  await save($)
  await reviseSummaries($, [], [from, to].filter(key => key !== ''))
}

// Starts the thread the person named in the open picker, as a heading or create_thread
// would (the next colour), and moves what the picker is for into it. A name already a
// thread's moves it there; an empty one does nothing.
async function moveToNewThread($: EngineInterface, typed: string) {
  const name = nameOf(typed.replace(/^#+/, ''))
  if (name === '' || name.length > 48 || (await read($, picking)) === '') return
  const isNew = !(await read($, threads)).some(t => keyOf(t.name) === keyOf(name))
  await addThreads($, [name], 'user')
  await moveTo($, keyOf(name), isNew)
}

// A part's thread tag with a small button beside it that opens the move picker, or
// with no thread, a "+ thread" button. A Button, never a Client: every Client of a
// plugin shares one frame on the desktop, and one per tag of a long transcript
// overran its render deadline, which tore the frame down for every Client.
function drawMovableTag(
  $: EngineInterface,
  e: Parameters<EngineInterface['ui']['resolve']>[0] & { requestId: string },
  thread: Thread | undefined,
  align: 'start' | 'end',
  inset = 0,
): RenderElement {
  const row = e.requestId
  const place = thread === undefined ? '' : keyOf(thread.name)
  const { Box, Button } = $.ui.resolve(e)
  // The desktop draws it chromeless and faint, bright under the pointer.
  const look = e.surface === 'desktop' ? ({ plain: true, dimColor: true } as const) : ({ variant: 'secondary' } as const)
  // With the pointer anywhere on the tag, its name included, the button lights in the
  // thread's colour, showing where to press; the cursor stays the surface's own.
  return (
    <Box key={`tagbox:${place}`} flexDirection="row" columnGap={e.surface === 'desktop' ? 0 : 1} alignItems="center">
      {thread !== undefined && drawTag($, e, thread, align, inset)}
      <Button
        key={`tag:${place}`}
        label={thread === undefined ? '+ thread' : '▾'}
        {...look}
        hover={{ color: thread?.color ?? 'text' }}
        onPress={() => togglePicker($, row, place)}
      />
    </Box>
  )
}

// What the multitask plugin's voice says when it says nothing; that plugin draws it as nothing.
const QUIET = '(quiet)'

// A row's text with nothing of its own to show: none, or the voice's "(quiet)".
const isBlankText = (text: string) => text.trim() === '' || text.trim() === QUIET

// Props that give a Box something to show, or room, though it holds nothing.
const SHAPED = /^(border|padding|margin|height|minHeight|width|minWidth|background)/

// A drawing that shows nothing, as a plugin beneath draws a row it hides: none, a Box
// drawn "none" that no hover reveals, or a Box or Text of only such with no shape of
// its own. Anything else, the engine's own drawing among it, shows something.
function isBlank(node: unknown): boolean {
  if (node === null || node === undefined || node === false || node === '') return true
  if (typeof node !== 'object') return false
  const el = node as { type?: unknown; props?: Record<string, unknown>; hover?: Record<string, unknown>; children?: unknown[] }
  if (el.type === 'Box' && el.props?.display === 'none') return el.hover?.display === undefined
  if (el.type !== 'Box' && el.type !== 'Text') return false
  if (Object.keys(el.props ?? {}).some(prop => SHAPED.test(prop))) return false
  return (el.children ?? []).every(isBlank)
}

// A row that holds a "+ thread" keeps one fixed row of room for it, its tags (if
// any) against the part below, so the pointer revealing it moves nothing. Only a
// row with something of its own to show gets one: never one drawn as nothing.
const ADD_ROW = { height: 1, flexShrink: 0, alignItems: 'flex-end' } as const

// The faint "+ thread" of a part of no thread, shown while the pointer is over the
// keyed Box it sits in. It goes in the flow of an ADD_ROW row above the part: an
// absolute Box is placed against the whole message, whose top is the part itself.
function drawAddThread(
  $: EngineInterface,
  e: Parameters<EngineInterface['ui']['resolve']>[0] & { requestId: string },
  align: 'start' | 'end',
): RenderElement {
  const { Box } = $.ui.resolve(e)
  return (
    <Box display="none" hover={{ display: 'flex' }}>
      {drawMovableTag($, e, undefined, align)}
    </Box>
  )
}

type MenuSwitch = { key: string; label: string; isOn: boolean }

// The switches of the band's menu: threads on in this chat, and, while they are, whether
// the agent may start them and whether the chat is filtered to the picked thread.
async function menuSwitches($: EngineInterface): Promise<MenuSwitch[]> {
  const isThreadsOn = await read($, isOn)
  return [
    { key: THREADS_SWITCH, label: 'On in this chat', isOn: isThreadsOn },
    ...(isThreadsOn
      ? [
          { key: AGENT_SWITCH, label: 'Agent may start threads', isOn: await read($, agentMayCreate) },
          { key: FILTER_SWITCH, label: 'Filter the chat', isOn: await read($, filtersChat) },
          { key: SUMMARIES_SWITCH, label: 'Thread summaries', isOn: await read($, summariesOn) },
          ...((await read($, summariesOn)) ? [{ key: LINE_SWITCH, label: 'Show thread summary', isOn: await read($, summaryLineShown) }] : []),
        ]
      : []),
  ]
}

// A row of the desktop's menu card: its label, a Button that flips it, then its slide
// switch, a picture with a hit area laid over it that flips it too.
function drawMenuRow($: EngineInterface, elements: Elements['desktop'], s: MenuSwitch): RenderElement {
  const { Box, Button, Svg, Client } = elements
  return (
    <Box flexDirection="row" alignItems="center" justifyContent="space-between" columnGap={2}>
      <Button key={s.key} label={s.label} plain onPress={() => flipMenuSwitch($, s.key)} />
      <Box flexShrink={0}>
        <Svg source={switchPicture(s.isOn)} alt={`${s.label}: ${s.isOn ? 'on' : 'off'}`} width={34} height={CHIP_HEIGHT} />
        <Box position="absolute" top={0} left={0} width="100%" height="100%">
          <Client key={SWITCH_HIT + s.key} module="./switch.tsx" props={{ isOn: s.isOn }} width="100%" height="100%" />
        </Box>
      </Box>
    </Box>
  )
}

// The thread view's filter: one thread (by its key) picked, or left out where it was.
const toggleViewThread = ($: EngineInterface, key: string) => filterView($, (keys, list) => toggledShown(list, keys, key))

// The desktop's hit area over a thread's tag in the thread view's filter, as over a menu
// switch: a click on it posts, and the post toggles the thread.
const filterHitOf = (elements: Elements['desktop']) => (key: string, isPicked: boolean) => {
  const { Client } = elements
  return <Client key={FILTER_THREAD_KEY + key} module="./switch.tsx" props={{ isOn: isPicked }} width="100%" height="100%" />
}

// The menu's row that opens the thread view, as /thread-view does; only while threads are on.
const VIEW_ROW = 'Open thread view'

// The fill of the desktop's Select field: white at 5% over the band in the dark theme
// (no theme colour names it). The light theme's is white at 50%, over a near-white band.
const FIELD_FILL = 'rgba(255,255,255,0.05)'
// The Select's 6px either side of its text and caret, from its outer edge: 5px inside
// the Box's 1px border, in the band's ch.
const FIELD_PADDING = 0.7
// The gap between the rows of the menu's card, in the desktop's half lines: a quarter of
// the band's line, about 5px, so a row (one line, about 19px, or a 20px slide switch)
// comes about 24px after the last, as the options of the desktop's Select do.
const MENU_ROW_GAP = 0.5

// The band's threads menu, a settings cog: its switches, then, while threads are on,
// the thread actions (opening the thread view, starting a thread, managing the threads),
// which take the switches' place past their first rows. On the desktop, a button drawn
// as the desktop draws a Select (as the thread picker and Multitask's dropdown beside
// it): the field's fill and its ring, stronger under the pointer, the radius, the
// padding, one line high, the cog, the caret. The keyed Box it is holds them in a card
// the desktop lifts over the band while the pointer is on the button or the card, or the
// focus is in them. Elsewhere, a Button that shows or hides them beside it.
async function drawMenu($: EngineInterface, e: Parameters<EngineInterface['ui']['resolve']>[0]): Promise<RenderElement> {
  const isThreadsOn = await read($, isOn)
  // past its first rows (a new thread's name, managing the threads), the thread actions alone
  const mode = isThreadsOn ? await read($, menuMode) : ''
  const switches = mode === '' ? await menuSwitches($) : []
  const ui = $.ui.resolve(e)
  const menuUi = { Box: ui.Box, Text: ui.Text, Button: ui.Button, Input: 'Input' in ui ? ui.Input : undefined }
  const actions = isThreadsOn ? drawThreadActions($, menuUi, e.surface, await read($, threads), mode) : []
  if (e.surface === 'desktop') {
    const desktop = $.ui.resolve(e)
    const { Box, Svg } = desktop
    return (
      <Box
        key={MENU}
        flexDirection="row"
        alignItems="center"
        height={1}
        paddingX={FIELD_PADDING}
        paddingY={0}
        borderStyle="single"
        backgroundColor={FIELD_FILL}
        hover={{ borderColor: 'promptBorder' }}
      >
        <Svg source={COG_PICTURE} alt="Threads menu" width={CARET_SIZE} height={CARET_SIZE} />
        <Svg source={CARET_PICTURE} alt="menu" width={CARET_GAP + CARET_SIZE} height={CARET_SIZE} />
        <Box position="absolute" display="none" hover={{ display: 'flex' }} flexDirection="column" rowGap={MENU_ROW_GAP}>
          {switches.map(s => drawMenuRow($, desktop, s))}
          {actions}
        </Box>
      </Box>
    )
  }
  const { Box, Text, Button } = $.ui.resolve(e)
  const isOpen = await read($, menuOpen)
  return (
    <Box flexDirection="row" alignItems="center" columnGap={2}>
      <Button
        key={MENU}
        label={isOpen ? '⚙ ▴' : '⚙ ▾'}
        variant="secondary"
        onPress={() => toggleMenu($)}
      />
      {isOpen &&
        switches.map(s => (
          <Box flexDirection="row" columnGap={1}>
            <Text dimColor>{s.label}</Text>
            <Button
              key={s.key}
              label={s.isOn ? '( ●)' : '(● )'}
              variant={s.isOn ? 'primary' : 'secondary'}
              dimColor={!s.isOn}
              onPress={() => flipMenuSwitch($, s.key)}
            />
          </Box>
        ))}
      {isOpen && actions}
    </Box>
  )
}

// The move picker's field for a new thread's name, and its "+" pill that opens the
// field; not under `pick:` or `tag:`, which name the picker's pills and the tags' buttons.
const NEW_THREAD_FIELD = 'new-thread'
const NEW_THREAD_PILL = 'pick-new'

// Swaps the open picker's pills for its field for a new thread's name, or back.
async function setNaming($: EngineInterface, isNaming: boolean) {
  await update($, naming, () => isNaming)
}

// The field a new thread's name is typed in, focused as it shows, and the "×" beside it
// that goes back: the move picker's and the Threads menu's alike, under keys of each's own.
function drawNameField(
  ui: { Input: Elements['terminal']['Input']; Button: Elements['terminal']['Button'] },
  keys: { field: string; cancel: string },
  submitLabel: string,
  onSubmit: (value: string) => unknown,
  onCancel: () => unknown,
): RenderElement[] {
  const { Input, Button } = ui
  return [
    <Input key={keys.field} placeholder="name" submitLabel={submitLabel} autoFocus onSubmit={(value: string) => void onSubmit(value)} />,
    <Button key={keys.cancel} label="×" plain dimColor onPress={() => void onCancel()} />,
  ]
}

// The row of thread pills that moves a part, drawn in the flow at its top beside
// its tag, or where its "+ thread" sits; "none", for no thread, has no colour and a
// dashed outline. A last "+" pill swaps the pills, in the same row, for a field to
// name a new thread: Enter starts it and moves the part there, "×" goes back. So the
// picker is of use with no threads yet. Mobile, which draws no field, has no "+".
function drawPicker(
  $: EngineInterface,
  e: Parameters<EngineInterface['ui']['resolve']>[0],
  list: Thread[],
  place: string,
  align: 'start' | 'end',
  isNaming: boolean,
): RenderElement {
  const choices: { key: string; name: string; color: string | undefined }[] = [
    ...list
      .filter(t => keyOf(t.name) !== place && t.isArchived !== true)
      .map(t => ({ key: keyOf(t.name), name: t.name, color: t.color })),
    ...(place === '' ? [] : [{ key: '', name: 'none', color: undefined }]),
  ]
  const justify = align === 'end' ? 'flex-end' : 'flex-start'
  const elements = $.ui.resolve(e)
  const { Box, Text, Button } = elements
  // The mobile app draws no field yet, though its table may still hand one over.
  const Input = e.surface !== 'mobile' && 'Input' in elements ? elements.Input : undefined
  const canName = Input !== undefined
  const row = (children: RenderElement[]) => (
    <Box flexDirection="row" flexWrap="wrap" columnGap={1} alignItems="center" justifyContent={justify}>
      <Text dimColor>{isNaming && canName ? 'new thread' : 'move to'}</Text>
      {children}
    </Box>
  )

  if (isNaming && Input !== undefined) {
    return row(
      drawNameField(
        { Input, Button },
        { field: NEW_THREAD_FIELD, cancel: 'pick-cancel' },
        'move',
        value => moveToNewThread($, value),
        () => setNaming($, false),
      ),
    )
  }

  if (e.surface !== 'desktop') {
    // A Button takes no dashed outline; "none" is drawn dim instead.
    return row([
      ...choices.map(c => (
        <Button
          key={`pick:${c.key}`}
          label={c.name}
          {...(c.color === undefined ? { dimColor: true } : {})}
          onPress={() => moveTo($, c.key)}
        />
      )),
      ...(canName ? [<Button key={NEW_THREAD_PILL} label="+" onPress={() => setNaming($, true)} />] : []),
    ])
  }
  const desktop = $.ui.resolve(e)
  const pills = [
    ...choices.map(c => ({
      key: `pick:${c.key}`,
      pillOf: (isHot: boolean) => chipPicture(c.name, c.color, false, false, false, undefined, isHot),
      alt: c.name,
    })),
    {
      key: NEW_THREAD_PILL,
      pillOf: (isHot: boolean) => chipPicture('+', undefined, false, false, false, false, isHot),
      alt: 'new thread',
    },
  ]
  return row(
    pills.map(p => drawPillSwitch(desktop, `choice:${p.key}`, p.key, false, p.alt, p.pillOf)),
  )
}

// Picks the thread messages with no heading go to ('' none), and, while the chat is
// filtered to it, takes the chat back to its end. The thread view's filter is its own.
async function pickThread($: EngineInterface, key: string) {
  await update($, current, () => key)
  await save($)
  if (await read($, filtersChat)) await scrollToEnd($)
}

// A thread's name by its key, for telling the model.
async function nameByKey($: EngineInterface, key: string): Promise<string> {
  return (await read($, threads)).find(t => keyOf(t.name) === key)?.name ?? key
}

// Merges the thread `fromKey` into `toKey`: an old heading means the one it joined, and
// the picked thread and the thread view's filter follow it. The model is told beside the
// person's next message, as where the threads stand changed.
async function mergeThreads($: EngineInterface, fromKey: string, toKey: string) {
  if (fromKey === toKey) return
  await update($, aliases, merged => ({
    ...Object.fromEntries(Object.entries(merged).map(([k, v]) => [k, v === fromKey ? toKey : v])),
    [fromKey]: toKey,
  }))
  await update($, threads, all => all.filter(t => keyOf(t.name) !== fromKey))
  await update($, current, key => (key === fromKey ? toKey : key))
  await update($, viewThreads, keys => [...new Set(keys.map(key => (key === fromKey ? toKey : key)))])
  await update($, activeThread, key => (key === fromKey ? toKey : key))
  await save($)
  await reviseSummaries($, [fromKey], [toKey])
}

// Archives a thread, or brings it back: archived, it leaves the pickers and the thread
// view's filter but keeps its messages, and is no longer the picked thread. The model is
// told beside the person's next message.
async function setArchived($: EngineInterface, key: string, isArchived: boolean) {
  const name = await nameByKey($, key)
  await update($, threads, all =>
    all.map(t => (keyOf(t.name) !== key ? t : isArchived ? { ...t, isArchived: true } : withoutArchived(t))),
  )
  if (isArchived) {
    await update($, current, cur => (cur === key ? '' : cur))
    await update($, viewThreads, keys => keys.filter(k => k !== key))
  }
  const note = isArchived
    ? `The user archived the thread "${name}": it is hidden from their thread picker but kept. Write in it only if they bring it up.`
    : `The user brought back the archived thread "${name}".`
  await update($, untold, all => [...all, note])
  await save($)
}

// Deletes a thread: its tags leave every message, whose text stays, of no thread; a
// heading that names it, a merge into it, a send to it and a move to it are of no
// thread. A thread started again by its name takes its key back. The model is told
// beside the person's next message.
async function deleteThread($: EngineInterface, key: string) {
  const name = await nameByKey($, key)
  await update($, threads, all => all.filter(t => keyOf(t.name) !== key))
  await update($, deleted, all => (all.includes(key) ? all : [...all, key]))
  await update($, current, cur => (cur === key ? '' : cur))
  await update($, viewThreads, keys => keys.filter(k => k !== key))
  await update($, activeThread, k => (k === key ? '' : k))
  await update($, untold, all => [
    ...all,
    `The user deleted the thread "${name}": its messages no longer belong to any thread. Do not write under its heading unless they start it again.`,
  ])
  await save($)
  await reviseSummaries($, [key], [])
}

// The text the person's bubble shows: a known thread's heading line goes, as the
// tags above name the threads; where several sections share the bubble, a plain
// `▸ name` line still marks where each thread's part starts. A heading that
// names no thread stays as typed. A quoted selection opening the first thread's part
// stays at the top, above its `▸ name`, where the desktop wrote it.
function bubbleText(shown: Section[], resolve: (name: string) => Thread | undefined): string {
  const only = shown.length === 1 ? shown[0] : undefined
  if (only !== undefined && only.thread !== null && resolve(only.thread) !== undefined) return only.text
  const [first, ...later] = shown
  const isThreaded = first !== undefined && first.thread !== null && resolve(first.thread) !== undefined
  const opening = isThreaded && first !== undefined ? leadingQuoteOf(first.text) : undefined
  const parts = opening === undefined || first === undefined ? shown : [{ ...first, text: opening.rest }, ...later]
  const text = parts
    .map(s => {
      if (s.thread === null) return s.text
      const thread = resolve(s.thread)
      const marker = thread === undefined ? `# ${s.thread}` : `▸ ${thread.name}`
      return s.text === '' ? marker : `${marker}\n${s.text}`
    })
    .join('\n\n')
  return opening === undefined ? text : `${opening.quote}\n\n${text}`
}

// The thread view (pane.tsx) places a section by the rules the chat draws it by.
const viewDeps: ViewDeps = { threadOf, personThreadOf, personSectionsOf, replySectionsOf, linksFor, placeSection, stemOf }

// Where the thread view's window stood when it last moved: at or near its end, a new
// message keeps it at the end; scrolled up, it stays where the person put it.
let viewPlace: ViewPlace = 'end'
// A row the window is still to go back to, once the surface drawing it afresh has
// measured its rows (viewMoveOf).
let viewReturn: number | undefined
// The row this plugin's own move to the window's top is carried on to (returnView).
let viewReturning: number | undefined
// The person's moves of the window so far: one made while a move back waits stands.
let personMoves = 0
// The rows of the view's tree as its window last moved over it; none before it moved.
let viewContentRows: number | undefined

// Where the window stands over the thread view, `offset` rows down: 0 at its top, 1 at its
// end. At its end while it keeps to the end, or before its rows are known.
function viewNearOf(offset: number, bodyRows: number): number {
  if (viewPlace === 'end' || viewContentRows === undefined || viewContentRows <= bodyRows) return 1
  return Math.min(1, Math.max(0, (offset + bodyRows / 2) / viewContentRows))
}

// How long a move back waits after a surface draws the view afresh: for it to measure
// its rows, and for a move of the person's it drew for to be seen first.
const VIEW_SETTLE_MS = 100

// How long a surface may take to draw a change to what the thread view shows, and to
// lay out its markdown and pictures: a move it reports meanwhile may be its own.
const VIEW_REDRAW_MS = 500
// The plugin's keys the thread view is drawn from (viewInputs, and the pictures read).
const VIEW_KEYS: ReadonlySet<string> = new Set([
  'viewRows', 'picturesRead', 'viewFrom', 'viewThreads', 'recent', 'threads', 'aliases', 'snaps', 'sentTo', 'moved', 'deleted',
])
// Changes to what the thread view shows so far; the one the surface may yet report a
// move of its own for as it draws it, until the person's next move or VIEW_REDRAW_MS.
let viewChanges = 0
let viewChangeUndrawn: number | undefined

// Keeps the thread view's window on its newest rows as they come, until the person scrolls.
async function pinViewToEnd($: EngineInterface) {
  try {
    await $.ui.scroll({ in: VIEW, to: 'end' })
  } catch {
    return
  }
}

// A change to what the thread view shows. At its end, a shorter tree (a reply hidden
// once a tool call follows it, a picture's card made smaller) pulls the desktop's window
// up with it, which it reports as the person's move: the view's scroll hook keeps it
// at its end (isRedrawMove). Once drawn, a view at its end is taken there again: a
// surface that stopped keeping to its end, or went there before its rows were laid out,
// leaves it short.
function noteViewChange($: EngineInterface) {
  const change = ++viewChanges
  viewChangeUndrawn = change
  $.clock.after(VIEW_REDRAW_MS, () => {
    if (viewChangeUndrawn === change) viewChangeUndrawn = undefined
    if (viewChanges === change && viewPlace === 'end') void pinViewToEnd($)
  })
}

// How long after a change to the view's filter the surface may still be drawing and laying
// out what it then shows; and that change, while it may (filterView).
const FILTER_SETTLE_MS = 1500
let viewFiltering: number | undefined
let viewFilters = 0

// Whether a move reported as the person's is the surface's own as it draws a change at
// the view's end, by no wheel (whose pointer a surface reports): up, the first since the
// change, while it is drawn; or any, while a filter change settles. Sections a wider
// filter shows come above those in the window, and the surface keeping its window on
// them moves it down, short of the new end.
const isRedrawMove = (e: { origin: { kind: string }; by: number; pointer?: unknown }) =>
  e.origin.kind === 'person' &&
  e.pointer === undefined &&
  viewPlace === 'end' &&
  ((viewChangeUndrawn !== undefined && e.by < 0) || viewFiltering !== undefined)

// Takes the thread view's window to a row: a move to its top that its scroll hook
// carries on to the row (a plugin names no row to scroll to).
async function returnView($: EngineInterface, row: number) {
  viewReturning = row
  try {
    await $.ui.scroll({ in: VIEW, to: 'start' })
  } catch {
    return
  } finally {
    viewReturning = undefined
  }
}

// Puts the thread view's window back where the person left it when a surface draws the
// view afresh, at its top: the desktop does on opening it and on coming back to its tab.
// Not just after the window was kept off earlier sections drawn above it: a drawing at
// the top then is one the surface made before it took that move.
function settleView($: EngineInterface, offset: number, bodyRows: number) {
  if (viewReturn === undefined && Date.now() - viewKeptAt < VIEW_REDRAW_MS) return
  const move = viewMoveOf(viewPlace, viewReturn, offset, bodyRows)
  if (move === undefined) return
  if (move.to !== 'end') viewReturn = undefined
  const moves = personMoves
  $.clock.after(VIEW_SETTLE_MS, () => {
    if (personMoves !== moves) return
    if (move.to !== 'end') {
      void returnView($, move.to)
      return
    }
    viewReturn = move.back
    void pinViewToEnd($)
  })
}

// The person's place in the thread view from now on: its newest rows, the newest sections
// drawn.
async function placeViewAtEnd($: EngineInterface) {
  viewPlace = 'end'
  viewReturn = undefined
  viewGrowth = undefined
  viewKeptAt = 0
  try {
    await update($, viewFrom, () => null)
  } catch {
    // drawn from where it was
  }
}

// The sections the thread view last drew: its first, of how many; none before it drew.
let viewSpan: ViewSpan | undefined
// Earlier sections drawn above the window, to be kept out of it (ViewGrowth): the first
// section drawn before them (`from`), whether a drawing holds them yet, when they were
// asked for, and the moves left to keep the window off them.
type Growth = ViewGrowth & { from: number; isDrawn: boolean; at: number; tries: number }
let viewGrowth: Growth | undefined
// Whether this plugin's move to the window's top is one keeping it off them (keepViewPlace).
let viewKeeping = false
// When the window was last kept off them, by that move or the person's carried down by them.
let viewKeptAt = 0
// How many moves try to keep the window off them, VIEW_SETTLE_MS apart, before it is left
// be; and how long they hold off more earlier sections.
const KEEP_TRIES = 6
const VIEW_GROW_MS = 3000

// A step of the thread view's own for `/thread-view trace`, beside its drawings.
const noteView = (what: string) => traceView(what).end('noted')

// Draws SECTIONS_MORE earlier sections above those the thread view draws, the window kept
// on the rows it shows: `rows` the view's rows as the window last moved over it. A view at
// its end is kept there, as the surface keeps to its end.
async function showEarlier($: EngineInterface, rows: number | undefined) {
  const span = viewSpan
  if (span === undefined || span.from === 0) return
  if (viewGrowth !== undefined && Date.now() - viewGrowth.at < VIEW_GROW_MS) return
  const isAtEnd = viewPlace === 'end' || rows === undefined
  const from = Math.max(0, span.from - SECTIONS_MORE)
  viewGrowth = isAtEnd ? undefined : { rows, nudge: 0, from: span.from, isDrawn: false, at: Date.now(), tries: KEEP_TRIES }
  noteView(`earlier sections asked for: from ${span.from} to ${from} of ${span.count}, ${isAtEnd ? 'at the end' : `over ${rows} rows`}`)
  if (isAtEnd) await pinViewToEnd($)
  try {
    await update($, viewFrom, () => from)
  } catch {
    viewGrowth = undefined
  }
}

// Keeps the sections the thread view draws while the person reads it scrolled up: new ones
// come below them, and none goes from above.
async function holdViewFrom($: EngineInterface) {
  const span = viewSpan
  if (span === undefined) return
  try {
    if ((await read($, viewFrom)) === null) await update($, viewFrom, from => from ?? span.from)
  } catch {
    // drawn as it was
  }
}

// Keeps the thread view's window off the earlier sections drawn above it: a move to its top
// that its scroll hook carries down by the rows they added (keptMoveOf), tried again until
// the surface has said them.
async function keepViewPlace($: EngineInterface) {
  const growth = viewGrowth
  if (growth === undefined) return
  growth.tries -= 1
  viewKeeping = true
  try {
    await $.ui.scroll({ in: VIEW, to: 'start' })
  } catch {
    // tried again while tries are left
  } finally {
    viewKeeping = false
  }
  if (viewGrowth !== growth) return
  if (growth.tries > 0) $.clock.after(VIEW_SETTLE_MS, () => void keepViewPlace($))
  else viewGrowth = undefined
}

// Where keepViewPlace's move goes, from the window's row (`at`): down by the rows the earlier
// sections added, or, before the surface has said them, a row up or down, which has a desktop
// say them. None where the window cannot move: the view fitted it.
function keptMoveOf(growth: ViewGrowth, e: { offset: number; by: number; bodyRows: number; contentRows: number }) {
  const at = e.offset - e.by
  const offset = grownOffsetOf(growth, at, e.contentRows)
  if (offset !== undefined) return { at, offset, nudge: 0 }
  const nudge = nudgeOf(at, e.contentRows, e.bodyRows)
  return nudge === 0 ? undefined : { at, offset: at + nudge, nudge }
}

// Changes what the thread view's filter picks (`shown` from what it picked), and takes
// the view to the newest of what it then shows: where it was drawn from is of other
// sections. The surface's own moves as it draws and lays that out keep it at the end
// (isRedrawMove), and once they settle it is taken there again, unless the person moved
// it meanwhile. The thread picked above the prompt stays as it is.
async function filterView($: EngineInterface, shown: (keys: string[], list: Thread[]) => string[]) {
  const filtering = ++viewFilters
  viewFiltering = filtering
  $.clock.after(FILTER_SETTLE_MS, () => {
    if (viewFiltering !== filtering) return
    viewFiltering = undefined
    if (viewPlace === 'end') void pinViewToEnd($)
  })
  await placeViewAtEnd($)
  const list = await read($, threads)
  await update($, viewThreads, keys => shown(keys, list))
  await save($)
  await pinViewToEnd($)
}

// Opens the thread view (or shows it, already open) at its newest rows; a surface that
// draws it only later is taken there as it does (settleView).
async function openView($: EngineInterface) {
  await placeViewAtEnd($)
  const { step, end } = traceView('open asked')
  const opened = await $.ui.open({ id: VIEW, title: VIEW_TITLE })
  step(`open answered: ${JSON.stringify(opened)}`)
  if (opened.isPlaced) await pinViewToEnd($)
  end('open done')
  return opened
}

// What the thread view is drawn from; read while drawing, so a change draws it again.
// The rows it kept are the transcript as stored; the conversation as the engine
// holds it (a compaction's summary in place of what came before) is read only to
// fill in rows kept without their text, or for a session it kept no rows of.
async function viewInputs($: EngineInterface, step: (what: string) => void = () => {}): Promise<ViewInputs> {
  const known = await read($, viewRows)
  step(`rows read: ${known.length}, ${known.filter(row => row.text === undefined).length} without text`)
  let messages: ViewInputs['messages'] = []
  if (needsMessages(known)) {
    try {
      messages = await $.session.messages()
      step(`conversation read: ${messages.length} messages`)
    } catch (error) {
      step(`conversation not read: ${String(error)}`)
      messages = []
    }
  }
  const inputs = {
    list: await read($, threads),
    merged: await read($, aliases),
    snapped: await read($, snaps),
    sent: await read($, sentTo),
    moves: await read($, moved),
    shown: await read($, viewThreads),
    recent: await read($, recent),
    deleted: await read($, deleted),
    known,
    messages,
    // react's reactions while it draws them in the chat, its values read as the view draws,
    // so a new one draws it again
    reactions: (await read($, reactIsOn)) ? await read($, reactReactions) : [],
  }
  step(`threads read: ${inputs.list.length}, filter picked ${inputs.shown.length}`)
  return inputs
}

// The thread view's last few drawings, step by step, for `/thread-view trace`: when each
// began, the time to each step, and how it ended (no end: still running, or cut off).
type ViewTrace = { at: string; steps: string[]; end?: string }
const viewTraces: ViewTrace[] = []
const VIEW_TRACES_KEPT = 10

function traceView(start: string): { step: (what: string) => void; end: (how: string) => void } {
  const began = Date.now()
  const trace: ViewTrace = { at: new Date(began).toISOString(), steps: [] }
  viewTraces.push(trace)
  if (viewTraces.length > VIEW_TRACES_KEPT) viewTraces.shift()
  const step = (what: string) => {
    trace.steps.push(`${Date.now() - began}ms ${what}`)
  }
  step(start)
  return { step, end: how => (trace.end = `${Date.now() - began}ms ${how}`) }
}

// The picture cards a drawing of the view holds, those with bytes, and their bytes' length.
function picturesIn(node: unknown, counts = { cards: 0, filled: 0, chars: 0 }) {
  if (typeof node !== 'object' || node === null) return counts
  const { type, props, children } = node as { type?: unknown; props?: { alt?: unknown; source?: unknown }; children?: unknown[] }
  if (type === 'Svg' && props?.alt === 'Pasted image') {
    counts.cards += 1
    const data = /base64,([^"]*)"/.exec(String(props.source))?.[1]
    if (data !== undefined) {
      counts.filled += 1
      counts.chars += data.length
    }
  }
  for (const child of children ?? []) picturesIn(child, counts)
  return counts
}

const viewTraceText = () =>
  viewTraces.length === 0
    ? 'The thread view has not been drawn since thread-chat last loaded.'
    : viewTraces.map(t => [`draw at ${t.at}: ${t.end ?? 'NO END (still running, or cut off)'}`, ...t.steps.map(s => `  ${s}`)].join('\n')).join('\n')

// The file beside a session's rows that holds their marks' hashes, a line a row.
const MARKS_FILE = 'marks.txt'

// The plugin's data folder, under the Claude Code configuration folder; none where
// that folder is not known.
async function dataFolder($: EngineInterface): Promise<string | undefined> {
  const home = (await $.env.get('USERPROFILE')) || (await $.env.get('HOME'))
  const config = (await $.env.get('CLAUDE_CONFIG_DIR')) || (home ? `${home}/.claude` : undefined)
  return dataFolderOf($.plugin.root, $.plugin.name, config)
}

// Where a session's view rows are kept between runs: files of their own, all of
// every message's text, as the store holds 4 MiB in all; the store notes only how
// many there are (KeptView). They are in the plugin's data folder, a folder a session.
async function rowsFolder($: EngineInterface, id: string): Promise<string | undefined> {
  const data = await dataFolder($)
  return data === undefined ? undefined : `${data}/views/${id.replace(/[^A-Za-z0-9_-]/g, '_')}`
}

// The rows kept of a session: in its files, or in the store, as an earlier version
// kept them; none where none were kept. A file that cannot be read is passed over.
async function keptRows($: EngineInterface, id: string): Promise<ViewRow[]> {
  const kept = await $.store.get(viewKey(id))
  if (Array.isArray(kept)) return kept as ViewRow[]
  if (!isKeptView(kept) || kept.chunks.length === 0) return []
  const folder = await rowsFolder($, id)
  if (folder === undefined) return []
  const chunks: string[] = []
  for (let i = 0; i < kept.chunks.length; i++) {
    const text = await $.fs.read(`${folder}/${i}.jsonl`).catch(() => undefined)
    if (text !== undefined) chunks.push(text)
  }
  return rowsOfChunks(chunks)
}

// Keeps a session's view rows for its next run, every one with its text: the files
// whose text changed are written, then the hashes of the rows' marks, then the
// store's note of the files. Rows an earlier version kept in the store move to
// files. Best effort: the view this run draws keeps its rows, and the next turn
// tries again.
async function keepViewRows($: EngineInterface, id: string, rows: ViewRow[]) {
  try {
    const folder = await rowsFolder($, id)
    if (folder === undefined) return
    const chunks = chunksOf(rows)
    const fingerprints = chunks.map(fingerprintOf)
    const kept = await $.store.get(viewKey(id))
    const before = isKeptView(kept) ? kept.chunks : []
    if (fingerprints.length === before.length && fingerprints.every((print, i) => print === before[i])) return
    for (const [i, text] of chunks.entries()) {
      if (fingerprints[i] !== before[i]) await $.fs.write(`${folder}/${i}.jsonl`, text)
    }
    // a file past the rows' end is left empty, as no file is deleted
    for (let i = chunks.length; i < before.length; i++) await $.fs.write(`${folder}/${i}.jsonl`, '')
    await $.fs.write(`${folder}/${MARKS_FILE}`, marksOf(rows))
    await $.store.set(viewKey(id), { chunks: fingerprints })
  } catch {
    // nothing more is kept this time
  }
}

// Takes up the pictures' files a session's kept rows note and its rows here lack: noted
// there since this run read them (by a repair of rows an earlier version kept). Best
// effort, as keeping them is.
async function takeKeptPaths($: EngineInterface, id: string) {
  try {
    const rows = await read($, viewRows)
    if (rows.length === 0) return
    const kept = await keptRows($, id)
    if (withKeptPaths(rows, kept) !== rows) await update($, viewRows, all => withKeptPaths(all, kept))
  } catch {
    // the rows stand as they are
  }
}

// The person's message whose pictures wait for the row naming their files, which Claude
// Code stores after it in the same turn.
let awaitingPaths: string | undefined

// The thread view's pictures, by the file each was saved to: their bytes once read
// (`Picture`), `loading` until then, `failed` where they cannot be (the file gone, or
// too large to draw and no way here to make it smaller). Read once a run of this code.
const pictures = new Map<string, Picture | 'loading' | 'failed'>()
// The files whose pictures wait to be read, in the order the view asked for them, and
// whether they are being read (or soon will be).
const pictureQueue: string[] = []
let isReadingPictures = false

// A picture whose file's base64 is longer than this is drawn from a smaller copy, so
// several fit in what one drawing of the view holds (PICTURE_CHARS_DRAWN): a JPEG at
// most this many pixels across and down (a card's bounds and a fifth), of this quality.
const PICTURE_FILE_CHARS = 40_000
const THUMB_BOX = { width: 240, height: 360 }
const THUMB_QUALITY = 70
// The pictures one run of PowerShell makes smaller, by the characters their job list takes:
// it goes in an environment variable, which takes 32767 at most.
const THUMB_JOBS_CHARS = 16_000
// Whether this machine may have a way to make a picture smaller: false once none was
// found, so the view stops asking.
let canResize = true

// A picture's bytes as the view draws them, from its file: at hand once read; else read
// in the background, the view drawn again once they are.
function pictureFor($: EngineInterface, image: ViewImage): Picture | 'loading' | undefined {
  const { path } = image
  if (path === undefined) return undefined
  const known = pictures.get(path)
  if (known !== undefined) return known === 'failed' ? undefined : known
  pictures.set(path, 'loading')
  pictureQueue.push(path)
  if (!isReadingPictures) {
    isReadingPictures = true
    // once this drawing is done: a drawing writes nothing
    $.clock.after(1, () => void readPictures($))
  }
  return 'loading'
}

// The thread view drawn again with the pictures read so far.
async function drawPictures($: EngineInterface) {
  try {
    await update($, picturesRead, n => n + 1)
  } catch {
    try {
      $.ui.invalidate('ui.render')
    } catch {
      // drawn with them next time it is drawn
    }
  }
}

// Reads the pictures the view waits for, the view drawn again as they come: those few
// enough to draw from their files, the rest from smaller copies kept under the plugin's
// data folder, made once.
async function readPictures($: EngineInterface) {
  try {
    while (pictureQueue.length > 0) {
      const paths = pictureQueue.splice(0)
      const folder = await dataFolder($).catch(() => undefined)
      const toMake: ThumbJob[] = []
      for (const path of paths) {
        const stat = await $.fs.stat(path).catch(() => undefined)
        if (stat?.kind !== 'file') {
          pictures.set(path, 'failed')
          continue
        }
        if (Math.ceil(stat.size / 3) * 4 <= PICTURE_FILE_CHARS) {
          pictures.set(path, (await pictureFile($, path)) ?? 'failed')
          continue
        }
        const name = thumbNameOf(path, stat.size, stat.mtimeMs, THUMB_BOX.width)
        const thumb = folder === undefined ? undefined : `${folder}/thumbs/${name}`
        const made = thumb === undefined ? undefined : await pictureFile($, thumb)
        if (thumb === undefined || made !== undefined || !canResize) pictures.set(path, made ?? 'failed')
        else toMake.push({ from: path, to: thumb })
      }
      await drawPictures($)
      if (toMake.length === 0) continue
      await makeThumbs($, toMake).catch(() => undefined)
      for (const { from, to } of toMake) pictures.set(from, (await pictureFile($, to)) ?? 'failed')
      await drawPictures($)
    }
  } finally {
    isReadingPictures = false
  }
}

// A picture file's bytes as the view draws them; none where it cannot be read, is not
// a picture of a type drawn, is too large to draw, or is cut short.
async function pictureFile($: EngineInterface, path: string): Promise<Picture | undefined> {
  try {
    const { base64 } = await $.fs.read(path, { as: 'bytes' })
    const type = imageTypeOf(base64)
    if (type === undefined || !isDrawable(type, base64)) return undefined
    if (type === 'image/jpeg' && !atob(base64.slice(-8)).endsWith('\xff\xd9')) return undefined
    return { type, data: base64, ...imageSizeOf(type, base64) }
  } catch {
    return undefined
  }
}

// A picture to make smaller: its file, and the file its smaller copy is written to.
type ThumbJob = { from: string; to: string }

// Makes smaller copies of pictures with what this machine has: on Windows, PowerShell's
// System.Drawing, the pictures of a run in one call; elsewhere sips (macOS), else
// ImageMagick where it is installed. Each writes a JPEG within THUMB_BOX, and none
// enlarges. A way that cannot start is not tried again; none that can, and the view
// stops asking.
async function makeThumbs($: EngineInterface, jobs: ThumbJob[]) {
  if (!canResize || jobs.length === 0) return
  if (jobs.some(job => /^(?:[A-Za-z]:[\\/]|\\\\)/.test(job.from))) {
    let batch: ThumbJob[] = []
    for (const job of [...jobs, undefined]) {
      if (job !== undefined && JSON.stringify([...batch, job]).length <= THUMB_JOBS_CHARS) {
        batch.push(job)
        continue
      }
      if (batch.length > 0 && !(await resizeOnWindows($, batch))) {
        canResize = false
        return
      }
      batch = job === undefined ? [] : [job]
    }
    return
  }
  for (const job of jobs) {
    if (!(await resizeElsewhere($, job))) {
      canResize = false
      return
    }
  }
}

// PowerShell's script for a run of pictures named in THREAD_CHAT_THUMBS: each drawn
// smaller onto white (a JPEG has no transparency), written beside its place and then
// moved there, so a copy cut short is never taken for one made.
const RESIZE_SCRIPT = `
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Drawing
$codec = [System.Drawing.Imaging.ImageCodecInfo]::GetImageEncoders() | Where-Object { $_.MimeType -eq 'image/jpeg' }
$options = New-Object System.Drawing.Imaging.EncoderParameters 1
$options.Param[0] = New-Object System.Drawing.Imaging.EncoderParameter ([System.Drawing.Imaging.Encoder]::Quality), ([long]$env:THREAD_CHAT_THUMB_QUALITY)
$box = [double]$env:THREAD_CHAT_THUMB_WIDTH, [double]$env:THREAD_CHAT_THUMB_HEIGHT
$jobs = $env:THREAD_CHAT_THUMBS | ConvertFrom-Json
foreach ($job in $jobs) {
  try {
    $source = [System.Drawing.Image]::FromFile($job.from)
    try {
      $scale = [Math]::Min(1.0, [Math]::Min($box[0] / $source.Width, $box[1] / $source.Height))
      $width = [Math]::Max(1, [int][Math]::Round($source.Width * $scale))
      $height = [Math]::Max(1, [int][Math]::Round($source.Height * $scale))
      $thumb = New-Object System.Drawing.Bitmap $width, $height
      try {
        $graphics = [System.Drawing.Graphics]::FromImage($thumb)
        $graphics.InterpolationMode = [System.Drawing.Drawing2D.InterpolationMode]::HighQualityBicubic
        $graphics.Clear([System.Drawing.Color]::White)
        $graphics.DrawImage($source, 0, 0, $width, $height)
        $graphics.Dispose()
        [void][System.IO.Directory]::CreateDirectory([System.IO.Path]::GetDirectoryName($job.to))
        $part = "$($job.to).part"
        $thumb.Save($part, $codec, $options)
        Move-Item -LiteralPath $part -Destination $job.to -Force
      } finally { $thumb.Dispose() }
    } finally { $source.Dispose() }
  } catch { [Console]::Error.WriteLine("$($job.from): $_") }
}
`

// Makes a run of pictures smaller on Windows; false where PowerShell cannot start.
async function resizeOnWindows($: EngineInterface, jobs: ThumbJob[]): Promise<boolean> {
  try {
    await $.process.run(['powershell.exe', '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', RESIZE_SCRIPT], {
      env: {
        THREAD_CHAT_THUMBS: JSON.stringify(jobs),
        THREAD_CHAT_THUMB_WIDTH: String(THUMB_BOX.width),
        THREAD_CHAT_THUMB_HEIGHT: String(THUMB_BOX.height),
        THREAD_CHAT_THUMB_QUALITY: String(THUMB_QUALITY),
      },
      timeoutMs: Math.min(600_000, 20_000 + 2_000 * jobs.length),
    })
    return true
  } catch {
    // not started, or still running at the timeout: the copies made so far stand
    return false
  }
}

// The commands that make a picture smaller off Windows, in the order tried: sips
// (macOS), then ImageMagick 7 and 6. The first of them that starts is used from then on.
const RESIZERS: ((job: ThumbJob) => string[])[] = [
  job => ['sips', '-Z', String(THUMB_BOX.width), '-s', 'format', 'jpeg', '-s', 'formatOptions', String(THUMB_QUALITY), job.from, '--out', job.to],
  job => ['magick', job.from, '-auto-orient', '-thumbnail', `${THUMB_BOX.width}x${THUMB_BOX.height}>`, '-quality', String(THUMB_QUALITY), `jpeg:${job.to}`],
  job => ['convert', job.from, '-auto-orient', '-thumbnail', `${THUMB_BOX.width}x${THUMB_BOX.height}>`, '-quality', String(THUMB_QUALITY), `jpeg:${job.to}`],
]
let resizerAt = 0

// Makes one picture smaller off Windows; false where no command for it starts.
async function resizeElsewhere($: EngineInterface, job: ThumbJob): Promise<boolean> {
  // the commands write into the folder, but do not make it
  const folder = job.to.slice(0, Math.max(job.to.lastIndexOf('/'), job.to.lastIndexOf('\\')))
  if (!(await $.fs.exists(folder).catch(() => false))) await $.fs.write(`${folder}/README.txt`, THUMBS_README).catch(() => undefined)
  while (resizerAt < RESIZERS.length) {
    const argv = RESIZERS[resizerAt]?.(job)
    if (argv === undefined) break
    try {
      await $.process.run(argv, { timeoutMs: 20_000 })
      return true
    } catch {
      resizerAt += 1
    }
  }
  return false
}

const THUMBS_README = 'Smaller copies of pictures pasted in Claude Code sessions, drawn in the thread view. Safe to delete: they are made again.\n'

// The thread picker in the band, keyed PICKER: a Select whose face is the picked thread,
// where a message with no heading goes. Its options are the threads to post to, then
// "No thread"; a thread's value is THREAD_OPTION and its key, which "No thread"'s is not.
// The mobile app, which draws no Select, has a Button that opens the same choices in the
// band, keyed under `picker:`.
const PICKER = 'thread-picker'
const THREAD_OPTION = 'thread:'
const NO_THREAD = 'none'

// The field in the Threads menu for a new thread's name; the menu's thread actions are
// keyed under `threads:`.
const NAME_FIELD = 'threads:name'

// The elements the Threads menu's thread actions are drawn with, alike on every surface.
type MenuUi = Pick<Elements['terminal'], 'Box' | 'Text' | 'Button'> & { Input?: Elements['terminal']['Input'] }

async function setMenuMode($: EngineInterface, mode: string) {
  await update($, menuMode, () => mode)
}

// Opens or closes the Threads menu where a press does (the terminal), at its first rows.
async function toggleMenu($: EngineInterface) {
  await update($, menuMode, () => '')
  await update($, menuOpen, open => !open)
}

// Opens or closes the mobile app's picker, at its list of threads.
async function togglePickerOpen($: EngineInterface) {
  await update($, menuMode, () => '')
  await update($, pickerOpen, open => !open)
}

// Picks a thread from the mobile app's picker ('' none), which closes, as a dropdown does.
async function pickFromList($: EngineInterface, key: string) {
  await update($, pickerOpen, () => false)
  await pickThread($, key)
}

// Starts the thread named in the menu's field, as a heading would (the next colour), and
// picks it; the menu goes back to its first rows. A name already a thread's picks that
// one; an empty or long one does nothing.
async function startFromMenu($: EngineInterface, typed: string) {
  const name = nameOf(typed.replace(/^#+/, ''))
  if (name === '' || name.length > 48) return
  await addThreads($, [name], 'user')
  await setMenuMode($, '')
  await pickThread($, keyOf(name))
}

// The Threads menu's thread actions while threads are on, as `mode` (menuMode) has them:
// at first, rows that open the thread view, start a thread (where a field can be drawn)
// and manage the threads; then the field for a new thread's name, or each thread's merge,
// archive and delete. Rows are Boxes of no key, as a keyed Box in the desktop's card would
// start a hover scope of its own; on the desktop the first rows are plain, as the card's
// switches are, and elsewhere they are Buttons in the band's row.
function drawThreadActions($: EngineInterface, ui: MenuUi, surface: RenderSurface, list: Thread[], mode: string): RenderElement[] {
  const { Box, Text, Button, Input } = ui
  const active = list.filter(t => t.isArchived !== true)
  const archived = list.filter(t => t.isArchived === true)
  const dot = (t: Thread) => <Text color={t.color}>●</Text>
  const row = (children: (RenderElement | false)[]) => (
    <Box flexDirection="row" columnGap={1} alignItems="center">
      {children}
    </Box>
  )
  const column = (children: (RenderElement | false)[]) => (
    <Box flexDirection="column" alignItems="flex-start">
      {children}
    </Box>
  )
  const byKey = (key: string) => list.find(t => keyOf(t.name) === key)

  if (mode === '') {
    const action = (key: string, label: string, onPress: () => unknown) =>
      surface === 'desktop' ? (
        row([<Button key={key} label={label} plain onPress={() => void onPress()} />])
      ) : (
        <Button key={key} label={label} variant="secondary" onPress={() => void onPress()} />
      )
    return [
      action(VIEW, VIEW_ROW, () => openView($)),
      ...(Input === undefined ? [] : [action('threads:new', 'New thread', () => setMenuMode($, 'name'))]),
      ...(list.length === 0 ? [] : [action('threads:manage', 'Manage threads', () => setMenuMode($, 'manage'))]),
    ]
  }

  if (mode === 'name' && Input !== undefined) {
    return [
      column([
        <Text dimColor>new thread</Text>,
        row(
          drawNameField(
            { Input, Button },
            { field: NAME_FIELD, cancel: 'threads:name-cancel' },
            'start',
            value => startFromMenu($, value),
            () => setMenuMode($, ''),
          ),
        ),
      ]),
    ]
  }

  const merging = mode.startsWith('merge:') ? byKey(mode.slice('merge:'.length)) : undefined
  if (merging !== undefined) {
    const from = keyOf(merging.name)
    return [
      column([
        <Text dimColor>{`merge ${merging.name} into`}</Text>,
        ...active
          .filter(t => keyOf(t.name) !== from)
          .map(t =>
            row([
              dot(t),
              <Button
                key={`threads:merge-into:${keyOf(t.name)}`}
                label={t.name}
                plain
                onPress={async () => {
                  await mergeThreads($, from, keyOf(t.name))
                  await setMenuMode($, 'manage')
                }}
              />,
            ]),
          ),
        <Button key="threads:cancel" label="cancel" plain dimColor onPress={() => setMenuMode($, 'manage')} />,
      ]),
    ]
  }

  const deleting = mode.startsWith('delete:') ? byKey(mode.slice('delete:'.length)) : undefined
  if (deleting !== undefined) {
    const key = keyOf(deleting.name)
    return [
      column([
        <Text>{`delete ${deleting.name}?`}</Text>,
        <Text dimColor>Its messages stay, without its tag.</Text>,
        row([
          <Button
            key="threads:delete-yes"
            label="delete"
            variant="primary"
            onPress={async () => {
              await deleteThread($, key)
              await setMenuMode($, 'manage')
            }}
          />,
          <Button key="threads:cancel" label="cancel" plain dimColor onPress={() => setMenuMode($, 'manage')} />,
        ]),
      ]),
    ]
  }

  // Each thread's merge, archive and delete, the archived threads apart (also where the
  // thread a mode named has gone).
  const actions = (t: Thread) => {
    const key = keyOf(t.name)
    const isArchived = t.isArchived === true
    return [
      !isArchived && active.length > 1 && (
        <Button key={`threads:merge:${key}`} label="merge" plain dimColor onPress={() => setMenuMode($, `merge:${key}`)} />
      ),
      <Button
        key={`threads:${isArchived ? 'unarchive' : 'archive'}:${key}`}
        label={isArchived ? 'unarchive' : 'archive'}
        plain
        dimColor
        onPress={() => setArchived($, key, !isArchived)}
      />,
      <Button key={`threads:delete:${key}`} label="delete" plain dimColor onPress={() => setMenuMode($, `delete:${key}`)} />,
    ]
  }
  return [
    column([
      row([<Text dimColor>threads</Text>, <Button key="threads:done" label="done" plain dimColor onPress={() => setMenuMode($, '')} />]),
      ...(active.length === 0 ? [<Text dimColor>none</Text>] : active.map(t => row([dot(t), <Text>{t.name}</Text>, ...actions(t)]))),
      ...(archived.length === 0
        ? []
        : [<Text dimColor>archived</Text>, ...archived.map(t => row([dot(t), <Text dimColor>{t.name}</Text>, ...actions(t)]))]),
    ]),
  ]
}

// The opacity of the desktop's tint behind the thread picker, as two hex digits added to
// the thread's colour: about 15%, which still shows on a dark theme.
const PICKER_TINT = '26'

// The desktop's tint has the picker's own small rounded corners. Only a border gives a Box
// corners there, so it has one, clear, and that border's padding put back to a little room
// on the left for the dot and none elsewhere, so past the picker the tint shows only the
// border's width, the same on the right as above and below: the desktop sets the height.
const PICKER_TINT_SHAPE = { borderStyle: 'single', borderColor: '#00000000', paddingLeft: 0.5, paddingRight: 0, paddingY: 0 }

// The desktop's mark before the picker, 8px across: a dot of the picked thread's colour,
// or with none a ring in the dimmed text colour. A picture, so the band centres it on the
// picker exactly; a glyph sits wherever its font puts it in the line.
const PICKER_MARK_SIZE = 8
const pickerMarkPicture = (color: string | undefined) =>
  `<svg xmlns="http://www.w3.org/2000/svg" width="8" height="8" viewBox="0 0 8 8">` +
  (color === undefined
    ? '<circle cx="4" cy="4" r="3.5" fill="none" stroke="currentColor" stroke-opacity="0.5"/>'
    : `<circle cx="4" cy="4" r="4" fill="${escapeXml(color)}"/>`) +
  '</svg>'

// Threads' controls in the band: the thread picker after a mark of the picked thread's
// colour, or, with no threads to post to, how to start one. They give way first.
async function drawThreadControls(
  $: EngineInterface,
  e: Parameters<EngineInterface['ui']['resolve']>[0],
): Promise<RenderElement> {
  const list = await read($, threads)
  const active = list.filter(t => t.isArchived !== true)
  const cur = await read($, current)
  const picked = active.find(t => keyOf(t.name) === cur)
  const ui = $.ui.resolve(e)
  const { Box, Text, Button } = ui
  const dot = (t: Thread | undefined) => (t === undefined ? <Text dimColor>○</Text> : <Text color={t.color}>●</Text>)

  if (active.length === 0) {
    return (
      <Box flexDirection="row" alignItems="center" flexShrink={1} minWidth={0}>
        <Text dimColor wrap="truncate-end">
          start a thread with # name
        </Text>
      </Box>
    )
  }

  if (e.surface !== 'mobile') {
    const { Select } = $.ui.resolve(e)
    // The thread messages go to shows in its colour: on the desktop, a dot of it on a
    // light tint of it behind the picker; elsewhere, where a see-through fill may not
    // show, one solid cell of it. With no thread, a hollow dot alone.
    const isDesktop = e.surface === 'desktop'
    // The tint's shape stays with no thread, clear, so picking one moves nothing.
    const tint = isDesktop ? { ...PICKER_TINT_SHAPE, ...(picked !== undefined ? { backgroundColor: picked.color + PICKER_TINT } : {}) } : {}
    let mark: RenderElement
    if (e.surface === 'desktop') {
      const { Svg } = $.ui.resolve(e)
      mark = (
        <Svg
          source={pickerMarkPicture(picked?.color)}
          alt={picked === undefined ? 'No thread' : `${picked.name} thread`}
          width={PICKER_MARK_SIZE}
          height={PICKER_MARK_SIZE}
        />
      )
    } else {
      mark = picked !== undefined ? <Text backgroundColor={picked.color}> </Text> : dot(picked)
    }
    return (
      <Box flexDirection="row" alignItems="center" flexShrink={1} minWidth={0}>
        <Box flexDirection="row" alignItems="center" columnGap={1} flexShrink={0} {...tint}>
          {mark}
          <Select
            key={PICKER}
            options={[...active.map(t => ({ value: THREAD_OPTION + keyOf(t.name), label: t.name })), { value: NO_THREAD, label: 'No thread' }]}
            value={picked === undefined ? NO_THREAD : THREAD_OPTION + keyOf(picked.name)}
            onSelect={value => pickThread($, value.startsWith(THREAD_OPTION) ? value.slice(THREAD_OPTION.length) : '')}
          />
        </Box>
      </Box>
    )
  }

  // The mobile app: a Button that opens the choices in the band, then the threads' actions.
  const isOpen = await read($, pickerOpen)
  const mode = await read($, menuMode)
  const choice = (t: Thread | undefined) => {
    const key = t === undefined ? '' : keyOf(t.name)
    return (
      <Box flexDirection="row" columnGap={1} alignItems="center">
        {dot(t)}
        <Button
          key={t === undefined ? 'picker:none' : `picker:thread:${key}`}
          label={t?.name ?? 'No thread'}
          plain
          {...(t === undefined ? { dimColor: true } : {})}
          onPress={() => pickFromList($, key)}
        />
        {key === cur && <Text dimColor>✓</Text>}
      </Box>
    )
  }
  const choices =
    mode === ''
      ? [
          ...active.map(t => choice(t)),
          choice(undefined),
          <Button key="threads:manage" label="Manage threads" plain dimColor onPress={() => setMenuMode($, 'manage')} />,
        ]
      : drawThreadActions($, { Box, Text, Button }, e.surface, list, mode)
  return (
    <Box flexDirection="row" alignItems="flex-start" flexGrow={1} flexShrink={1} minWidth={0}>
      <Box key={PICKER} flexDirection="column" flexShrink={0}>
        <Box flexDirection="row">
          {dot(picked)}
          <Button
            key="picker:open"
            label={`${picked?.name ?? 'No thread'} ▾`}
            variant={isOpen ? 'primary' : 'secondary'}
            onPress={() => togglePickerOpen($)}
          />
        </Box>
        {isOpen && (
          <Box flexDirection="column" alignItems="flex-start">
            {choices}
          </Box>
        )}
      </Box>
    </Box>
  )
}

// The main conversation's position once a turn of it ended, from the engine's own count
// of its context (a free read), and the rows stored since stamped with it: a thread's
// last message counts from the end of its turn, its own tool output not held against it.
async function noteTurnEnd($: EngineInterface) {
  const usage = await $.session.usage().catch(() => undefined)
  let at = START_POS
  await update($, tokenPos, was => (at = advancedPos(was, usage?.context.tokens)))
  await update($, viewRows, rows => withStamps(rows, at))
}

// The sections the thread view places, every thread's whatever its filter picked, with
// what they were placed from.
async function allEntries($: EngineInterface) {
  const inputs = { ...(await viewInputs($)), shown: [] }
  return { inputs, entries: viewEntries(inputs, viewDeps).entries }
}

// How far each thread has fallen behind the conversation.
async function gapsNow($: EngineInterface) {
  const { inputs, entries } = await allEntries($)
  return threadGaps(entries, inputs.known, await read($, tokenPos), inputs.list)
}

// Tokens of other conversation after which a thread's next message from the person
// catches the agent up on it, and the model that writes the summaries: the settings, as
// `register` last got them.
const CATCH_UP_AFTER = 75_000
const SUMMARY_MODEL = 'claude-haiku-5-5'
// The model tried where the one set is refused (an organisation's list of models may hold
// the alias and not the id).
const FALLBACK_MODEL = 'haiku'
const summaryConfig = { catchUpAfter: CATCH_UP_AFTER, model: SUMMARY_MODEL }

// A summary call to make: a thread's pack (`short`, `long`, `line`), or the one-line
// summaries of the threads turns touched, with those turns' sections of each by its key;
// how many times it has been tried.
type SummaryJob = { kind: 'pack'; key: string; tries: number } | { kind: 'line'; sections: Record<string, string>; tries: number }
// The calls waiting, by what they are for (one per thread's pack, one for the lines), those
// running, and how many may run at once.
const summaryJobs = new Map<string, SummaryJob>()
const summaryRunning = new Set<string>()
const MAX_SUMMARY_CALLS = 2
let isPumpDue = false
// The model refused this run, so the one tried in its place (FALLBACK_MODEL); and why the
// summaries stopped for the rest of the run, both refused.
let modelInUse: string | undefined
let summariesStopped: string | undefined
// The latest calls and what came of them, for `/thread-view trace`.
const summaryLog: string[] = []
const SUMMARY_LOG_KEPT = 16

const jobId = (job: SummaryJob) => (job.kind === 'pack' ? `pack:${job.key}` : 'line')

// Turns' sections of each thread, those of a later turn after an earlier's.
function withSections(earlier: Record<string, string>, later: Record<string, string>): Record<string, string> {
  const all = { ...earlier }
  for (const [key, text] of Object.entries(later)) all[key] = all[key] === undefined ? text : `${all[key]}\n\n${text}`
  return all
}

// A step of the summaries' for the trace, by the engine's clock.
async function noteSummary($: EngineInterface, what: string) {
  const now = await $.clock.now().catch(() => Date.now())
  summaryLog.push(`${new Date(now).toISOString().slice(11, 19)} ${what}`)
  if (summaryLog.length > SUMMARY_LOG_KEPT) summaryLog.shift()
}

// Queues a summary call, in place of one queued for the same thread (the one-line job takes
// in the threads of both); it runs from a timer, never inside the hook that asked for it,
// so no hook waits on it and no turn's Escape cuts it.
function queueSummary($: EngineInterface, job: SummaryJob) {
  const id = jobId(job)
  const queued = summaryJobs.get(id)
  const merged = job.kind === 'line' && queued?.kind === 'line' ? { ...job, sections: withSections(queued.sections, job.sections) } : job
  summaryJobs.set(id, merged)
  pumpSummaries($)
}

function pumpSummaries($: EngineInterface) {
  if (isPumpDue) return
  isPumpDue = true
  $.clock.after(0, () => {
    isPumpDue = false
    for (const [id, job] of summaryJobs) {
      if (summaryRunning.size >= MAX_SUMMARY_CALLS) break
      if (summaryRunning.has(id)) continue
      summaryJobs.delete(id)
      summaryRunning.add(id)
      void runSummary($, job).finally(() => {
        summaryRunning.delete(id)
        if (summaryJobs.size > 0) pumpSummaries($)
      })
    }
  })
}

// What came of a summary call: its text, a failure worth trying again later, or one not.
type SummaryAnswer = { kind: 'text'; text: string } | { kind: 'retry'; why: string } | { kind: 'failed'; why: string }

// What a job asks the summary model: which job and the threads it is for (`keys`), the
// fixed instructions, the request with all it needs, and the cap on the reply. The threads
// are there for a way of asking that keeps something per thread (a cached conversation),
// which would take its new messages from the request.
type SummaryAsk = { what: string; job: SummaryJob['kind']; keys: string[]; system: string; prompt: string; maxTokens: number; timeoutMs?: number }

// How the summary model is asked: one independent call each time, with all it needs (the
// thread's messages, and where they do not fit, its last summary). Every job asks through
// here, so another way of asking replaces this one alone.
const askSummaryModel = ($: EngineInterface, ask: SummaryAsk) => callSummaryModel($, ask)

// One independent call to the summary model: its instructions marked for the prompt cache,
// effort low (its thinking counts against the cap). A model refused is tried once more as
// FALLBACK_MODEL, then the summaries stop for the run; an empty reply is tried once more
// with room for twice the words.
async function callSummaryModel($: EngineInterface, ask: SummaryAsk): Promise<SummaryAnswer> {
  const { what, system, prompt, maxTokens } = ask
  const chars = system.length + prompt.length
  const started = Date.now()
  for (let attempt = 0; attempt < 3; attempt++) {
    const model = modelInUse ?? summaryConfig.model
    let result: Awaited<ReturnType<EngineInterface['model']['complete']>>
    try {
      result = await $.model.complete({
        model,
        system: [{ text: system, cache: true }],
        prompt,
        maxTokens: attempt === 0 ? maxTokens : maxTokens * 2,
        effort: 'low',
        timeoutMs: ask.timeoutMs ?? SUMMARY_TIMEOUT_MS,
      })
    } catch (error) {
      if (modelInUse === undefined && model !== FALLBACK_MODEL) {
        modelInUse = FALLBACK_MODEL
        await noteSummary($, `${what}: model ${model} refused (${String(error)}); trying ${FALLBACK_MODEL}`)
        continue
      }
      summariesStopped = `the model ${model} was refused: ${String(error)}`
      await noteSummary($, `${what}: ${summariesStopped}; summaries stop for this run`)
      return { kind: 'failed', why: summariesStopped }
    }
    const isFailed = !result.isAnswered
    await update($, summaryUsage, all => withUsage(all, result.usage, chars, isFailed))
    const u = result.usage
    const spent = `${tokensText(u.input_tokens)} in, ${tokensText(u.cache_read_input_tokens)} cache read, ${tokensText(u.cache_creation_input_tokens)} cache written, ${tokensText(u.output_tokens)} out, ${((Date.now() - started) / 1000).toFixed(1)}s`
    if (result.isAnswered) {
      await noteSummary($, `${what}: ${spent}`)
      return { kind: 'text', text: result.text }
    }
    if (result.reason === 'empty-reply' && attempt === 0) {
      await noteSummary($, `${what}: empty reply (${spent}); trying with more room`)
      continue
    }
    if (result.reason === 'api-error') {
      const why = `API error ${result.status ?? 'with no response'} (${result.error})`
      if (result.error === 'authentication_failed') {
        summariesStopped = why
        await noteSummary($, `${what}: ${why}; summaries stop for this run`)
        return { kind: 'failed', why }
      }
      await noteSummary($, `${what}: ${why}`)
      return isPassing(result.status, result.error) ? { kind: 'retry', why } : { kind: 'failed', why }
    }
    await noteSummary($, `${what}: ${result.reason}`)
    return { kind: 'failed', why: result.reason }
  }
  return { kind: 'failed', why: 'no answer' }
}

// Runs a summary call; one that failed in passing is queued again after a wait, at most
// RETRY_MS's length of times.
async function runSummary($: EngineInterface, job: SummaryJob) {
  try {
    if (summariesStopped !== undefined || !(await read($, isOn)) || !(await read($, summariesOn))) return
    const answer = job.kind === 'pack' ? await makePack($, job.key) : await makeLines($, job.sections)
    if (answer?.kind !== 'retry') return
    const wait = RETRY_MS[job.tries]
    if (wait === undefined) {
      await noteSummary($, `${jobId(job)}: given up after ${job.tries + 1} tries`)
      return
    }
    $.clock.after(wait, () => queueSummary($, { ...job, tries: job.tries + 1 }))
  } catch (error) {
    await noteSummary($, `${jobId(job)}: threw ${String(error)}`).catch(() => undefined)
  }
}

// Makes a thread's pack from its messages, with the message before and after each from
// elsewhere: from all of them where they fit one call (so it never drifts), else from its
// last summary on, or part by part, each building on the one before. Nothing where it is
// current, or the thread is gone or has no messages.
async function makePack($: EngineInterface, key: string, timeoutMs?: number): Promise<SummaryAnswer | undefined> {
  const { inputs, entries } = await allEntries($)
  const thread = inputs.list.find(t => keyOf(t.name) === key)
  if (thread === undefined) return undefined
  const was = (await read($, summaries))[key]
  const lastRow = entries.findLast(entry => entry.thread !== undefined && keyOf(entry.thread.name) === key)?.id
  if (lastRow === undefined || isCurrent(was, lastRow)) return undefined
  let parts = packParts(entries, key)
  let previous: string | undefined
  const coversRow = was?.coversRow
  if (parts.length > 1 && was?.long !== undefined && coversRow !== undefined && entries.some(entry => entry.id === coversRow)) {
    parts = packParts(entries, key, coversRow)
    previous = was.long
  }
  let made: ReturnType<typeof parsePack> = {}
  for (const [i, part] of parts.entries()) {
    const what = `pack ${thread.name}${parts.length > 1 ? ` (part ${i + 1} of ${parts.length})` : ''}`
    const prompt = packPrompt(thread.name, previous, part)
    const answer = await askSummaryModel($, { what, job: 'pack', keys: [key], system: PACK_SYSTEM, prompt, maxTokens: PACK_MAX_TOKENS, timeoutMs })
    if (answer.kind !== 'text') return answer
    const parsed = parsePack(answer.text)
    if (parsed.short === undefined && parsed.long === undefined) await noteSummary($, `${what}: reply not in parts, kept as it was`)
    made = { ...made, ...parsed }
    previous = parsed.long ?? previous
  }
  if (made.short === undefined && made.long === undefined && made.line === undefined) return { kind: 'failed', why: 'unparsed' }
  const now = await $.clock.now()
  const pos = inputs.known.find(row => row.id === lastRow)?.pos
  const summary: ThreadSummary = {
    ...was,
    name: thread.name,
    ...made,
    coversRow: lastRow,
    ...(pos === undefined ? {} : { coversPos: pos }),
    madeAt: now,
    ...(made.line === undefined ? {} : { lineAt: now }),
  }
  await update($, summaries, all => ({ ...all, [key]: summary }))
  const line = made.line
  if (line !== undefined) await update($, summaryLines, all => ({ ...all, [key]: { line, at: now } }))
  await keepSummaries($)
  return { kind: 'text', text: '' }
}

// A pack's cap on the reply: its three parts, about 1.5k tokens, and room for thinking.
const PACK_MAX_TOKENS = 4000
// How long a summary call may take: one made ahead, and one read_thread waits for.
const SUMMARY_TIMEOUT_MS = 90_000
const READ_TIMEOUT_MS = 30_000

// A one-line call's cap on the reply: a line a thread, and room for thinking.
const LINE_MAX_TOKENS = 1500

// Makes the one-line summaries of the threads turns touched, in one call, from each one's
// line so far and those turns' sections of it; a thread with a pack waiting or being made
// is left to it, which writes its line too.
async function makeLines($: EngineInterface, sections: Record<string, string>): Promise<SummaryAnswer | undefined> {
  const list = await read($, threads)
  const lines = await read($, summaryLines)
  const inputs: (LineInput & { key: string })[] = []
  for (const [key, messages] of Object.entries(sections)) {
    const thread = list.find(t => keyOf(t.name) === key && t.isArchived !== true)
    const packId = `pack:${key}`
    if (thread === undefined || messages.trim() === '' || summaryJobs.has(packId) || summaryRunning.has(packId)) continue
    const line = lines[key]?.line
    inputs.push({ key, name: thread.name, messages, ...(line === undefined ? {} : { line }) })
  }
  if (inputs.length === 0) return undefined
  const what = `lines ${inputs.map(t => t.name).join(', ')}`
  const answer = await askSummaryModel($, {
    what,
    job: 'line',
    keys: inputs.map(t => t.key),
    system: LINE_SYSTEM,
    prompt: linePrompt(inputs),
    maxTokens: LINE_MAX_TOKENS,
  })
  if (answer.kind !== 'text') return answer
  const made = parseLines(answer.text)
  const wanted = new Set(inputs.map(t => t.key))
  const fresh = Object.entries(made).filter(([key]) => wanted.has(key))
  if (fresh.length === 0) {
    await noteSummary($, `${what}: reply held no line, kept as they were`)
    return { kind: 'failed', why: 'unparsed' }
  }
  const now = await $.clock.now()
  await update($, summaryLines, was => ({ ...was, ...Object.fromEntries(fresh.map(([key, line]) => [key, { line, at: now }])) }))
  await update($, summaries, was => {
    const next = { ...was }
    for (const [key, line] of fresh) {
      const name = list.find(t => keyOf(t.name) === key)?.name ?? key
      next[key] = { ...(next[key] ?? { name }), line, lineAt: now }
    }
    return next
  })
  await keepSummaries($)
  return { kind: 'text', text: '' }
}

// Queues the one-line summaries of the threads the turn that just ended touched (its rows
// since the person's last message), and notes the last of them as the active thread.
async function queueTurnLines($: EngineInterface) {
  if (summariesStopped !== undefined || !(await read($, isOn)) || !(await read($, summariesOn))) return
  const stems = new Set((await read($, recent)).map(stemOf))
  const { entries } = await allEntries($)
  const isTurnRow = (id: string) => stems.has(stemOf(id))
  const touched = [
    ...new Set(entries.flatMap(entry => (entry.thread !== undefined && entry.id !== undefined && isTurnRow(entry.id) ? [keyOf(entry.thread.name)] : []))),
  ]
  if (touched.length === 0) return
  const last = touched.at(-1)
  if (last !== undefined) await update($, activeThread, () => last)
  const sections = Object.fromEntries(touched.map(key => [key, turnSectionsOf(entries, key, isTurnRow)]))
  queueSummary($, { kind: 'line', sections, tries: 0 })
}

// The threads' summaries once the threads `gone` are gone (merged away, deleted) and those
// of `changed` (merged into, a message moved into or out of) are to be made again: kept
// meanwhile as made from earlier messages, so the next due pack reads all of the thread's.
async function reviseSummaries($: EngineInterface, gone: readonly string[], changed: readonly string[]) {
  const all = await read($, summaries)
  if (![...gone, ...changed].some(key => all[key] !== undefined)) return
  await update($, summaries, was => {
    const next = { ...was }
    for (const key of gone) delete next[key]
    for (const key of changed) {
      const s = next[key]
      if (s === undefined) continue
      const { coversRow: _row, coversPos: _pos, ...earlier } = s
      next[key] = earlier
    }
    return next
  })
  if (gone.length > 0) await update($, summaryLines, was => Object.fromEntries(Object.entries(was).filter(([key]) => !gone.includes(key))))
  await keepSummaries($)
}

// The file beside a session's rows that keeps its threads' summaries.
const SUMMARIES_FILE = 'summaries.json'

// Keeps the threads' summaries, and what their calls cost, for the session's next run:
// best effort, as for its rows.
async function keepSummaries($: EngineInterface) {
  try {
    const folder = await rowsFolder($, await $.session.id())
    if (folder === undefined) return
    const kept = { summaries: await read($, summaries), usage: await read($, summaryUsage) }
    await $.fs.write(`${folder}/${SUMMARIES_FILE}`, JSON.stringify(kept))
  } catch {
    // kept with the next summary
  }
}

// Takes up the summaries a session's file kept, where this run holds none (a restart, a
// resume); `onlyRows` keeps those made from these rows alone (a rewind or fork keeps
// those of the rows it took).
async function takeKeptSummaries($: EngineInterface, id: string, onlyRows?: ReadonlySet<string>) {
  if (Object.keys(await read($, summaries)).length > 0) return
  const folder = await rowsFolder($, id).catch(() => undefined)
  const text = folder === undefined ? undefined : await $.fs.read(`${folder}/${SUMMARIES_FILE}`).catch(() => undefined)
  if (text === undefined) return
  let kept: { summaries?: unknown; usage?: unknown }
  try {
    kept = JSON.parse(text) as { summaries?: unknown; usage?: unknown }
  } catch {
    return
  }
  const all = Object.fromEntries(
    Object.entries(summariesOf(kept.summaries)).filter(([, s]) => onlyRows === undefined || (s.coversRow !== undefined && onlyRows.has(s.coversRow))),
  )
  if (Object.keys(all).length === 0) return
  await update($, summaries, () => all)
  await update($, summaryLines, () =>
    Object.fromEntries(Object.entries(all).flatMap(([key, s]) => (s.line === undefined ? [] : [[key, { line: s.line, at: s.lineAt ?? s.madeAt ?? 0 }]]))),
  )
}

// Queues the packs due: as a turn ends, each thread (not archived) near catching up, or
// past it, whose pack is not current; as a compaction starts (`isEvery`), each whose pack
// is not current, as every thread will be past catching up once it is done. While threads
// and their summaries are on.
async function queueDuePacks($: EngineInterface, isEvery = false) {
  if (summariesStopped !== undefined || !(await read($, isOn)) || !(await read($, summariesOn))) return
  const all = await read($, summaries)
  const list = await read($, threads)
  const isArchived = new Set(list.filter(t => t.isArchived === true).map(t => keyOf(t.name)))
  for (const gap of await gapsNow($)) {
    const isDue = isEvery || isPackDue(gap, summaryConfig.catchUpAfter)
    if (isArchived.has(gap.key) || !isDue || isCurrent(all[gap.key], gap.lastRow)) continue
    queueSummary($, { kind: 'pack', key: gap.key, tries: 0 })
  }
}

const READ_TOOL = 'mcp__thread-chat__read_thread'
const READ_SPEC = {
  name: 'read_thread',
  description:
    "Read a conversation thread's history: a summary of its earlier discussion and its latest messages verbatim. Use it to catch up on a thread you have lost track of.",
  inputSchema: {
    type: 'object',
    properties: { thread: { type: 'string', description: "The thread's name" } },
    required: ['thread'],
  },
  // in the tools the model is sent from the start, so the list never changes mid-session
  isDeferred: false,
}

// Offers the agent read_thread; the catch-up notes name it only once it is offered.
async function offerReadTool($: EngineInterface) {
  try {
    await $.tool.register(READ_SPEC)
    await update($, readToolOffered, () => true)
  } catch {
    // the notes carry the thread's messages instead
  }
}

// What the agent is told beside the person's message of the threads it goes to (`names`)
// that are past catching up: a note each for the first three, a pointer for any more.
// While threads and their summaries are on.
async function catchUpNotes($: EngineInterface, names: readonly string[]): Promise<string[]> {
  if (names.length === 0 || !(await read($, summariesOn))) return []
  const { inputs, entries } = await allEntries($)
  const gaps = threadGaps(entries, inputs.known, await read($, tokenPos), inputs.list)
  const keys = new Set(names.map(keyOf))
  const behind = gaps.filter(g => keys.has(g.key) && isPast(g, summaryConfig.catchUpAfter))
  if (behind.length === 0) return []
  const all = await read($, summaries)
  const tool = (await read($, readToolOffered)) ? READ_TOOL : undefined
  return [...behind.slice(0, MAX_NOTES).map(g => catchUpNote(g, all[g.key], entries, tool)), ...behind.slice(MAX_NOTES).map(g => catchUpPointer(g, tool))]
}

const MAX_NOTES = 3

// What read_thread answers for the thread a name means (as a heading would mean it): its
// summary and its messages since, made now (within READ_TIMEOUT_MS) where it has no current
// one and more messages than are told whole, while its summaries are on.
async function readThread($: EngineInterface, raw: unknown): Promise<string> {
  const typed = typeof raw === 'string' ? nameOf(raw.replace(/^#+/, '')) : ''
  if (typed === '') return 'Name the thread to read: {"thread": "<name>"}.'
  const list = await read($, threads)
  const links = linksFor(await read($, aliases), await read($, deleted), await read($, snaps))
  const thread = threadOf(resolveHeading(typed, list, links), list, links)
  if (thread === undefined) return `No thread is named "${typed}". Threads: ${list.map(t => `"${t.name}"`).join(', ') || 'none'}.`
  const key = keyOf(thread.name)
  const { inputs, entries } = await allEntries($)
  const gap = threadGaps(entries, inputs.known, await read($, tokenPos), inputs.list).find(g => g.key === key)
  let summary = (await read($, summaries))[key]
  const lastRow = entries.findLast(entry => entry.thread !== undefined && keyOf(entry.thread.name) === key)?.id
  const isLong = verbatimOf(entries, key, summary?.coversRow, TOOL_TAIL_CHARS).isCut
  if (!isCurrent(summary, lastRow) && isLong && summariesStopped === undefined && (await read($, summariesOn))) {
    await makePack($, key, READ_TIMEOUT_MS)
    summary = (await read($, summaries))[key]
  }
  return readThreadText(thread.name, key, gap, summary, entries)
}

// Where the threads stand for their summaries, for `/thread-view trace`.
async function summaryTraceText($: EngineInterface): Promise<string> {
  const { catchUpAfter } = summaryConfig
  const at = await read($, tokenPos)
  const gaps = await gapsNow($)
  const all = await read($, summaries)
  const head =
    `Thread summaries: token position ${tokensText(at.pos)}` +
    `${at.last === undefined ? ', no context reading yet' : `, context ${tokensText(at.last)}`}` +
    `, ${at.epoch} compaction${at.epoch === 1 ? '' : 's'}; catch up after ${tokensText(catchUpAfter)}`
  const stateOf = (key: string, lastRow: string | undefined) => {
    const s = all[key]
    if (s?.short === undefined && s?.long === undefined) return ''
    return isCurrent(s, lastRow) ? '; summary current' : '; summary of an earlier message'
  }
  return [
    head,
    ...gaps.map(
      g =>
        `  ${g.name}: ${tokensText(g.gap)} since its last message${g.isCompacted ? ', compacted since' : ''}` +
        `${isPast(g, catchUpAfter) ? ', past catching up' : ''}${stateOf(g.key, g.lastRow)}` +
        `${all[g.key]?.line === undefined ? '' : `\n    ${all[g.key]?.line}`}`,
    ),
    `  model ${modelInUse ?? summaryConfig.model}; ${usageText(await read($, summaryUsage))}` +
      `${(await read($, summariesOn)) ? '' : '; off in this chat'}${(await read($, readToolOffered)) ? '; read_thread offered' : ''}`,
    ...(summariesStopped === undefined ? [] : [`  stopped: ${summariesStopped}`]),
    ...(summaryJobs.size + summaryRunning.size === 0 ? [] : [`  calls running: ${[...summaryRunning].join(', ') || 'none'}; waiting: ${[...summaryJobs.keys()].join(', ') || 'none'}`]),
    ...summaryLog.map(line => `  ${line}`),
  ].join('\n')
}

// A number setting as `register` gets it, or its default where unset or not a number.
const numberOption = (value: unknown, fallback: number) => (typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : fallback)

export const register: Register = (on, options) => {
  summaryConfig.catchUpAfter = numberOption(options.catchUpAfter, CATCH_UP_AFTER)
  summaryConfig.model = typeof options.summaryModel === 'string' && options.summaryModel.trim() !== '' ? options.summaryModel.trim() : SUMMARY_MODEL

  on('session.start', async ($, e, next) => {
    await $.command.register({ name: 'threads', description: 'Turn conversation threads on or off in this chat' })
    await $.command.register({ name: VIEW, description: 'Read the threads you pick, without tool rows, in a pane' })
    // A restarted or resumed session takes up the rows its thread view kept; a reloaded
    // one, which holds its rows, the pictures' files noted in them since.
    if ((await read($, viewRows)).length === 0) {
      const kept = await keptRows($, await $.session.id()).catch(() => [])
      if (kept.length > 0) await update($, viewRows, () => kept)
    } else {
      await takeKeptPaths($, await $.session.id())
    }
    await $.command.register({
      name: 'merge-threads',
      description: 'Merge one conversation thread into another',
      argumentHint: '<thread> into <thread>',
    })

    // Threads held by an earlier version of this mod lack fields this one draws, or carry
    // its filter's pick: the one thread it picked alone is this version's picked thread.
    const held = await read($, threads)
    if (held.length > 0) {
      const picked = pickedByFilter(held)
      if (picked !== '' && (await read($, current)) === '') await update($, current, () => picked)
      await update($, threads, list => list.map(cleanThread))
    }

    // A restarted, resumed or reloaded session takes up the threads it kept, joined to
    // any it holds; a rewound or forked one, which starts under a new id with no record
    // of its own, those of the session it came from, and that session's view rows up
    // to where it was rewound.
    const id = await $.session.id()
    let saved = (await $.store.get(storeKey(id))) as Partial<Saved> | undefined
    let taken: ViewRow[] = []
    if (saved === undefined) {
      // Best effort: a session whose messages or store cannot be read starts empty.
      const parent = await parentOf($, id).catch(() => undefined)
      if (parent !== undefined) {
        saved = (await $.store.get(storeKey(parent))) as Partial<Saved> | undefined
        const rows = (await read($, viewRows)).length === 0 ? await keptRows($, parent).catch(() => []) : []
        if (rows.length > 0) {
          taken = rowsUpTo(rows, await $.session.messages().catch(() => []))
          await update($, viewRows, () => taken)
          // its threads' summaries made from the rows it took
          await takeKeptSummaries($, parent, new Set(taken.map(row => row.id)))
        }
      }
    } else {
      await takeKeptSummaries($, id)
    }
    if (saved?.threads !== undefined) await takeUp($, saved)
    // Threads held on (a reload) stay on; else they are as the session, or the one it
    // came from, kept them. A record kept before /threads, or none, is on where it used them.
    if (!(await read($, isOn)) && (saved?.isOn ?? (await wasInUse($)))) await update($, isOn, () => true)
    // The agent and filter switches are as the record kept them (each flip keeps them, so
    // a reload's held ones match it); a record without them leaves them as they stand.
    const keptMayCreate = saved?.agentMayCreate
    if (keptMayCreate !== undefined) await update($, agentMayCreate, () => keptMayCreate)
    const keptFilters = saved?.filtersChat
    if (keptFilters !== undefined) await update($, filtersChat, () => keptFilters)
    const keptSummariesOn = saved?.summariesOn
    if (keptSummariesOn !== undefined) await update($, summariesOn, () => keptSummariesOn)
    const keptLineShown = saved?.summaryLineShown
    if (keptLineShown !== undefined) await update($, summaryLineShown, () => keptLineShown)
    const keptActive = saved?.activeThread
    if (keptActive !== undefined && (await read($, activeThread)) === '') await update($, activeThread, () => keptActive)
    // With threads and the agent switch on, after a reload or a restart, its tool is offered again.
    if ((await read($, isOn)) && (await read($, agentMayCreate))) await offerCreateTool($)
    // read_thread is offered as a run starts with threads and their summaries on, never
    // later, so the tools the model is sent stay the same all session (a change would have
    // the main model write its whole prompt cache again); a reload offers it again.
    const isReload = await read($, hasStarted)
    const isReadDue = !isReload && (await read($, isOn)) && (await read($, summariesOn))
    if ((await read($, readToolOffered)) || isReadDue) await offerReadTool($)
    await update($, hasStarted, () => true)
    // Rows kept by an earlier version count from now: none is past catching up at once.
    const at = await read($, tokenPos)
    await update($, viewRows, rows => withStamps(rows, at))
    // A session with threads on keeps the rows it took up from the one it came from;
    // one with them off keeps none on disk. Its record is saved all the same: it stops
    // its next run looking for a session it came from.
    if (taken.length > 0 && (await read($, isOn))) await keepViewRows($, id, taken)
    await save($)

    return next(e)
  })

  on('command.run', { command: 'threads' }, async $ => {
    const now = await flipThreads($)
    return {
      text: now
        ? 'Threads are on: start or reply to one with a # name heading (or + thread in the desktop app).'
        : 'Threads are off. They are kept for when /threads turns them on again.',
    }
  })

  on('prompt.submit', async ($, e, next) => {
    if (!PERSON.has(e.origin.kind)) return next(e)
    // Off, the message goes on as it came, its headings plain text; the model told how
    // threads work is told they are off, once.
    if (!(await read($, isOn))) {
      const off = await offNote($)
      return off === undefined ? next(e) : next({ ...e, context: [...(e.context ?? []), off] })
    }
    // The text goes on as typed, the one version everything reads; what its
    // headings mean is decided now, kept for drawing it, and told to the model.
    // Messages the person moved between threads since they last wrote go beside this
    // one, after how threads work and where they stand, when the model is to be told.
    const told = await read($, untold)
    if (told.length > 0) await update($, untold, () => [])
    // The threads it goes to (`to`) that the agent has likely lost track of are caught up on.
    const send = async (notes: string[], to: readonly string[] = []) => {
      const all = [...(await briefing($)), ...told, ...notes, ...(await catchUpNotes($, to).catch(() => []))]
      return all.length === 0 ? next(e) : next({ ...e, context: [...(e.context ?? []), ...all] })
    }

    const merged = await read($, aliases)
    const links = linksFor(merged, await read($, deleted), await read($, snaps))
    const list = await read($, threads)
    const { names, last, meanings } = decideHeadings(e.text, list, links, merged)
    if (names.length === 0) {
      // A reply to parts of earlier replies goes to the thread they came from, even
      // while another is picked: the person pointed at that thread's text.
      const quoted = await quotedThreadOf($, replyQuotesOf(e.text), list)
      if (quoted !== undefined) {
        unsent.push({ text: e.text.trim(), key: keyOf(quoted.name) })
        return send(
          [
            `This message belongs to the thread "${quoted.name}": the user replied to part of your message in that thread, so your reply most likely belongs under that thread's heading.`,
          ],
          [quoted.name],
        )
      }
      // With a thread picked above the prompt, a message with no heading goes to it.
      const cur = await read($, current)
      const picked = cur === '' ? undefined : list.find(t => keyOf(t.name) === cur && t.isArchived !== true)
      if (picked === undefined) return send([])
      unsent.push({ text: e.text.trim(), key: keyOf(picked.name) })
      return send(
        [
          `This message belongs to the thread "${picked.name}": the user posted it there with their thread picker, so your reply most likely belongs under that thread's heading.`,
        ],
        [picked.name],
      )
    }
    await addThreads($, names, 'user')
    // The picker follows the thread of the message's last heading, so the person's next
    // message with no heading goes on in it.
    if (last !== undefined) await update($, current, () => keyOf(last))
    const decided = linksOf(meanings)
    if (Object.keys(decided).length > 0) await update($, snaps, all => ({ ...all, ...decided }))
    await save($)
    if (meanings.length === 0) return send([], names)

    return send([`Thread headings in this message, as the user meant them: ${meanings.map(meaningNote).join('; ')}.`], names)
  })

  // A message sent with no heading to one thread is known by its row once stored, and the
  // rows since the person's last message are noted: a filtered chat still shows those of
  // them that belong to no thread.
  on('session.append', async ($, e, next) => {
    const isPersonMessage = PERSON.has(e.origin.kind) && (e.door === 'prompt' || e.door === 'delivery')
    if (e.agentId === undefined) {
      const ids = [e.uuid, ...toolCallIds(e.message.content)]
      await update($, recent, all => (isPersonMessage ? ids : [...all, ...ids]))
      const marks = e.message.type === 'assistant' ? textMarksOf(e.message.content) : []
      if (isPersonMessage || marks.length > 0) await update($, recentTexts, all => (isPersonMessage ? [] : [...all, ...marks]))
    }
    if (e.agentId === undefined && isPersonMessage && unsent.length > 0) {
      const said = textOf(e.message.content)
      const sent = unsent.findIndex(u => said.includes(u.text))
      const key = sent >= 0 ? unsent.splice(sent, 1)[0]?.key : undefined
      if (key !== undefined) await update($, sentTo, all => ({ ...all, [e.uuid]: key }))
    }
    // The thread view learns a person's message or a reply's text, as stored, with
    // its text: its record of the transcript, which no compaction rewrites. It draws
    // again with it. A row whose append was refused is not kept; one whose store
    // failed is noted all the same (the screen may show it already).
    let stored: Awaited<ReturnType<typeof next>> | undefined
    try {
      stored = await next(e)
      return stored
    } finally {
      const kept = stored?.message === undefined ? e : { ...e, message: stored.message }
      const row = stored?.deny === undefined ? viewRowOf(kept, PERSON) : undefined
      if (row !== undefined) {
        await update($, viewRows, all => withViewRow(all, row))
        // A new message keeps the thread view at its end, unless the person scrolled up.
        if (viewPlace === 'end') void pinViewToEnd($)
      }
      // The pictures pasted with a person's message are known by the files Claude Code
      // saved them to, which a hidden row after it names.
      if (row?.role === 'user') awaitingPaths = row.images === undefined ? undefined : row.id
      const paths = stored?.deny === undefined && awaitingPaths !== undefined ? imagePathsOf(kept) : undefined
      if (paths !== undefined && awaitingPaths !== undefined) {
        const id = awaitingPaths
        awaitingPaths = undefined
        await update($, viewRows, all => withImagePaths(all, id, paths))
      }
      // The view shows a turn's last reply: those a tool call follows in its turn are interim.
      if (e.agentId === undefined && stored?.deny === undefined) {
        if (e.message.type === 'user' && e.door === 'prompt') turnReplies = new Set()
        if (row?.role === 'assistant' && row.interim !== true) turnReplies.add(row.id)
        if (e.message.type === 'assistant' && hasToolCall(e.message.content)) {
          const ids = turnReplies
          turnReplies = new Set()
          if (ids.size > 0) await update($, viewRows, all => withInterim(all, ids))
        }
      }
    }
  })

  // A turn's rows are kept for the session's next run as the turn ends, while threads
  // are on: all of them then, those from before they came on too.
  on('turn.complete', async ($, e, next) => {
    const result = await next(e)
    if (e.agentId === undefined) {
      turnReplies = new Set()
      await noteTurnEnd($)
    }
    if (e.agentId === undefined && (await read($, isOn))) {
      if ((await read($, threads)).length > 0) await save($)
      const id = await $.session.id()
      // pictures' files a repair noted in the kept rows since are kept, not written over
      await takeKeptPaths($, id)
      const rows = await read($, viewRows)
      if (rows.length > 0) await keepViewRows($, id, rows)
      // threads near catching up get their summaries made ahead, and those the turn touched
      // their one-line summaries
      await queueDuePacks($)
      await queueTurnLines($)
    }
    return result
  })

  on('command.run', { command: VIEW }, async ($, e) => {
    if (e.args.trim() === 'trace') return { text: `${viewTraceText()}\n\n${await summaryTraceText($)}` }
    if (!(await read($, isOn))) return { text: OFF_TEXT }
    const opened = await openView($)
    return { text: opened.isPlaced ? 'Thread view opened.' : `Thread view not shown: ${opened.reason}` }
  })

  // Where the thread view's window was last moved to, by the person or by this plugin:
  // at or near its end, new messages keep it there. This plugin's move back to a row
  // goes to that row; a move of the person's drops any still to come. The surface's own
  // move as it draws a shorter view at its end goes to the end: the engine, keeping to
  // the end, would take it on from the new end, as far again above it, and stop there.
  // Earlier sections drawn above the window push what it showed down, as many pixels down
  // as the desktop keeps it: the next move, this plugin's or the person's, once the surface
  // has said the rows they added, goes down by them. The person near the top of what is
  // drawn has earlier sections drawn; scrolled up elsewhere, what is drawn stays.
  on('ui.scroll', { component: 'Pane', requestId: VIEW }, async ($, e, next) => {
    const isMine = e.origin.kind === 'plugin' && e.origin.name === $.plugin.name
    const isPerson = e.origin.kind === 'person'
    const isRedraw = isRedrawMove(e)
    const growth = viewGrowth
    const isKeeping = isMine && viewKeeping && e.offset === 0
    const kept = isKeeping && growth !== undefined ? keptMoveOf(growth, e) : undefined
    if (isKeeping && kept === undefined) {
      // kept already, or the window cannot move: the view fitted it, and its end shows
      // what it showed
      if (growth !== undefined) {
        viewGrowth = undefined
        void pinViewToEnd($)
      }
      return { deny: 'no move to keep the window where it was' }
    }
    if (isPerson && growth !== undefined && !growth.isDrawn) growth.rows = e.contentRows
    const grown = isPerson && !isRedraw && growth?.isDrawn === true ? grownOffsetOf(growth, e.offset, e.contentRows) : undefined
    const move = isRedraw
      ? { ...e, offset: Math.max(0, e.contentRows - e.bodyRows) }
      : kept !== undefined
        ? { ...e, offset: kept.offset }
        : grown !== undefined
          ? { ...e, offset: grown }
          : isMine && viewReturning !== undefined && e.offset === 0
            ? { ...e, offset: viewReturning }
            : e
    if (isPerson) viewChangeUndrawn = undefined
    if (isPerson && !isRedraw) {
      personMoves += 1
      viewReturn = undefined
    }
    const result = await next(move)
    if (result.deny === undefined) {
      const isKept = (kept !== undefined && kept.nudge === 0) || grown !== undefined
      if (kept !== undefined && kept.nudge !== 0 && growth !== undefined) growth.nudge += kept.nudge
      else viewPlace = viewPlaceOf(move)
      if (isKept) viewKeptAt = Date.now()
      if (viewGrowth === growth && isKept) viewGrowth = undefined
    }
    if (growth !== undefined && (kept !== undefined || grown !== undefined)) {
      const how = kept === undefined ? 'kept on the person\'s move' : kept.nudge === 0 ? 'kept' : 'nudged'
      const denied = result.deny === undefined ? '' : `, denied (${result.deny})`
      noteView(`window ${how}: ${e.contentRows} rows (were ${growth.rows}), to ${move.offset}${denied}`)
    }
    viewContentRows = move.contentRows
    if (isPerson && !isRedraw && result.deny === undefined) {
      if (viewPlace !== 'end') void holdViewFrom($)
      if (e.by < 0 && move.offset <= e.bodyRows) void showEarlier($, move.contentRows)
    }
    return result
  })

  // What the thread view shows changed: kept at its end as a surface draws it.
  on('state.set', { plugin: 'thread-chat' }, async ($, e, next) => {
    const result = await next(e)
    if (VIEW_KEYS.has(e.key)) noteViewChange($)
    return result
  })

  // The thread view: the sections of the threads its filter picked, their tags and a reply's
  // borders drawn by the code that draws the chat's. Its only Clients are its filter's hit
  // areas, one per thread: a pane of many rows must not add a Client per row to those every
  // overlay on the desktop shares. A failure to draw it says so in the pane: else the
  // engine draws its own, an empty pane.
  on('ui.render', { component: 'Pane', requestId: VIEW }, async ($, e) => {
    const { step, end } = traceView(`began: ${e.surface}, window at ${e.props.scroll?.offset} of ${e.props.scroll?.bodyRows} rows`)
    try {
      settleView($, e.props.scroll.offset, e.props.scroll.bodyRows)
      // drawn again as the pictures it waits for are read
      const read_ = await read($, picturesRead)
      step(`pictures read so far: ${read_}`)
      const inputs = await viewInputs($, step)
      // the newest sections, or from the first the person had drawn as they scrolled up
      const from = await read($, viewFrom)
      const near = viewNearOf(e.props.scroll.offset, e.props.scroll.bodyRows)
      // the threads' one-line summaries while they are on, which the pointer on a tag shows;
      // read here, so a new line draws the view again
      const lines = (await read($, summariesOn)) ? await read($, summaryLines) : {}
      const now = await $.clock.now().catch(() => Date.now())
      const summaryOf = (key: string) => {
        const made = lines[key]
        return made === undefined ? undefined : { line: made.line, age: ageText(now - made.at) }
      }
      const { tree: drawn, span } = drawView(
        {
          surface: e.surface,
          ui: $.ui.resolve(e),
          markdown: text => drawMarkdown($, e, text),
          // the chat's tags without its move button: the picker it opens is the chat's row's
          tagRow: thread => drawTagRow($, e, [drawTag($, e, thread, isOnRightOf(e.surface) ? 'end' : 'start')]),
          tag: (thread, alt) => drawTag($, e, thread, 'start', 0, alt),
          // its text is markdown, so its tag is not inset, as on the chat's markdown parts
          threadPart: (thread, body) => drawThreadPart($, e, thread, drawTag($, e, thread, 'start'), body),
          picture: image => pictureFor($, image),
          near,
          from: from ?? undefined,
          showEarlier: () => void showEarlier($, viewContentRows),
          toggleShown: key => void toggleViewThread($, key),
          filterHit: e.surface === 'desktop' ? filterHitOf($.ui.resolve(e)) : undefined,
          summaryOf,
          // to set a summary's card above its tag, inside the pane
          columns: e.props.bodyColumns,
          tagWidth: thread => tagWidth(thread.name.toUpperCase(), CHAT_TAG_SIZE),
        },
        inputs,
        viewDeps,
      )
      viewSpan = span
      // earlier sections drawn above the window: once the surface has drawn them, the window
      // is kept off them
      const growth = viewGrowth
      if (growth !== undefined && !growth.isDrawn && span.from < growth.from) {
        growth.isDrawn = true
        $.clock.after(VIEW_SETTLE_MS, () => void keepViewPlace($))
      }
      const { cards, filled, chars } = picturesIn(drawn)
      end(
        `returned a ${(drawn as { type?: string }).type ?? 'tree'} near ${near.toFixed(2)} of sections ${span.from} on of ${span.count}: ` +
          `${cards} picture cards, ${filled} with ${chars} characters of picture data`,
      )
      return drawn
    } catch (error) {
      end(`threw ${String(error)}`)
      return drawViewFailure($.ui.resolve(e), error)
    }
  })

  on('command.run', { command: 'merge-threads' }, async ($, e) => {
    if (!(await read($, isOn))) return { text: OFF_TEXT }
    const [fromText, toText] = e.args.split(/\s+into\s+/i).map(part => nameOf(part.replace(/^#+/, '')))
    if (!fromText || !toText) return { text: 'Usage: /merge-threads <thread> into <thread>' }

    const list = await read($, threads)
    const keys = list.map(t => keyOf(t.name))
    const from = list.find(t => keyOf(t.name) === closestThread(fromText, keys))
    const to = list.find(t => keyOf(t.name) === closestThread(toText, keys))
    if (from === undefined || to === undefined || from === to) {
      return { text: `Could not tell which threads to merge. Threads: ${list.map(t => t.name).join(', ') || 'none'}.` }
    }

    await mergeThreads($, keyOf(from.name), keyOf(to.name))
    return { text: `Merged thread "${from.name}" into "${to.name}": "# ${from.name}" now means "${to.name}".` }
  })

  // Threads are of the main conversation, whose text alone is sorted into them. A
  // subagent's call, or one from the engine's hidden forks (a prompt suggestion, a
  // memory extraction) that are offered the main loop's tools, carries its loop's
  // agentId and is refused: the engine's own refusal of a fork's call lies beneath
  // next(e), which this hook, answering itself, never calls.
  // read_thread, offered as a run starts with threads and their summaries on: for the main
  // conversation alone, as create_thread is, so no hidden fork has a summary made.
  on('tool.call', { tool: READ_TOOL }, async ($, e) => {
    if (e.agentId !== undefined) return { deny: 'Only the main conversation reads threads; this call came from another agent.' }
    if (!(await read($, isOn))) return { deny: 'The user turned conversation threads off.' }
    return { result: await readThread($, (e as { thread?: unknown }).thread) }
  })

  on('tool.call', { tool: 'mcp__thread-chat__create_thread' }, async ($, e) => {
    if (e.agentId !== undefined) {
      return { deny: 'Only the main conversation starts threads; this call came from another agent.' }
    }
    if (!(await read($, isOn))) return { deny: 'The user turned conversation threads off. Do not start threads.' }
    if (!(await read($, agentMayCreate))) {
      return { deny: 'The user has not enabled agent-created threads. Reply in existing threads only.' }
    }
    const raw = (e as { name?: unknown }).name
    const name = typeof raw === 'string' ? nameOf(raw.replace(/^#+/, '')) : ''
    if (name === '' || name.length > 48) {
      return { deny: 'Give the thread a short name (1-48 characters).' }
    }
    await addThreads($, [name], 'agent')
    await save($)
    return { result: `Thread "${name}" exists. Write to it under the heading "# ${name}".` }
  })

  // A compaction may summarise how threads work away: the model is told again beside
  // the person's next message. Every thread is then past catching up.
  on('session.compact', async ($, e, next) => {
    // A compaction of the main conversation starting (not a precompute, whose timing is the
    // engine's own): the threads' summaries are made meanwhile, ready as it ends. Queued, not
    // awaited: the compaction does not wait on them.
    if (e.agentId === undefined && e.trigger !== 'precompute') await queueDuePacks($, true).catch(() => undefined)
    const result = await next(e)
    const isCompacted = e.agentId === undefined && e.trigger !== 'precompute' && result.skip === undefined
    if (isCompacted) {
      await update($, tokenPos, compactedPos)
      const wasBriefed = (await read($, briefed)) !== null
      if (wasBriefed) await update($, briefed, () => null)
      if (wasBriefed || (await read($, isOn))) await save($)
    }
    return result
  })

  // The menu's switches, the thread view's filter and the one open move picker's pills post
  // here when clicked: the only Clients, so their count stays a few times the threads'.
  on('ui.message', async ($, e, next) => {
    if ((e.data as { flip?: unknown } | null)?.flip !== true) return next(e)
    if (e.element.startsWith(SWITCH_HIT)) await flipMenuSwitch($, e.element.slice(SWITCH_HIT.length))
    else if (e.element.startsWith(FILTER_THREAD_KEY)) await toggleViewThread($, e.element.slice(FILTER_THREAD_KEY.length))
    else if (await read($, isOn)) {
      if (e.element.startsWith('pick:')) await moveTo($, e.element.slice('pick:'.length))
      else if (e.element === NEW_THREAD_PILL) await setNaming($, true)
    }
    return next(e)
  })

  // The person's message stays the engine's own drawing (its images and all):
  // its thread tags go above it in their colours, and its heading lines go. A filtered
  // chat trims its text to the filtered thread's sections.
  on('ui.render', { component: 'UserMessage' }, async ($, e, next) => {
    // Off, every message is the engine's drawing alone, filtered before or not.
    if (!(await read($, isOn))) return next(e)
    // A plugin's prompt is never the person's, though a surface may name it as theirs.
    // A row of no words (an image alone) is the engine's drawing alone: no tag or
    // "+ thread" goes round it.
    if (!PERSON.has(e.props.origin.kind) || isOthersPrompt(e.props.text) || e.props.text.trim() === '') {
      // Another party's message (a notification, a plugin's) belongs to no thread.
      if (!(await isFilteredOut($, [e.requestId]))) return next(e)
      const { Box } = $.ui.resolve(e)
      return <Box display="none" />
    }
    const list = await read($, threads)
    const merged = await read($, aliases)
    const snapped = await read($, snaps)
    const gone = await read($, deleted)
    const links = linksFor(merged, gone, snapped)
    const resolve = (name: string) => personThreadOf(name, list, links)
    const typed = personSectionsOf(e.props.text, list, snapped, merged, gone)
    // A message with no heading may have gone to the thread picked as it was sent.
    const sentThread = typed.some(s => s.thread !== null) ? undefined : await sentThreadOf($, e.requestId, list, merged)
    const sent = sentThread === undefined ? typed : [{ thread: sentThread.name, text: e.props.text }]
    const moves = await read($, moved)
    const sections = sent.map(s => placeSection(s, e.requestId, moves, resolve, list, linksFor(merged, gone)))
    const open = await read($, picking)
    const isNaming = await read($, naming)
    const pickerPlace = open.startsWith(`${e.requestId}|`) ? open.slice(e.requestId.length + 1) : undefined
    // On the desktop, a message of no thread offers "+ thread" where the pointer hovers.
    const canAdd = e.surface === 'desktop'
    const selected = await chatFilterKeys($)
    const isPlain = selected.size === 0 && !sections.some(s => s.thread !== null) && pickerPlace === undefined
    // A message of no thread is the engine's drawing alone, but for a deleted thread's
    // heading line, which goes.
    if (isPlain && !canAdd) {
      const text = bubbleText(sections, resolve) || e.props.text
      return next(text.trim() === e.props.text.trim() ? e : { ...e, props: { ...e.props, text } })
    }

    const { Box } = $.ui.resolve(e)
    const isRecentRow = selected.size > 0 && (await isRecent($, [e.requestId]))
    const shown = sections.filter(s => isShown(s, selected, resolve, isRecentRow))
    if (shown.length === 0) return <Box display="none" />
    const text = bubbleText(shown, resolve) || e.props.text
    const message = await next(text === e.props.text ? e : { ...e, props: { ...e.props, text } })
    // A row a plugin beneath draws as nothing stays nothing: no tag or "+ thread" round it.
    if (isBlank(message)) return message

    const tags = [
      ...new Map(
        shown.flatMap(s => {
          const thread = s.thread === null ? undefined : resolve(s.thread)
          return thread === undefined ? [] : [[keyOf(thread.name), thread] as const]
        }),
      ).values(),
    ]
    const hasPlain = shown.some(s => s.thread === null)
    for (const t of tags) glimpses.set(`${e.requestId}|${keyOf(t.name)}`, `their message "${glimpseOf(text)}"`)
    if (hasPlain) glimpses.set(`${e.requestId}|`, `their message "${glimpseOf(text)}"`)
    // Where the surface puts the person's messages on the right, the tags go there too.
    const align = isOnRightOf(e.surface) ? 'end' : 'start'
    // "+ thread" shows in the tags' row, in the flow: placed over the message instead,
    // it lands on the bubble wherever no tag holds a row above it.
    const add = hasPlain && canAdd ? drawAddThread($, e, align) : undefined
    // An open move picker takes the place of "+ thread" in that row, beside the tags;
    // its pills are taller than ADD_ROW's one fixed row, so the row grows to hold them.
    const picker = pickerPlace === undefined ? undefined : drawPicker($, e, list, pickerPlace, align, isNaming)
    const side = picker ?? add
    const rowFit = picker !== undefined ? { alignItems: 'center' as const } : add !== undefined ? ADD_ROW : {}

    return (
      <Box key="message" flexDirection="column">
        {(tags.length > 0 || side !== undefined) &&
          drawTagRow($, e, tags.map(t => drawMovableTag($, e, t, align)), side, rowFit)}
        {message}
      </Box>
    )
  })

  // A reply is drawn a section at a time by the engine, as it draws any reply;
  // each thread's section sits in a box of its colour under its name.
  on('ui.render', { component: 'AssistantMessage' }, async ($, e, next) => {
    // The thread view finds the person's moves of this reply's parts by the id the
    // screen draws it under, matched by its whole text before it is split.
    noteDrawnReply(e.requestId, e.props.text)
    // Off, a reply is the engine's drawing alone: no tags, no "+ thread" or room for one.
    if (!(await read($, isOn))) return next(e)
    // The voice's "(quiet)" (the multitask plugin draws it as nothing) and a block of no
    // words are the engine's drawing alone: no "+ thread", or room for one, round nothing.
    if (isBlankText(e.props.text)) {
      const isHidden = (await chatFilterKeys($)).size > 0 && !(await isRecentReply($, e.requestId, e.props.text))
      if (!isHidden) return next(e)
      const { Box } = $.ui.resolve(e)
      return <Box display="none" />
    }
    const list = await read($, threads)
    const merged = await read($, aliases)
    const gone = await read($, deleted)
    const selected = await chatFilterKeys($)
    const links = linksFor(merged, gone)
    const resolve = (name: string) => threadOf(name, list, links)
    const written = replySectionsOf(e.props.text, list, merged, gone)
    const moves = await read($, moved)
    const sections = written.map(s => placeSection(s, e.requestId, moves, resolve, list, links))
    const open = await read($, picking)
    const isNaming = await read($, naming)
    const pickerPlace = open.startsWith(`${e.requestId}|`) ? open.slice(e.requestId.length + 1) : undefined
    // On the desktop, a part of no thread offers "+ thread" where the pointer hovers.
    const canAdd = e.surface === 'desktop'
    const isPlain = selected.size === 0 && !sections.some(s => s.thread !== null) && pickerPlace === undefined
    // A reply of no thread is the engine's drawing alone, but for a deleted thread's
    // heading lines, which go.
    if (isPlain && !canAdd) {
      const text = sections.map(s => s.text).join('\n\n')
      const isUntouched = gone.length === 0 || text.trim() === e.props.text.trim() || text === ''
      return next(isUntouched ? e : { ...e, props: { ...e.props, text } })
    }

    const { Box } = $.ui.resolve(e)
    const isRecentRow = selected.size > 0 && (await isRecentReply($, e.requestId, e.props.text))
    const shown = sections.filter(s => isShown(s, selected, resolve, isRecentRow))
    if (shown.length === 0) return <Box display="none" />

    // A screen gets one message's text with a drawing, so the engine draws one part
    // of the reply; the other parts are drawn as markdown, as a reply's text is.
    // Each place's tag and picker are drawn once, at its first part.
    const parts: RenderElement[] = []
    const placesDrawn = new Set<string>()
    let isEngineDrawn = false
    for (const [i, s] of shown.entries()) {
      const isFirstOfReply = e.props.isFirstOfReply && i === 0 && s.thread === null
      let body: RenderElement | undefined
      const isDrawnByEngine = s.text !== '' && !isEngineDrawn
      if (isDrawnByEngine) {
        body = await next({ ...e, props: { ...e.props, text: s.text, isFirstOfReply } })
        isEngineDrawn = true
      } else if (s.text !== '') {
        body = drawMarkdown($, e, s.text)
      }
      const thread = s.thread === null ? undefined : resolve(s.thread)
      // A part of no thread that a plugin beneath draws as nothing stays nothing.
      if (thread === undefined && isBlank(body)) continue
      const place = thread === undefined ? '' : keyOf(thread.name)
      const isFirstOfPlace = !placesDrawn.has(place)
      placesDrawn.add(place)
      if (isFirstOfPlace) glimpses.set(`${e.requestId}|${place}`, `part of your reply "${glimpseOf(s.text)}"`)
      const isPicking = isFirstOfPlace && pickerPlace === place

      if (thread === undefined) {
        // An open picker takes the row of "+ thread", at its end; its pills are
        // taller than ADD_ROW's one fixed row, so the row is the picker's own.
        parts.push(
          <Box key={`part:${i}`} flexDirection="column">
            {isPicking
              ? drawPicker($, e, list, place, 'end', isNaming)
              : isFirstOfPlace &&
                canAdd && (
                  <Box flexDirection="row" justifyContent="flex-end" {...ADD_ROW}>
                    {drawAddThread($, e, 'end')}
                  </Box>
                )}
            {body}
          </Box>,
        )
        continue
      }
      // On the desktop the tag moves in to meet the engine's prose; Markdown parts have no inset.
      const tagInset = e.surface === 'desktop' && isDrawnByEngine ? REPLY_TAG_INSET : 0
      const tag = isFirstOfPlace ? drawMovableTag($, e, thread, 'start', tagInset) : drawTag($, e, thread, 'start', tagInset)
      // an open picker sits beside the tag it opened from
      const head = isPicking ? (
        <Box flexDirection="row" flexWrap="wrap" columnGap={2} alignItems="center">
          {tag}
          {drawPicker($, e, list, place, 'start', isNaming)}
        </Box>
      ) : (
        tag
      )
      parts.push(drawThreadPart($, e, thread, head, body))
    }
    if (parts.length === 0) return <Box display="none" />
    return <Box flexDirection="column" rowGap={1}>{parts}</Box>
  })

  // Tool rows belong to no thread: while the chat is filtered, only those since the
  // person's last message stay.
  on('ui.render', { component: 'ToolUse' }, async ($, e, next) => {
    if (!(await isFilteredOut($, [e.requestId]))) return next(e)
    const { Box } = $.ui.resolve(e)
    return <Box display="none" />
  })

  on('ui.render', { component: 'ToolResult' }, async ($, e, next) => {
    if (!(await isFilteredOut($, [e.requestId]))) return next(e)
    const { Box } = $.ui.resolve(e)
    return <Box display="none" />
  })

  on('ui.render', { component: 'ToolGroup' }, async ($, e, next) => {
    const ids = [e.requestId, ...e.props.calls.flatMap(call => (call.tool_use_id === undefined ? [] : [call.tool_use_id]))]
    if (!(await isFilteredOut($, ids))) return next(e)
    const { Box } = $.ui.resolve(e)
    return <Box display="none" />
  })

  // The band above the prompt: while threads are on, the thread picker, giving way first,
  // then thread-chat's menu right after it. They sit before what other mods draw there,
  // which keeps its width. The mobile app draws no menu: /threads and
  // /thread-view are there. With the menu's `Show thread summary` on, a line under them
  // holds a thread's one-line summary.
  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    const below = await next(e)
    if (e.props.hasSurvey) return below

    const on_ = await read($, isOn)
    const { Box } = $.ui.resolve(e)
    const menu = e.surface === 'mobile' ? undefined : await drawMenu($, e)
    if (menu === undefined && !on_) return below

    const mine = (
      <Box flexDirection="row" alignItems="center" columnGap={1} flexGrow={1} flexShrink={1} minWidth={0}>
        {on_ && (await drawThreadControls($, e))}
        {menu !== undefined && <Box flexShrink={0}>{menu}</Box>}
      </Box>
    )
    const controls =
      below.type === 'engine' ? (
        mine
      ) : (
        <Box flexDirection="row" alignItems="center" columnGap={2}>
          {mine}
          <Box flexDirection="row" alignItems="center" flexShrink={0}>
            {below}
          </Box>
        </Box>
      )
    const line = on_ ? await drawSummaryLine($, e) : undefined
    if (line === undefined) return controls
    return (
      <Box flexDirection="column" minWidth={0} rowGap={e.surface === 'desktop' ? SUMMARY_LINE_GAP : 0}>
        {controls}
        {line}
      </Box>
    )
  })
}

// The gap above the band's summary line on the desktop, in its half lines: about 5px, so
// the line clears the picker's tint by as much as the band pads above and below. The
// terminal's rows are whole lines, so it has none.
const SUMMARY_LINE_GAP = 0.5

// The band's line of a thread's one-line summary, under its controls, while the menu's
// `Show thread summary` is on: the picked thread's, or with none picked the thread the
// latest turn touched last; its line alone, dim, cut to one row, from the band's left
// edge, where the picker's tint starts. None where that thread has no line yet; where
// the summaries stopped this run, why.
async function drawSummaryLine($: EngineInterface, e: Parameters<EngineInterface['ui']['resolve']>[0]): Promise<RenderElement | undefined> {
  if (!(await read($, summaryLineShown)) || !(await read($, summariesOn))) return undefined
  const { Box, Text } = $.ui.resolve(e)
  if (summariesStopped !== undefined) {
    return (
      <Box flexDirection="row" minWidth={0}>
        <Box flexShrink={1} minWidth={0}>
          <Text dimColor wrap="truncate-end">{`Thread summaries unavailable: ${summariesStopped}`}</Text>
        </Box>
      </Box>
    )
  }
  const key = (await read($, current)) || (await read($, activeThread))
  const thread = (await read($, threads)).find(t => keyOf(t.name) === key && t.isArchived !== true)
  const line = thread === undefined ? undefined : (await read($, summaryLines))[key]?.line
  if (thread === undefined || line === undefined) return undefined
  return (
    <Box key={SUMMARY_LINE} flexDirection="row" minWidth={0}>
      <Box flexShrink={1} minWidth={0}>
        <Text dimColor wrap="truncate-end">{line}</Text>
      </Box>
    </Box>
  )
}

// The band's line of a thread's one-line summary.
const SUMMARY_LINE = 'summary-line-row'
