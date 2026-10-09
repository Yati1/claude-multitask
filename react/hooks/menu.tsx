import type { Elements, RenderElement, RenderNode, RenderSurface } from 'claude-code'

// The band above the prompt that the thread-chat, multitask and react mods share, and its
// `mods` menu: one small button at the band's right end whose menu holds each loaded mod's
// switches for the chat. This file is the same in each of the three mods, as installed
// mods share no files: a change to one is made to all three alike.
//
// Whichever of the mods draws the band first (the one nearest the engine) lays it out: a
// row of the mods' controls, then the menu. Each mod drawing after it finds the band in
// the tree beneath by its keys and adds its own controls and switches there, so the band
// and its button are drawn once with any one, two or all three of the mods loaded. Each
// switch is a Button of the mod that drew it, so its press reaches that mod alone.
//
// On the desktop the menu is a card the desktop floats over the band while the pointer is
// on `mods` or the card, or the keyboard is in them. Elsewhere `mods` opens and closes it
// in the band, by the open state of the mod that laid the band out.

export const BAND = 'claude-multitask-mods-band'
export const CONTROLS = 'claude-multitask-mods-controls'
export const MENU = 'claude-multitask-mods-menu'
export const SWITCHES = 'claude-multitask-mods-switches'
export const MENU_BUTTON = 'claude-multitask-mods'

const CONTROL = 'claude-multitask-mods-control:'
const SWITCH = 'claude-multitask-mods-switch:'

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
  controls?: BandControls
  switches: readonly MenuSwitch[]
  // Off the desktop: whether `mods` has the menu open, and the press that opens or closes
  // it. Read only by the mod that lays the band out.
  isOpen: () => Promise<boolean>
  onToggle: () => unknown
}

type BoxElement = Extract<RenderElement, { type: 'Box' }>

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

function controlsBox(ui: BandParts['ui'], controls: BandControls): RenderElement {
  const { Box } = ui
  const fit = controls.grows === true ? { flexGrow: 1, flexShrink: 1, minWidth: 0 } : { flexShrink: 0 }
  return (
    <Box key={`${CONTROL}${orderOf(controls.rank, controls.name)}`} flexDirection="row" alignItems="center" {...fit}>
      {controls.element}
    </Box>
  )
}

function switchRow(ui: BandParts['ui'], s: MenuSwitch): RenderElement {
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
  const { Box, Button } = parts.ui
  const controls = parts.controls === undefined ? [] : [controlsBox(parts.ui, parts.controls)]
  const switches = parts.switches.map(s => switchRow(parts.ui, s))

  const added = replaceKeyed(below, BAND, band => {
    const withControls = replaceKeyed(band, CONTROLS, box => withChildren(box, controls)) ?? band
    return (replaceKeyed(withControls, SWITCHES, box => withChildren(box, switches)) ?? withControls) as BoxElement
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
  const isDesktop = parts.surface === 'desktop'
  const isOpen = !isDesktop && (await parts.isOpen())
  const list = withChildren(
    (isDesktop ? (
      <Box key={SWITCHES} flexDirection="column" />
    ) : (
      <Box key={SWITCHES} flexDirection="column" display={isOpen ? 'flex' : 'none'} />
    )) as BoxElement,
    switches,
  )
  // The desktop opens the card as the pointer or the keyboard reaches `mods`, so its press
  // has nothing left to do.
  const menu = isDesktop ? (
    <Box key={MENU} flexShrink={0}>
      <Button key={MENU_BUTTON} label="mods" variant="secondary" dimColor onPress={() => undefined} />
      <Box position="absolute" display="none" hover={{ display: 'flex' }}>
        {list}
      </Box>
    </Box>
  ) : (
    <Box key={MENU} flexDirection="column" alignItems="flex-end" flexShrink={0}>
      <Button
        key={MENU_BUTTON}
        label="mods"
        variant={isOpen ? 'primary' : 'secondary'}
        dimColor={!isOpen}
        onPress={parts.onToggle}
      />
      {list}
    </Box>
  )
  const row = withChildren(
    (
      <Box key={CONTROLS} flexDirection="row" alignItems="center" columnGap={2} flexGrow={1} flexShrink={1} minWidth={0} />
    ) as BoxElement,
    [...controls, ...others],
  )
  return (
    <Box key={BAND} flexDirection="row" alignItems={isDesktop ? 'center' : 'flex-start'} columnGap={2}>
      {row}
      {menu}
    </Box>
  )
}
