// The band's mods menu (hooks/menu.tsx) is copied into each mod, as installed mods share no
// files; each copy finds the others' band by its keys, so the copies must stay the same.
import { readFileSync } from 'node:fs'

const mods = ['thread-chat', 'multitask', 'react']
const [first, ...rest] = mods.map(mod => readFileSync(new URL(`../${mod}/hooks/menu.tsx`, import.meta.url), 'utf8'))
const differing = mods.slice(1).filter((_, i) => rest[i] !== first)
if (differing.length > 0) {
  console.error(`hooks/menu.tsx differs from thread-chat's in: ${differing.join(', ')}. Make the copies the same.`)
  process.exit(1)
}
