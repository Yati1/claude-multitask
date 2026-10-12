// An emoji the agent answered a person's message with, shown on that message: the
// message by its stored row id and the start of its text as typed.
export type Reaction = {
  id: string
  // the text's start, whitespace dropped: how the message is known where the screen
  // draws it under another id
  mark: string
  emoji: string
}

// The person's message the main conversation's current turn answers.
export type Answering = { id: string; mark: string }

// thread-chat's thread view reads `isOn` and `reactions` to draw the reactions on the
// person's messages as the chat does (its types/react.d.ts): keep their keys and shape,
// or change both mods together.
declare module 'claude-code' {
  interface PluginState {
    react: {
      // whether reactions are on in the session: as the person last chose there with
      // /react, else as the default; off, the mod leaves the session be
      isOn: boolean
      // the person's own choice in the session with /react, kept over the default; null
      // until they make one
      choice: boolean | null
      // whether reactions are on in a session with no choice of its own, as the person
      // last set with /react default (kept for every session); on until they set it
      isOnByDefault: boolean
      // whether the model was last told, beside the person's message, that reactions
      // are on; false again after a compaction while on, so it is told again
      isBriefed: boolean
      // the reactions so far, oldest first, one per message
      reactions: Reaction[]
      // the person's message the turn running now answers; null when the turn came
      // from anything else (a notification, a plugin's prompt)
      answering: Answering | null
      // the mods the welcome line above the prompt was last dismissed with, as this mod's
      // store kept them (hooks/welcome.tsx); written as the session starts, so the other
      // mods know this one is installed
      welcome: { seen: string[] }
    }
  }
}
