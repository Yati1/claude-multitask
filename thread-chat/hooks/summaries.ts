import type { Thread, TokenPos, ViewRow } from '../types'
import { keyOf } from './parse'

// Thread summaries: how far the main conversation has moved on since each thread's last
// message, in tokens of Claude's own context (tool calls and results, reminders and all,
// not just the words the person sees), and the summaries a small model keeps of each
// thread so the agent can catch up on one it has lost track of.
//
// Here are the rules, as plain functions; register.tsx owns every hook and every call on
// `$`, as for the thread view (pane.tsx).

// The main conversation's token position: how many tokens its context has grown by in
// all (`pos`), from the context size the engine last reported (`last`, none before the
// first reading) and how many compactions it has been through (`epoch`). The context
// shrinking (a compaction, `/clear`, tool results cleared) is not counted back.
export const START_POS: TokenPos = { pos: 0, epoch: 0 }

// The position once the engine reports the context at `tokens` (the input tokens of the
// last response, everything the model was sent); as it was where the engine reports none.
// The first reading is the baseline.
export function advancedPos(at: TokenPos, tokens: number | undefined): TokenPos {
  if (tokens === undefined || !Number.isFinite(tokens)) return at
  if (at.last === undefined || tokens < at.last) return { ...at, last: tokens }
  return tokens === at.last ? at : { ...at, pos: at.pos + (tokens - at.last), last: tokens }
}

// The position once a compaction has run: every row stamped before it is past catching up.
export const compactedPos = (at: TokenPos): TokenPos => ({ ...at, epoch: at.epoch + 1 })

// A position as a session's record keeps it, or the start where it holds none that reads.
export function tokenPosOf(value: unknown): TokenPos | undefined {
  if (typeof value !== 'object' || value === null) return undefined
  const { pos, last, epoch } = value as Partial<Record<keyof TokenPos, unknown>>
  if (typeof pos !== 'number' || typeof epoch !== 'number') return undefined
  return typeof last === 'number' ? { pos, last, epoch } : { pos, epoch }
}

// The rows once those not yet stamped (stored since the last stamp, or kept by an earlier
// version) carry the position `at`; the same rows where all are stamped.
export function withStamps(rows: ViewRow[], at: TokenPos): ViewRow[] {
  if (rows.every(row => row.pos !== undefined)) return rows
  return rows.map(row => (row.pos !== undefined ? row : { ...row, pos: at.pos, epoch: at.epoch }))
}

// One section of the conversation as the thread view places it (pane.tsx's viewEntries):
// its row's id, who wrote it, its thread and its text.
export type SummaryEntry = { id: string | undefined; role: 'user' | 'assistant'; thread: Thread | undefined; text: string }

// How far a thread has fallen behind: its last message's row, the tokens the conversation
// has grown by since, and whether a compaction ran since (which past catching up too).
export type ThreadGap = {
  key: string
  name: string
  lastRow: string | undefined
  gap: number
  isCompacted: boolean
}

// Each thread's last message among the sections, in thread order, by the rows' stamps; a
// thread with no stamped row has no gap yet.
export function threadGaps(entries: readonly SummaryEntry[], rows: readonly ViewRow[], at: TokenPos, list: readonly Thread[]): ThreadGap[] {
  const lastRow = new Map<string, string>()
  for (const entry of entries) {
    if (entry.thread !== undefined && entry.id !== undefined) lastRow.set(keyOf(entry.thread.name), entry.id)
  }
  const byId = new Map(rows.map(row => [row.id, row]))
  return list.flatMap(t => {
    const key = keyOf(t.name)
    const id = lastRow.get(key)
    const row = id === undefined ? undefined : byId.get(id)
    if (row === undefined || row.pos === undefined) return []
    return [{ key, name: t.name, lastRow: id, gap: Math.max(0, at.pos - row.pos), isCompacted: (row.epoch ?? 0) < at.epoch }]
  })
}

// Whether a thread is far enough behind that the agent is caught up on it when the
// person next writes in it.
export const isPast = (gap: ThreadGap, threshold: number) => gap.isCompacted || gap.gap >= threshold

// Tokens as the trace says them: 12.3k.
export const tokensText = (n: number) => (n >= 1000 ? `${(n / 1000).toFixed(1)}k` : String(Math.round(n)))
