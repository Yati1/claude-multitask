// What the thread view reads of the react mod's values, as react's own contract declares
// them, so it can draw react's reactions on the person's messages as the chat does. Not
// part of thread-chat's contract (plugin.json names index.d.ts): react ships its own.
// Without react the values are never written, and the view reads their initials.

export {}

declare module 'claude-code' {
  interface PluginState {
    react: {
      // whether reactions are on in the session; off, react draws none
      isOn: boolean
      // the emoji the agent answered a person's message with, oldest first, one per
      // message: the message by its stored row id and the start of its text as typed,
      // whitespace dropped
      reactions: { id: string; mark: string; emoji: string }[]
    }
  }
}
