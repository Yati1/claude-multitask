import type { ClientModule, JsonValue } from 'claude-code'

type State = { isHeld: boolean }

// An invisible hit area laid over a part of the desktop's `thoughts` button (its word, a
// dot, its `+N`): a click, Enter or Space posts `{ press: true }` to the hooks module,
// which opens the Thoughts pane. One per part, inside the part's own Box, so the pointer
// over a dot is still over that dot, for its card.
const Press: ClientModule<JsonValue, State> = (props, surface) => {
  const { Text } = surface.elements
  const press = () => surface.post({ press: true })

  // A click presses once, whether the surface reports its down, its up or both.
  surface.onPointer(e => {
    if (e.button !== undefined && e.button !== 'left') return
    if (e.type === 'down') {
      surface.setState({ isHeld: true })
      press()
    } else if (e.type === 'up') {
      if (surface.state?.isHeld === true) surface.setState({ isHeld: false })
      else press()
    }
  })
  surface.onKey(e => {
    if (e.key === 'return' || e.key === ' ') press()
  })

  return <Text>{' '.repeat(Math.max(1, surface.columns))}</Text>
}

export default Press
