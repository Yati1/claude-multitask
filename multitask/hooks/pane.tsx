import type { Color, ElementTable, RenderElement, RenderSurface } from 'claude-code'

import type { Thought, ThoughtStatus } from '../types'
import { oneLine } from './prompts'

// The Thoughts pane: running thoughts first, each a card in its colour's border; the
// rest one line each, the one most recently ended first, until opened. A card sets
// each kind of line apart by a label at its left: the task, the progress notes (the
// latest at full strength with its age, in the warning colour once the thought has
// been quiet a while), the report, and the messages queued for its turn's end. A card's
// `tell` opens a field at its foot to send the thought a message of the person's own.
//
// It is drawn as the thread view is (thread-chat's pane.tsx): plain functions here,
// every hook and every call on `$` in register.tsx, which hands them what they draw
// with. A plugin hooks an event once without a matcher, and the engine follows `$`
// only into functions of the file that uses it.

const GLYPH: Record<ThoughtStatus, string> = { running: '◐', idle: '○', stopped: '×', failed: '!' }

// What each status reads as: a turn that ended is done, though a message resumes it.
const STATUS_WORD: Record<ThoughtStatus, string> = { running: 'running', idle: 'done', stopped: 'stopped', failed: 'failed' }

// The order thoughts are listed in: running ones, then those that failed, then done,
// then stopped.
const RANK: Record<ThoughtStatus, number> = { running: 0, failed: 1, idle: 2, stopped: 3 }

// How long a running thought may go without a note, or since its turn started, before
// its age is drawn in the warning colour.
export const QUIET_MS = 5 * 60_000

// Notes a card shows, at most: folded, and opened.
const NOTES_FOLDED = 3
const NOTES_OPENED = 5

// The most of a report drawn when opened: what one Markdown element takes.
const REPORT_MAX = 10_000

// Cells the labels at a card's left take, the gap after them included.
const LABEL_COLUMNS = 7

// How a thought's colour is drawn: as it is, or dim (see drawThoughts).
type Tint = { color: Color; dimColor?: true }

// The key of a card's field to tell its thought something: this, then the thought's id.
export const TELL_FIELD = 'tell-field:'

// A card's padding inside its border, as the thread view pads a reply's thread part: on
// the desktop on every side (a bordered Box there is padded 8px above and below unless
// told otherwise); on the terminal, where a row is a whole line, at the sides alone.
const DESKTOP_CARD_PADDING = { padding: 1 } as const
const CARD_PADDING = { paddingX: 1 } as const

// A span of time, short: under a minute, minutes, hours and minutes, or days.
export function spanOf(ms: number): string {
  const minutes = Math.floor(Math.max(0, ms) / 60_000)
  if (minutes < 1) return '<1m'
  if (minutes < 60) return `${minutes}m`
  const hours = Math.floor(minutes / 60)
  if (hours < 10) return minutes % 60 === 0 ? `${hours}h` : `${hours}h ${minutes % 60}m`
  if (hours < 48) return `${hours}h`
  return `${Math.floor(hours / 24)}d`
}

// How long ago a time was, as the pane says it.
export const agoOf = (ms: number) => (ms < 60_000 ? 'just now' : `${spanOf(ms)} ago`)

// A task's first line, which a running card shows until it is opened.
export function firstLine(task: string): string {
  return task.trimStart().split('\n')[0]?.trimEnd() ?? ''
}

// The thoughts in the order the pane lists them: running ones as they were started,
// the rest the one most recently ended first.
export function orderOf(list: readonly Thought[]): Thought[] {
  return list
    .map((t, i) => ({ t, i }))
    .sort((a, b) => {
      const rank = RANK[a.t.status] - RANK[b.t.status]
      if (rank !== 0) return rank
      if (a.t.status === 'running') return a.i - b.i
      return (b.t.endedAt ?? 0) - (a.t.endedAt ?? 0) || b.i - a.i
    })
    .map(({ t }) => t)
}

// Whether a thought's report is shown: once it has one and has stopped working, and
// unless it wrote notes since (an old report would read as the result of new work).
export const showsReport = (t: Thought) => t.lastText !== '' && t.status !== 'running' && t.notedSinceReport !== true

