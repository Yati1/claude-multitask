import type { ElementTable, On, RenderElement } from 'claude-code'

// This file is the same in thread-chat, multitask and react but for OWN, the mod's own
// value: keep the copies otherwise identical.
//
// The welcome line, in the band above the prompt: the command of each of the mods newly
// installed, the ones not installed with what each is for, a link to the getting-started
// page and a Dismiss button. Dismissed, it stays away until another of the mods is
// installed. It shows whether the mods are on or off: it says how to turn them on. The
// engine raises the band on the terminal and the desktop only, and never in a `-p` run.
//
// One line for every mod installed: each runs this, and only the one whose hook stands
// outermost in the band's chain draws it, so it sits above all the mods draw there. Each
// mod knows which of the others are installed by their `welcome` values, which each writes
// as the session starts, and whether it stands outermost by what ran beneath its hook: the
// outermost finds every other installed mod there.
//
// The press on Dismiss passes every mod's hook, whichever drew it, and each installed mod
// keeps in its own store (shared by every session) the mods installed then, with those
// any of them kept before. The line shows while an installed mod is in none of the
// installed mods' records: a mod installed later, its store empty, still finds in the
// others' that they were seen, and a dismissal holds whichever mods stay installed.

// The one line that differs between the copies: this mod's own value. The engine refuses
// a module that names another plugin's value in a write, though the write never runs.
const OWN = { plugin: 'multitask', key: 'welcome' } as const

const THREAD_CHAT = { plugin: 'thread-chat', key: 'welcome' } as const
const MULTITASK = { plugin: 'multitask', key: 'welcome' } as const
const REACT = { plugin: 'react', key: 'welcome' } as const

type Mod = 'thread-chat' | 'multitask' | 'react'
const MODS: readonly Mod[] = ['thread-chat', 'multitask', 'react']

// What each installed mod published: the mods its store says were seen.
type Seen = Partial<Record<Mod, string[]>>

// What the line says: the mods newly installed, and those to try.
type Plan = { fresh: Mod[]; missing: Mod[] }

// The mods installed when the person last dismissed the line, kept in this mod's store.
const KEPT = 'welcome'

export const DISMISS = 'claude-multitask-welcome-dismiss'
export const DOCS = 'https://github.com/othrayte/claude-multitask/blob/main/docs/getting-started.md'

// Every directory: the session.start matcher that lets every session through. A mod
// registers an event once without a matcher, and its own hook is that one.
const ANY = /^/

const ABOUT: Record<Mod, { command: string; what: string; why: string; whyShort: string }> = {
  'thread-chat': { command: '/threads', what: 'topic threads', why: 'keep each topic in its own thread', whyShort: 'topic threads' },
  multitask: { command: '/multitask', what: 'multitasking', why: 'talk to Claude while it works', whyShort: 'talk while it works' },
  react: { command: '/react', what: 'emoji reactions', why: "emoji reactions instead of 'done' replies", whyShort: 'emoji reactions' },
}

// The cells the first line gives the link and the button: `Docs  [ Dismiss ]` and the gap.
const CONTROLS_WIDTH = 19

const isMod = (name: string): name is Mod => (MODS as readonly string[]).includes(name)
const namesOf = (value: unknown): string[] => (Array.isArray(value) ? value.filter((v): v is string => typeof v === 'string') : [])
const join = (parts: readonly string[]) => (parts.length <= 1 ? parts.join('') : `${parts.slice(0, -1).join(', ')} and ${parts.at(-1)}`)

// The values the three mods published, in MODS order; one never written is undefined.
function seenOf(values: readonly ({ seen: string[] } | undefined)[]): Seen {
  const seen: Seen = {}
  MODS.forEach((mod, i) => {
    const value = values[i]
    if (value !== undefined) seen[mod] = namesOf(value.seen)
  })
  return seen
}

const installedOf = (seen: Seen) => MODS.filter(mod => seen[mod] !== undefined)

// Dismissed: the mods installed now, with those any installed mod kept.
function dismissed(seen: Seen): string[] {
  const installed = installedOf(seen)
  const names = new Set([...installed.flatMap(mod => seen[mod] ?? []), ...installed])
  return MODS.filter(mod => names.has(mod))
}

// What the line says, when `me` draws it: none while another installed mod stands outside
// it in the chain (not among the plugins `beneath` it), or while every installed mod was
// seen.
function planFor(seen: Seen, me: string, beneath: ReadonlySet<string>): Plan | undefined {
  const installed = installedOf(seen)
  if (!isMod(me) || !installed.includes(me)) return undefined
  if (installed.some(mod => mod !== me && !beneath.has(mod))) return undefined
  const known = new Set(installed.flatMap(mod => seen[mod] ?? []))
  const fresh = installed.filter(mod => !known.has(mod))
  if (fresh.length === 0) return undefined
  return { fresh, missing: MODS.filter(mod => !installed.includes(mod) && !known.has(mod)) }
}

