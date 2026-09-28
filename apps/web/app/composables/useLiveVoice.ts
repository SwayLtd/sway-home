/**
 * GPT-Live in the browser.
 *
 * A live session is a phone call with the house: the microphone stays open, the model can be
 * interrupted mid-sentence, and it talks back while it is still listening. That is the whole
 * reason for the extra machinery here - a press-to-talk button can be built out of a plain
 * recorder, but a conversation cannot.
 *
 * The division of labour matters more than the plumbing:
 *
 *  - **OpenAI holds the conversation.** Audio in, audio out, turn taking, interruptions.
 *  - **This hub holds the house.** Every time GPT-Live decides it needs a fact or an action,
 *    it emits a delegation; we answer it by asking `/agent/ask`, which runs the real tools
 *    with the real permission checks, and we hand the resulting sentence back. No house tool
 *    is registered with OpenAI, so nothing on the other side of the wire can open a door.
 *  - **The hub holds the key.** The SDP offer is proxied through `/voice/live/session`.
 *
 * The transcript is kept here because client delegation does not carry the user's words:
 * `session.delegation.created` is metadata only, so the request we send to the agent is
 * assembled from the transcript deltas we have been collecting.
 *
 * See https://developers.openai.com/api/docs/guides/live-delegation
 */

import { LiveTurns } from '@sway-home/shared/live_turns'

export type LiveState = 'idle' | 'connecting' | 'live' | 'closing' | 'error'

export interface LiveStatus {
  available: boolean
  model: string
  reason: string
}

export interface LiveReply {
  text: string
  attachments: { kind: string; data: Record<string, any> }[]
}

export interface LiveCallbacks {
  /** The user's sentence, as soon as a pause ends it. */
  onUtterance?: (text: string) => void
  /** The house's answer, with any card it produced. */
  onReply?: (reply: LiveReply) => void
}

export function useLiveVoice() {
  const state = useState<LiveState>('live-voice-state', () => 'idle')
  const status = useState<LiveStatus | null>('live-voice-status', () => null)
  const error = useState<string | null>('live-voice-error', () => null)
  /** What the user is saying right now, for captions. Cleared when a turn is delegated. */
  const heard = useState('live-voice-heard', () => '')
  const spoken = useState('live-voice-spoken', () => '')

  let peer: RTCPeerConnection | null = null
  let channel: RTCDataChannel | null = null
  let microphone: MediaStream | null = null
  let audio: HTMLAudioElement | null = null
  let conversationId: string | null = null
  let turns: LiveTurns | null = null

  async function loadStatus(): Promise<LiveStatus> {
    status.value = await hubFetch<LiveStatus>('/voice/live')
    return status.value
  }

  function send(event: Record<string, unknown>): void {
    if (channel?.readyState === 'open') channel.send(JSON.stringify(event))
  }

  function teardown(): void {
    turns?.flush()
    turns = null
    microphone?.getTracks().forEach((track) => track.stop())
    channel?.close()
    peer?.close()
    if (audio) audio.srcObject = null
    microphone = null
    channel = null
    peer = null
    audio = null
    heard.value = ''
  }

  /**
   * One sentence to the house. The same endpoint, agent, tools and permission checks as the
   * text path: talking is a different way in, not a different assistant.
   */
  async function ask(text: string): Promise<LiveReply> {
    const result = await hubFetch<{ reply: string; conversationId: string; attachments?: LiveReply['attachments'] }>('/agent/ask', {
      method: 'POST',
      body: { message: text, conversationId },
    })
    conversationId = result.conversationId
    return { text: result.reply, attachments: result.attachments ?? [] }
  }

  function handle(event: Record<string, any>): void {
    switch (event.type) {
      case 'session.started':
        state.value = 'live'
        break
      case 'session.input_transcript.delta':
        turns?.heard(String(event.delta ?? ''))
        heard.value = turns?.caption() ?? ''
        break
      case 'session.output_transcript.delta':
        spoken.value += String(event.delta ?? '')
        break
      case 'session.delegation.created':
        if (event.delegation?.target === 'client') turns?.delegated(String(event.delegation.id))
        break
      case 'session.closed':
        state.value = 'idle'
        teardown()
        break
      case 'error':
        error.value = String(event.error?.message ?? 'Erreur de session')
        break
      default:
        break
    }
  }

  /**
   * Opens the call. Must be triggered by a click: browsers refuse a microphone otherwise,
   * which is also the right policy for something billed by the second.
   */
  async function start(callbacks: LiveCallbacks = {}): Promise<void> {
    if (state.value === 'live' || state.value === 'connecting') return
    error.value = null
    state.value = 'connecting'

    turns = new LiveTurns({
      ask,
      send,
      onUtterance: (text) => {
        heard.value = ''
        callbacks.onUtterance?.(text)
      },
      onReply: (_text, reply) => callbacks.onReply?.(reply as LiveReply),
    })

    try {
      const available = status.value ?? (await loadStatus())
      if (!available.available) throw new Error(available.reason)

      const connection = new RTCPeerConnection()
      peer = connection

      audio = new Audio()
      audio.autoplay = true
      connection.addEventListener('track', (event) => {
        if (audio) audio.srcObject = new MediaStream([event.track])
        void audio?.play().catch(() => {
          error.value = "Le navigateur bloque la lecture audio. Cliquez sur la page, puis relancez."
        })
      })

      microphone = await navigator.mediaDevices.getUserMedia({ audio: true })
      for (const track of microphone.getAudioTracks()) connection.addTrack(track, microphone)

      // The channel has to exist before the offer is created, or it is not in the SDP.
      channel = connection.createDataChannel('oai-events')
      channel.addEventListener('message', ({ data }) => handle(JSON.parse(data)))
      channel.addEventListener('close', () => {
        if (state.value === 'live') state.value = 'idle'
      })

      const offer = await connection.createOffer()
      await connection.setLocalDescription(offer)
      await gathered(connection)

      const sdp = connection.localDescription?.sdp
      if (!sdp) throw new Error('Offre SDP manquante')

      const answer = await hubFetch<{ sessionId: string; sdp: string }>('/voice/live/session', { method: 'POST', body: { sdp } })
      await connection.setRemoteDescription({ type: 'answer', sdp: answer.sdp })
      // The HTTP exchange started the session. Sending session.start here would be an error.
    } catch (failure) {
      error.value = (failure as Error).message
      state.value = 'error'
      teardown()
    }
  }

  /** Closes politely, so the final usage event arrives and the session is not left running. */
  function stop(): void {
    if (state.value !== 'live') {
      teardown()
      state.value = 'idle'
      return
    }
    state.value = 'closing'
    send({ type: 'session.close' })
    setTimeout(() => {
      if (state.value === 'closing') {
        state.value = 'idle'
        teardown()
      }
    }, 5000)
  }

  return { state, status, error, heard, spoken, loadStatus, start, stop }
}

/** ICE candidates have to be in the offer: the hub posts one SDP and gets one answer. */
function gathered(connection: RTCPeerConnection): Promise<void> {
  if (connection.iceGatheringState === 'complete') return Promise.resolve()
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      connection.removeEventListener('icegatheringstatechange', check)
      reject(new Error('Délai dépassé pendant la collecte ICE'))
    }, 10_000)
    function check() {
      if (connection.iceGatheringState !== 'complete') return
      clearTimeout(timer)
      connection.removeEventListener('icegatheringstatechange', check)
      resolve()
    }
    connection.addEventListener('icegatheringstatechange', check)
    check()
  })
}
