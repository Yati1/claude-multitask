export type Thread = {
  name: string
  color: string
  // picked in the band's filter; none picked shows everything
  isSelected: boolean
  createdBy: 'user' | 'agent'
}

declare module 'claude-code' {
  interface PluginState {
    'thread-chat': {
      threads: Thread[]
      // a merged-away thread's key -> the key of the thread it now belongs to
      aliases: Record<string, string>
      agentMayCreate: boolean
      // a heading's key as typed -> the key of the thread it was decided to mean at send
      snaps: Record<string, string>
      // the main conversation's rows since the person's last message, that message
      // first: each row's id and each tool call's, in the order they were stored
      recent: string[]
      // the start of each reply text in those rows: a screen may know a reply by an
      // id of its own (the desktop's is the API message's), so a reply is matched by text
      recentTexts: string[]
      // a person's message row id -> the key of the thread it went to: sent with no
      // heading while that thread alone was picked
      sentTo: Record<string, string>
    }
  }
}
