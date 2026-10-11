export type ThoughtStatus = 'running' | 'idle' | 'stopped' | 'failed'

export type Thought = {
  // the subagent's id, as $.agent.spawn answered it
  id: string
  name: string
  task: string
  color: string
  status: ThoughtStatus
  // messages the voice queued for when the thought finishes its current turn
  queued: string[]
  // the text of its latest finished turn: its report, question or problem
  lastText: string
  // its latest progress notes, oldest first, kept for following its work (each is relayed too)
  notes: string[]
  // whether it wrote a note after its latest report, which the Thoughts pane then no longer shows
  notedSinceReport?: boolean
  // the turn it is running now, from its latest model request
  turnId: string | null
  // a message to hand over once the interrupted turn has ended
  interruptWith: string | null
  // whether its queue waits no longer for a turn to end: the turn it waited for ended, and
  // it goes to the thought at the next chance
  isHandOverDue?: boolean
  // when it was started, or its latest turn began; when it wrote its latest note; when its
  // latest turn ended or it was stopped (ms, by $.clock). Absent for a thought kept before
  // they were noted.
  startedAt?: number
  notedAt?: number
  endedAt?: number
}

// What a thought said, waiting to reach the voice: a progress note, or the end of a
// turn (isDone), with the text it ended on or none. A turn's end tells how many of the
// voice's messages waited for it (pending), and whether they have reached the thought
// since; a note about such messages still pending is isPending, dropped once they reach it.
// isFromPerson: not the thought's but the person's own message to it, from the Thoughts pane.
export type Update = {
  thought: string
  text: string
  isDone?: boolean
  pending?: number
  isHandedOver?: boolean
  isPending?: boolean
  isFromPerson?: boolean
}

// A session's thoughts as kept in the store between runs of the app: when they were kept,
// and the list, its oldest ended thoughts dropped past a bound.
export type KeptThoughts = { at: number; thoughts: Thought[] }

// What the voice was last told of a thought, by a relay or a what's-new note: its status,
// its report and its latest progress note as they were then
export type Heard = { status: ThoughtStatus; report: string; note: string }

declare module 'claude-code' {
  interface PluginState {
    multitask: {
      isOn: boolean
      thoughts: Thought[]
      inbox: Update[]
      isMainBusy: boolean
      // what the voice was last told of each thought, by thought id
      heard: Record<string, Heard>
      // whether the voice was last told, beside the person's message, that Multitask is on;
      // false again after a compaction while on, so its whole part is told again
      toldVoice: boolean
      // thoughts the person opened in the Thoughts pane to show everything: a finished one's
      // whole card instead of one line, a running one's whole task instead of its first line
      expanded: string[]
      // thoughts whose last report the person opened in the Thoughts pane to read whole,
      // instead of its first line; a thought leaves it when it starts new work
      openReports: string[]
      // counts the minutes the Thoughts pane has stood open, so its ages are drawn afresh
      paneTick: number
      // counts the band's own redraws: a dot starting to blink, a thought's dot fading out as
      // its turn ends, a blink or note on the terminal ending, the ages in the dots' hover
      // cards each minute
      bandTick: number
      // the thought whose card in the Thoughts pane has its field open to tell it something; '' none
      tellingTo: string
      // whether the Thoughts pane lists every thought that is not running, not only the
      // most recently ended (the person pressed `N more`)
      showsAllEnded: boolean
      // where the turn through the palette's first colours stands: the index of the next a
      // thought takes, unless a running thought holds it
      colorTurn: number
    }
  }
}