// How long a running thought has gone without a note, or since its turn started if
// that came later; none where neither time is known.
export function quietFor(t: Thought, now: number | undefined): number | undefined {
  const times = [t.notedAt, t.startedAt].filter((at): at is number => at !== undefined)
  return times.length === 0 || now === undefined ? undefined : now - Math.max(...times)
}

// How long ago `at` was, as agoOf says it; none where either time is not known.
const agoSince = (at: number | undefined, now: number | undefined) =>
  at === undefined || now === undefined ? undefined : agoOf(now - at)

// What the pane is drawn with, as register.tsx reads it while drawing: the surface and
// its elements, the time (none where it cannot be read: no ages are drawn), the pane's
// width, which thoughts and reports are opened, and what each control does.
export type ThoughtsDrawing = {
  surface: RenderSurface
  ui: ElementTable
  now: number | undefined
  isOn: boolean
  bodyColumns: number
  opened: readonly string[]
  shownReports: readonly string[]
  toggleExpanded: (id: string) => void
  toggleReport: (id: string) => void
  stop: (id: string) => void
  unqueue: (id: string, index: number) => void
  // the thought whose card has its field open ('' none), what opens or closes it, and
  // what Enter there sends, should the pane's ui.input hook not take it first
  tellingTo: string
  toggleTell: (id: string) => void
  tell: (id: string, text: string) => void
}

// The field a card's thought is told something in, where the surface draws one (the
// mobile app draws none yet, though its table may hand one over) while Multitask is on:
// off, a thought whose turn ended cannot be resumed.
function tellFieldOf(draw: ThoughtsDrawing) {
  if (!draw.isOn || draw.surface === 'mobile' || !('Input' in draw.ui)) return undefined
  return draw.ui.Input
}

// The pane's body: a line of how many thoughts there are, by status, then each one.
export function drawThoughts(draw: ThoughtsDrawing, list: readonly Thought[]): RenderElement {
  const { Box, Text } = draw.ui
  const counts = (['running', 'failed', 'idle', 'stopped'] as const)
    .map(status => ({ status, count: list.filter(t => t.status === status).length }))
    .filter(c => c.count > 0)
    .map(c => `${c.count} ${STATUS_WORD[c.status]}`)
  const summary = list.length === 0 ? 'No thoughts yet.' : counts.join(' · ')
  // Only running thoughts hold their colours: one that ended keeps its own, dimmed while a
  // running thought has taken it, so the two are not mistaken for each other.
  const held = new Set(list.filter(t => t.status === 'running').map(t => t.color))
  const tintOf = (t: Thought): Tint => ({ color: t.color, ...(t.status !== 'running' && held.has(t.color) && { dimColor: true }) })
  return (
    <Box flexDirection="column">
      <Box marginBottom={1}>
        <Text dimColor>
          Multitask is {draw.isOn ? 'on' : 'off'} · {summary}
        </Text>
      </Box>
      {orderOf(list).map(t =>
        t.status !== 'running' && !draw.opened.includes(t.id) ? drawLine(draw, t, tintOf(t)) : drawCard(draw, t, tintOf(t)),
      )}
    </Box>
  )
}

// What a thought's status says, in its colour, with how long it has been so: running
// for how long its turn has run, else how long ago it ended.
function drawStatus(draw: ThoughtsDrawing, t: Thought): RenderElement {
  const { Text } = draw.ui
  const at = t.status === 'running' ? t.startedAt : t.endedAt
  const { now } = draw
  const age = at === undefined || now === undefined ? '' : t.status === 'running' ? ` for ${spanOf(now - at)}` : ` ${agoOf(now - at)}`
  const look: { color?: Color; dimColor?: boolean } =
    t.status === 'running' ? { color: t.color } : t.status === 'failed' ? { color: 'error' } : { dimColor: true }
  return (
    <Text {...look} wrap="truncate-end">
      {STATUS_WORD[t.status]}
      {age}
    </Text>
  )
}

