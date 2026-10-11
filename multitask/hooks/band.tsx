import type { ElementTable, RenderElement, RenderSurface } from 'claude-code'

import type { Thought } from '../types'
import { agoOf } from './pane'
import { oneLine } from './prompts'

// The band's `thoughts` button, left of Multitask's dropdown, which opens the Thoughts
// pane, with the thoughts' dots after its word: one for each running thought, in its
// colour, in the order they started, DOTS_SHOWN at most and `+N` for the rest. A dot
// blinks white as its thought works, at each new row in its conversation (BLINK_MS apart
// at least: register.tsx starts a blink, none while one runs), and swells a little and
// back as it writes a progress note. As a turn ends, the dot flashes and gives way to a
// check (a cross for one that failed; a stopped one only fades), which fades out of the
// button. Hovered on the desktop, a dot's card says the thought's name, its latest note
// and how long ago that came.
//
// The desktop draws a dot as a small SVG, which it shows as an image: its SMIL animation
// runs there, with no redraw. The desktop builds the band afresh at each redraw, which
// would start an animation over, so one is drawn with how far it has got (a negative
// `begin`): a redraw carries it on, and once it is over the dot is drawn still. A blink
// and a note's swell are two animations of the one disc, each carried on alone. A Button
// holds only text, so there the button is a Box drawn as the dropdown is, each of its
// parts under a hit area that opens the pane (drawField). Every other surface draws a
// Button, a dot in it a glyph: white a moment for a blink, inverted for a note; a check
// or cross as a turn ends.
//
// As pane.tsx: plain functions here, every hook and call on `$` in register.tsx.

// The most dots the band shows; the rest are counted as `+N`.
export const DOTS_SHOWN = 8
// How long a dot's swell at a note takes; its blink, which is also the least time from one
// blink's start to the next; the white of a blink in a glyph; and its end.
export const PULSE_MS = 1000
export const BLINK_MS = 1000
const FLICKER_MS = 400
export const FADE_MS = 1500
// How long a blink takes to reach white, the rest of it back to the thought's colour.
const BLINK_PEAK_MS = 250
// How often the ages in the dots' cards are drawn afresh while they stand.
export const CARD_AGE_MS = 60_000

// The key of a dot's Box on the desktop: this, then the thought's id. A glyph has none: a
// Button keeps no key on the text in it.
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

// The glyph for each where a dot is no picture, the pane's for a failed or stopped thought.
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
// button, a swell or blink in a glyph to end, the cards' ages; undefined when nothing
// waits. A swell or blink in a picture ends of itself; only a picture has a card.
function redrawIn(dots: readonly Dot[], draw: ButtonDrawing): number | undefined {
  const { now } = draw
  if (now === undefined || dots.length === 0) return undefined
  const waits = dots.flatMap(d => {
    const { end, swell, blink } = runsOf(d, now, FLICKER_MS)
    if (end !== undefined) return [FADE_MS - end]
    if (isPicture(draw)) return []
    return [swell === undefined ? [] : [PULSE_MS - swell], blink === undefined ? [] : [FLICKER_MS - blink]].flat()
  })
  if (isPicture(draw)) waits.push(CARD_AGE_MS)
  return waits.length === 0 ? undefined : Math.max(1, Math.min(...waits))
}

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

// What the `thoughts` button is drawn with besides the dots': what opens the Thoughts
// pane, and on the desktop the hit area (a Client, which register.tsx makes) for each of
// its parts, by name.
export type ButtonDrawing = DotsDrawing & {
  open: () => void
  hitOf?: (part: string) => RenderElement
}

// The key of the `thoughts` button.
export const THOUGHTS_BUTTON = 'open-thoughts'
const WORD_SHOWN = 'thoughts'

// The fill of the desktop's Select field, white at 5% over the band (no theme colour
// names it), and its 6px either side of its text from its outer edge, in the band's ch:
// as thread-chat draws its menu beside its thread picker. The room between the button's
// word and its first dot, and before its `+N`. The clear 3px right of a dot's disc in its
// picture, in the band's ch, which a last dot's padding leaves out.
const FIELD_FILL = 'rgba(255,255,255,0.05)'
const FIELD_PADDING = 0.7
const WORD_GAP = 0.5
const MORE_GAP = 0.3
const DOT_ROOM = 0.4

