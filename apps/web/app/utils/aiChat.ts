/**
 * Types and pure helpers for <AiChat> (Beautiful UI's ChatComposer, source 06).
 */

/** what the person typed, right-aligned in the thread */
export interface ChatUserEntry {
  id: string
  kind: 'user'
  text: string
}

/** one tool step the agent ran, e.g. "Historique . Temperature salon pendant 2 s" */
export interface ChatAgentEntry {
  id: string
  kind: 'agent'
  label: string
  sub?: string
  time?: string
  body: string
  /** still being finalized: dimmed, blurred and slightly scaled down until it settles */
  resolving?: boolean
}

export type ChatEntry = ChatUserEntry | ChatAgentEntry

export const CHAT_DEFAULT_PLACEHOLDER = 'Message, ou mentionnez un appareil avec @'