// A thought that is not running, folded to one line: its name, status, its report's
// first line, and stop.
function drawLine(draw: ThoughtsDrawing, t: Thought, tint: Tint): RenderElement {
  const { Box, Text, Button } = draw.ui
  return (
    <Box key={`line:${t.id}`} flexDirection="row" columnGap={1} alignItems="center">
      <Box flexShrink={0}>
        <Text {...tint}>{GLYPH[t.status]}</Text>
      </Box>
      <Box flexShrink={0}>
        <Button key={`expand:${t.id}`} plain label={t.name} hover={tint} onPress={() => draw.toggleExpanded(t.id)} />
      </Box>
      <Box flexShrink={0}>{drawStatus(draw, t)}</Box>
      <Box flexGrow={1} flexShrink={1} minWidth={0}>
        {showsReport(t) && (
          <Text dimColor wrap="truncate-end">
            {oneLine(t.lastText, 200)}
          </Text>
        )}
      </Box>
      {t.status !== 'stopped' && (
        <Box flexShrink={0}>
          <Button key={`stop:${t.id}`} plain dimColor hover={tint} label="stop" onPress={() => draw.stop(t.id)} />
        </Box>
      )}
    </Box>
  )
}

// One kind of a card's lines under its label: the label on the first line alone, dim
// or in `tint`, the lines beside it, `gap` rows below what is above.
function drawSection(draw: ThoughtsDrawing, label: string, lines: RenderElement[], gap: number, tint?: Tint): RenderElement {
  const { Box, Text } = draw.ui
  return (
    <Box flexDirection="row" marginTop={gap}>
      <Box width={LABEL_COLUMNS} flexShrink={0}>
        <Text {...(tint ?? { dimColor: true })}>{label}</Text>
      </Box>
      <Box flexDirection="column" flexGrow={1} flexShrink={1} minWidth={0}>
        {lines}
      </Box>
    </Box>
  )
}

