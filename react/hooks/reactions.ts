import type { Reaction } from '../types'

// What a reply that became a reaction goes on as, and is kept as: a reply the desktop
// draws as nothing, which the model reads as having said nothing.
export const NO_RESPONSE = 'No response requested.'

// What the model is told beside the person's message once reactions come on (and again
// after a compaction), and once after they go off.
export const BRIEF = `# Emoji reactions
When your whole reply would only acknowledge the user's message (such as "on it", "done", "got it" or "thanks"), you may reply with exactly one emoji and nothing else, for example 👍, ✅ or 🙏. It is shown as a reaction on the user's message instead of as a reply, and your history keeps that reply as "${NO_RESPONSE}". Any other reply, more than one emoji included, is shown as a normal reply. This holds for the rest of the conversation, until a note says the user turned reactions off.`

export const OFF_NOTE =
  'The user turned emoji reactions off. Acknowledge in words again: a reply of one emoji is now shown as a normal reply.'

// One emoji: a flag, a keycap, or a pictograph with its presentation and skin tone
// marks, joined to others by zero-width joiners, and a subdivision flag's tags.
const PICTOGRAPH = '\\p{Extended_Pictographic}\\uFE0F?\\p{Emoji_Modifier}?'
const ONE_EMOJI = new RegExp(
  `^(?:\\p{Regional_Indicator}{2}|[#*0-9]\\uFE0F?\\u20E3|${PICTOGRAPH}(?:\\u200D${PICTOGRAPH})*[\\u{E0020}-\\u{E007F}]*)$`,
  'u',
)
// What an emoji is made of, a lone surrogate included: a reply streamed so far that
// holds nothing else may still turn out to be one.
const EMOJI_PARTS =
  /^[\p{Extended_Pictographic}\p{Emoji_Modifier}\p{Regional_Indicator}‍️⃣\u{E0020}-\u{E007F}#*0-9\uD800-\uDFFF]*$/u
// The longest emoji held for, in UTF-16 units: a family or a subdivision flag is
// under 20.
const EMOJI_MAX = 32

// Whether a reply's whole text is one emoji, spacing round it aside.
export const isOneEmoji = (text: string) => ONE_EMOJI.test(text.trim())

// Whether a reply streamed so far could still be one emoji once it has all come.
export function couldBeEmoji(text: string): boolean {
  const t = text.trim()
  return t.length <= EMOJI_MAX && EMOJI_PARTS.test(t)
}

// A text's start with its spacing dropped: the same however the text's blocks were
// joined, and with notes for the model after it.
export const markOf = (text: string) => text.replace(/\s+/g, '').slice(0, 80)

// A mark this short ("ok", "thanks") is said too often to know a message by.
const MIN_MARK = 12

// A row's id as the screen may know it: blocks of one stored row drawn apart take ids
// that keep the row's first 24 characters.
const stemOf = (id: string) => id.slice(0, 24)

function newest(list: readonly Reaction[], is: (r: Reaction) => boolean): Reaction | undefined {
  for (let i = list.length - 1; i >= 0; i--) {
    const r = list[i] as Reaction
    if (is(r)) return r
  }
  return undefined
}

// The reaction drawn on a message: the one kept for its row id; failing that, for a
// person's message (`text` given), the newest kept for a message that starts the same,
// where that start is long enough to tell messages apart.
export function reactionFor(list: readonly Reaction[], id: string, text?: string): Reaction | undefined {
  const byId = newest(list, r => r.id === id) ?? (id.length >= 24 ? newest(list, r => stemOf(r.id) === stemOf(id)) : undefined)
  if (byId !== undefined || text === undefined) return byId
  const mark = markOf(text)
  return mark.length < MIN_MARK ? undefined : newest(list, r => r.mark === mark)
}

// How many reactions a session keeps: the newest.
const REACTIONS_KEPT = 500

// The reactions once `reaction` is on its message, in place of one it had.
export function withReaction(list: readonly Reaction[], reaction: Reaction): Reaction[] {
  return [...list.filter(r => r.id !== reaction.id), reaction].slice(-REACTIONS_KEPT)
}

// The reactions of both lists, `newer` winning for a message both have.
export function joinReactions(older: readonly Reaction[], newer: readonly Reaction[]): Reaction[] {
  return newer.reduce((all, r) => withReaction(all, r), [...older])
}

// The reactions on messages a conversation still holds: those of a session rewound or
// forked from another, which may have left some of its messages behind.
export function reactionsHeld(list: readonly Reaction[], messages: readonly { role: string; text: string }[]): Reaction[] {
  const marks = messages.filter(m => m.role === 'user').map(m => markOf(m.text))
  return list.filter(r => r.mark !== '' && marks.some(mark => mark.startsWith(r.mark)))
}

// Hashes of the starts of a conversation's messages, long enough to tell it apart:
// what a session rewound or forked from this one is known by.
export function marksOf(messages: readonly { text: string }[]): string[] {
  return messages
    .map(m => markOf(m.text))
    .filter(start => start.length >= MIN_MARK)
    .map(start => {
      let hash = 0x811c9dc5
      for (let i = 0; i < start.length; i++) hash = Math.imul(hash ^ start.charCodeAt(i), 0x01000193)
      return (hash >>> 0).toString(16).padStart(8, '0')
    })
}
