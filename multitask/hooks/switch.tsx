import type { ClientModule } from 'claude-code'

type State = { isHeld: boolean }

// An invisible hit area laid over a switch's picture: a click, Enter or Space
// posts `{ flip: true }` to the hooks module, which flips the value it draws.
const Switch: ClientModule<{ isOn: boolean }, State> = (props, surface) => {
  const { Text } = surface.elements
  const flip = () => surface.post({ flip: true })

  // A click flips once, whether the surface reports its down, its up or both.
  surface.onPointer(e => {
    if (e.button !== undefined && e.button !== 'left') return
    if (e.type === 'down') {
      surface.setState({ isHeld: true })
      flip()
    } else if (e.type === 'up') {
      if (surface.state?.isHeld === true) surface.setState({ isHeld: false })
      else flip()
    }
  })
  surface.onKey(e => {
    if (e.key === 'return' || e.key === ' ') flip()
  })

  return <Text>{' '.repeat(Math.max(1, surface.columns))}</Text>
}

export default Switch