// The longest of the texts that fits in `room` cells; the last when none does.
const fit = (texts: readonly string[], room: number | undefined) =>
  texts.find(text => room === undefined || text.length <= room) ?? texts.at(-1) ?? ''

// The commands of the mods newly installed.
function freshLine(fresh: readonly Mod[], room: number | undefined): string {
  const lead = fresh.length === 1 ? 'New mod' : 'New mods'
  return fit(
    [
      `${lead}: ${join(fresh.map(mod => `${ABOUT[mod].command} for ${ABOUT[mod].what}`))}.`,
      `${lead}: ${join(fresh.map(mod => ABOUT[mod].command))}.`,
    ],
    room,
  )
}

// The mods not installed, each with what it is for, shorter where the long text doesn't fit.
function missingLine(missing: readonly Mod[], room: number | undefined): string {
  const long = join(missing.map(mod => `${mod} (${ABOUT[mod].why})`))
  const short = join(missing.map(mod => `${mod} (${ABOUT[mod].whyShort})`))
  return fit([`Also try ${long}.`, `Also try ${short}.`], room)
}

// Props that give a Box something to show, or room, though it holds nothing.
const SHAPED = /^(border|padding|margin|height|minHeight|width|minWidth|background)/

// A drawing that shows nothing: the engine's own (the band holds nothing of its own but
// a survey), none, a Box drawn "none", or a Box or Text of only such with no shape.
function isBlank(node: unknown): boolean {
  if (node === null || node === undefined || node === false || node === '') return true
  if (typeof node !== 'object') return false
  const el = node as { type?: unknown; props?: Record<string, unknown>; hover?: Record<string, unknown>; children?: unknown[] }
  if (el.type === 'engine') return true
  if (el.type === 'Box' && el.props?.display === 'none') return el.hover?.display === undefined
  if (el.type !== 'Box' && el.type !== 'Text') return false
  if (Object.keys(el.props ?? {}).some(prop => SHAPED.test(prop))) return false
  return (el.children ?? []).every(isBlank)
}

// The line: the new mods' commands, the link and the button; under it, the mods to try.
// `width` is the band's, in cells, when the surface measured it.
function drawWelcome(ui: ElementTable, width: number | undefined, plan: Plan): RenderElement {
  const { Box, Text, Button, Link } = ui
  return (
    <Box flexDirection="column" minWidth={0}>
      <Box flexDirection="row" columnGap={2}>
        <Box flexGrow={1} flexShrink={1} minWidth={0}>
          <Text>{freshLine(plan.fresh, width === undefined ? undefined : width - CONTROLS_WIDTH)}</Text>
        </Box>
        <Box flexDirection="row" columnGap={2} flexShrink={0}>
          <Link href={DOCS} label="Docs" />
          {/* Every mod's `ui.press` hook keeps the dismissal: the press needs nothing more. */}
          <Button key={DISMISS} label="Dismiss" onPress={() => {}} />
        </Box>
      </Box>
      {plan.missing.length > 0 && <Text dimColor>{missingLine(plan.missing, width)}</Text>}
    </Box>
  )
}

export function welcome(on: On) {
  // As the session starts, each mod publishes what its store kept, which also says it is
  // installed.
  on('session.start', { cwd: ANY }, async ($, e, next) => {
    const result = await next(e)
    try {
      await $.state.set(OWN, { seen: namesOf(await $.store.get(KEPT)) })
    } catch {
      // unpublished: the line counts this mod as not installed
    }
    return result
  })

  // A press on Dismiss, whichever of the mods drew it: this mod keeps and publishes the
  // mods installed now, with those any of them kept.
  on('ui.press', { element: DISMISS }, async ($, e, next) => {
    const result = await next(e)
    if (!isMod(e.plugin)) return result
    try {
      const values = [(await $.state.get(THREAD_CHAT)).value, (await $.state.get(MULTITASK)).value, (await $.state.get(REACT)).value]
      const seen = dismissed(seenOf(values))
      await $.store.set(KEPT, seen)
      await $.state.set(OWN, { seen })
    } catch {
      // kept as it was
    }
    return result
  })

  // The band: the line above what the rest draw there, a gap between them when they draw
  // anything. A survey holds the band alone: the matcher leaves it be, and is the mod's
  // own band hook's with that added, as a mod registers one matcher once.
  on('ui.render', { component: 'AbovePrompt', props: { hasSurvey: false } }, async ($, e, next) => {
    const below = await next(e)
    const values = [(await $.state.get(THREAD_CHAT)).value, (await $.state.get(MULTITASK)).value, (await $.state.get(REACT)).value]
    const plan = planFor(seenOf(values), $.plugin.name, new Set(next.trace.map(link => link.plugin)))
    if (plan === undefined) return below
    const ui = $.ui.resolve(e)
    const line = drawWelcome(ui, e.props.bodyColumns > 0 ? e.props.bodyColumns : undefined, plan)
    if (isBlank(below)) return line
    const { Box } = ui
    return (
      <Box flexDirection="column" rowGap={1} minWidth={0}>
        {line}
        {below}
      </Box>
    )
  })
}
