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
  drawView,
  markOf,
  noteDrawnReply,
  pickedOf,
  viewKey,
  viewRowOf,
  withViewRow,
} from './pane'
import type { ViewDeps, ViewInputs } from './pane'

const threads = atom({ plugin: 'thread-chat', key: 'threads' } as const, [])
const aliases = atom({ plugin: 'thread-chat', key: 'aliases' } as const, {})
const agentMayCreate = atom({ plugin: 'thread-chat', key: 'agentMayCreate' } as const, false)
const snaps = atom({ plugin: 'thread-chat', key: 'snaps' } as const, {})
const recent = atom({ plugin: 'thread-chat', key: 'recent' } as const, [])
const recentTexts = atom({ plugin: 'thread-chat', key: 'recentTexts' } as const, [])
const sentTo = atom({ plugin: 'thread-chat', key: 'sentTo' } as const, {})
const moved = atom({ plugin: 'thread-chat', key: 'moved' } as const, {})
const picking = atom({ plugin: 'thread-chat', key: 'picking' } as const, '')
const naming = atom({ plugin: 'thread-chat', key: 'naming' } as const, false)
const untold = atom({ plugin: 'thread-chat', key: 'untold' } as const, [])
const briefed = atom({ plugin: 'thread-chat', key: 'briefed' } as const, null)
const viewRows = atom({ plugin: 'thread-chat', key: 'viewRows' } as const, [])

const CREATE_TOOL = 'mcp__thread-chat__create_thread'
const AGENT_SWITCH = 'agent-switch'
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
      isSelected: false,
      createdBy,
    }))
  return added.length === 0 ? list : [...list, ...added]
}

