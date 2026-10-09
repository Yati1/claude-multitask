import { atom, read, update } from 'claude-code'
import type { BoxProps, Elements, EngineInterface, Register, RenderElement } from 'claude-code'

import type { Brief, Thread, ViewRow } from '../types'
import {
  PALETTE,
  closestThread,
  headingStart,
  headingsIn,
  holdsQuote,
  isOthersPrompt,
  keyOf,
  nameOf,
  replyQuotesOf,
  rewriteHeadings,
  splitRunOns,
  splitSections,
} from './parse'
import type { RunOn, Section } from './parse'
import {
  chunksOf,
  dataFolderOf,
  drawView,
  fingerprintOf,
  isKeptView,
  markHashOf,
  markOf,
  marksOf,
  needsMessages,
  noteDrawnReply,
  rowsOfChunks,
  rowsUpTo,
  viewKey,
  viewRowOf,
  withViewRow,
} from './pane'
import type { ViewDeps, ViewInputs } from './pane'
import { drawBand } from './menu'
import type { MenuSwitch } from './menu'

const isOn = atom({ plugin: 'thread-chat', key: 'isOn' } as const, false)
const threads = atom({ plugin: 'thread-chat', key: 'threads' } as const, [])
const aliases = atom({ plugin: 'thread-chat', key: 'aliases' } as const, {})
const agentMayCreate = atom({ plugin: 'thread-chat', key: 'agentMayCreate' } as const, false)
const snaps = atom({ plugin: 'thread-chat', key: 'snaps' } as const, {})
const current = atom({ plugin: 'thread-chat', key: 'current' } as const, '')
const deleted = atom({ plugin: 'thread-chat', key: 'deleted' } as const, [])
const sentTo = atom({ plugin: 'thread-chat', key: 'sentTo' } as const, {})
const moved = atom({ plugin: 'thread-chat', key: 'moved' } as const, {})
const picking = atom({ plugin: 'thread-chat', key: 'picking' } as const, '')
const naming = atom({ plugin: 'thread-chat', key: 'naming' } as const, false)
const untold = atom({ plugin: 'thread-chat', key: 'untold' } as const, [])
const briefed = atom({ plugin: 'thread-chat', key: 'briefed' } as const, null)
const viewRows = atom({ plugin: 'thread-chat', key: 'viewRows' } as const, [])
const menuOpen = atom({ plugin: 'thread-chat', key: 'menuOpen' } as const, false)

const CREATE_TOOL = 'mcp__thread-chat__create_thread'
// The switches in the band's `mods` menu: threads on or off, and whether the agent may start them.
const THREADS_SWITCH = 'mods-menu:threads'
const AGENT_SWITCH = 'mods-menu:agent-threads'
// The thread view's pane id, which is also its command's name and its band button's key.
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

// Flips whether the agent may start threads, offering it the tool as it comes on.
async function flipAgentSwitch($: EngineInterface) {
  let now = false
  await update($, agentMayCreate, may => (now = !may))
  if (now) await offerCreateTool($)
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
// thread, its heading gone.
function personSectionsOf(
  text: string,
  list: Thread[],
  snapped: Record<string, string>,
  merged: Record<string, string>,
  gone: readonly string[] = [],
): Section[] {
  const links = linksFor(merged, gone, snapped)
  const sections = splitSections(splitRunOns(text, typed => runOnOf(typed, list, links, merged)), () => true)
  return withoutGone(sections, name => isGone(resolveHeading(name, list, links), list, links))
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

// What the headings of a prompt mean: the thread names, in order, and each
// heading not written as its thread's exact name (a typo, a start of a name,
// `+name`, a name with the first line on its line) as typed with the thread it
// means. A heading may also mean a thread introduced earlier in the same prompt.
function decideHeadings(text: string, list: Thread[], links: Record<string, string>, merged: Record<string, string>) {
  let known = list
  const meanings: Meaning[] = []
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
    const meant = resolveHeading(raw, known, links)
    if (raw.startsWith('+') || keyOf(nameOf(raw)) !== keyOf(meant)) meanings.push({ typed: raw, meant })
    known = withThreads(known, [meant], 'user')
    return meant
  })
  return { names: headingsIn(resolved), meanings }
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
  threads: Thread[]
  aliases: Record<string, string>
  snaps: Record<string, string>
  // absent from a record kept before the thread picker, whose threads may carry the
  // filter's `isSelected`
  current: string
  deleted: string[]
  sentTo: Record<string, string>
  moved: Record<string, string>
  untold: string[]
  briefed: Brief | null
}

