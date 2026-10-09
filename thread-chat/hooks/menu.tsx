import type { Elements, RenderElement, RenderNode, RenderSurface } from 'claude-code'

// The band above the prompt that the thread-chat, multitask and react mods share, and the
// menu of each loaded mod's switches for the chat, opened by one button named for the
// loaded mods ("Threads, tasks & emoji"). This file is the same in each of the three
// mods, as installed mods share no files: a change to one is made to all three alike.
//
// Whichever of the mods draws the band first (the one nearest the engine) lays it out: a
// row of the mods' controls, then the menu. Each mod drawing after it finds the band in
// the tree beneath by its keys and adds its own controls and switches there, so the band
// is drawn once with any one, two or all three of the mods loaded. Each switch is a
// Button of the mod that drew it, so its press reaches that mod alone.
//
// The button is drawn the same way, by every mod in turn, each adding its name to its
// label, so it shows once. On the desktop it sits below the input, beside the mode and
// model, and the menu opens above the input at the band's right end; that row of the
// desktop holds only inline text and buttons, so the menu cannot open from it. Elsewhere
// the button and the menu are in the band. Its press does nothing of its own: each mod
// hooks presses of MENU_BUTTON, whichever mod drew it, to open or close the menu by its
// own account, and on the desktop presses of MENU_SWITCH, a switch picked, to close it.

export const BAND = 'claude-multitask-mods-band'
export const CONTROLS = 'claude-multitask-mods-controls'
export const MENU = 'claude-multitask-mods-menu'
export const SWITCHES = 'claude-multitask-mods-switches'
export const PILL = 'claude-multitask-mods-pill'
export const MENU_BUTTON = 'claude-multitask-mods'

const CONTROL = 'claude-multitask-mods-control:'
const SWITCH = 'claude-multitask-mods-switch:'
const NAMES = 'claude-multitask-mods-names'
const NAME = 'claude-multitask-mods-name:'

// The keys of every mod's switches (`mods-menu:threads`, ...).
export const MENU_SWITCH = /^mods-menu:/

// A mod's word in the button's label, which names the loaded mods in `rank` order, as
// the switches are ordered: thread-chat's `threads` at 10, multitask's `tasks` at 20,
// react's `emoji` at 30.
export type ModName = { rank: number; word: string }

// One switch of a mod's in the menu: its label, then a Button of the mod's own, `key`,
// showing `on` or `off`, whose press flips it. `rank` orders the switches of all the
// mods, lowest first: thread-chat's from 10, multitask's from 20, react's from 30.
export type MenuSwitch = {
  rank: number
  key: string
  label: string
  isOn: boolean
  onPress: () => unknown
}

// A mod's controls in the band (thread-chat's pills, multitask's `thoughts`), ordered by
// `rank` as the switches are. Growing, they take the room the band has left and give way
// first; else they keep their width.
export type BandControls = {
  rank: number
  name: string
  element: RenderElement
  grows?: boolean
}

export type BandParts = {
  ui: Pick<Elements['terminal'], 'Box' | 'Text' | 'Button'>
  surface: RenderSurface
  name: ModName
  controls?: BandControls
  switches: readonly MenuSwitch[]
  // Whether the menu is open, by this mod's account.
  isOpen: () => Promise<boolean>
}

type BoxElement = Extract<RenderElement, { type: 'Box' }>
type Ui = BandParts['ui']

const orderOf = (rank: number, name: string) => `${String(Math.max(0, Math.floor(rank))).padStart(4, '0')}:${name}`

function keyOf(node: RenderNode): string {
  if (typeof node === 'string' || node.type !== 'Box') return ''
  const key = node.props?.key
  return typeof key === 'string' ? key : ''
}

// The tree with the first Box keyed `key` in it replaced by `fn` of it; undefined where it
// holds none.
function replaceKeyed(node: RenderNode, key: string, fn: (box: BoxElement) => BoxElement): RenderNode | undefined {
  if (typeof node === 'string') return undefined
  if (node.type === 'Box' && node.props?.key === key) return fn(node)
  const children = (node as { children?: unknown }).children
  if (!Array.isArray(children)) return undefined
  for (const [i, child] of (children as RenderNode[]).entries()) {
    const now = replaceKeyed(child, key, fn)
    if (now !== undefined) return { ...node, children: children.map((c, j) => (j === i ? now : c)) } as RenderNode
  }
  return undefined
}

// A Box's children with `added` among them, in the order of their keys, one of each key:
// an added one takes the place of one already there under its key.
function withChildren(box: BoxElement, added: readonly RenderElement[]): BoxElement {
  const keys = new Set(added.map(keyOf))
  const kept = (box.children ?? []).filter(child => !keys.has(keyOf(child)))
  const children = [...kept, ...added].sort((a, b) => {
    const [x, y] = [keyOf(a), keyOf(b)]
    return x < y ? -1 : x > y ? 1 : 0
  })
  return { ...box, children }
}

// The names a button drawn beneath carries, kept as empty Boxes keyed by them.
function namesIn(pill: BoxElement): ModName[] {
  const names = (pill.children ?? []).find((child): child is BoxElement => keyOf(child) === NAMES)
  return (names?.children ?? []).flatMap(child => {
    const found = /^(\d+):(.+)$/.exec(keyOf(child).slice(NAME.length))
    return keyOf(child).startsWith(NAME) && found !== null ? [{ rank: Number(found[1]), word: found[2] ?? '' }] : []
  })
}

