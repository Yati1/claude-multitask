import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register, RenderElement } from 'claude-code'

import type { Thread } from '../types'
import {
  PALETTE,
  closestThread,
  headingsIn,
  keyOf,
  nameOf,
  rewriteHeadings,
  splitSections,
} from './parse'
import type { Section } from './parse'

const threads = atom({ plugin: 'thread-chat', key: 'threads' } as const, [])
const aliases = atom({ plugin: 'thread-chat', key: 'aliases' } as const, {})
const agentMayCreate = atom({ plugin: 'thread-chat', key: 'agentMayCreate' } as const, false)
const snaps = atom({ plugin: 'thread-chat', key: 'snaps' } as const, {})
const recent = atom({ plugin: 'thread-chat', key: 'recent' } as const, [])
const recentTexts = atom({ plugin: 'thread-chat', key: 'recentTexts' } as const, [])
const sentTo = atom({ plugin: 'thread-chat', key: 'sentTo' } as const, {})

const CREATE_TOOL = 'mcp__thread-chat__create_thread'
const AGENT_SWITCH = 'agent-switch'

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

// What the headings of a prompt mean: the thread names, in order, and each
// heading not written as its thread's exact name (a typo, a start of a name,
// `+name`) as typed with the thread it means. A heading may also mean a thread
// introduced earlier in the same prompt.
function decideHeadings(text: string, list: Thread[], links: Record<string, string>) {
  let known = list
  const meanings: { typed: string; meant: string }[] = []
  const resolved = rewriteHeadings(text, raw => {
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
  }
  await $.store.set(storeKey(await $.session.id()), saved)
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

// Messages sent with no heading to the one picked thread, until their rows are stored.
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
      const moved = await $.ui.scroll({ to: { requestId: id }, block: 'end' })
      if (moved.deny === undefined || /person|not scrollable/.test(moved.deny)) return
    }
  } catch {
    return
  }
}

// The decisions in `meanings` as links from a typed heading's key to its thread's.
function linksOf(meanings: { typed: string; meant: string }[]): Record<string, string> {
  return Object.fromEntries(
    meanings.map(m => [keyOf(nameOf(m.typed)), keyOf(m.meant)]).filter(([typed, meant]) => typed !== meant),
  )
}

