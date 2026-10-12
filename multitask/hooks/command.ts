import type { AskOptions } from 'claude-code'

// This file is the same in thread-chat, multitask and react: keep the copies identical.
//
// Each mod's slash command (/threads, /multitask, /react) switches it on or off in the
// chat, and by default in new chats, with the same arguments:
//
//   (none)                     asks whether it is on in this chat, in the engine's question dialog
//   on | enable                on in this chat, as the person's choice there
//   off | disable              off in this chat, as the person's choice there
//   toggle                     the other way in this chat
//   status                     says how it is, here and in new chats
//   default                    asks whether new chats start with it on
//   default on | enable        on in new chats, and in chats never switched
//   default off | disable      off in new chats, and in chats never switched
//
// Setting the chat to what it is already still makes it the person's choice there, so a
// default set later leaves the chat be, and says it was so; setting the default to what it
// is already changes nothing and says so. Anything else changes nothing and says how to use
// it. Where no one can be asked (a `-p` run draws nowhere), the command says how it is
// instead. Its line in the command menu says how it is too.
//
// The engine lets `$` reach only functions declared in the file that uses it, so this file
// never touches the session: each mod's command hook hands it what it needs (Session).

// One mod's switch, by name.
export type Names = {
  // the command's name, without its slash
  command: string
  // what it switches, as a sentence starts with it (`Threads`), and the verb that follows
  noun: string
  be: 'is' | 'are'
  // the arguments the mod takes beside these, for the usage line (`mode [multitask|focus]`)
  extraUsage?: string
}

// How the switch is.
export type State = {
  // whether it is on in this chat
  isOnHere: boolean
  // the person's own choice in this chat; null where the chat follows the default
  choiceHere: boolean | null
  // whether it is on in new chats
  isOnByDefault: boolean
  // what more there is to say of the chat while it is on (multitask's mode), or ''
  detail: string
}

// The session, as a mod's command hook hands it over.
export type Session = {
  // how the switch is now
  state: () => Promise<State>
  // whether anyone can be asked: a session that draws nowhere (a `-p` run) has no one
  canAsk: () => Promise<boolean>
  // `$.ui.ask`: the label picked, or typed text; rejects when dismissed
  ask: (question: string, options: AskOptions) => Promise<string>
  // turns it on or off in this chat as the person's choice; what to say. Called with what
  // the chat is already, it records the choice and changes nothing else.
  setHere: (isOn: boolean) => Promise<string>
  // turns it on or off by default; what to say
  setDefault: (isOn: boolean) => Promise<string>
}

const ON = new Set(['on', 'enable'])
const OFF = new Set(['off', 'disable'])

// On or off, as a word of the person's means it; undefined for any other word.
export const valueOf = (word: string): boolean | undefined =>
  ON.has(word.toLowerCase()) ? true : OFF.has(word.toLowerCase()) ? false : undefined

const onOff = (isOn: boolean) => (isOn ? 'on' : 'off')

// The command's arguments, as the menu draws them dim after its name.
export const argumentHint = (names: Names) =>
  `[on|off|toggle|status|${names.extraUsage === undefined ? '' : `${names.extraUsage.split(' ')[0]}|`}default [on|off]]`

// What the command says to an argument it does not take.
export const usageOf = (names: Names) =>
  `Usage: \`/${names.command} [on|off|toggle|status|${names.extraUsage === undefined ? '' : `${names.extraUsage}|`}default [on|off]]\`; with no argument it asks.`

// The person's words after the command, lower case.
export const wordsOf = (args: string) => args.trim().toLowerCase().split(/\s+/).filter(word => word !== '')

const detailOf = (state: State) => (state.isOnHere && state.detail !== '' ? `, ${state.detail}` : '')

// How it is, here and in new chats: `Threads: on in this chat (your choice) · off in new chats`.
export function statusOf(names: Names, state: State): string {
  const why = state.choiceHere === null ? 'following the default' : 'your choice'
  return `${names.noun}: ${onOff(state.isOnHere)} in this chat (${why})${detailOf(state)} · ${onOff(state.isOnByDefault)} in new chats`
}

