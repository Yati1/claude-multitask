export type Thread = {
  name: string
  color: string
  createdBy: 'user' | 'agent'
  // hidden from the thread picker, the move picker and the thread view's filter, but
  // kept: its messages keep their tags, and a heading naming it brings it back
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
  // a reply a tool call followed in its turn: words on the way, not the turn's last
  // reply, so the view leaves it out
  interim?: true
  // the pictures the person pasted with their message, in order
  images?: ViewImage[]
  // the main conversation's token position (TokenPos) as the row's turn ended, and its
  // compaction count then: how far the conversation has moved on since is the gap a
  // thread's summary is for. Absent until the turn ends; a row an earlier version kept
  // is stamped when the session starts.
  pos?: number
  epoch?: number
}

// The main conversation's token position: how many tokens its context (Claude's whole
// transcript as the model is sent it, tool output included) has grown by in all, from the
// context size the engine last reported (none before its first report this run), and how
// many compactions it has been through.
export type TokenPos = {
  pos: number
  last?: number
  epoch: number
}

// A picture the person pasted: its media type, its size where its header tells it, and
// the file Claude Code saved it to, read as the view draws it. Rows kept by an earlier
// version hold its bytes as base64 instead, where they were few enough to draw.
export type ViewImage = {
  type: string
  width?: number
  height?: number
  path?: string
  data?: string
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
      // whether the chat is filtered to the thread picked above the prompt; off (as at
      // first), the chat shows every row
      filtersChat: boolean
      // a heading's key as typed -> the key of the thread it was decided to mean at send
      snaps: Record<string, string>
      // the main conversation's rows since the person's last message, that message
      // first: each row's id and each tool call's, in the order they were stored
      recent: string[]
      // the start of each reply text in those rows: a screen may know a reply by an
      // id of its own (the desktop's is the API message's), so a reply is matched by text
      recentTexts: string[]
      // the key of the thread picked above the prompt ('' none): where a message with
      // no heading goes. The thread view does not follow it (viewThreads).
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
      // how many of the thread view's pictures have been read from their files: each
      // one read draws the view again
      picturesRead: number
      // the first of the thread view's sections it draws, by its place among them; null
      // while it draws the newest (as opened, or another pick in its filter)
      viewFrom: number | null
      // what the thread view's own filter picked: the keys of the threads it shows, and
      // '' for the sections of no thread; none, it shows every section
      viewThreads: string[]
      // whether the band's menu shows its switches, on a surface where a press opens it
      menuOpen: boolean
      // what the band's menu shows of the threads: '' its first rows (the switches, opening
      // the thread view, starting a thread, managing them), 'name' the field for a new
      // thread's name, 'manage' each thread's merge, archive and delete, `merge:<key>` the
      // threads that one can merge into, `delete:<key>` the question whether to delete it
      menuMode: string
      // whether the thread picker's list is open in the mobile app, which draws no Select:
      // its button opens and closes it
      pickerOpen: boolean
      // the main conversation's token position, kept with the session's record
      tokenPos: TokenPos
    }
  }
}