// Whether the dots are pictures, in a button drawn of a Box: on the desktop, the one
// surface with both pictures and hit areas.
const isPicture = (draw: ButtonDrawing) => draw.hitOf !== undefined && 'Svg' in draw.ui

// A dot on any surface but the desktop: a glyph.
function drawGlyph(draw: DotsDrawing, d: Dot): RenderElement {
  const { Text } = draw.ui
  const { swell, blink } = runsOf(d, draw.now, FLICKER_MS)
  const isSwell = swell !== undefined
  return (
    <Text color={blink !== undefined && !isSwell ? WHITE : d.t.color} {...(isSwell && { inverse: true })}>
      {GLYPH[d.kind]}
    </Text>
  )
}

// The button on the desktop: a Box drawn as the dropdown beside it is (its fill and its
// ring, stronger under the pointer, one line high), holding its word, its dots and its
// `+N`, each in a Box of its own under a hit area that fills it, the padding inside them,
// so a click anywhere in the ring opens the pane. Its own side padding is set to none, as
// the desktop gives a bordered Box 12px either side unless told otherwise. A dot's Box
// holds its picture, its card and its hit area: the pointer on the hit area is on the
// dot, so the card shows.
function drawField(draw: ButtonDrawing, shown: readonly Dot[], more: number): RenderElement {
  const { ui, hitOf } = draw
  if (!('Svg' in ui) || hitOf === undefined) return <ui.Box />
  const { Box, Text, Svg } = ui
  const hit = (part: string) => (
    <Box position="absolute" top={0} left={0} width="100%" height="100%">
      {hitOf(part)}
    </Box>
  )
  const lastDot = more > 0 ? -1 : shown.length - 1
  return (
    <Box
      key={THOUGHTS_BUTTON}
      flexDirection="row"
      alignItems="center"
      flexShrink={0}
      height={1}
      paddingY={0}
      paddingLeft={0}
      paddingRight={0}
      borderStyle="single"
      backgroundColor={FIELD_FILL}
      hover={{ borderColor: 'promptBorder' }}
    >
      <Box flexShrink={0} paddingLeft={FIELD_PADDING} paddingRight={shown.length === 0 ? FIELD_PADDING : WORD_GAP}>
        <Text>{WORD_SHOWN}</Text>
        {hit('word')}
      </Box>
      {shown.map((d, i) => (
        <Box key={`${DOT}${d.t.id}`} flexShrink={0} {...(i === lastDot && { paddingRight: FIELD_PADDING - DOT_ROOM })}>
          <Svg source={pictureOf(d, draw.now)} alt={`${d.t.name}: ${WORD[d.kind]}`} width={DOT_PX} height={DOT_PX} />
          {drawCard(draw, d)}
          {hit(`dot:${d.t.id}`)}
        </Box>
      ))}
      {more > 0 && (
        <Box flexShrink={0} paddingLeft={MORE_GAP} paddingRight={FIELD_PADDING}>
          <Text dimColor>{`+${more}`}</Text>
          {hit('more')}
        </Box>
      )}
    </Box>
  )
}

// The `thoughts` button, which opens the Thoughts pane: its word, then a dot for each
// thought with one (none: the word alone), and how long until it must be drawn again.
export function drawThoughtsButton(draw: ButtonDrawing, list: readonly Thought[]): { button: RenderElement; redrawIn?: number } {
  const all = dotsOf(list, draw)
  const shown = all.slice(0, DOTS_SHOWN)
  const more = all.length - shown.length
  const wait = redrawIn(shown, draw)
  const timing = wait === undefined ? {} : { redrawIn: wait }
  if (isPicture(draw)) return { button: drawField(draw, shown, more), ...timing }
  const { Button, Text } = draw.ui
  const dots: (string | RenderElement)[] = shown.length === 0 ? [] : [' ', ...shown.map(d => drawGlyph(draw, d))]
  const rest = more > 0 ? [<Text dimColor>{` +${more}`}</Text>] : []
  return {
    button: (
      <Button key={THOUGHTS_BUTTON} label={WORD_SHOWN} onPress={draw.open}>
        {[WORD_SHOWN, ...dots, ...rest]}
      </Button>
    ),
    ...timing,
  }
}
