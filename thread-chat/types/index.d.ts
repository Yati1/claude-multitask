export type Thread = {
  name: string
  color: string
  createdBy: 'user' | 'agent'
  // hidden from the thread picker and the move picker, but kept: its messages keep
  // their tags, and a heading naming it brings it back
  isArchived?: boolean
}

// A row of the main conversation the thread view draws: a person's message or a
// reply's text, as stored, by its row id and the start of its text.
export type ViewRow = {
  id: string
  role: 'user' | 'assistant'
  // the text's start, whitespace dropped: how a transcript row is matched to it
  mark: string
  // the text as the transcript shows it (a person's message as typed, without the
  // notes for the model beside it), so the view does not depend on the conversation
  // a compaction rewrites. Absent on rows kept by an earlier version.
  text?: string
  // the length of the text as typed, where notes for the model follow it in the row
  // (rows of an earlier version, which kept no text)
  typed?: number
}

// Where the threads stood when the model was last told, beside the person's message:
// the merges (a merged-away thread's key -> its thread's key) and the agent switch.
export type Brief = {
  merged: Record<string, string>
  mayCreate: boolean
}

declare module 'claude-code' {
  interface PluginState {
    'thread-chat': {
      // whether threads are on in the session: the person turns them on and off with
      // /threads; off, the mod leaves the session be
      isOn: boolean
      threads: Thread[]
      // a merged-away thread's key -> the key of the thread it now belongs to
      aliases: Record<string, string>
      agentMayCreate: boolean
      // a heading's key as typed -> the key of the thread it was decided to mean at send
      snaps: Record<string, string>
      // the key of the thread picked above the prompt ('' none): where a message with
      // no heading goes, and what the thread view shows
      current: string
      // the keys of threads the person deleted: a heading that names one, or a merge or
      // an earlier send that points to one, belongs to no thread. A thread started again
      // by that name takes its key back.
      deleted: string[]
      // a person's message row id -> the key of the thread it went to: sent with no
      // heading while that thread was picked
      sentTo: Record<string, string>
      // `${row id}|${key of the thread a part was first placed in, '' none}` -> the key
      // of the thread the person moved it to ('' none)
      moved: Record<string, string>
      // the open move picker: `${row id}|${key of the thread its part sits in}`; '' none
      picking: string
      // whether the open move picker shows a field for a new thread's name in place
      // of its pills
      naming: boolean
      // moves, archives and deletions to tell the model beside the person's next message
      untold: string[]
      // what the model was last told of the threads; null until it is told how they
      // work (and again after a compaction)
      briefed: Brief | null
      // the person's messages and reply texts as stored, in order: what the thread
      // view draws, each by its transcript row's id
      viewRows: ViewRow[]
      // whether the band's `mods` menu is open off the desktop, where `mods` opens and closes
      // it; read only while this mod lays the band out
      menuOpen: boolean
    }
  }
}