// `threads`, `threads & tasks`, `threads, tasks & emoji`, its first letter a capital.
function labelOf(words: readonly string[]): string {
  const said = words.length < 3 ? words.join(' & ') : `${words.slice(0, -1).join(', ')} & ${words.at(-1)}`
  return said.charAt(0).toUpperCase() + said.slice(1)
}

// The button that opens and closes the menu, its label naming `names`. Its press does
// nothing of its own: every mod's hook on it does.
function drawPill(ui: Ui, names: readonly ModName[], isOpen: boolean): BoxElement {
  const { Box, Button } = ui
  const byOrder = new Map(names.map(n => [orderOf(n.rank, n.word), n.word]))
  const order = [...byOrder.keys()].sort()
  return (
    <Box key={PILL} flexDirection="row" flexShrink={0}>
      <Box key={NAMES} display="none">
        {order.map(o => (
          <Box key={`${NAME}${o}`} />
        ))}
      </Box>
      <Button
        key={MENU_BUTTON}
        label={labelOf(order.map(o => byOrder.get(o) ?? ''))}
        variant={isOpen ? 'primary' : 'secondary'}
        dimColor={!isOpen}
        onPress={() => undefined}
      />
    </Box>
  ) as BoxElement
}

// `below` with the button beneath given this mod's name too; undefined with none beneath.
function withPill(below: RenderNode, ui: Ui, name: ModName, isOpen: boolean): RenderNode | undefined {
  return replaceKeyed(below, PILL, pill => drawPill(ui, [...namesIn(pill), name], isOpen))
}

// The desktop's row below the input with the button in it: the button drawn beneath, its
// label given this mod's name too, or, with none beneath, the button before `below`.
export function drawMenuButton(below: RenderElement, ui: Ui, name: ModName, isOpen: boolean): RenderElement {
  const drawn = withPill(below, ui, name, isOpen)
  if (drawn !== undefined && typeof drawn !== 'string') return drawn
  const { Box } = ui
  return (
    <Box flexDirection="row">
      {drawPill(ui, [name], isOpen)}
      {below}
    </Box>
  )
}

function controlsBox(ui: Ui, controls: BandControls): RenderElement {
  const { Box } = ui
  const fit = controls.grows === true ? { flexGrow: 1, flexShrink: 1, minWidth: 0 } : { flexShrink: 0 }
  return (
    <Box key={`${CONTROL}${orderOf(controls.rank, controls.name)}`} flexDirection="row" alignItems="center" {...fit}>
      {controls.element}
    </Box>
  )
}

function switchRow(ui: Ui, s: MenuSwitch): RenderElement {
  const { Box, Text, Button } = ui
  return (
    <Box
      key={`${SWITCH}${orderOf(s.rank, s.key)}`}
      flexDirection="row"
      alignItems="center"
      justifyContent="space-between"
      columnGap={2}
    >
      <Text>{s.label}</Text>
      <Button
        key={s.key}
        label={s.isOn ? 'on' : 'off'}
        variant={s.isOn ? 'primary' : 'secondary'}
        dimColor={!s.isOn}
        onPress={s.onPress}
      />
    </Box>
  )
}

// The band with this mod's controls and switches: added to the band drawn beneath, or, with
// none beneath, a band laid out here. Another plugin's drawing beneath stays, after the
// mods' controls, giving way first.
export async function drawBand(below: RenderElement, parts: BandParts): Promise<RenderElement> {
  const { Box } = parts.ui
  const isDesktop = parts.surface === 'desktop'
  const isOpen = await parts.isOpen()
  const controls = parts.controls === undefined ? [] : [controlsBox(parts.ui, parts.controls)]
  const switches = parts.switches.map(s => switchRow(parts.ui, s))

  const added = replaceKeyed(below, BAND, band => {
    const withControls = replaceKeyed(band, CONTROLS, box => withChildren(box, controls)) ?? band
    const withSwitches = replaceKeyed(withControls, SWITCHES, box => withChildren(box, switches)) ?? withControls
    return (withPill(withSwitches, parts.ui, parts.name, isOpen) ?? withSwitches) as BoxElement
  })
  if (added !== undefined && typeof added !== 'string') return added

  const others =
    below.type === 'engine'
      ? []
      : [
          <Box key={`${CONTROL}${orderOf(9999, 'others')}`} flexDirection="row" alignItems="center" flexShrink={1} minWidth={0}>
            {below}
          </Box>,
        ]
  const list = withChildren(
    (isDesktop ? (
      <Box key={SWITCHES} flexDirection="column" />
    ) : (
      <Box key={SWITCHES} flexDirection="column" display={isOpen ? 'flex' : 'none'} />
    )) as BoxElement,
    switches,
  )
  // On the desktop the menu is there only while open: a card at the band's right end,
  // just above the input, whose button is below the input. Elsewhere the button heads it.
  const menu = isDesktop
    ? isOpen
      ? [
          <Box key={MENU} flexDirection="column" flexShrink={0} borderStyle="round" borderDimColor paddingX={1}>
            {list}
          </Box>,
        ]
      : []
    : [
        <Box key={MENU} flexDirection="column" alignItems="flex-end" flexShrink={0}>
          {drawPill(parts.ui, [parts.name], isOpen)}
          {list}
        </Box>,
      ]
  const row = withChildren(
    (
      <Box key={CONTROLS} flexDirection="row" alignItems="center" columnGap={2} flexGrow={1} flexShrink={1} minWidth={0} />
    ) as BoxElement,
    [...controls, ...others],
  )
  return (
    <Box key={BAND} flexDirection="row" alignItems={isDesktop ? 'flex-end' : 'flex-start'} columnGap={2}>
      {row}
      {menu}
    </Box>
  )
}
