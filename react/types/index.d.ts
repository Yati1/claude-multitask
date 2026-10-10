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

// Where the desktop draws a reaction on the person's message: on the bubble's
// bottom-right corner, or under it, where the desktop shows the message's time and copy.
export type Place = 'corner' | 'under'

declare module 'claude-code' {
  interface PluginState {
    react: {
      // whether reactions are on in the session: the person turns them on and off with
      // /react; off, the mod leaves the session be
      isOn: boolean
      // whether the model was last told, beside the person's message, that reactions
      // are on; false again after a compaction while on, so it is told again
      isBriefed: boolean
      // the reactions so far, oldest first, one per message
      reactions: Reaction[]
      // the person's message the turn running now answers; null when the turn came
      // from anything else (a notification, a plugin's prompt)
      answering: Answering | null
      // where the desktop draws a reaction, as the person last chose with /react place
      // (kept for every session); the corner until they choose
      place: Place
    }
  }
}
