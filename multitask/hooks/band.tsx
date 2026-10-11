import type { ElementTable, RenderElement, RenderSurface } from 'claude-code'

import type { Thought } from '../types'
import { agoOf } from './pane'
import { oneLine } from './prompts'

// The band's dots, left of Multitask's dropdown: one for each running thought, in its
// colour, in the order they started, DOTS_SHOWN at most and `+N` for the rest. A dot
// blinks white as its thought works, at each new row in its conversation (BLINK_MS apart
// at least: register.tsx starts a blink, none while one runs), and swells a little and
// back as it writes a progress note. As a turn ends, the dot flashes and gives way to a
// check (a cross for one that failed; a stopped one only fades), which fades out of the
// row. Hovered on the desktop, a dot's card says the thought's name, its latest note and
// how long ago that came.
//
// The desktop draws a dot as a small SVG, which it shows as an image: its SMIL animation
// runs there, with no redraw. The desktop builds the band afresh at each redraw, which
// would start an animation over, so one is drawn with how far it has got (a negative
// `begin`): a redraw carries it on, and once it is over the dot is drawn still. A blink
// and a note's swell are two animations of the one disc, each carried on alone. The
// terminal draws a dot as a glyph: white a moment for a blink, inverted for a note; a
// check or cross as a turn ends.
//
// As pane.tsx: plain functions here, every hook and call on `$` in register.tsx.

// The most dots the band shows; the rest are counted as `+N`.
export const DOTS_SHOWN = 8
// How long a dot's swell at a note takes; its blink, which is also the least time from one
// blink's start to the next; the white of a blink on the terminal; and its end.
export const PULSE_MS = 1000
export const BLINK_MS = 1000
const FLICKER_MS = 400
export const FADE_MS = 1500
// How long a blink takes to reach white, the rest of it back to the thought's colour.
const BLINK_PEAK_MS = 250
// How often the ages in the dots' cards are drawn afresh while they stand.
export const CARD_AGE_MS = 60_000

// The key of a dot's Box: this, then the thought's id.
export const DOT = 'dot:'

// The side of a dot's picture, in CSS pixels: its disc 8 across, the rest room to swell
// and flash in, so neither moves the band.
const DOT_PX = 14
const WHITE = '#ffffff'
// The disc's radius, its stroke drawing it half a pixel wider; at a note's height, 1.3
// times as wide.
const R = 3.5
const R_SWELL = 4.7

// What a dot shows: a running thought, or the end of its turn.
type DotKind = 'running' | 'done' | 'failed' | 'stopped'
// `since`: when its latest note came (running) or its turn ended; `blinkAt`: when its
// latest blink began (running).
type Dot = { t: Thought; kind: DotKind; since: number | undefined; blinkAt?: number | undefined }

// The terminal's glyph for each, the pane's for a failed or stopped thought.
const GLYPH: Record<DotKind, string> = { running: '●', done: '✓', failed: '!', stopped: '×' }
const WORD: Record<DotKind, string> = { running: 'running', done: 'done', failed: 'failed', stopped: 'stopped' }

// What the dots are drawn with, as register.tsx reads it while drawing the band: the
// surface and its elements, the time (none where it cannot be read: nothing animates or
// fades, and the cards have no ages), when each thought's turn was last seen to end in
// this run, by id (a thought taken up from the store has none, so does not fade), and when
// each running thought's latest blink began, by id.
export type DotsDrawing = {
  surface: RenderSurface
  ui: ElementTable
  now: number | undefined
  endings: ReadonlyMap<string, number>
  blinks: ReadonlyMap<string, number>
}

// The thoughts with a dot, in the order they started: those running, and those whose
// turn ended under FADE_MS ago.
export function dotsOf(list: readonly Thought[], draw: Pick<DotsDrawing, 'now' | 'endings' | 'blinks'>): Dot[] {
  const { now, endings, blinks } = draw
  return list.flatMap((t): Dot[] => {
    if (t.status === 'running') return [{ t, kind: 'running', since: t.notedAt, blinkAt: blinks.get(t.id) }]
    const at = endings.get(t.id)
    if (at === undefined || now === undefined || now - at >= FADE_MS) return []
    return [{ t, kind: t.status === 'idle' ? 'done' : t.status, since: at }]
  })
}

// How far an animation that began `at` and takes `ms` has got, in ms, while it runs;
// undefined when it does not.
function runningFor(at: number | undefined, ms: number, now: number | undefined): number | undefined {
  if (at === undefined || now === undefined) return undefined
  const gone = now - at
  return gone >= 0 && gone < ms ? gone : undefined
}

// What of a dot runs now, each as how far it has got: a running thought's swell at a
// note and blink (its white on the terminal, which lasts `blinkMs`), or the end of a turn.
function runsOf(d: Dot, now: number | undefined, blinkMs = BLINK_MS) {
  if (d.kind !== 'running') return { end: runningFor(d.since, FADE_MS, now) }
  return { swell: runningFor(d.since, PULSE_MS, now), blink: runningFor(d.blinkAt, blinkMs, now) }
}

// How long until the band must be drawn again for its dots: an end to fade out of the
// row, a swell or blink on the terminal to end, the cards' ages; undefined when nothing
// waits. A swell or blink in a picture ends of itself.
function redrawIn(dots: readonly Dot[], draw: DotsDrawing): number | undefined {
  const { now } = draw
  if (now === undefined || dots.length === 0) return undefined
  const waits = dots.flatMap(d => {
    const { end, swell, blink } = runsOf(d, now, FLICKER_MS)
    if (end !== undefined) return [FADE_MS - end]
    if (isPicture(draw)) return []
    return [swell === undefined ? [] : [PULSE_MS - swell], blink === undefined ? [] : [FLICKER_MS - blink]].flat()
  })
  if (hasCards(draw)) waits.push(CARD_AGE_MS)
  return waits.length === 0 ? undefined : Math.max(1, Math.min(...waits))
}

