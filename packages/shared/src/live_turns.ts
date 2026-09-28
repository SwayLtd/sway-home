import { stripRichText } from './rich_text.ts'

/**
 * Turn taking for a GPT-Live call, decided by the application.
 *
 * GPT-Live holds the conversation, but it does not know the house, and waiting for it to
 * *decide* to delegate proved unreliable: sometimes it answered on its own, sometimes it said
 * nothing, and in both cases no request ever reached the house. So the application decides:
 *
 *  1. Transcript fragments of the user's speech accumulate into an utterance.
 *  2. A pause (`silenceMs` with no new fragment) ends the utterance.
 *  3. The utterance goes to the house agent - the same agent, tools and permission checks as
 *     the text path - and is shown on screen immediately.
 *  4. The answer goes back to GPT-Live to be spoken: threaded to a delegation if GPT-Live
 *     opened one, or, after `graceMs` without one, as general commentary. Either way it is
 *     delivered exactly once.
 *
 * OpenAI documents this pattern for client delegation: "use the transcript itself to trigger
 * application-owned work" (https://developers.openai.com/api/docs/guides/live-delegation).
 *
 * Pure TypeScript with injected time, so it runs the same in the browser and in tests.
 */

export interface LiveTurnReply {
  text: string
  attachments: { kind: string; data: Record<string, unknown> }[]
}

export interface LiveTurnOptions {
  /** A pause this long after the last fragment ends the utterance. */
  silenceMs?: number
  /** How long to wait for GPT-Live to open a delegation before speaking the answer anyway. */
  graceMs?: number
  /** How long a delegation with nothing heard waits for a transcript before giving up. */
  orphanMs?: number
  /** Sends one utterance to the house agent. */
  ask: (text: string) => Promise<LiveTurnReply>
  /** Sends one event on the GPT-Live data channel. */
  send: (event: Record<string, unknown>) => void
  onUtterance?: (text: string) => void
  onReply?: (text: string, reply: LiveTurnReply) => void
  /** Injected so tests control time. Returns a cancel function. */
  schedule?: (fn: () => void, ms: number) => () => void
}

/** `session.*.append` carries at most 500 tokens; this character budget stays under it. */
export const LIVE_APPEND_LIMIT = 1400

interface Turn {
  id: number
  text: string
  delegationId: string | null
  outcome: { reply: LiveTurnReply } | { error: Error } | null
  delivered: boolean
  cancelGrace: (() => void) | null
}

const defaultSchedule = (fn: () => void, ms: number) => {
  const handle = setTimeout(fn, ms)
  return () => clearTimeout(handle)
}

export class LiveTurns {
  readonly #options: Required<Omit<LiveTurnOptions, 'onUtterance' | 'onReply'>> & Pick<LiveTurnOptions, 'onUtterance' | 'onReply'>
  #buffer = ''
  #cancelSilence: (() => void) | null = null
  #turns: Turn[] = []
  #waiting: { id: string; cancel: () => void }[] = []
  #sequence = 0

  constructor(options: LiveTurnOptions) {
    this.#options = {
      silenceMs: 900,
      graceMs: 1200,
      orphanMs: 3000,
      schedule: defaultSchedule,
      ...options,
    }
  }

  /** What the user is saying right now, for the live caption. */
  caption(): string {
    return this.#buffer.trim()
  }

  /** One `session.input_transcript.delta`. */
  heard(delta: string): void {
    this.#buffer += delta
    this.#cancelSilence?.()
    this.#cancelSilence = this.#options.schedule(() => this.#endUtterance(), this.#options.silenceMs)
  }

  /** One `session.delegation.created` with a client target. */
  delegated(id: string): void {
    // Mid-sentence: GPT-Live has heard enough to want help, so the sentence ends here and
    // this delegation carries its answer.
    if (this.#buffer.trim().length > 0) {
      this.#wait(id)
      this.#endUtterance()
      return
    }

    // Otherwise it belongs to the latest turn that has not been threaded to one yet.
    const turn = [...this.#turns].reverse().find((candidate) => !candidate.delivered && candidate.delegationId === null)
    if (turn) {
      turn.delegationId = id
      if (turn.outcome) this.#deliver(turn)
      return
    }

    // Nothing heard yet - the transcript can trail the delegation. Hold the id briefly for
    // the utterance that is presumably on its way, then say so rather than leave it open.
    this.#wait(id)
  }

  /** Ends the current utterance now, for hang-up. */
  flush(): void {
    this.#endUtterance()
  }

  #wait(id: string): void {
    const cancel = this.#options.schedule(() => {
      this.#waiting = this.#waiting.filter((entry) => entry.id !== id)
      this.#options.send({
        type: 'session.thinking.append',
        event_id: `orphan-${id}`,
        delegation_id: id,
        content: "Aucune demande n'a été transcrite pour cette délégation.",
      })
    }, this.#options.orphanMs)
    this.#waiting.push({ id, cancel })
  }

  #endUtterance(): void {
    this.#cancelSilence?.()
    this.#cancelSilence = null
    const text = this.#buffer.trim()
    this.#buffer = ''
    if (text.length === 0) return

    const waiting = this.#waiting.shift()
    waiting?.cancel()

    const turn: Turn = {
      id: (this.#sequence += 1),
      text,
      delegationId: waiting?.id ?? null,
      outcome: null,
      delivered: false,
      cancelGrace: null,
    }
    this.#turns.push(turn)
    this.#options.onUtterance?.(text)

    this.#options.ask(text).then(
      (reply) => {
        turn.outcome = { reply }
        this.#options.onReply?.(text, reply)
        this.#settled(turn)
      },
      (error: unknown) => {
        turn.outcome = { error: error instanceof Error ? error : new Error(String(error)) }
        this.#settled(turn)
      }
    )
  }

  #settled(turn: Turn): void {
    if (turn.delegationId !== null) {
      this.#deliver(turn)
      return
    }
    // GPT-Live may still open a delegation for this; give it a moment so the answer is
    // threaded to it, then speak it regardless.
    turn.cancelGrace = this.#options.schedule(() => this.#deliver(turn), this.#options.graceMs)
  }

  #deliver(turn: Turn): void {
    if (turn.delivered || !turn.outcome) return
    turn.delivered = true
    turn.cancelGrace?.()

    // The screen gets the chips; the voice gets the sentence they sit in.
    const content = 'reply' in turn.outcome ? stripRichText(turn.outcome.reply.text) : `Le hub ne répond pas : ${turn.outcome.error.message}`
    this.#options.send({
      type: 'session.commentary.append',
      event_id: `turn-${turn.id}`,
      delegation_id: turn.delegationId,
      content: content.slice(0, LIVE_APPEND_LIMIT),
    })
    // Delivered turns are no longer needed; keeping them would only slow the lookups.
    this.#turns = this.#turns.filter((candidate) => !candidate.delivered)
  }
}
