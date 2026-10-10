import type { ElementTable, RenderElement, RenderSurface } from 'claude-code'

import type { Thought } from '../types'
import { agoOf } from './pane'
import { oneLine } from './prompts'

// The band's dots, left of Multitask's dropdown: one for each running thought, in its
// colour, in the order they started, DOTS_SHOWN at most and `+N` for the rest. A dot
// pulses white and back as its thought writes a progress note. As a turn ends, the dot
// flashes and gives way to a check (a cross for one that failed; a stopped one only
// fades), which fades out of the row. Hovered on the desktop, a dot's card says the
// thought's name, its latest note and how long ago that came.
//
// The desktop draws a dot as a small SVG, which it shows as an image: its SMIL animation
// runs there, with no redraw. The desktop builds the band afresh at each redraw, which
// would start an animation over, so one is drawn with how far it has got (a negative
// `begin`): a redraw carries it on, and once it is over the dot is drawn still. The
// terminal draws a dot as a glyph, inverted for a pulse; a check or cross as a turn ends.
//
// As pane.tsx: plain functions here, every hook and call on `$` in register.tsx.

// The most dots the band shows; the rest are counted as `+N`.
export const DOTS_SHOWN = 8
// How long a dot's pulse takes, and its end.
export const PULSE_MS = 1000
export const FADE_MS = 1500
// How often the ages in the dots' cards are drawn afresh while they stand.
export const CARD_AGE_MS = 60_000

// The key of a dot's Box: this, then the thought's id.
export const DOT = 'dot:'

// The side of a dot's picture, in CSS pixels: its disc 8 across, the rest room to flash in.
const DOT_PX = 14
const WHITE = '#ffffff'

// What a dot shows: a running thought, or the end of its turn.
type DotKind = 'running' | 'done' | 'failed' | 'stopped'
type Dot = { t: Thought; kind: DotKind; since: number | undefined }

// The terminal's glyph for each, the pane's for a failed or stopped thought.
const GLYPH: Record<DotKind, string> = { running: '●', done: '✓', failed: '!', stopped: '×' }
const WORD: Record<DotKind, string> = { running: 'running', done: 'done', failed: 'failed', stopped: 'stopped' }

// What the dots are drawn with, as register.tsx reads it while drawing the band: the
// surface and its elements, the time (none where it cannot be read: nothing animates or
// fades, and the cards have no ages), and when each thought's turn was last seen to end
// in this run, by id (a thought taken up from the store has none, so does not fade).
export type DotsDrawing = {
  surface: RenderSurface
  ui: ElementTable
  now: number | undefined
  endings: ReadonlyMap<string, number>
}

// The thoughts with a dot, in the order they started: those running, and those whose
// turn ended under FADE_MS ago.
export function dotsOf(list: readonly Thought[], now: number | undefined, endings: ReadonlyMap<string, number>): Dot[] {
  return list.flatMap((t): Dot[] => {
    if (t.status === 'running') return [{ t, kind: 'running', since: t.notedAt }]
    const at = endings.get(t.id)
    if (at === undefined || now === undefined || now - at >= FADE_MS) return []
    return [{ t, kind: t.status === 'idle' ? 'done' : t.status, since: at }]
  })
}

// How far a dot's pulse or end has got, in ms, while it runs; undefined when none runs.
function runningFor(d: Dot, now: number | undefined): number | undefined {
  if (d.since === undefined || now === undefined) return undefined
  const ms = now - d.since
  return ms >= 0 && ms < (d.kind === 'running' ? PULSE_MS : FADE_MS) ? ms : undefined
}

// How long until the band must be drawn again for its dots: an end to fade out of the
// row, a pulse on the terminal to end, the cards' ages; undefined when nothing waits.
// A pulse on the desktop ends of itself.
function redrawIn(dots: readonly Dot[], draw: DotsDrawing): number | undefined {
  const { now } = draw
  if (now === undefined || dots.length === 0) return undefined
  const waits = dots.flatMap(d => {
    const ms = runningFor(d, now)
    if (ms === undefined || (d.kind === 'running' && draw.surface !== 'terminal')) return []
    return [(d.kind === 'running' ? PULSE_MS : FADE_MS) - ms]
  })
  if (hasCards(draw)) waits.push(CARD_AGE_MS)
  return waits.length === 0 ? undefined : Math.max(1, Math.min(...waits))
}

// Whether a dot has a card on hover: on the desktop, which lifts it over the band.
const hasCards = (draw: DotsDrawing) => draw.surface === 'desktop'

