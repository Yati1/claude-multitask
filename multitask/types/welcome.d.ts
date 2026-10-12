// What the welcome line (hooks/welcome.tsx) reads of the other mods' values, as their own
// contracts declare them: the mods each last dismissed it with, written as its session
// starts, so this mod knows which of them are installed. Not part of this mod's contract
// (plugin.json names index.d.ts). Without a mod its value is never written.

export {}

declare module 'claude-code' {
  interface PluginState {
    'thread-chat': {
      welcome: { seen: string[] }
    }
    react: {
      welcome: { seen: string[] }
    }
  }
}
