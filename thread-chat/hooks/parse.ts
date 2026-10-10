// A thread heading is a level-1 heading, with or without the space:
// `# design` or `#design`. `##` and deeper stay inside the current section.
// A leading `+` (`#+design`) asks for a new thread even when one is close.
const HEADING = /^#(?!#)[ \t]*(\+?[\p{L}\p{N}][^\n]{0,47}?)[ \t#]*$/u
const FENCE = /^\s*(```|~~~)/

export const PALETTE = [
  '#4fa3e0',
  '#d9636a',
  '#58b36b',
  '#c98a2e',
  '#9b6fd6',
  '#2fb3a6',
  '#d66bb0',
  '#8a9a3a',
]

export type Section = {
  // null is the unthreaded conversation
  thread: string | null
  text: string
}

export const keyOf = (name: string) => name.trim().replace(/\s+/g, ' ').toLowerCase()

export const nameOf = (name: string) => name.trim().replace(/^\+/, '').trim().replace(/\s+/g, ' ')

// The engine's frame around a prompt a plugin submitted, still on the text where a
// surface shows the stored message (the desktop), whatever origin it gives the row.
const PLUGIN_FRAME = /^\s*The [^\n]{1,80} plugin sent a message(?: while you were working)?:[ \t]*\r?\n/

export const isPluginFramed = (text: string) => PLUGIN_FRAME.test(text)

// The multitask plugin's relay of its thoughts' updates, as a surface may hold it
// bare: its header, now or as it was first worded, ending its line, so a person's
// own words starting the same way stay theirs.
const RELAY_HEAD = /^\s*Thought updates(?::|\. Reply \(quiet\) unless something here needs you\.)[ \t]*\r?\n/

// A prompt another party sent, though a surface may name its row the person's.
export const isOthersPrompt = (text: string) => PLUGIN_FRAME.test(text) || RELAY_HEAD.test(text)

// The heading's text as written, `+` included.
function rawHeadingOf(line: string): string | undefined {
  return HEADING.exec(line.trimEnd())?.[1]
}

function headingOf(line: string): string | undefined {
  const raw = rawHeadingOf(line)
  return raw === undefined ? undefined : nameOf(raw)
}

// Every thread heading in a text, outside code fences, in order, first spelling kept.
export function headingsIn(text: string): string[] {
  const seen = new Map<string, string>()
  let isFenced = false
  for (const line of text.split('\n')) {
    if (FENCE.test(line)) isFenced = !isFenced
    if (isFenced) continue
    const name = headingOf(line)
    if (name !== undefined && !seen.has(keyOf(name))) seen.set(keyOf(name), name)
  }
  return [...seen.values()]
}

// Rewrites each thread heading outside code fences to the name `resolve`
// answers for it; a heading already spelled that way is left as typed.
export function rewriteHeadings(text: string, resolve: (raw: string) => string): string {
  let isFenced = false
  return text
    .split('\n')
    .map(line => {
      if (FENCE.test(line)) isFenced = !isFenced
      const raw = isFenced ? undefined : rawHeadingOf(line)
      if (raw === undefined) return line
      const name = resolve(raw)
      return name === nameOf(raw) && !raw.startsWith('+') ? line : `# ${name}`
    })
    .join('\n')
}

// A level-1 heading line of any length, its text starting with a letter or digit:
// a heading typed with its section's first line on the same line may run past
// what a heading may hold.
const RUN_ON = /^#(?!#)[ \t]*([\p{L}\p{N}][^\n]*)$/u
// Between a name and the words after it on its line: spaces, after a `:`, `-` or
// the like where one is typed.
const AFTER_NAME = /^(?:[ \t]*[:,;.!?\-–—])?[ \t]+/u
const escapeRegExp = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')

export type RunOn = { name: string; rest: string }

// The longest of `names` a heading's text starts with, as whole words and in any
// case, and the rest of the line after it; undefined when it starts with none, or
// nothing but marks follows the name.
export function headingStart(text: string, names: string[]): RunOn | undefined {
  const longestFirst = [...new Set(names.map(nameOf))].filter(n => n !== '').sort((a, b) => b.length - a.length)
  for (const name of longestFirst) {
    const words = name.split(' ').map(escapeRegExp).join('\\s+')
    const start = new RegExp(`^${words}`, 'iu').exec(text)
    if (start === null) continue
    const after = text.slice(start[0].length)
    const gap = AFTER_NAME.exec(after)
    if (gap === null) continue
    const rest = after.slice(gap[0].length).trimEnd()
    if (/[\p{L}\p{N}]/u.test(rest)) return { name: nameOf(start[0]), rest }
  }
  return undefined
}

// Splits each level-1 heading line outside code fences that `split` finds typed
// with its section's first line on it: the name it answers stays the heading and
// the rest of the line goes on the line below.
export function splitRunOns(text: string, split: (typed: string) => RunOn | undefined): string {
  let isFenced = false
  return text
    .split('\n')
    .map(line => {
      if (FENCE.test(line)) isFenced = !isFenced
      const typed = isFenced ? undefined : RUN_ON.exec(line.trimEnd())?.[1]
      const runOn = typed === undefined ? undefined : split(typed)
      return runOn === undefined ? line : `# ${runOn.name}\n${runOn.rest}`
    })
    .join('\n')
}

const squash = (name: string) => name.toLowerCase().replace(/[^\p{L}\p{N}]/gu, '')

