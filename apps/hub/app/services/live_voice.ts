/**
 * GPT-Live: full-duplex voice for the house assistant.
 *
 * The split is the important part. GPT-Live holds the *conversation* - it listens while it
 * speaks, it handles interruptions, it decides when it needs help. Everything that touches
 * the house goes through **client delegation**: when it needs an answer, the browser asks
 * this hub's own agent, which runs the real tools with the real permission checks, and hands
 * back a sentence. No house tool is ever registered with OpenAI, so no model on someone
 * else's machine can open a door.
 *
 * Two things stay on this side of the wire and never reach a browser:
 *
 *  - the OpenAI key, which is why the SDP exchange is proxied here rather than done directly;
 *  - the decision to allow live voice at all, which local-only mode revokes outright.
 *
 * Docs: https://developers.openai.com/api/docs/guides/live
 *       https://developers.openai.com/api/docs/guides/live-delegation (client delegation)
 *       https://developers.openai.com/api/docs/guides/voice-webrtc?api=live
 */

import { settings } from '#repositories/store'
import { secrets } from '#services/secrets'
import type { AgentSettings } from '@sway-home/shared'

/** The voice model. Sessions are billed by the second, so this is not a background service. */
export const LIVE_MODEL = 'gpt-live-1'

const LIVE_SESSIONS_URL = 'https://api.openai.com/v1/live/sessions'

export interface LiveSessionConfig {
  model: string
  instructions: string
  /** `client` means: ask the browser, which asks this hub. Never a model OpenAI runs. */
  delegation: { type: 'client' }
}

export interface LiveStatus {
  available: boolean
  model: string
  reason: string
}

/** Just enough of `fetch` to send one request, so a test can stand in for it. */
export type FetchLike = (url: string, init: RequestInit) => Promise<Response>

export type LiveConnectResult =
  | { ok: true; sessionId: string; sdp: string }
  | { ok: false; status: number; error: string }

function openAiKey(): string | null {
  const key = secrets.get('openai')?.apiKey?.trim()
  return key && key.length > 0 ? key : null
}

function localOnly(): boolean {
  const config = settings.get<AgentSettings>('agent', {} as AgentSettings)
  return config?.privacy?.localOnly === true
}

/**
 * What GPT-Live is told about itself.
 *
 * Short on purpose. The house knowledge - devices, rooms, state, memory - lives in the
 * backend prompt that `agent_service` builds, and sending it twice would pay for it twice.
 * This prompt only has to teach three habits: speak briefly, delegate anything factual, and
 * never invent an action.
 */
const CONVERSATION_PROMPT = [
  "Tu es l'assistant vocal de cette maison. Tu parles français, naturellement, comme quelqu'un dans la pièce d'à côté.",
  'Réponds toujours en une phrase courte. Pas de préambule, pas de liste, pas de récapitulatif.',
  "Tu ne connais rien de la maison par toi-même : dès qu'on te demande un état, une mesure, une analyse ou une action, délègue au backend et attends son résultat.",
  "L'application t'envoie la réponse de la maison dès qu'elle l'a, même sans délégation : quand un commentaire arrive, dis-le, brièvement. N'invente jamais de réponse en attendant.",
  "N'annonce jamais une action comme faite avant que le backend te l'ait confirmée. En attendant, un mot suffit : je regarde.",
  'Si le backend renvoie un chiffre, dis le chiffre avec son unité. Il est déjà affiché à l écran, ne le décris pas.',
  "Si on te coupe, arrête-toi et écoute.",
].join(' ')

class LiveVoiceService {
  /** Whether the browser may open a live session at all, and why not when it may not. */
  status(): LiveStatus {
    if (localOnly()) {
      return { available: false, model: LIVE_MODEL, reason: 'Mode local uniquement : la voix temps réel passerait par un service distant.' }
    }
    if (!openAiKey()) {
      return { available: false, model: LIVE_MODEL, reason: 'Aucune clé OpenAI configurée. Réglages > Assistant.' }
    }
    return { available: true, model: LIVE_MODEL, reason: '' }
  }

  /** The session OpenAI is asked to create. Client delegation is not negotiable. */
  sessionConfig(): LiveSessionConfig {
    return {
      model: LIVE_MODEL,
      instructions: CONVERSATION_PROMPT,
      delegation: { type: 'client' },
    }
  }

  /**
   * Exchanges the browser's SDP offer for OpenAI's answer.
   *
   * `fetchImpl` is injectable so the whole path can be tested without a network or a key,
   * which matters: this is the one function in the hub that sends anything to OpenAI
   * outside the agent loop.
   */
  async connect(sdp: string, fetchImpl: FetchLike = fetch): Promise<LiveConnectResult> {
    const status = this.status()
    if (!status.available) return { ok: false, status: 503, error: status.reason }
    if (typeof sdp !== 'string' || sdp.trim().length === 0) return { ok: false, status: 400, error: 'Offre SDP vide.' }

    const key = openAiKey()
    if (!key) return { ok: false, status: 503, error: 'Aucune clé OpenAI configurée.' }

    try {
      const response = await fetchImpl(LIVE_SESSIONS_URL, {
        method: 'POST',
        headers: { authorization: `Bearer ${key}`, 'content-type': 'application/json' },
        body: JSON.stringify({ session: this.sessionConfig(), transport: { type: 'webrtc', sdp } }),
      })

      const text = await response.text()
      if (!response.ok) {
        // The provider's message is passed through: "no access to gpt-live-1" is the single
        // most useful thing a console can show here, and hiding it costs an hour of guessing.
        let message = text.slice(0, 300)
        try {
          message = (JSON.parse(text) as { error?: { message?: string } }).error?.message ?? message
        } catch {
          /* a non-JSON body is still worth showing verbatim */
        }
        return { ok: false, status: response.status, error: message }
      }

      const payload = JSON.parse(text) as { session?: { id?: string }; transport?: { sdp?: string } }
      if (!payload.session?.id || !payload.transport?.sdp) return { ok: false, status: 502, error: 'Réponse inattendue de OpenAI.' }
      return { ok: true, sessionId: payload.session.id, sdp: payload.transport.sdp }
    } catch (error) {
      return { ok: false, status: 502, error: (error as Error).message }
    }
  }
}

export const liveVoice = new LiveVoiceService()
