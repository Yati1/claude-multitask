// Copies the plugin API types Claude Code writes into each mod when it loads it
// (<mod>/.claude-plugin/types/claude-code/index.d.ts) over the committed copy in
// engine-types/, taking the newest version found. Older Claude Code sessions keep
// rewriting the generated copies, so it never replaces the committed copy with an
// older version unless run with --force. Run from the main checkout or a worktree:
// it also reads the main checkout's mods, the only ones the engine loads.
import { execFileSync } from 'node:child_process'
import { copyFileSync, existsSync, readFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'

const MODS = ['thread-chat', 'multitask']
const git = (...args) => execFileSync('git', args, { encoding: 'utf8' }).trim()
const here = git('rev-parse', '--show-toplevel')
const main = dirname(git('rev-parse', '--path-format=absolute', '--git-common-dir'))
const target = join(here, 'engine-types', 'claude-code', 'index.d.ts')

// The version on the first line, "// Written by Claude Code 2.1.293.", as numbers.
const version = file => {
  const match = /Written by Claude Code (\d+(?:\.\d+)*)/.exec(readFileSync(file, 'utf8').split('\n', 1)[0])
  return match ? match[1].split('.').map(Number) : undefined
}
const compare = (a, b) => {
  for (let i = 0; i < Math.max(a.length, b.length); i++) if ((a[i] ?? 0) !== (b[i] ?? 0)) return (a[i] ?? 0) - (b[i] ?? 0)
  return 0
}

const roots = [...new Set([resolve(here), resolve(main)])]
const found = roots
  .flatMap(root => MODS.map(mod => join(root, mod, '.claude-plugin', 'types', 'claude-code', 'index.d.ts')))
  .filter(existsSync)
  .map(file => ({ file, version: version(file) }))
  .filter(source => source.version)
  .sort((a, b) => compare(b.version, a.version))

const newest = found[0]
if (!newest) {
  console.error('No generated types found: load the mods in Claude Code first.')
  process.exit(1)
}
const current = existsSync(target) ? version(target) : undefined
const name = v => v.join('.')
if (current && compare(newest.version, current) === 0) {
  console.log(`engine-types is already at ${name(current)}.`)
} else if (current && compare(newest.version, current) < 0 && !process.argv.includes('--force')) {
  console.error(`The newest generated types are ${name(newest.version)}, older than the committed ${name(current)}; left as is (--force to replace).`)
  process.exit(1)
} else {
  copyFileSync(newest.file, target)
  console.log(`engine-types: ${current ? name(current) : 'none'} -> ${name(newest.version)}, from ${newest.file}`)
}