// A colour as it may go into a picture's markup: a thought's is one of the palette's; any
// other is drawn grey.
const markupColor = (color: string) => (/^#[0-9a-fA-F]{3,8}$/.test(color) ? color : '#888888')

// One SMIL animation of `attribute` over the whole of a pulse or end (`ms`), through
// `steps` of [ms from its start, value], `begin` ms from when the picture was drawn
// (negative: under way already), held at its end. Each spans the whole, never ending
// before the picture is drawn: one that had ended by then would not be held, as the
// desktop's engine counts only an animation that ends after its picture began.
function animate(attribute: string, ms: number, begin: number, steps: [number, string][], more = ''): string {
  const values = steps.map(([, value]) => value).join(';')
  const keyTimes = steps.map(([at]) => Math.round((at / ms) * 1000) / 1000).join(';')
  return `<animate attributeName="${attribute}" values="${values}" keyTimes="${keyTimes}" dur="${ms}ms" begin="${begin}ms" fill="freeze"${more}/>`
}

const disc = (color: string, inner = '') =>
  `<circle cx="7" cy="7" r="3.5" fill="${color}" stroke="${color}" stroke-width="1">${inner}</circle>`

// A stroke of a turn's end (a check or cross): drawn in from its start after the flash,
// then faded out by the end's close.
const stroke = (color: string, path: string, length: number, begin: number) =>
  `<path d="${path}" fill="none" stroke="${color}" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" ` +
  `stroke-dasharray="${length}" stroke-dashoffset="${length}">` +
  animate('stroke-dashoffset', FADE_MS, begin, [[0, `${length}`], [300, `${length}`], [650, '0'], [FADE_MS, '0']]) +
  animate('opacity', FADE_MS, begin, [[0, '1'], [FADE_MS - 500, '1'], [FADE_MS, '0']]) +
  '</path>'

// A dot's picture: still, pulsing, or its end, as far as it has got. Each animation's
// start is marked in it, so two pulses are two pictures, never one the desktop held.
export function pictureOf(d: Dot, now: number | undefined): string {
  const color = markupColor(d.t.color)
  const ms = runningFor(d, now)
  const svg = (body: string) =>
    `<svg xmlns="http://www.w3.org/2000/svg" width="${DOT_PX}" height="${DOT_PX}" viewBox="0 0 14 14">` +
    `${ms === undefined ? '' : `<!--${d.since}-->`}${body}</svg>`
  if (ms === undefined) return svg(d.kind === 'running' ? disc(color) : '')
  const begin = -ms
  if (d.kind === 'running') {
    const ease = ' calcMode="spline" keySplines="0.42 0 0.58 1;0.42 0 0.58 1"'
    return svg(disc(color, animate('fill', PULSE_MS, begin, [[0, color], [PULSE_MS / 2, WHITE], [PULSE_MS, color]], ease)))
  }
  const end = (attribute: string, steps: [number, string][]) => animate(attribute, FADE_MS, begin, steps)
  if (d.kind === 'stopped') return svg(disc(color, end('r', [[0, '3.5'], [FADE_MS, '2']]) + end('opacity', [[0, '1'], [FADE_MS, '0']])))
  // A flash: white, wider, gone; then the check or cross.
  const flash = disc(
    color,
    end('fill', [[0, color], [150, WHITE], [FADE_MS, WHITE]]) +
      end('r', [[0, '3.5'], [400, '6'], [FADE_MS, '6']]) +
      end('stroke-width', [[0, '1'], [400, '0'], [FADE_MS, '0']]) +
      end('opacity', [[0, '1'], [100, '1'], [400, '0'], [FADE_MS, '0']]),
  )
  const mark = d.kind === 'done' ? stroke(color, 'M4 7.3 6.2 9.5 10.2 4.8', 10, begin) : stroke(color, 'M4.5 4.5 9.5 9.5M9.5 4.5 4.5 9.5', 8, begin)
  return svg(flash + mark)
}

// A dot's card, shown while it is hovered: the thought's name; its latest note and how
// long ago that came, or, as its turn ends, its report and how it ended.
function drawCard(draw: DotsDrawing, d: Dot): RenderElement {
  const { Box, Text } = draw.ui
  const { t } = d
  const { now } = draw
  const note = t.notes?.at(-1)
  const isRunning = d.kind === 'running'
  const said = isRunning ? note : t.lastText || note
  const ago = (at: number | undefined) => (at === undefined || now === undefined ? undefined : agoOf(now - at))
  const started = ago(t.startedAt)
  const age = !isRunning ? WORD[d.kind] : note !== undefined ? ago(t.notedAt) : started === undefined ? undefined : `started ${started}`
  return (
    <Box position="absolute" display="none" hover={{ display: 'flex' }} flexDirection="column">
      <Text color={t.color} bold>
        {t.name}
      </Text>
      {said !== undefined && said !== '' ? <Text>{oneLine(said, 300)}</Text> : <Text dimColor>No notes yet</Text>}
      {age !== undefined && <Text dimColor>{age}</Text>}
    </Box>
  )
}

// Whether the dots are pictures: everywhere but the terminal, whose table may still hand
// over an Svg it cannot draw.
const isPicture = (draw: DotsDrawing) => draw.surface !== 'terminal'

// One dot, keyed by its thought: a picture with its card where the surface draws one,
// else a glyph.
function drawDot(draw: DotsDrawing, d: Dot): RenderElement {
  const { ui } = draw
  const { Box, Text } = ui
  const key = `${DOT}${d.t.id}`
  if (isPicture(draw) && 'Svg' in ui) {
    const { Svg } = ui
    return (
      <Box key={key} flexShrink={0}>
        <Svg source={pictureOf(d, draw.now)} alt={`${d.t.name}: ${WORD[d.kind]}`} width={DOT_PX} height={DOT_PX} />
        {hasCards(draw) && drawCard(draw, d)}
      </Box>
    )
  }
  const isPulse = d.kind === 'running' && runningFor(d, draw.now) !== undefined
  return (
    <Box key={key} flexShrink={0}>
      <Text color={d.t.color} {...(isPulse && { inverse: true })}>
        {GLYPH[d.kind]}
      </Text>
    </Box>
  )
}

// The band's dots, none when no thought has one, and how long until they must be drawn again.
export function drawDots(draw: DotsDrawing, list: readonly Thought[]): { dots?: RenderElement; redrawIn?: number } {
  const all = dotsOf(list, draw.now, draw.endings)
  if (all.length === 0) return {}
  const shown = all.slice(0, DOTS_SHOWN)
  const { Box, Text } = draw.ui
  const wait = redrawIn(shown, draw)
  return {
    dots: (
      <Box flexDirection="row" alignItems="center" columnGap={isPicture(draw) ? 0 : 1} flexShrink={0}>
        {shown.map(d => drawDot(draw, d))}
        {all.length > shown.length && <Text dimColor>{`+${all.length - shown.length}`}</Text>}
      </Box>
    ),
    ...(wait !== undefined && { redrawIn: wait }),
  }
}