// Keeps the session's switch, threads, merges, recorded meanings and picked thread for its next run.
async function save($: EngineInterface) {
  const saved: Saved = {
    isOn: await read($, isOn),
    threads: await read($, threads),
    aliases: await read($, aliases),
    snaps: await read($, snaps),
    current: await read($, current),
    deleted: await read($, deleted),
    sentTo: await read($, sentTo),
    moved: await read($, moved),
    untold: await read($, untold),
    briefed: await read($, briefed),
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
// meanings of both (this run's winning), and this run's picked thread when it has one.
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
  await update($, current, key => key || (saved.current ?? pickedByFilter(saved.threads ?? [])))
  await update($, untold, all => [...(saved.untold ?? []).filter(note => !all.includes(note)), ...all])
  await update($, briefed, brief => brief ?? saved.briefed ?? null)
}

// A row's id as the screen knows it: blocks of one stored row drawn apart take
// ids that keep the row's first 24 characters.
const stemOf = (id: string) => id.slice(0, 24)

// Messages sent with no heading to one thread (the one picked, or the one a reply's
// quotes came from), until their rows are stored.
const unsent: { text: string; key: string }[] = []

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
    'This conversation can hold several threads at once. The user starts or replies to a thread with a level-1 heading in their message: `# name` or `#name` (with or without the space). Text before the first heading is the unthreaded conversation. A heading may be abbreviated or mistyped, or written `#+name` to start a new thread; a note beside the message then says which thread each heading means.',
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
// surface draws one, its capitals alone on the terminal.
function drawTag(
  $: EngineInterface,
  e: Parameters<EngineInterface['ui']['resolve']>[0],
  thread: { name: string; color: string },
  align: 'start' | 'end',
  inset = 0,
): RenderElement {
  if (e.surface === 'terminal') {
    const { Text } = $.ui.resolve(e)
    return <Text color={thread.color}>{thread.name.toUpperCase()}</Text>
  }
  const { Svg } = $.ui.resolve(e)
  const tag = tagPicture(thread.name, thread.color, align, inset)
  return <Svg source={tag.source} alt={thread.name} width={tag.width} height={tag.height} />
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

// A tip for the control in the keyed Box it sits in, shown while the pointer is over
// that Box. Placed out of the flow, so showing it moves nothing; the desktop lifts it
// into a card over the band, beside the control.
function drawTip($: EngineInterface, e: Parameters<EngineInterface['ui']['resolve']>[0], text: string): RenderElement {
  const { Box, Text } = $.ui.resolve(e)
  return (
    <Box position="absolute" display="none" hover={{ display: 'flex' }}>
      <Text>{text}</Text>
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
// that goes back: the move picker's and the thread picker's alike, under keys of each's own.
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

// Picks the thread messages with no heading go to, which the thread view shows ('' none).
async function pickThread($: EngineInterface, key: string) {
  await update($, current, () => key)
  await save($)
}

// A thread's name by its key, for telling the model.
async function nameByKey($: EngineInterface, key: string): Promise<string> {
  return (await read($, threads)).find(t => keyOf(t.name) === key)?.name ?? key
}

// Merges the thread `fromKey` into `toKey`: an old heading means the one it joined, and
// the picked thread follows it. The model is told beside the person's next message, as
// where the threads stand changed.
async function mergeThreads($: EngineInterface, fromKey: string, toKey: string) {
  if (fromKey === toKey) return
  await update($, aliases, merged => ({
    ...Object.fromEntries(Object.entries(merged).map(([k, v]) => [k, v === fromKey ? toKey : v])),
    [fromKey]: toKey,
  }))
  await update($, threads, all => all.filter(t => keyOf(t.name) !== fromKey))
  await update($, current, key => (key === fromKey ? toKey : key))
  await save($)
}

// Archives a thread, or brings it back: archived, it leaves the pickers but keeps its
// messages, and is no longer the picked thread. The model is told beside the person's
// next message.
async function setArchived($: EngineInterface, key: string, isArchived: boolean) {
  const name = await nameByKey($, key)
  await update($, threads, all =>
    all.map(t => (keyOf(t.name) !== key ? t : isArchived ? { ...t, isArchived: true } : withoutArchived(t))),
  )
  if (isArchived) await update($, current, cur => (cur === key ? '' : cur))
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
  await update($, untold, all => [
    ...all,
    `The user deleted the thread "${name}": its messages no longer belong to any thread. Do not write under its heading unless they start it again.`,
  ])
  await save($)
}

// The text the person's bubble shows: a known thread's heading line goes, as the
// tags above name the threads; where several sections share the bubble, a plain
// `▸ name` line still marks where each thread's part starts. A heading that
// names no thread stays as typed.
function bubbleText(shown: Section[], resolve: (name: string) => Thread | undefined): string {
  const only = shown.length === 1 ? shown[0] : undefined
  if (only !== undefined && only.thread !== null && resolve(only.thread) !== undefined) return only.text
  return shown
    .map(s => {
      if (s.thread === null) return s.text
      const thread = resolve(s.thread)
      const marker = thread === undefined ? `# ${s.thread}` : `▸ ${thread.name}`
      return s.text === '' ? marker : `${marker}\n${s.text}`
    })
    .join('\n\n')
}

// The thread view (pane.tsx) places a section by the rules the chat draws it by.
const viewDeps: ViewDeps = { threadOf, personThreadOf, personSectionsOf, replySectionsOf, linksFor, placeSection, stemOf }

// Keeps the thread view's window on its newest rows as they come, until the person scrolls.
async function pinViewToEnd($: EngineInterface) {
  try {
    await $.ui.scroll({ in: VIEW, to: 'end' })
  } catch {
    return
  }
}

// Opens the thread view (or shows it, already open) at its newest rows.
async function openView($: EngineInterface) {
  const opened = await $.ui.open({ id: VIEW, title: VIEW_TITLE })
  if (opened.isPlaced) await pinViewToEnd($)
  return opened
}

// What the thread view is drawn from; read while drawing, so a change draws it again.
// The rows it kept are the transcript as stored; the conversation as the engine
// holds it (a compaction's summary in place of what came before) is read only to
// fill in rows kept without their text, or for a session it kept no rows of.
async function viewInputs($: EngineInterface): Promise<ViewInputs> {
  const known = await read($, viewRows)
  let messages: ViewInputs['messages'] = []
  if (needsMessages(known)) {
    try {
      messages = await $.session.messages()
    } catch {
      messages = []
    }
  }
  return {
    list: await read($, threads),
    merged: await read($, aliases),
    snapped: await read($, snaps),
    sent: await read($, sentTo),
    moves: await read($, moved),
    current: await read($, current),
    deleted: await read($, deleted),
    known,
    messages,
  }
}

// The file beside a session's rows that holds their marks' hashes, a line a row.
const MARKS_FILE = 'marks.txt'

// Where a session's view rows are kept between runs: files of their own, all of
// every message's text, as the store holds 4 MiB in all; the store notes only how
// many there are (KeptView). They are in the plugin's data folder under the Claude
// Code configuration folder, a folder a session. None where the configuration
// folder is not known.
async function rowsFolder($: EngineInterface, id: string): Promise<string | undefined> {
  const home = (await $.env.get('USERPROFILE')) || (await $.env.get('HOME'))
  const config = (await $.env.get('CLAUDE_CONFIG_DIR')) || (home ? `${home}/.claude` : undefined)
  const data = dataFolderOf($.plugin.root, $.plugin.name, config)
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

// Threads' controls in the band: a pill per thread, then `view`. They take the room the
// band has left and give way first; nothing the pointer shows takes room.
async function drawThreadControls(
  $: EngineInterface,
  e: Parameters<EngineInterface['ui']['resolve']>[0],
): Promise<RenderElement> {
  const list = (await read($, threads)).filter(t => t.isArchived !== true)
  const cur = await read($, current)
  const isFiltering = cur !== ''
  // Messages with no heading go to the picked thread.
  const sendTarget = list.find(t => keyOf(t.name) === cur)
  // After the threads, a short button that opens the thread view: a Button, not a
  // Client, on every surface.
  const { Button } = $.ui.resolve(e)
  const viewButton =
    list.length === 0 ? undefined : <Button key={VIEW} label="view" variant="secondary" dimColor onPress={() => openView($)} />

  if (e.surface === 'desktop') {
    // A pill per thread, lit under the pointer. Pills past the room clip at its end (their
    // hit areas with them); the thread view holds every thread. The tip is a card the
    // desktop lifts over the band.
    const desktop = $.ui.resolve(e)
    const { Box, Text } = desktop
    return (
      <Box flexDirection="row" columnGap={1} alignItems="center" flexGrow={1} flexShrink={1} minWidth={0}>
        <Box flexDirection="row" columnGap={1} alignItems="center" flexShrink={1} minWidth={0} overflow="hidden">
          {list.length === 0 && (
            <Text dimColor wrap="truncate-end">
              start a thread with # name
            </Text>
          )}
          {list.map(t => {
            const isSelected = sendTarget === t
            const isSendTarget = isSelected
            return drawPillSwitch(
              desktop,
              `chip:${keyOf(t.name)}`,
              `thread:${keyOf(t.name)}`,
              isSelected,
              isSendTarget ? `${t.name}: messages with no heading go here` : t.name,
              isHot => chipPicture(t.name, t.color, isSelected, isFiltering && !isSelected, isSendTarget, undefined, isHot),
              { flexShrink: 0 },
            )
          })}
        </Box>
        {viewButton && (
          <Box key="thread-view-tip" flexShrink={0}>
            {viewButton}
            {drawTip($, e, 'Thread view: the picked thread alone, in a pane')}
          </Box>
        )}
      </Box>
    )
  }
  // The terminal wraps the pills in their part of the row rather than lose any.
  const { Box, Text } = $.ui.resolve(e)
  return (
    <Box flexDirection="row" columnGap={1} alignItems="center" flexGrow={1} flexShrink={1} minWidth={0}>
      <Box flexDirection="row" flexWrap="wrap" columnGap={1} alignItems="center" flexShrink={1} minWidth={0}>
        {list.length === 0 && <Text dimColor>start a thread with # name</Text>}
        {list.map(t => (
          <Box flexDirection="row" flexShrink={0}>
            <Text color={t.color}>●</Text>
            <Button
              key={`thread:${keyOf(t.name)}`}
              label={sendTarget === t ? `${t.name} ➤` : t.name}
              variant={sendTarget === t ? 'primary' : 'secondary'}
              dimColor={isFiltering && sendTarget !== t}
              onPress={() => pickThread($, cur === keyOf(t.name) ? '' : keyOf(t.name))}
            />
          </Box>
        ))}
      </Box>
      {viewButton && <Box flexShrink={0}>{viewButton}</Box>}
    </Box>
  )
}

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    await $.command.register({ name: 'threads', description: 'Turn conversation threads on or off in this chat' })
    await $.command.register({ name: VIEW, description: 'Show the picked thread alone, without tool rows, in a pane' })
    // A restarted or resumed session takes up the rows its thread view kept.
    if ((await read($, viewRows)).length === 0) {
      const kept = await keptRows($, await $.session.id()).catch(() => [])
      if (kept.length > 0) await update($, viewRows, () => kept)
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
        }
      }
    }
    if (saved?.threads !== undefined) await takeUp($, saved)
    // Threads held on (a reload) stay on; else they are as the session, or the one it
    // came from, kept them. A record kept before /threads, or none, is on where it used them.
    if (!(await read($, isOn)) && (saved?.isOn ?? (await wasInUse($)))) await update($, isOn, () => true)
    // The agent switch outlives a reload of this code: with threads on, its tool is offered again.
    if ((await read($, isOn)) && (await read($, agentMayCreate))) await offerCreateTool($)
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
    const send = async (notes: string[]) => {
      const all = [...(await briefing($)), ...told, ...notes]
      return all.length === 0 ? next(e) : next({ ...e, context: [...(e.context ?? []), ...all] })
    }

    const merged = await read($, aliases)
    const links = linksFor(merged, await read($, deleted), await read($, snaps))
    const list = await read($, threads)
    const { names, meanings } = decideHeadings(e.text, list, links, merged)
    if (names.length === 0) {
      // A reply to parts of earlier replies goes to the thread they came from, even
      // while another is picked: the person pointed at that thread's text.
      const quoted = await quotedThreadOf($, replyQuotesOf(e.text), list)
      if (quoted !== undefined) {
        unsent.push({ text: e.text.trim(), key: keyOf(quoted.name) })
        return send([
          `This message belongs to the thread "${quoted.name}": the user replied to part of your message in that thread, so your reply most likely belongs under that thread's heading.`,
        ])
      }
      // With a thread picked above the prompt, a message with no heading goes to it.
      const cur = await read($, current)
      const picked = cur === '' ? undefined : list.find(t => keyOf(t.name) === cur && t.isArchived !== true)
      if (picked === undefined) return send([])
      unsent.push({ text: e.text.trim(), key: keyOf(picked.name) })
      return send([
        `This message belongs to the thread "${picked.name}": the user posted it there with their thread picker, so your reply most likely belongs under that thread's heading.`,
      ])
    }
    await addThreads($, names, 'user')
    const decided = linksOf(meanings)
    if (Object.keys(decided).length > 0) await update($, snaps, all => ({ ...all, ...decided }))
    await save($)
    if (meanings.length === 0) return send([])

    return send([`Thread headings in this message, as the user meant them: ${meanings.map(meaningNote).join('; ')}.`])
  })

  // A message sent with no heading to one thread is known by its row once stored.
  on('session.append', async ($, e, next) => {
    const isPersonMessage = PERSON.has(e.origin.kind) && (e.door === 'prompt' || e.door === 'delivery')
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
      const row = stored?.deny === undefined ? viewRowOf(stored === undefined ? e : { ...e, message: stored.message }, PERSON) : undefined
      if (row !== undefined) await update($, viewRows, all => withViewRow(all, row))
    }
  })

  // A turn's rows are kept for the session's next run as the turn ends, while threads
  // are on: all of them then, those from before they came on too.
  on('turn.complete', async ($, e, next) => {
    const result = await next(e)
    if (e.agentId === undefined && (await read($, isOn))) {
      if ((await read($, threads)).length > 0) await save($)
      const rows = await read($, viewRows)
      if (rows.length > 0) await keepViewRows($, await $.session.id(), rows)
    }
    return result
  })

  on('command.run', { command: VIEW }, async $ => {
    if (!(await read($, isOn))) return { text: OFF_TEXT }
    const opened = await openView($)
    return { text: opened.isPlaced ? 'Thread view opened.' : `Thread view not shown: ${opened.reason}` }
  })

  // Another thread picked takes the thread view to the newest of what it holds.
  on('state.set', { plugin: 'thread-chat', key: 'current' }, async ($, e, next) => {
    const result = await next(e)
    try {
      if (e.previous !== e.value && (await $.ui.panes()).some(p => p.id === VIEW)) await pinViewToEnd($)
    } catch {
      // the pick stands whether or not the view moves
    }
    return result
  })

  // The thread view: the picked thread's sections, each tagged in its thread's
  // colour and drawn as markdown, as the chat draws them. No Client: a pane of
  // many rows must not add to the Clients every overlay on the desktop shares.
  on('ui.render', { component: 'Pane', requestId: VIEW }, async ($, e) =>
    drawView(
      {
        ui: $.ui.resolve(e),
        tag: thread => drawTag($, e, thread, 'start'),
        markdown: text => drawMarkdown($, e, text),
      },
      await viewInputs($),
      viewDeps,
    ),
  )

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
  // the person's next message.
  on('session.compact', async ($, e, next) => {
    const result = await next(e)
    const isCompacted = e.agentId === undefined && e.trigger !== 'precompute' && result.skip === undefined
    if (isCompacted && (await read($, briefed)) !== null) {
      await update($, briefed, () => null)
      await save($)
    }
    return result
  })

  // The band's chips and the one open move picker's pills post here when clicked: the
  // only Clients, so their count stays near the number of threads.
  on('ui.message', async ($, e, next) => {
    if ((e.data as { flip?: unknown } | null)?.flip === true && (await read($, isOn))) {
      if (e.element.startsWith('thread:')) {
        const key = e.element.slice('thread:'.length)
        await pickThread($, (await read($, current)) === key ? '' : key)
      }
      else if (e.element.startsWith('pick:')) await moveTo($, e.element.slice('pick:'.length))
      else if (e.element === NEW_THREAD_PILL) await setNaming($, true)
    }
    return next(e)
  })

  // The person's message stays the engine's own drawing (its images and all):
  // its thread tags go above it in their colours, and its heading lines go.
  on('ui.render', { component: 'UserMessage' }, async ($, e, next) => {
    // Off, every message is the engine's drawing alone.
    if (!(await read($, isOn))) return next(e)
    // A plugin's prompt is never the person's, though a surface may name it as theirs.
    // A row of no words (an image alone) is the engine's drawing alone: no tag or
    // "+ thread" goes round it.
    if (!PERSON.has(e.props.origin.kind) || isOthersPrompt(e.props.text) || e.props.text.trim() === '') return next(e)
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
    const isPlain = !sections.some(s => s.thread !== null) && pickerPlace === undefined
    const text = bubbleText(sections, resolve) || e.props.text
    // A message of no thread is the engine's drawing alone, but for a deleted thread's
    // heading line, which goes.
    if (isPlain && !canAdd) return next(text.trim() === e.props.text.trim() ? e : { ...e, props: { ...e.props, text } })

    const { Box } = $.ui.resolve(e)
    const shown = sections
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
    const isOnRight = e.surface === 'desktop' || e.surface === 'mobile'
    const align = isOnRight ? 'end' : 'start'
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
        {(tags.length > 0 || side !== undefined) && (
          <Box flexDirection="row" columnGap={2} justifyContent={isOnRight ? 'flex-end' : 'flex-start'} {...rowFit}>
            {/* on the side away from the edge the tags keep to, so showing it moves none */}
            {isOnRight && side}
            {tags.map(t => drawMovableTag($, e, t, align))}
            {!isOnRight && side}
          </Box>
        )}
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
    if (isBlankText(e.props.text)) return next(e)
    const list = await read($, threads)
    const merged = await read($, aliases)
    const gone = await read($, deleted)
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
    const isPlain = !sections.some(s => s.thread !== null) && pickerPlace === undefined
    // A reply of no thread is the engine's drawing alone, but for a deleted thread's
    // heading lines, which go.
    if (isPlain && !canAdd) {
      const text = sections.map(s => s.text).join('\n\n')
      const isUntouched = gone.length === 0 || text.trim() === e.props.text.trim() || text === ''
      return next(isUntouched ? e : { ...e, props: { ...e.props, text } })
    }
    // A thread's border keeps its part the same cells off on every side (REPLY_BORDER_PADDING).
    const borderPadding =
      e.surface === 'desktop' ? { padding: REPLY_BORDER_PADDING } : { paddingX: REPLY_BORDER_PADDING }

    const { Box } = $.ui.resolve(e)
    const shown = sections

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
      parts.push(
        <Box flexDirection="column" borderStyle="round" borderColor={thread.color} {...borderPadding}>
          {/* an open picker sits beside the tag it opened from */}
          {isPicking ? (
            <Box flexDirection="row" flexWrap="wrap" columnGap={2} alignItems="center">
              {tag}
              {drawPicker($, e, list, place, 'start', isNaming)}
            </Box>
          ) : (
            tag
          )}
          {body}
        </Box>,
      )
    }
    if (parts.length === 0) return <Box display="none" />
    return <Box flexDirection="column" rowGap={1}>{parts}</Box>
  })

  // The band above the prompt, shared with the other mods of this repository through
  // ./menu.tsx: while threads are on, their pills and `view`; always, the switches in its
  // `mods` menu that turn threads on and off and, while on, let the agent start them.
  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    const below = await next(e)
    if (e.props.hasSurvey) return below

    const on_ = await read($, isOn)
    const switches: MenuSwitch[] = [{ rank: 10, key: THREADS_SWITCH, label: 'Threads', isOn: on_, onPress: () => flipThreads($) }]
    if (on_) {
      const mayCreate = await read($, agentMayCreate)
      switches.push({
        rank: 11,
        key: AGENT_SWITCH,
        label: 'Agent may start threads',
        isOn: mayCreate,
        onPress: () => flipAgentSwitch($),
      })
    }
    return drawBand(below, {
      ui: $.ui.resolve(e),
      surface: e.surface,
      controls: on_ ? { rank: 10, name: 'thread-chat', element: await drawThreadControls($, e), grows: true } : undefined,
      switches,
      isOpen: () => read($, menuOpen),
      onToggle: () => update($, menuOpen, open => !open),
    })
  })
}