function protocol(list: Thread[], merged: Record<string, string>, mayCreate: boolean): string {
  const names = list.length === 0 ? 'none yet' : list.map(t => `"${t.name}"`).join(', ')
  const mergedNames = Object.entries(merged).map(([from, to]) => `"${from}" is now "${to}"`)
  return [
    '# Conversation threads',
    'This conversation can hold several threads at once. The user starts or replies to a thread with a level-1 heading in their message: `# name` or `#name` (with or without the space). Text before the first heading is the unthreaded conversation. A heading may be abbreviated or mistyped, or written `#+name` to start a new thread; a note beside the message then says which thread each heading means.',
    'Reply the same way. Put what belongs to a thread under a level-1 heading carrying that thread\'s exact name, one section per thread the user wrote to; keep unthreaded material before any thread heading. Use `##` or deeper for structure inside a section: a level-1 heading that is not a thread name drops back into the unthreaded conversation.',
    `Threads so far: ${names}.`,
    ...(mergedNames.length === 0 ? [] : [`Merged threads (an old heading means the new one): ${mergedNames.join('; ')}.`]),
    mayCreate
      ? `You may start a new thread with ${CREATE_TOOL} when a distinct topic deserves its own thread, then write to it under its heading. Do it sparingly.`
      : `Do not start new threads yourself; the user has not enabled that (${CREATE_TOOL} will refuse).`,
  ].join('\n\n')
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
// against the edge the tag aligns to.
function tagPicture(name: string, color: string, align: 'start' | 'end') {
  const label = name.toUpperCase()
  // Roomier than the guess: the text keeps to its edge, so spare width never shows.
  const width = Math.ceil(tagWidth(label, CHAT_TAG_SIZE) * 1.25)
  const height = 12
  const x = align === 'end' ? width : 0
  const source =
    `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}">` +
    `<text x="${x}" y="9.5" text-anchor="${align}" ${TAG_FONT} font-size="${CHAT_TAG_SIZE}" font-weight="600"` +
    ` letter-spacing="${TAG_SPACING}" fill="${color}">${escapeXml(label)}</text></svg>`
  return { source, width, height }
}

// The SVG of a thread's filter pill: one row high, its coloured dot and tag inside,
// outlined and tinted in the thread's colour when picked, faded when another is,
// and with an arrow after the tag when it alone is picked: messages with no
// heading go to it.
function chipPicture(name: string, color: string, isSelected: boolean, isDimmed: boolean, isSendTarget: boolean) {
  const label = name.toUpperCase()
  const text = tagWidth(label, PILL_TAG_SIZE * (isSelected ? 1.03 : 1))
  const arrowAt = 19 + text + 5
  const width = isSendTarget ? arrowAt + 8 + 8 : 19 + text + 9
  const h = CHIP_HEIGHT
  const fill = isSelected ? `fill="${color}" fill-opacity="0.2" stroke="${color}" stroke-width="1.5"` : 'class="bg"'
  const source = [
    `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${h}" viewBox="0 0 ${width} ${h}"${isDimmed ? ' opacity="0.45"' : ''}>`,
    '<style>.bg{fill:#ffffff14;stroke:#ffffff38}.t{fill:#e6e6e6}',
    '@media (prefers-color-scheme: light){.bg{fill:#0000000a;stroke:#00000038}.t{fill:#1f1f1f}}</style>',
    `<rect ${fill} x="0.75" y="0.75" width="${width - 1.5}" height="${h - 1.5}" rx="${(h - 1.5) / 2}"/>`,
    `<circle cx="10.5" cy="${h / 2}" r="3" fill="${color}"/>`,
    `<text class="t" x="19" y="${h / 2 + 3.8}" ${TAG_FONT} font-size="${PILL_TAG_SIZE}"`,
    ` font-weight="${isSelected ? 700 : 600}" letter-spacing="${TAG_SPACING}">${escapeXml(label)}</text>`,
    isSendTarget
      ? `<path d="M${arrowAt} ${h / 2 - 4}L${arrowAt + 8} ${h / 2}L${arrowAt} ${h / 2 + 4}L${arrowAt + 2} ${h / 2}Z" fill="${color}"/>`
      : '',
    '</svg>',
  ].join('')
  return { source, width }
}

// A thread's name as a tag: small capitals in its colour, a picture where the
// surface draws one, its capitals alone on the terminal.
function drawTag(
  $: EngineInterface,
  e: Parameters<EngineInterface['ui']['resolve']>[0],
  thread: { name: string; color: string },
  align: 'start' | 'end',
): RenderElement {
  if (e.surface === 'terminal') {
    const { Text } = $.ui.resolve(e)
    return <Text color={thread.color}>{thread.name.toUpperCase()}</Text>
  }
  const { Svg } = $.ui.resolve(e)
  const tag = tagPicture(thread.name, thread.color, align)
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

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
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

    // A restarted or resumed session takes up the threads it kept.
    if ((await read($, threads)).length === 0) {
      const saved = (await $.store.get(storeKey(await $.session.id()))) as Partial<Saved> | undefined
      if (saved?.threads !== undefined) {
        const kept = saved.threads.map(t => ({ ...t, isSelected: false }))
        await update($, threads, () => kept)
        await update($, aliases, () => saved.aliases ?? {})
        await update($, snaps, () => saved.snaps ?? {})
        await update($, recent, () => saved.recent ?? [])
        await update($, recentTexts, () => saved.recentTexts ?? [])
        await update($, sentTo, () => saved.sentTo ?? {})
      }
    } else {
      // Threads made before saving existed (or since the last save) are kept now.
      await save($)
    }

    return next(e)
  })

  on('prompt.submit', async ($, e, next) => {
    if (!PERSON.has(e.origin.kind)) return next(e)
    // The text goes on as typed, the one version everything reads; what its
    // headings mean is decided now, kept for drawing it, and told to the model.
    const links = { ...(await read($, snaps)), ...(await read($, aliases)) }
    const list = await read($, threads)
    const { names, meanings } = decideHeadings(e.text, list, links)
    if (names.length === 0) {
      // With one thread alone picked, a message with no heading goes to that thread.
      const picked = list.filter(t => t.isSelected)
      const only = picked.length === 1 ? picked[0] : undefined
      if (only === undefined) return next(e)
      unsent.push({ text: e.text.trim(), key: keyOf(only.name) })
      const note = `This message belongs to the thread "${only.name}": the user wrote it while viewing that thread alone. Reply to it under that thread's heading.`
      return next({ ...e, context: [...(e.context ?? []), note] })
    }
    await addThreads($, names, 'user')
    const decided = linksOf(meanings)
    if (Object.keys(decided).length > 0) await update($, snaps, all => ({ ...all, ...decided }))
    await save($)
    if (meanings.length === 0) return next(e)

    const note = `Thread headings in this message, as the user meant them: ${meanings
      .map(m => (m.typed.startsWith('+') ? `"#${m.typed}" starts the new thread "${m.meant}"` : `"#${m.typed}" is the thread "${m.meant}"`))
      .join('; ')}.`
    return next({ ...e, context: [...(e.context ?? []), note] })
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
    return next(e)
  })

  // A turn's rows are kept for the session's next run as the turn ends.
  on('turn.complete', async ($, e, next) => {
    const result = await next(e)
    if (e.agentId === undefined && (await read($, threads)).length > 0) await save($)
    return result
  })

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

  on('tool.call', { tool: 'mcp__thread-chat__create_thread' }, async ($, e) => {
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

  on('prompt.compose', async ($, e, next) => {
    const composed = await next(e)
    const section = {
      id: 'thread-chat',
      text: protocol(await read($, threads), await read($, aliases), await read($, agentMayCreate)),
      scope: 'session' as const,
    }
    return { ...composed, sections: [...composed.sections, section] }
  })

  // The band's chips and switch post here when clicked.
  on('ui.message', async ($, e, next) => {
    if ((e.data as { flip?: unknown } | null)?.flip === true) {
      if (e.element === AGENT_SWITCH) await update($, agentMayCreate, may => !may)
      else if (e.element.startsWith('thread:')) await toggleThread($, e.element.slice('thread:'.length))
    }
    return next(e)
  })

  // The person's message stays the engine's own drawing (its images and all):
  // its thread tags go above it in their colours, its heading lines go, and a
  // filter trims its text to the picked threads' sections.
  on('ui.render', { component: 'UserMessage' }, async ($, e, next) => {
    if (!PERSON.has(e.props.origin.kind)) {
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
    const typed = splitSections(e.props.text, () => true)
    // A message with no heading may have gone to the one thread picked as it was sent.
    const sentThread = typed.some(s => s.thread !== null) ? undefined : await sentThreadOf($, e.requestId, list, merged)
    const sections = sentThread === undefined ? typed : [{ thread: sentThread.name, text: e.props.text }]
    if (selected.size === 0 && !sections.some(s => s.thread !== null)) return next(e)

    const { Box } = $.ui.resolve(e)
    const isRecentRow = selected.size > 0 && (await isRecent($, [e.requestId]))
    const shown = sections.filter(s => isShown(s, selected, resolve, isRecentRow))
    if (shown.length === 0) return <Box display="none" />

    const text = bubbleText(shown, resolve) || e.props.text
    const message = await next(text === e.props.text ? e : { ...e, props: { ...e.props, text } })

    const tags = [
      ...new Map(
        shown.flatMap(s => {
          const thread = s.thread === null ? undefined : resolve(s.thread)
          return thread === undefined ? [] : [[keyOf(thread.name), thread] as const]
        }),
      ).values(),
    ]
    if (tags.length === 0) return message
    // Where the surface puts the person's messages on the right, the tags go there too.
    const isOnRight = e.surface === 'desktop' || e.surface === 'mobile'

    return (
      <Box flexDirection="column">
        <Box flexDirection="row" columnGap={2} justifyContent={isOnRight ? 'flex-end' : 'flex-start'}>
          {tags.map(t => drawTag($, e, t, isOnRight ? 'end' : 'start'))}
        </Box>
        {message}
      </Box>
    )
  })

  // A reply is drawn a section at a time by the engine, as it draws any reply;
  // each thread's section sits in a box of its colour under its name.
  on('ui.render', { component: 'AssistantMessage' }, async ($, e, next) => {
    const list = await read($, threads)
    if (list.length === 0) return next(e)
    const merged = await read($, aliases)
    const selected = await selectedKeys($)
    const sections = splitSections(e.props.text, name => threadOf(name, list, merged) !== undefined)
    if (selected.size === 0 && !sections.some(s => s.thread !== null)) return next(e)

    const { Box } = $.ui.resolve(e)
    const isRecentRow = selected.size > 0 && (await isRecentReply($, e.requestId, e.props.text))
    const shown = sections.filter(s => isShown(s, selected, name => threadOf(name, list, merged), isRecentRow))
    if (shown.length === 0) return <Box display="none" />

    // A screen gets one message's text with a drawing, so the engine draws one part
    // of the reply; the other parts are drawn as markdown, as a reply's text is.
    const parts: RenderElement[] = []
    let isEngineDrawn = false
    for (const [i, s] of shown.entries()) {
      const isFirstOfReply = e.props.isFirstOfReply && i === 0 && s.thread === null
      let body: RenderElement | undefined
      if (s.text !== '' && !isEngineDrawn) {
        body = await next({ ...e, props: { ...e.props, text: s.text, isFirstOfReply } })
        isEngineDrawn = true
      } else if (s.text !== '') {
        body = drawMarkdown($, e, s.text)
      }
      if (s.thread === null) {
        if (body !== undefined) parts.push(body)
        continue
      }
      const thread = threadOf(s.thread, list, merged)
      const color = thread?.color ?? '#888888'
      parts.push(
        <Box flexDirection="column" borderStyle="round" borderColor={color} paddingX={1}>
          {drawTag($, e, { name: thread?.name ?? s.thread, color }, 'start')}
          {body}
        </Box>,
      )
    }
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
    let band: RenderElement

    if (e.surface === 'desktop') {
      // A pill per thread, and a real switch: its picture with a hit area laid over it.
      const { Box, Text, Svg, Client } = $.ui.resolve(e)
      band = (
        <Box flexDirection="row" flexWrap="wrap" columnGap={1} alignItems="center">
          {list.length === 0 && <Text dimColor>start a thread with # name</Text>}
          {list.map(t => {
            const isSelected = t.isSelected === true
            const isSendTarget = isSelected && sendTarget === t
            const pill = chipPicture(t.name, t.color, isSelected, isFiltering && !isSelected, isSendTarget)
            return (
              <Box key={`chip:${keyOf(t.name)}`}>
                <Svg
                  source={pill.source}
                  alt={isSendTarget ? `${t.name}: messages with no heading go here` : t.name}
                  width={pill.width}
                  height={CHIP_HEIGHT}
                />
                <Box position="absolute" top={0} left={0} width="100%" height="100%">
                  <Client key={`thread:${keyOf(t.name)}`} module="./switch.tsx" props={{ isOn: isSelected }} width="100%" height="100%" />
                </Box>
              </Box>
            )
          })}
          <Box key="agent-switch-tip" flexDirection="row" alignItems="center" columnGap={1}>
            <Box>
              <Svg source={switchPicture(mayCreate)} alt={tip} width={34} height={20} />
              <Box position="absolute" top={0} left={0} width="100%" height="100%">
                <Client key={AGENT_SWITCH} module="./switch.tsx" props={{ isOn: mayCreate }} width="100%" height="100%" />
              </Box>
            </Box>
            <Box display="none" hover={{ display: 'flex' }}>
              <Text dimColor>{tip}</Text>
            </Box>
          </Box>
        </Box>
      )
    } else {
      const { Box, Text, Button } = $.ui.resolve(e)
      band = (
        <Box flexDirection="row" flexWrap="wrap" columnGap={1} alignItems="center">
          {list.length === 0 && <Text dimColor>start a thread with # name</Text>}
          {list.map(t => (
            <Box flexDirection="row">
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
          <Box key="agent-switch-tip" flexDirection="row">
            <Button
              key="agent-may-create"
              label={mayCreate ? '( ●)' : '(● )'}
              variant={mayCreate ? 'primary' : 'secondary'}
              dimColor={!mayCreate}
              onPress={() => update($, agentMayCreate, may => !may)}
            />
            <Box display="none" hover={{ display: 'flex' }} paddingX={1}>
              <Text dimColor>{tip}</Text>
            </Box>
          </Box>
        </Box>
      )
    }

    // Other mods' controls share the row, to the right of the threads.
    if (below.type === 'engine') return band
    const { Box } = $.ui.resolve(e)
    return (
      <Box flexDirection="row" flexWrap="wrap" justifyContent="space-between" alignItems="center" columnGap={2}>
        {band}
        {below}
      </Box>
    )
  })
}