// Whether a dot has a card on hover: on the desktop, which lifts it over the band.
const hasCards = (draw: DotsDrawing) => draw.surface === 'desktop'

// A colour as it may go into a picture's markup: a thought's is one of the palette's; any
// other is drawn grey.
const markupColor = (color: string) => (/^#[0-9a-fA-F]{3,8}$/.test(color) ? color : '#888888')

// One SMIL animation of `attribute` over the whole of a swell, blink or end (`ms`),
// through `steps` of [ms from its start, value], `begin` ms from when the picture was
// drawn (negative: under way already), held at its end. Each spans the whole, never
// ending before the picture is drawn: one that had ended by then would not be held, as
// the desktop's engine counts only an animation that ends after its picture began.
function animate(attribute: string, ms: number, begin: number, steps: [number, string][], more = ''): string {
  const values = steps.map(([, value]) => value).join(';')
  const keyTimes = steps.map(([at]) => Math.round((at / ms) * 1000) / 1000).join(';')
  return `<animate attributeName="${attribute}" values="${values}" keyTimes="${keyTimes}" dur="${ms}ms" begin="${begin}ms" fill="freeze"${more}/>`
}

// Easing for an animation of two steps: there and back.
const EASE = ' calcMode="spline" keySplines="0.42 0 0.58 1;0.42 0 0.58 1"'
const EASE_BLINK = ' calcMode="spline" keySplines="0.25 0.1 0.25 1;0.42 0 0.58 1"'

const disc = (color: string, inner = '') =>
  `<circle cx="7" cy="7" r="${R}" fill="${color}" stroke="${color}" stroke-width="1">${inner}</circle>`

// A stroke of a turn's end (a check or cross): drawn in from its start after the flash,
// then faded out by the end's close.
const stroke = (color: string, path: string, length: number, begin: number) =>
  `<path d="${path}" fill="none" stroke="${color}" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" ` +
  `stroke-dasharray="${length}" stroke-dashoffset="${length}">` +
  animate('stroke-dashoffset', FADE_MS, begin, [[0, `${length}`], [300, `${length}`], [650, '0'], [FADE_MS, '0']]) +
  animate('opacity', FADE_MS, begin, [[0, '1'], [FADE_MS - 500, '1'], [FADE_MS, '0']]) +
  '</path>'

// A dot's picture: still, swelling, blinking, or its end, as far as each has got. Each
// animation's start is marked in it, so two blinks are two pictures, never one the
// desktop held.
export function pictureOf(d: Dot, now: number | undefined): string {
  const color = markupColor(d.t.color)
  const { end, swell, blink } = runsOf(d, now)
  const marks = [swell !== undefined && `note ${d.since}`, blink !== undefined && `blink ${d.blinkAt}`, end !== undefined && `end ${d.since}`]
  const mark = marks.filter(Boolean).join(', ')
  const svg = (body: string) =>
    `<svg xmlns="http://www.w3.org/2000/svg" width="${DOT_PX}" height="${DOT_PX}" viewBox="0 0 14 14">` +
    `${mark === '' ? '' : `<!--${mark}-->`}${body}</svg>`
  if (d.kind === 'running') {
    const swelling = swell === undefined ? '' : animate('r', PULSE_MS, -swell, [[0, `${R}`], [PULSE_MS / 2, `${R_SWELL}`], [PULSE_MS, `${R}`]], EASE)
    const blinking =
      blink === undefined ? '' : animate('fill', BLINK_MS, -blink, [[0, color], [BLINK_PEAK_MS, WHITE], [BLINK_MS, color]], EASE_BLINK)
    return svg(disc(color, swelling + blinking))
  }
  if (end === undefined) return svg('')
  const begin = -end
  const ending = (attribute: string, steps: [number, string][]) => animate(attribute, FADE_MS, begin, steps)
  if (d.kind === 'stopped') return svg(disc(color, ending('r', [[0, `${R}`], [FADE_MS, '2']]) + ending('opacity', [[0, '1'], [FADE_MS, '0']])))
  // A flash: white, wider, gone; then the check or cross.
  const flash = disc(
    color,
    ending('fill', [[0, color], [150, WHITE], [FADE_MS, WHITE]]) +
      ending('r', [[0, `${R}`], [400, '6'], [FADE_MS, '6']]) +
      ending('stroke-width', [[0, '1'], [400, '0'], [FADE_MS, '0']]) +
      ending('opacity', [[0, '1'], [100, '1'], [400, '0'], [FADE_MS, '0']]),
  )
  const check = d.kind === 'done' ? stroke(color, 'M4 7.3 6.2 9.5 10.2 4.8', 10, begin) : stroke(color, 'M4.5 4.5 9.5 9.5M9.5 4.5 4.5 9.5', 8, begin)
  return svg(flash + check)
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
  const { swell, blink } = runsOf(d, draw.now, FLICKER_MS)
  const isSwell = swell !== undefined
  return (
    <Box key={key} flexShrink={0}>
      <Text color={blink !== undefined && !isSwell ? WHITE : d.t.color} {...(isSwell && { inverse: true })}>
        {GLYPH[d.kind]}
      </Text>
    </Box>
  )
}

// The band's dots, none when no thought has one, and how long until they must be drawn again.
export function drawDots(draw: DotsDrawing, list: readonly Thought[]): { dots?: RenderElement; redrawIn?: number } {
  const all = dotsOf(list, draw)
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
