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
  lastText: string
  // the turn it is running now, from its latest model request
  turnId: string | null
  // a message to hand over once the interrupted turn has ended
  interruptWith: string | null
}

// What a thought said, waiting to reach the voice
export type Update = { thought: string; text: string }

declare module 'claude-code' {
  interface PluginState {
    multitask: {
      isOn: boolean
      thoughts: Thought[]
      inbox: Update[]
      isMainBusy: boolean
      // whether the voice was last told, beside the person's message, that Multitask is on
      toldVoice: boolean
    }
  }
}
