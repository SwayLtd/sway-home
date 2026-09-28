/**
 * Types and pure helpers for AiAgentScreen (Beautiful UI's 20_AgentScreen.tsx).
 *
 * Real use in Sway Home: a camera snapshot (an image URL the parent refreshes every few
 * seconds) or a live video URL, plus "teach a task" - while `recording` is true the hub
 * records what the person does by hand and turns it into a routine proposal once it stops.
 */

export type AgentScreenVariant = 'default' | 'Loading'

/** mm:ss, matching the source's fmt() (no hour digit, wraps past 99 minutes). */
export function agentScreenFormatElapsed(totalSeconds: number): string {
  const minutes = Math.floor(totalSeconds / 60)
  const seconds = totalSeconds % 60
  return `${String(minutes).padStart(2, '0')}:${String(seconds).padStart(2, '0')}`
}

/** Whether a src should play as <video> rather than render as <img>, by file extension. */
export function agentScreenIsVideoSrc(src: string): boolean {
  return /\.(mp4|webm|mov|m4v)(\?|$)/i.test(src)
}
