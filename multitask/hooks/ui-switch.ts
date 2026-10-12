import type { EngineInterface, On } from 'claude-code'

// This file is the same in thread-chat, multitask and react: keep the copies identical.
//
// Claude Code draws a mod's controls in an app (the desktop's, a phone's) only while its
// hooks-modules switch reads on. The switch is a rollout flag each Claude Code process
// saves, as it starts, to one cache in the global config that every version shares. An
// older version that is served it off (such as one bundled in another app) saves it off,
// and a running session then refuses each request to draw a mod's controls, though the
// mods' hooks go on running; a newer version starting saves it on again. A session run
// with DISABLE_GROWTHBOOK set reads the flag's default instead, on since 2.1.289.
//
// So beside the person's message, while the saved switch reads off and the session
// draws in an app, the model is told what happened and what to do, once until the
// switch reads on again; a toast says so too. Whichever mod's hook runs first tells;
// the others find its note in the message's context and stay quiet.

const FLAG = 'tengu_plugin_hooks_modules'

// What every copy's note holds, so the others know it is told.
export const SWITCH_MARK = 'hooks-modules switch'

export const SWITCH_NOTE =
  `The mods' controls are off in the app: an older Claude Code version on this computer (such as one bundled in another app) reset the shared ${SWITCH_MARK}, so Claude Code has stopped drawing the controls of the thread-chat, multitask and react mods (the band above the prompt, reactions); the mods still work underneath. ` +
  'Tell the user this once, plainly, with what to do: open a new session in the Code tab, which turns the switch back on. ' +
  'For a lasting fix, run the older Claude Code with DISABLE_GROWTHBOOK=1 set, or upgrade it to 2.1.289 or later.'

export const SWITCH_TOAST = `The mods' controls are off: an older Claude Code version reset the ${SWITCH_MARK}. Open a new session in the Code tab to turn it back on.`

const TOAST_MS = 20_000

// A read over this rejects; such a config is left unread.
const READ_LIMIT = 4 * 1024 * 1024

// The ways a person's own prompt arrives: typed in the terminal, the desktop app (an SDK
// host) or Remote Control.
const PERSON = /^(composer|sdk|bridge)$/

type Watch = {
  // the global config's path; null where there is no home folder
  path?: string | null
  // the global config as last read: its file's size and time, and whether it held the
  // switch saved off
  saved?: { mtimeMs: number; size: number; isOff: boolean }
  // whether the session reads the flag's default (on) whatever is saved
  isDefaultOn?: boolean
  // whether the person was told since the switch last read on
  isTold: boolean
}

// Where the engine keeps the global config: in CLAUDE_CONFIG_DIR, else the home folder.
async function configPath($: EngineInterface, watch: Watch): Promise<string | null> {
  if (watch.path !== undefined) return watch.path
  const dir = (await $.env.get('CLAUDE_CONFIG_DIR')) || (await $.env.get('USERPROFILE')) || (await $.env.get('HOME'))
  watch.path = dir ? `${dir.replace(/[\\/]+$/, '')}/.claude.json` : null
  return watch.path
}

// Whether the saved switch reads off; undefined when the config cannot be read. Read
// again only once the file changed.
async function isSavedOff($: EngineInterface, watch: Watch): Promise<boolean | undefined> {
  const file = await configPath($, watch)
  if (file === null) return undefined
  const stat = await $.fs.stat(file).catch(() => undefined)
  if (stat === undefined || stat.size > READ_LIMIT) return undefined
  if (watch.saved?.mtimeMs === stat.mtimeMs && watch.saved.size === stat.size) return watch.saved.isOff
  const text = await $.fs.read(file).catch(() => undefined)
  if (typeof text !== 'string') return undefined
  let config: { cachedGrowthBookFeatures?: Record<string, unknown> } | null
  try {
    config = JSON.parse(text)
  } catch {
    return undefined
  }
  const isOff = config?.cachedGrowthBookFeatures?.[FLAG] === false
  watch.saved = { mtimeMs: stat.mtimeMs, size: stat.size, isOff }
  return isOff
}

// The note to put beside the person's message, when they are to be told.
async function switchNote($: EngineInterface, watch: Watch, context: readonly string[], kind: string): Promise<string | undefined> {
  if (watch.isDefaultOn === undefined) {
    const value = (await $.env.get('DISABLE_GROWTHBOOK'))?.trim() ?? ''
    watch.isDefaultOn = !/^(|0|false|no|off)$/i.test(value)
  }
  if (watch.isDefaultOn) return undefined
  const isOff = await isSavedOff($, watch)
  if (isOff === undefined) return undefined
  if (!isOff) {
    watch.isTold = false
    return undefined
  }
  if (context.some(note => note.includes(SWITCH_MARK))) watch.isTold = true
  if (watch.isTold) return undefined
  // The terminal draws the controls itself: only an app's are refused.
  const isInApp = kind !== 'composer' || (await $.session.surfaces()).some(surface => surface !== 'terminal')
  if (!isInApp) return undefined
  watch.isTold = true
  $.ui.toast(SWITCH_TOAST, { timeoutMs: TOAST_MS })
  return SWITCH_NOTE
}

// Tells the model and the person, beside the person's message, when Claude Code stopped
// drawing the mods' controls.
export function watchSwitch(on: On) {
  const watch: Watch = { isTold: false }
  on('prompt.submit', { origin: { kind: PERSON } }, async ($, e, next) => {
    const note = await switchNote($, watch, e.context ?? [], e.origin.kind).catch(() => undefined)
    return note === undefined ? next(e) : next({ ...e, context: [...(e.context ?? []), note] })
  })
}