function distance(a: string, b: string): number {
  let row = Array.from({ length: b.length + 1 }, (_, i) => i)
  for (let i = 1; i <= a.length; i++) {
    const next = [i]
    for (let j = 1; j <= b.length; j++) {
      const swap = (row[j - 1] ?? 0) + (a[i - 1] === b[j - 1] ? 0 : 1)
      next[j] = Math.min((row[j] ?? 0) + 1, (next[j - 1] ?? 0) + 1, swap)
    }
    row = next
  }
  return row[b.length] ?? 0
}

// The one candidate a typed name most likely means: the same name spelled
// differently, the start of exactly one (3+ characters), or a near miss
// (1 typo from 4 characters, 2 from 8). Undefined when none, or a tie.
export function closestThread(name: string, candidates: string[]): string | undefined {
  const wanted = squash(name)
  if (wanted === '') return undefined
  const same = candidates.find(c => squash(c) === wanted)
  if (same !== undefined) return same

  if (wanted.length >= 3) {
    const starting = candidates.filter(c => squash(c).startsWith(wanted))
    if (starting.length === 1) return starting[0]
  }

  const limit = wanted.length >= 8 ? 2 : wanted.length >= 4 ? 1 : 0
  const near = candidates
    .map(c => ({ c, d: distance(wanted, squash(c)) }))
    .filter(x => x.d <= limit)
    .sort((x, y) => x.d - y.d)
  if (near.length === 0 || (near.length > 1 && near[1]?.d === near[0]?.d)) return undefined
  return near[0]?.c
}

// Splits a message into sections. A heading `isThread` accepts opens that
// thread's section (the heading line itself is dropped: the drawing labels it);
// any other level-1 heading returns to the unthreaded conversation and is kept.
export function splitSections(text: string, isThread: (name: string) => boolean): Section[] {
  const sections: Section[] = []
  let current: { thread: string | null; lines: string[] } = { thread: null, lines: [] }
  let isFenced = false

  const close = () => {
    const body = current.lines.join('\n').trim()
    if (current.thread !== null || body !== '') sections.push({ thread: current.thread, text: body })
  }

  for (const line of text.split('\n')) {
    if (FENCE.test(line)) isFenced = !isFenced
    const name = isFenced ? undefined : headingOf(line)
    if (name === undefined) {
      current.lines.push(line)
      continue
    }
    close()
    current = isThread(name) ? { thread: name, lines: [] } : { thread: null, lines: [line] }
  }
  close()

  return sections
}

// The desktop's reply to a selected part of a message: a marker line, the selection
// quoted line by line (`> `), then the person's words on it. The first marker counts
// the blocks (`<!-- reply 2 -->`), later ones are bare; an older desktop wrote one bare.
const REPLY_MARKER = /^<!-- reply(?: [1-9][0-9]?)? -->$/
const QUOTED = /^>(?: |$)/

// The selections a message quotes as replies to parts of earlier messages, in order,
// each as selected (its `> ` gone); none for a message that is no such reply.
export function replyQuotesOf(text: string): string[] {
  if (!text.includes('<!-- reply')) return []
  const lines = text.split(/\r?\n/)
  const quotes: string[] = []
  for (let at = 0; at < lines.length; at++) {
    if (!REPLY_MARKER.test(lines[at] ?? '')) continue
    const quoted: string[] = []
    while (QUOTED.test(lines[at + 1] ?? '')) quoted.push((lines[++at] ?? '').replace(/^> ?/, ''))
    const quote = quoted.join('\n').trim()
    if (quote !== '') quotes.push(quote)
  }
  return quotes
}

export type LeadingQuote = { quote: string; rest: string }

// The replies to selected parts a text opens with (their markers, quoted lines and the
// blank lines between them), and the rest of it from the first other line; none where
// it opens with no quoted selection. The lines are kept as typed, line ends and all.
export function leadingQuoteOf(text: string): LeadingQuote | undefined {
  const lines = text.split('\n')
  let end = 0
  let isQuoting = false
  let hasQuote = false
  for (const [at, line] of lines.entries()) {
    const bare = line.trimEnd()
    if (REPLY_MARKER.test(bare)) {
      isQuoting = true
    } else if (isQuoting && QUOTED.test(bare)) {
      hasQuote = true
    } else if (bare.trim() === '') {
      isQuoting = false
      continue
    } else {
      break
    }
    end = at + 1
  }
  if (!hasQuote) return undefined
  return { quote: lines.slice(0, end).join('\n').trim(), rest: lines.slice(end).join('\n').trim() }
}

// A person's sections with a quoted selection that opens the message, right before its
// first thread heading, in that heading's section, the quote first: they replied to it
// there. `isThread` tells whether a heading means a thread; the opening text stays
// unthreaded where the heading means none, or where it holds words of their own.
export function withOpeningQuote(sections: Section[], isThread: (name: string) => boolean): Section[] {
  const [first, next, ...rest] = sections
  if (first === undefined || next === undefined || first.thread !== null || next.thread === null) return sections
  if (!isThread(next.thread) || leadingQuoteOf(first.text)?.rest !== '') return sections
  return [{ thread: next.thread, text: `${first.text}\n\n${next.text}`.trim() }, ...rest]
}

// A text in the letters and digits a reader sees of it drawn: a selection of drawn
// Markdown lacks its marks, link targets, list numbers and fence lines, and may join
// or split its lines.
function seenOf(text: string): string {
  return squash(
    text
      .replace(/^\s*(```|~~~).*$/gm, '')
      .replace(/^\s*(?:[-*+]|\d+[.)])\s+/gm, '')
      .replace(/\]\([^)]*\)/g, ']'),
  )
}

// Whether `text` holds what a reader quoted from it as drawn.
export function holdsQuote(text: string, quote: string): boolean {
  const wanted = seenOf(quote)
  return wanted !== '' && seenOf(text).includes(wanted)
}