async function addThreads($: EngineInterface, names: string[], createdBy: Thread['createdBy']) {
  if (names.length > 0) await update($, threads, list => withThreads(list, names, createdBy))
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
// same line split from it first.
function personSectionsOf(
  text: string,
  list: Thread[],
  snapped: Record<string, string>,
  merged: Record<string, string>,
): Section[] {
  const links = { ...snapped, ...merged }
  return splitSections(splitRunOns(text, typed => runOnOf(typed, list, links, merged)), () => true)
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
  threads: Thread[]
  aliases: Record<string, string>
  snaps: Record<string, string>
  recent: string[]
  recentTexts: string[]
  sentTo: Record<string, string>
  moved: Record<string, string>
  untold: string[]
  briefed: Brief | null
}

// Keeps the session's threads, merges, recorded meanings and latest rows for its next run.
async function save($: EngineInterface) {
  const saved: Saved = {
    threads: await read($, threads),
    aliases: await read($, aliases),
    snaps: await read($, snaps),
    recent: await read($, recent),
    recentTexts: await read($, recentTexts),
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
async function parentOf($: EngineInterface, id: string): Promise<string | undefined> {
  const mine = new Set(
    (await $.session.messages()).map(m => markOf(m.text)).filter(mark => mark.length >= MIN_PARENT_MARK),
  )
  if (mine.size === 0) return undefined
  const scores: { id: string; score: number }[] = []
  for (const key of await $.store.keys()) {
    if (!key.startsWith('view:') || key === viewKey(id)) continue
    const rows = await $.store.get(key)
    if (!Array.isArray(rows)) continue
    const known = new Set((rows as ViewRow[]).map(row => row.mark).filter(mark => mine.has(mark)))
    if (known.size > 0) scores.push({ id: key.slice('view:'.length), score: known.size })
  }
  scores.sort((a, b) => b.score - a.score)
  const [best, next] = scores
  if (best === undefined || best.score < 3 || (next !== undefined && next.score * 2 > best.score)) return undefined
  return best.id
}

// Joins a saved record to what this run holds, so neither loses anything: the threads
// either knows (this run's first picks kept), the merges and recorded meanings of both
// (this run's winning), and this run's rows when it has any. A thread this run holds
// is not merged away by an older record.
async function takeUp($: EngineInterface, saved: Partial<Saved>) {
  const held = new Set((await read($, threads)).map(t => keyOf(t.name)))
  const older = Object.fromEntries(Object.entries(saved.aliases ?? {}).filter(([key]) => !held.has(key)))
  const links = { ...older, ...(await read($, aliases)) }
  await update($, aliases, () => links)
  await update($, threads, list => {
    const mine = new Map(list.map(t => [keyOf(t.name), t]))
    const savedKeys = new Set((saved.threads ?? []).map(t => keyOf(t.name)))
    const ordered = [
      ...(saved.threads ?? []).map(t => mine.get(keyOf(t.name)) ?? { ...t, isSelected: false }),
      ...list.filter(t => !savedKeys.has(keyOf(t.name))),
    ]
    return ordered.filter(t => links[keyOf(t.name)] === undefined)
  })
  await update($, snaps, all => ({ ...(saved.snaps ?? {}), ...all }))
  await update($, sentTo, all => ({ ...(saved.sentTo ?? {}), ...all }))
  await update($, moved, all => ({ ...(saved.moved ?? {}), ...all }))
  await update($, recent, all => (all.length > 0 ? all : (saved.recent ?? [])))
  await update($, recentTexts, all => (all.length > 0 ? all : (saved.recentTexts ?? [])))
  await update($, untold, all => [...(saved.untold ?? []).filter(note => !all.includes(note)), ...all])
  await update($, briefed, brief => brief ?? saved.briefed ?? null)
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

// Whether a row that belongs to no thread is filtered out: while a thread is
// picked, all but those since the person's last message are.
async function isFilteredOut($: EngineInterface, ids: string[]): Promise<boolean> {
  if ((await selectedKeys($)).size === 0) return false
  return !(await isRecent($, ids))
}

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
function quotedPlaceOf(replies: string[], quote: string, resolve: (name: string) => Thread | undefined): string | undefined {
  for (const reply of replies) {
    if (!holdsQuote(reply, quote)) continue
    const places = new Set(
      splitSections(reply, name => resolve(name) !== undefined)
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
  const resolve = (name: string) => threadOf(name, list, merged)
  const replies = rows.filter(r => r.role === 'assistant' && r.text !== '').map(r => r.text).reverse()
  const places = new Set(quotes.flatMap(q => quotedPlaceOf(replies, q, resolve) ?? []))
  const only = places.size === 1 ? [...places][0] : undefined
  return only === undefined || only === '' ? undefined : threadOf(only, list, merged)
}

// The marks of a stored reply's text blocks, each as a screen may draw it alone.
function textMarksOf(content: readonly { type: string; [field: string]: unknown }[]): string[] {
  return content.flatMap(block => (block.type === 'text' && typeof block.text === 'string' ? [textMarkOf(block.text)] : []))
}

// The ids of the tool calls a stored row makes; each draws as a row of its own.
function toolCallIds(content: readonly { type: string; [field: string]: unknown }[]): string[] {
  return content.flatMap(block => (block.type === 'tool_use' && typeof block.id === 'string' ? [block.id] : []))
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
    'Reply the same way. Put what belongs to a thread under a level-1 heading carrying that thread\'s exact name, one section per thread the user wrote to; keep unthreaded material before any thread heading. Use `##` or deeper for structure inside a section: a level-1 heading that is not a thread name drops back into the unthreaded conversation.',
    'This holds for the rest of the conversation; a note beside a later message says when threads are merged or your leave to start them changes.',
    threadState(list, merged, mayCreate),
  ].join('\n\n')
}

// Where the threads stand: those so far, the merges, and whether the model may start one.
function threadState(list: Thread[], merged: Record<string, string>, mayCreate: boolean): string {
  const names = list.length === 0 ? 'none yet' : list.map(t => `"${t.name}"`).join(', ')
  const mergedNames = Object.entries(merged).map(([from, to]) => `"${from}" is now "${to}"`)
  return [
    `Threads so far: ${names}.`,
    ...(mergedNames.length === 0 ? [] : [`Merged threads (an old heading means the new one): ${mergedNames.join('; ')}.`]),
    mayCreate
      ? `You may start a new thread with ${CREATE_TOOL} when a distinct topic deserves its own thread, then write to it under its heading. Do it sparingly.`
      : `Do not start new threads yourself; the user has not enabled that (${CREATE_TOOL} will refuse).`,
  ].join(' ')
}

const mergesKey = (merged: Record<string, string>) => JSON.stringify(Object.entries(merged).sort())

// What the model is told of the threads beside the person's message: how they work,
// once they matter (and again after a compaction), then where they stand whenever a
// merge or the agent switch changed it. A thread it sees made (by a heading, its own
// create_thread, a move it is told of) needs no telling.
async function briefing($: EngineInterface): Promise<string[]> {
  const list = await read($, threads)
  const merged = await read($, aliases)
  const mayCreate = await read($, agentMayCreate)
  const was = await read($, briefed)
  const isUnused = list.length === 0 && Object.keys(merged).length === 0 && !mayCreate
  if (was === null ? isUnused : mergesKey(was.merged) === mergesKey(merged) && was.mayCreate === mayCreate) return []
  await update($, briefed, () => ({ merged, mayCreate }))
  await save($)
  return [was === null ? protocol(list, merged, mayCreate) : `The threads changed. ${threadState(list, merged, mayCreate)}`]
}

// The SVG of a slide switch: a rounded track with the knob to the right when on.
function switchPicture(isOn: boolean): string {
  const track = isOn ? '#3b82f6' : '#8c8c8c'
  const knob = isOn ? 23 : 11
  return `<svg xmlns="http://www.w3.org/2000/svg" width="34" height="20" viewBox="0 0 34 20"><rect x="1" y="2" width="32" height="16" rx="8" fill="${track}"/><circle cx="${knob}" cy="10" r="6" fill="#ffffff"/></svg>`
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
      <Box position="absolute" top={0} left={0} display="none" hover={{ display: 'flex' }}>
        <Svg source={hot.source} alt={alt} width={hot.width} height={CHIP_HEIGHT} />
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
    ...list.filter(t => keyOf(t.name) !== place).map(t => ({ key: keyOf(t.name), name: t.name, color: t.color })),
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

  if (isNaming && canName) {
    return row([
      <Input
        key={NEW_THREAD_FIELD}
        placeholder="name"
        submitLabel="move"
        autoFocus
        onSubmit={(value: string) => moveToNewThread($, value)}
      />,
      <Button key="pick-cancel" label="×" plain dimColor onPress={() => setNaming($, false)} />,
    ])
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

// Picks or drops a thread in the filter, and takes the chat back to its end.
async function toggleThread($: EngineInterface, key: string) {
  await update($, threads, all =>
    all.map(one => (keyOf(one.name) === key ? { ...one, isSelected: !one.isSelected } : one)),
  )
  await scrollToEnd($)
}

// The keys of the threads picked in the band; empty shows everything.
async function selectedKeys($: EngineInterface): Promise<Set<string>> {
  return new Set((await read($, threads)).filter(t => t.isSelected).map(t => keyOf(t.name)))
}

// Whether a section stays in view: all of them while no thread is picked, else
// the picked threads' sections, and unthreaded ones in rows since the person's
// last message.
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
const viewDeps: ViewDeps = { threadOf, personThreadOf, personSectionsOf, placeSection, stemOf }

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
async function viewInputs($: EngineInterface): Promise<ViewInputs> {
  let messages: ViewInputs['messages'] = []
  try {
    messages = await $.session.messages()
  } catch {
    messages = []
  }
  return {
    list: await read($, threads),
    merged: await read($, aliases),
    snapped: await read($, snaps),
    sent: await read($, sentTo),
    moves: await read($, moved),
    known: await read($, viewRows),
    messages,
  }
}

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    await $.command.register({ name: VIEW, description: 'Show the picked threads alone, without tool rows, in a pane' })
    // A restarted or resumed session takes up the rows its thread view knew by id.
    if ((await read($, viewRows)).length === 0) {
      const saved = await $.store.get(viewKey(await $.session.id()))
      if (Array.isArray(saved) && saved.length > 0) await update($, viewRows, () => saved as ViewRow[])
    }
    await $.tool.register({
      name: 'create_thread',
      description:
        'Start a new conversation thread the user can follow and filter. Then write to it under a level-1 heading with its exact name. Refused unless the user has enabled agent-created threads.',
      inputSchema: {
        type: 'object',
        properties: { name: { type: 'string', description: 'Short thread name, 1-4 words' } },
        required: ['name'],
      },
    })
    await $.command.register({
      name: 'merge-threads',
      description: 'Merge one conversation thread into another',
      argumentHint: '<thread> into <thread>',
    })

    // Threads saved by an earlier version of this mod lack fields this one draws.
    await update($, threads, list =>
      list.map(t => ({
        name: t.name,
        color: t.color ?? '#888888',
        isSelected: t.isSelected === true,
        createdBy: t.createdBy ?? 'user',
      })),
    )

    // A restarted, resumed or reloaded session takes up the threads it kept, joined to
    // any it holds; a rewound or forked one, which starts under a new id with no record
    // of its own, those of the session it came from, and that session's view rows.
    const id = await $.session.id()
    let saved = (await $.store.get(storeKey(id))) as Partial<Saved> | undefined
    if (saved === undefined) {
      // Best effort: a session whose messages or store cannot be read starts empty.
      const parent = await parentOf($, id).catch(() => undefined)
      if (parent !== undefined) {
        saved = (await $.store.get(storeKey(parent))) as Partial<Saved> | undefined
        const rows = await $.store.get(viewKey(parent))
        if ((await read($, viewRows)).length === 0 && Array.isArray(rows)) {
          await update($, viewRows, () => rows as ViewRow[])
          await $.store.set(viewKey(id), rows)
        }
      }
    }
    if (saved?.threads !== undefined) await takeUp($, saved)
    await save($)

    return next(e)
  })

  on('prompt.submit', async ($, e, next) => {
    if (!PERSON.has(e.origin.kind)) return next(e)
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
    const links = { ...(await read($, snaps)), ...merged }
    const list = await read($, threads)
    const { names, meanings } = decideHeadings(e.text, list, links, merged)
    if (names.length === 0) {
      // A reply to parts of earlier replies goes to the thread they came from, even
      // while another is picked: the person pointed at that thread's text.
      const quoted = await quotedThreadOf($, replyQuotesOf(e.text), list)
      if (quoted !== undefined) {
        unsent.push({ text: e.text.trim(), key: keyOf(quoted.name) })
        return send([
          `This message belongs to the thread "${quoted.name}": the user replied to part of your message in that thread. Reply under that thread's heading.`,
        ])
      }
      // With one thread alone picked, a message with no heading goes to that thread.
      const picked = list.filter(t => t.isSelected)
      const only = picked.length === 1 ? picked[0] : undefined
      if (only === undefined) return send([])
      unsent.push({ text: e.text.trim(), key: keyOf(only.name) })
      return send([
        `This message belongs to the thread "${only.name}": the user wrote it while viewing that thread alone. Reply to it under that thread's heading.`,
      ])
    }
    await addThreads($, names, 'user')
    const decided = linksOf(meanings)
    if (Object.keys(decided).length > 0) await update($, snaps, all => ({ ...all, ...decided }))
    await save($)
    if (meanings.length === 0) return send([])

    return send([`Thread headings in this message, as the user meant them: ${meanings.map(meaningNote).join('; ')}.`])
  })

  // The rows since the person's last message, noted as they are stored: a filter
  // still shows those of them that belong to no thread.
  on('session.append', async ($, e, next) => {
    if (e.agentId === undefined) {
      const ids = [e.uuid, ...toolCallIds(e.message.content)]
      const isPersonMessage = PERSON.has(e.origin.kind) && (e.door === 'prompt' || e.door === 'delivery')
      await update($, recent, all => (isPersonMessage ? ids : [...all, ...ids]))
      const marks = e.message.type === 'assistant' ? textMarksOf(e.message.content) : []
      if (isPersonMessage || marks.length > 0) await update($, recentTexts, all => (isPersonMessage ? [] : [...all, ...marks]))
      // A message sent to the one picked thread is known by its row from here on.
      const said = textOf(e.message.content)
      const sent = isPersonMessage ? unsent.findIndex(u => said.includes(u.text)) : -1
      const key = sent >= 0 ? unsent.splice(sent, 1)[0]?.key : undefined
      if (key !== undefined) await update($, sentTo, all => ({ ...all, [e.uuid]: key }))
    }
    try {
      return await next(e)
    } finally {
      // The thread view learns a person's message or a reply's text once it is
      // stored, and draws again with it. A row that failed to store is noted all the
      // same: the view matches rows to the transcript, where it is not.
      const row = viewRowOf(e, PERSON)
      if (row !== undefined) await update($, viewRows, all => withViewRow(all, row))
    }
  })

  // A turn's rows are kept for the session's next run as the turn ends.
  on('turn.complete', async ($, e, next) => {
    const result = await next(e)
    if (e.agentId === undefined) {
      if ((await read($, threads)).length > 0) await save($)
      const rows = await read($, viewRows)
      if (rows.length > 0) await $.store.set(viewKey(await $.session.id()), rows)
    }
    return result
  })

  on('command.run', { command: VIEW }, async $ => {
    const opened = await openView($)
    return { text: opened.isPlaced ? 'Thread view opened.' : `Thread view not shown: ${opened.reason}` }
  })

  // Another pick of threads takes the thread view to the newest of what they hold.
  on('state.set', { plugin: 'thread-chat', key: 'threads' }, async ($, e, next) => {
    const result = await next(e)
    try {
      if (pickedOf(e.previous) !== pickedOf(e.value) && (await $.ui.panes()).some(p => p.id === VIEW)) await pinViewToEnd($)
    } catch {
      // the pick stands whether or not the view moves
    }
    return result
  })

  // The thread view: the picked threads' sections, each tagged in its thread's
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
    const [fromText, toText] = e.args.split(/\s+into\s+/i).map(part => nameOf(part.replace(/^#+/, '')))
    if (!fromText || !toText) return { text: 'Usage: /merge-threads <thread> into <thread>' }

    const list = await read($, threads)
    const keys = list.map(t => keyOf(t.name))
    const from = list.find(t => keyOf(t.name) === closestThread(fromText, keys))
    const to = list.find(t => keyOf(t.name) === closestThread(toText, keys))
    if (from === undefined || to === undefined || from === to) {
      return { text: `Could not tell which threads to merge. Threads: ${list.map(t => t.name).join(', ') || 'none'}.` }
    }

    const fromKey = keyOf(from.name)
    const toKey = keyOf(to.name)
    await update($, aliases, merged => ({
      ...Object.fromEntries(Object.entries(merged).map(([k, v]) => [k, v === fromKey ? toKey : v])),
      [fromKey]: toKey,
    }))
    await update($, threads, all =>
      all
        .filter(t => keyOf(t.name) !== fromKey)
        .map(t => (keyOf(t.name) === toKey ? { ...t, isSelected: t.isSelected || from.isSelected } : t)),
    )
    await save($)
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

  // The band's chips and switch, and the one open move picker's pills, post here when clicked:
  // the only Clients, so their count stays near the number of threads.
  on('ui.message', async ($, e, next) => {
    if ((e.data as { flip?: unknown } | null)?.flip === true) {
      if (e.element === AGENT_SWITCH) await update($, agentMayCreate, may => !may)
      else if (e.element.startsWith('thread:')) await toggleThread($, e.element.slice('thread:'.length))
      else if (e.element.startsWith('pick:')) await moveTo($, e.element.slice('pick:'.length))
      else if (e.element === NEW_THREAD_PILL) await setNaming($, true)
    }
    return next(e)
  })

  // The person's message stays the engine's own drawing (its images and all):
  // its thread tags go above it in their colours, its heading lines go, and a
  // filter trims its text to the picked threads' sections.
  on('ui.render', { component: 'UserMessage' }, async ($, e, next) => {
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
    const resolve = (name: string) => personThreadOf(name, list, { ...snapped, ...merged })
    const selected = await selectedKeys($)
    const typed = personSectionsOf(e.props.text, list, snapped, merged)
    // A message with no heading may have gone to the one thread picked as it was sent.
    const sentThread = typed.some(s => s.thread !== null) ? undefined : await sentThreadOf($, e.requestId, list, merged)
    const sent = sentThread === undefined ? typed : [{ thread: sentThread.name, text: e.props.text }]
    const moves = await read($, moved)
    const sections = sent.map(s => placeSection(s, e.requestId, moves, resolve, list, merged))
    const open = await read($, picking)
    const isNaming = await read($, naming)
    const pickerPlace = open.startsWith(`${e.requestId}|`) ? open.slice(e.requestId.length + 1) : undefined
    // On the desktop, a message of no thread offers "+ thread" where the pointer hovers.
    const canAdd = e.surface === 'desktop'
    const isPlain = selected.size === 0 && !sections.some(s => s.thread !== null) && pickerPlace === undefined
    if (isPlain && !canAdd) return next(e)

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
    // The voice's "(quiet)" (the multitask plugin draws it as nothing) and a block of no
    // words are the engine's drawing alone: no "+ thread", or room for one, round nothing.
    if (isBlankText(e.props.text)) {
      const isHidden = (await selectedKeys($)).size > 0 && !(await isRecentReply($, e.requestId, e.props.text))
      if (!isHidden) return next(e)
      const { Box } = $.ui.resolve(e)
      return <Box display="none" />
    }
    // With no threads yet a part still offers "+ thread": its picker can start one.
    const list = await read($, threads)
    const merged = await read($, aliases)
    const selected = await selectedKeys($)
    const resolve = (name: string) => threadOf(name, list, merged)
    const written = splitSections(e.props.text, name => resolve(name) !== undefined)
    const moves = await read($, moved)
    const sections = written.map(s => placeSection(s, e.requestId, moves, resolve, list, merged))
    const open = await read($, picking)
    const isNaming = await read($, naming)
    const pickerPlace = open.startsWith(`${e.requestId}|`) ? open.slice(e.requestId.length + 1) : undefined
    // On the desktop, a part of no thread offers "+ thread" where the pointer hovers.
    const canAdd = e.surface === 'desktop'
    const isPlain = selected.size === 0 && !sections.some(s => s.thread !== null) && pickerPlace === undefined
    if (isPlain && !canAdd) return next(e)
    // A thread's border keeps its part the same cells off on every side (REPLY_BORDER_PADDING).
    const borderPadding =
      e.surface === 'desktop' ? { padding: REPLY_BORDER_PADDING } : { paddingX: REPLY_BORDER_PADDING }

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

  // Tool rows belong to no thread: while a thread is picked, only those since the
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

  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    const below = await next(e)
    if (e.props.hasSurvey) return below

    const list = await read($, threads)
    const mayCreate = await read($, agentMayCreate)
    const isFiltering = list.some(t => t.isSelected)
    // With one thread alone picked, messages with no heading go to it.
    const picked = list.filter(t => t.isSelected)
    const sendTarget = picked.length === 1 ? picked[0] : undefined
    const tip = `Agent may start threads: ${mayCreate ? 'on' : 'off'}`
    // After the threads, a short button that opens the thread view: a Button, not a
    // Client, on every surface.
    const { Button } = $.ui.resolve(e)
    const viewButton =
      list.length === 0 ? undefined : (
        <Button key={VIEW} label="view" variant="secondary" dimColor onPress={() => openView($)} />
      )
    let band: RenderElement

    // The band is one row: the threads take the room left and give way first, the
    // controls after them keep their width. Nothing the pointer shows takes room.
    if (e.surface === 'desktop') {
      // A pill per thread, and a real switch: its picture with a hit area laid over it,
      // lit under the pointer. Pills past the room clip at its end (their hit areas with
      // them); the thread view holds every thread. Tips are cards the desktop lifts over
      // the band.
      const desktop = $.ui.resolve(e)
      const { Box, Text, Svg, Client } = desktop
      band = (
        <Box flexDirection="row" columnGap={1} alignItems="center" flexGrow={1} flexShrink={1} minWidth={0}>
          <Box flexDirection="row" columnGap={1} alignItems="center" flexShrink={1} minWidth={0} overflow="hidden">
            {list.length === 0 && (
              <Text dimColor wrap="truncate-end">
                start a thread with # name
              </Text>
            )}
            {list.map(t => {
              const isSelected = t.isSelected === true
              const isSendTarget = isSelected && sendTarget === t
              return drawPillSwitch(
                desktop,
                `chip:${keyOf(t.name)}`,
                `thread:${keyOf(t.name)}`,
                isSelected,
                isSendTarget ? `${t.name}: messages with no heading go here` : t.name,
                isHot =>
                  chipPicture(t.name, t.color, isSelected, isFiltering && !isSelected, isSendTarget, undefined, isHot),
                { flexShrink: 0 },
              )
            })}
          </Box>
          {viewButton && (
            <Box key="thread-view-tip" flexShrink={0}>
              {viewButton}
              {drawTip($, e, 'Thread view: the picked threads alone, in a pane')}
            </Box>
          )}
          <Box key="agent-switch-tip" flexShrink={0}>
            <Box>
              <Svg source={switchPicture(mayCreate)} alt={tip} width={34} height={20} />
              <Box position="absolute" top={0} left={0} width="100%" height="100%">
                <Client key={AGENT_SWITCH} module="./switch.tsx" props={{ isOn: mayCreate }} width="100%" height="100%" />
              </Box>
            </Box>
            {drawTip($, e, tip)}
          </Box>
        </Box>
      )
    } else {
      // The terminal wraps the pills in their part of the row rather than lose any,
      // and names the agent switch beside it.
      const { Box, Text, Button } = $.ui.resolve(e)
      band = (
        <Box flexDirection="row" columnGap={1} alignItems="center" flexGrow={1} flexShrink={1} minWidth={0}>
          <Box flexDirection="row" flexWrap="wrap" columnGap={1} alignItems="center" flexShrink={1} minWidth={0}>
            {list.length === 0 && <Text dimColor>start a thread with # name</Text>}
            {list.map(t => (
              <Box flexDirection="row" flexShrink={0}>
                <Text color={t.color}>●</Text>
                <Button
                  key={`thread:${keyOf(t.name)}`}
                  label={sendTarget === t ? `${t.name} ➤` : t.name}
                  variant={t.isSelected ? 'primary' : 'secondary'}
                  dimColor={isFiltering && !t.isSelected}
                  onPress={() => toggleThread($, keyOf(t.name))}
                />
              </Box>
            ))}
          </Box>
          {viewButton && <Box flexShrink={0}>{viewButton}</Box>}
          <Box flexDirection="row" columnGap={1} flexShrink={0}>
            <Text dimColor>agent threads</Text>
            <Button
              key="agent-may-create"
              label={mayCreate ? '( ●)' : '(● )'}
              variant={mayCreate ? 'primary' : 'secondary'}
              dimColor={!mayCreate}
              onPress={() => update($, agentMayCreate, may => !may)}
            />
          </Box>
        </Box>
      )
    }

    // Other mods' controls share the one row, to the right of the threads: they keep
    // their width, and the threads give way.
    if (below.type === 'engine') return band
    const { Box } = $.ui.resolve(e)
    return (
      <Box flexDirection="row" justifyContent="space-between" alignItems="center" columnGap={2}>
        {band}
        <Box flexShrink={0}>{below}</Box>
      </Box>
    )
  })
}
