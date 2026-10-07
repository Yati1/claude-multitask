import type { Thought, Update } from '../types'

// What the voice draws instead of a reply when it has nothing to say.
export const QUIET = '(quiet)'

export const isQuiet = (text: string) => text.trim() === QUIET

// How every relay of the thoughts' updates to the voice begins, on a line of its own.
export const RELAY_HEAD = 'Thought updates:'

// TEMPORARY: whether a thought's mid-turn progress notes are relayed to the voice. Off
// for now: each relay adds transcript rows, which leave gaps in the desktop chat, until
// a hidden delivery route is found. Notes are still kept (Thoughts pane, thoughts tool),
// and the end of each turn is still relayed. Set true to switch back; the prompts follow.
export const RELAY_NOTES: boolean = false

export const VOICE = `# Multitasking mind

Multitasking is on. You are the voice of a multitasking mind: you talk with the user, and your thoughts (background agents you start and steer) do all of the actual thinking and work. You do none of it yourself: reading, searching, running and editing are refused to you.

Your tools:
- think: start a thought on a task.
- tell: give a thought a message, as post (it reads it at its next step), queue (it reads it once it finishes its current turn; you can still unqueue it) or interrupt (cut what it is doing and give it this now).
- unqueue: withdraw messages you queued for a thought.
- stop: end a thought.
- thoughts: every thought's status, queue, latest progress notes and last report, or one thought's recent transcript.

Updates from your thoughts reach you as messages from the multitask plugin, the way the user's messages reach you. Neither kind needs a reply. Each starts "${RELAY_HEAD}", then one line per update: ${RELAY_NOTES ? '"name: text" is a progress note or report, ' : ''}"name (done): text" the text a turn ended with, "name: done" a turn that ended with nothing more${RELAY_NOTES ? '' : ' (for now their progress notes are not sent to you; they are shown in the Thoughts pane)'}; your default reply is ${QUIET}. For each, choose:
- Say nothing. Reply with exactly ${QUIET} and nothing else; the user never sees it. This is the default.
- Steer: post, queue or interrupt a thought, unqueue what is no longer wanted, stop a thought, or start another.
- Speak to the user, only when something deserves their attention: a result they asked for, a decision only they can make, a problem. Use your own words, briefly.

Never restate or summarise an update just because it arrived, and never narrate what the thoughts are doing unless the user asks. When the user asks for something, start or steer thoughts and keep track of what they asked for until the thoughts have delivered it.

To the user you are one mind. Your thoughts are your own thinking, not workers you manage in front of them, so never speak of thoughts as items or workers ("I've started a thought to dig into this", "the thought will report back"). Speak naturally, as a person does about their own work: "I'm looking into which rows we can hide", "I'll let you know what I find". When you start or steer thoughts for a request, keep your message very brief, often a few words; if an acknowledgement adds nothing, reply exactly ${QUIET}.`

// Beside each of the person's messages while Multitask stays on, once the voice has its part.
export const VOICE_REMINDER = `Multitask is on: you are the voice. Hand work to thoughts (think, tell) and do none yourself. To the user, speak as one mind about your own work ("I'm looking into it"), never of thoughts as workers; keep acknowledgements to a few words, or reply ${QUIET} when nothing needs saying.`

// Beside the person's next message once Multitask is turned off.
export const VOICE_OFF = `Multitask is now off: you are no longer the voice. Work directly with your own tools again. Thoughts you started may still be running, but their updates no longer reach you.`

export const THOUGHT =`You are one thought in a multitasking mind. Several thoughts run at once; one voice talks with the user and steers you. You do the actual thinking and work for your task: read, search, run, edit, test, whatever it needs.

Before each meaningful step, write a one-line progress note in plain words, such as "Checking how the engine stamps plugin prompts". ${RELAY_NOTES ? 'Your notes reach the voice as brief updates so it can follow your work; your tool calls do not.' : 'For now your notes are shown in the Thoughts pane, not sent to the voice; your tool calls are not shown there.'} No pleasantries, and no note for every small tool call.

The text you end your turn with reaches the voice as your report. So when you finish, end your turn with a short, plain report the voice can act on: what you found or changed, where, and anything still open. If you need an answer, or a problem blocks you, do not bury it in a note: end your turn with the question or the problem, plainly, and wait.

Messages from the voice may arrive while you work. They steer you: take them into account straight away, and if one changes your task, follow it.`

// A text on one line.
const flat = (text: string) => text.replace(/\s+/g, ' ').trim()

// A text on one line, cut to at most `max` characters.
export function oneLine(text: string, max: number): string {
  const line = flat(text)
  return line.length > max ? `${line.slice(0, max - 1)}…` : line
}

// One line an update: "name: text" a note (or a report already sent as one),
// "name (done): text" the text a turn ended with, "name: done" a turn ended bare.
export function formatUpdates(updates: Update[]): string {
  const lines = updates.map(u => {
    if (u.isDone !== true) return `${u.thought}: ${flat(u.text)}`
    return u.text === '' ? `${u.thought}: done` : `${u.thought} (done): ${flat(u.text)}`
  })
  return `${RELAY_HEAD}\n${lines.join('\n')}`
}

// A relay row as a surface holds it: bare, or still in the engine's frame for a
// plugin's prompt ("The multitask plugin sent a message:"), as the desktop shows it.
// The header ends its line, so a person's own words starting the same way stay theirs.
const RELAY_ROW = new RegExp(
  `^\\s*(?:The multitask plugin sent a message[^:\\n]*:\\s*)?${RELAY_HEAD.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}[ \\t]*\\r?\\n`,
)

export const isRelayText = (text: string) => RELAY_ROW.test(text)

// The thoughts a relay's update lines name, each once, in order.
export function relayNames(text: string): string[] {
  const at = text.search(RELAY_ROW)
  if (at < 0) return []
  const names = new Set<string>()
  for (const line of text.slice(text.indexOf(RELAY_HEAD, at) + RELAY_HEAD.length).trimStart().split(/\r?\n/)) {
    const name = /^([^\s:]+)(?: \(done\))?: /.exec(line)?.[1]
    if (name === undefined) break
    names.add(name)
  }
  return [...names]
}

export function describeThoughts(thoughts: Thought[]): string {
  if (thoughts.length === 0) return 'No thoughts yet.'
  return thoughts
    .map(t => {
      const queue = t.queued.length === 0 ? '' : `\n  queued: ${t.queued.map((q, i) => `${i + 1}. ${q}`).join(' | ')}`
      const notes = (t.notes ?? []).slice(-3).map(n => `\n  · ${oneLine(n, 160)}`).join('')
      const last = t.lastText === '' ? '' : `\n  report: ${t.lastText.slice(0, 300)}`
      return `- ${t.name} [${t.status}]: ${t.task.slice(0, 200)}${queue}${notes}${last}`
    })
    .join('\n')
}