// The command's line in the menu: `Threads: on here · off in new chats`.
export const descriptionOf = (names: Names, state: State) =>
  `${names.noun}: ${onOff(state.isOnHere)} here${detailOf(state)} · ${onOff(state.isOnByDefault)} in new chats`

// Asks `question` with `labels`, the one at `current` marked as the current one; the
// index of the label picked, or of the one a typed answer names; undefined when the
// dialog was dismissed or the answer names none.
export async function askAmong(
  ask: Session['ask'],
  question: string,
  header: string,
  labels: readonly string[],
  current: number,
): Promise<number | undefined> {
  const shown = labels.map((label, i) => (i === current ? `${label} (current)` : label))
  try {
    const answer = await ask(question, { options: shown, header })
    const picked = shown.indexOf(answer)
    if (picked >= 0) return picked
    const typed = labels.findIndex(label => label.toLowerCase() === answer.trim().toLowerCase())
    return typed >= 0 ? typed : undefined
  } catch {
    return undefined
  }
}

// Asks on or off; true or false, or undefined when dismissed or answered otherwise.
async function askOnOff(session: Session, question: string, header: string, isOn: boolean): Promise<boolean | undefined> {
  const picked = await askAmong(session.ask, question, header, ['On', 'Off'], isOn ? 0 : 1)
  return picked === undefined ? undefined : picked === 0
}

// Makes `isOn`, which the chat is already, the person's choice there, as `on` or `off`
// does; says it was so, and, where the chat followed the default, that it now keeps it.
async function keepHere(session: Session, names: Names, state: State, isOn: boolean): Promise<string> {
  await session.setHere(isOn)
  const already = `${names.noun} ${names.be} already ${onOff(isOn)}`
  if (state.choiceHere === isOn) return `${already} in this chat.`
  return `${already}; this chat now keeps ${names.be === 'are' ? 'them' : 'it'} ${onOff(isOn)}.`
}

// Asks whether it is on in this chat (the bare command) or, with `isDefault`, in new chats
// (`/<command> default`), and changes it as answered. A dismissed question changes nothing
// and says how it is; so does an answer of the default it is already. An answer of what
// the chat is already makes it the person's choice there.
async function askOne(session: Session, names: Names, isDefault: boolean): Promise<string> {
  if (!(await session.canAsk())) return statusOf(names, await session.state())
  const before = await session.state()
  const isOn = isDefault
    ? await askOnOff(session, `${names.noun} in new chats?`, 'New chats', before.isOnByDefault)
    : await askOnOff(session, `${names.noun} in this chat?`, 'This chat', before.isOnHere)
  const now = await session.state()
  if (isOn === undefined || (isDefault && isOn === now.isOnByDefault)) return `No change. ${statusOf(names, now)}`
  if (isDefault) return session.setDefault(isOn)
  return isOn === now.isOnHere ? keepHere(session, names, now, isOn) : session.setHere(isOn)
}

// Runs the command with the person's arguments (any the mod takes beside these handled
// before); what it says.
export async function runSwitch(session: Session, names: Names, args: string): Promise<string> {
  const words = wordsOf(args)
  const [first = '', second = ''] = words
  if (words.length === 0) return askOne(session, names, false)
  const state = await session.state()
  if (words.length === 1) {
    const value = valueOf(first)
    if (value === state.isOnHere) return keepHere(session, names, state, value)
    if (value !== undefined) return session.setHere(value)
    if (first === 'toggle') return session.setHere(!state.isOnHere)
    if (first === 'status') return statusOf(names, state)
    if (first === 'default') return askOne(session, names, true)
  }
  if (words.length === 2 && first === 'default') {
    const value = valueOf(second)
    if (value === state.isOnByDefault) return `${names.noun} ${names.be} already ${onOff(value)} by default in new chats.`
    if (value !== undefined) return session.setDefault(value)
  }
  return usageOf(names)
}