// A thought's card: its name, status and controls; then its task, its notes, its
// report and its queue, each kind under its label.
function drawCard(draw: ThoughtsDrawing, t: Thought, tint: Tint): RenderElement {
  const { Box, Text, Button, Markdown } = draw.ui
  const Input = t.status === 'stopped' ? undefined : tellFieldOf(draw)
  const isTelling = Input !== undefined && draw.tellingTo === t.id
  const isPage = draw.surface !== 'terminal'
  // half a line between kinds on a page; none on the terminal, where the labels part them
  const gap = isPage ? 1 : 0
  const isOpened = draw.opened.includes(t.id)
  const isRunning = t.status === 'running'
  // Cells a card's task line has: the pane's body less the card's border and padding and the labels.
  const taskColumns = draw.bodyColumns - 4 - LABEL_COLUMNS
  const task = firstLine(t.task)
  const hasMore = isRunning && (t.task.trim() !== task || task.length > taskColumns)
  const control = { plain: true, dimColor: true, hover: tint } as const

  const notes = (t.notes ?? []).slice(isOpened ? -NOTES_OPENED : -NOTES_FOLDED)
  const quiet = isRunning ? quietFor(t, draw.now) : undefined
  const isQuiet = quiet !== undefined && quiet >= QUIET_MS
  const noteAge = agoSince(t.notedAt, draw.now)
  const noteLines = notes.map((note, i) => {
    const isLatest = i === notes.length - 1
    const text = isOpened ? note : oneLine(note, 200)
    const wrap = isOpened ? 'wrap' : 'truncate-end'
    if (!isLatest) {
      return (
        <Text dimColor wrap={wrap}>
          {text}
        </Text>
      )
    }
    return (
      <Box flexDirection="row" columnGap={2}>
        <Box flexGrow={1} flexShrink={1} minWidth={0}>
          <Text wrap={wrap}>{text}</Text>
        </Box>
        {noteAge !== undefined && (
          <Box flexShrink={0}>
            <Text {...(isQuiet ? { color: 'warning' } : { dimColor: true })}>{noteAge}</Text>
          </Box>
        )}
      </Box>
    )
  })
  // A running thought with no notes yet says how long it has been at it.
  const started = agoSince(t.startedAt, draw.now)
  if (noteLines.length === 0 && isRunning && started !== undefined) {
    noteLines.push(
      <Text {...(isQuiet ? { color: 'warning' } : { dimColor: true })} wrap="truncate-end">
        none yet, started {started}
      </Text>,
    )
  }

  const isReportShown = draw.shownReports.includes(t.id)
  const report = showsReport(t) && (
    <Box key={`reportbox:${t.id}`} flexDirection="column">
      {isReportShown && <Markdown text={t.lastText.length > REPORT_MAX ? `${t.lastText.slice(0, REPORT_MAX - 1)}…` : t.lastText} />}
      <Box flexDirection="row" columnGap={1}>
        {!isReportShown && (
          <Box flexGrow={1} flexShrink={1} minWidth={0}>
            <Text wrap="truncate-end">{oneLine(t.lastText, 200)}</Text>
          </Box>
        )}
        {/* Lit in the thought's colour with the pointer anywhere on the report; the line gives way, not it. */}
        <Box flexShrink={0}>
          <Button
            key={`report:${t.id}`}
            plain
            dimColor
            hover={tint}
            label={isReportShown ? 'less' : 'more'}
            onPress={() => draw.toggleReport(t.id)}
          />
        </Box>
      </Box>
    </Box>
  )

  const queued = t.queued.map((q, i) => (
    <Box flexDirection="row" columnGap={1}>
      <Box flexShrink={0}>
        <Text dimColor>{i + 1}.</Text>
      </Box>
      <Box flexGrow={1} flexShrink={1} minWidth={0}>
        <Text wrap={isOpened ? 'wrap' : 'truncate-end'}>{isOpened ? q : oneLine(q, 200)}</Text>
      </Box>
      <Box flexShrink={0}>
        <Button key={`unqueue:${t.id}:${i}`} {...control} label="unqueue" onPress={() => draw.unqueue(t.id, i)} />
      </Box>
    </Box>
  ))

  return (
    <Box
      key={`card:${t.id}`}
      flexDirection="column"
      borderStyle="round"
      borderColor={tint.color}
      {...(tint.dimColor && { borderDimColor: true })}
      {...(draw.surface === 'desktop' ? DESKTOP_CARD_PADDING : CARD_PADDING)}
      marginBottom={1}
    >
      <Box flexDirection="row" columnGap={1} alignItems="center">
        <Box flexShrink={0}>
          <Text {...tint} bold>
            {GLYPH[t.status]}
          </Text>
        </Box>
        <Box flexShrink={0}>
          <Button key={`expand:${t.id}`} plain label={t.name} hover={tint} onPress={() => draw.toggleExpanded(t.id)} />
        </Box>
        <Box flexGrow={1} flexShrink={1} minWidth={0}>
          {drawStatus(draw, t)}
        </Box>
        {hasMore && (
          <Box flexShrink={0}>
            <Button key={`more:${t.id}`} {...control} label={isOpened ? 'less' : 'more'} onPress={() => draw.toggleExpanded(t.id)} />
          </Box>
        )}
        {!isRunning && (
          <Box flexShrink={0}>
            <Button key={`collapse:${t.id}`} {...control} label="hide" onPress={() => draw.toggleExpanded(t.id)} />
          </Box>
        )}
        {Input !== undefined && (
          <Box flexShrink={0}>
            <Button key={`tell:${t.id}`} {...control} label={isTelling ? 'cancel' : 'tell'} onPress={() => draw.toggleTell(t.id)} />
          </Box>
        )}
        {t.status !== 'stopped' && (
          <Box flexShrink={0}>
            <Button key={`stop:${t.id}`} {...control} label="stop" onPress={() => draw.stop(t.id)} />
          </Box>
        )}
      </Box>
      {drawSection(
        draw,
        'task',
        [
          <Text dimColor italic wrap={isOpened ? 'wrap' : 'truncate-end'}>
            {isOpened ? t.task.trim() : task}
          </Text>,
        ],
        gap,
      )}
      {noteLines.length > 0 && drawSection(draw, 'notes', noteLines, gap)}
      {report !== false && drawSection(draw, 'report', [report], gap, tint)}
      {queued.length > 0 && drawSection(draw, 'queued', queued, gap)}
      {isTelling &&
        drawSection(
          draw,
          'tell',
          [
            <Input
              key={`${TELL_FIELD}${t.id}`}
              placeholder={`a message for ${t.name}`}
              submitLabel="send"
              autoFocus
              onSubmit={(value: string) => draw.tell(t.id, value)}
            />,
          ],
          gap,
          tint,
        )}
    </Box>
  )
}
