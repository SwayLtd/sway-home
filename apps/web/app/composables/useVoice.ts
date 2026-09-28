/**
 * Voice, privacy-first.
 *
 * Three engines, ordered by how much they respect the house:
 *
 *  1. **local** - Whisper (or Moonshine) for speech to text and Kokoro for text to speech,
 *     both as ONNX models running in the browser through Transformers.js, on WebGPU where
 *     it exists and WASM where it does not. Nothing leaves the machine, nothing is billed,
 *     and it keeps working with the internet unplugged. The cost is a one-off model
 *     download, which is why it is opt-in rather than default.
 *  2. **browser** - the Web Speech API. Instant, free, no download. On Chrome it sends the
 *     audio to Google, which is said plainly in the settings screen rather than buried.
 *  3. **cloud** - a hosted provider, for the cases where accuracy in a noisy kitchen
 *     matters more than locality. Deepgram Nova-3 at about 0.26 USD an hour for batch and
 *     0.46 for streaming is the cheapest of the good ones; Aura-2 at 30 USD per million
 *     characters is its match for speech.
 *
 * The engine is a setting, not a build-time choice, so a house can start on `browser` and
 * move to `local` the day someone decides the download is worth it.
 */

import { stripRichText } from '@sway-home/shared/rich_text'

export type VoiceEngine = 'local' | 'browser' | 'cloud' | 'off'

export interface VoiceSettings {
  engine: VoiceEngine
  language: string
  sttModel: string
  ttsVoice: string
  speakReplies: boolean
  wakeWord: string
  wakeWordEnabled: boolean
}

export const STT_MODELS = [
  { id: 'onnx-community/whisper-base', label: 'Whisper base', size: '~145 Mo', note: 'Le meilleur compromis multilingue. Français correct.' },
  { id: 'onnx-community/whisper-tiny', label: 'Whisper tiny', size: '~45 Mo', note: 'Rapide sur CPU, moins précis sur les noms propres.' },
  { id: 'onnx-community/whisper-large-v3-turbo', label: 'Whisper large v3 turbo', size: '~800 Mo', note: 'Le plus précis en local. Demande WebGPU.' },
  { id: 'onnx-community/moonshine-base-ONNX', label: 'Moonshine base', size: '~90 Mo', note: 'Anglais uniquement, mais la latence la plus basse.' },
]

export const TTS_VOICES = [
  { id: 'ff_siwis', label: 'Siwis (français)', language: 'fr' },
  { id: 'af_heart', label: 'Heart (anglais US)', language: 'en' },
  { id: 'af_bella', label: 'Bella (anglais US)', language: 'en' },
  { id: 'bf_emma', label: 'Emma (anglais UK)', language: 'en' },
  { id: 'am_michael', label: 'Michael (anglais US)', language: 'en' },
]

/**
 * What each option actually costs, kept in code so the settings screen cannot drift from
 * the truth and so the comparison is auditable rather than marketing.
 */
export const VOICE_PRICING = [
  { id: 'local-whisper', label: 'Whisper local (Transformers.js)', sttPerHour: 0, ttsPerMinute: null, privacy: 'local', note: 'Téléchargement unique du modèle, puis gratuit et hors ligne.' },
  { id: 'local-kokoro', label: 'Kokoro 82M local', sttPerHour: null, ttsPerMinute: 0, privacy: 'local', note: 'Synthèse temps réel sur CPU, 82 millions de paramètres.' },
  { id: 'browser', label: 'Web Speech API', sttPerHour: 0, ttsPerMinute: 0, privacy: 'cloud', note: "Gratuit, mais Chrome envoie l'audio à Google." },
  { id: 'deepgram', label: 'Deepgram Nova-3', sttPerHour: 0.258, ttsPerMinute: null, privacy: 'cloud', note: '0,0043 USD/min en batch, 0,0048 en streaming. Le moins cher des hébergés.' },
  { id: 'assemblyai', label: 'AssemblyAI Universal-3.5 Pro', sttPerHour: 0.45, ttsPerMinute: null, privacy: 'cloud', note: '0,45 USD/h en streaming, 0,21 USD/h en pré-enregistré.' },
  { id: 'cartesia', label: 'Cartesia Sonic', sttPerHour: null, ttsPerMinute: 0.014, privacy: 'cloud', note: 'Environ 40 ms avant le premier son, le plus rapide.' },
  { id: 'elevenlabs', label: 'ElevenLabs Flash v2.5', sttPerHour: null, ttsPerMinute: 0.05, privacy: 'cloud', note: '0,05 à 0,10 USD/min selon le modèle. La meilleure qualité de voix.' },
]

/** When the figures above were last checked against the vendors' own pricing pages. */
export const VOICE_PRICING_CHECKED_ON = '2026-09-26'

const defaults: VoiceSettings = {
  engine: 'browser',
  language: 'fr-FR',
  sttModel: 'onnx-community/whisper-base',
  ttsVoice: 'ff_siwis',
  // On by default: an assistant that notices a leak and says nothing out loud is a
  // notification, not an assistant. Browsers hold the first utterance until the page has
  // been clicked once, which is the one thing that cannot be worked around from here.
  speakReplies: true,
  wakeWord: 'hey jarvis',
  wakeWordEnabled: false,
}

export function useVoiceSettings() {
  const settings = useState<VoiceSettings>('voice-settings', () => ({ ...defaults }))

  onMounted(() => {
    const stored = localStorage.getItem('sway-voice')
    if (stored) {
      try {
        settings.value = { ...defaults, ...(JSON.parse(stored) as Partial<VoiceSettings>) }
      } catch {
        /* corrupted, keep defaults */
      }
    }
  })

  watch(settings, (value) => {
    if (import.meta.client) localStorage.setItem('sway-voice', JSON.stringify(value))
  }, { deep: true })

  return settings
}

// ---------------------------------------------------------------------------------------
// Speech to text
// ---------------------------------------------------------------------------------------

export interface Recogniser {
  start(): Promise<void>
  stop(): void
  readonly listening: Ref<boolean>
  readonly partial: Ref<string>
  readonly ready: Ref<boolean>
  readonly progress: Ref<number>
  readonly error: Ref<string | null>
}

/** Lazily built so the model bundle is never loaded for someone who never opens the mic. */
let transcriberPromise: Promise<(audio: Float32Array) => Promise<string>> | null = null

async function loadLocalTranscriber(model: string, language: string, onProgress: (ratio: number) => void) {
  if (transcriberPromise) return transcriberPromise

  transcriberPromise = (async () => {
    const { pipeline } = await import('@huggingface/transformers')
    const webgpu = typeof navigator !== 'undefined' && 'gpu' in navigator

    const transcriber = await pipeline('automatic-speech-recognition', model, {
      device: webgpu ? 'webgpu' : 'wasm',
      dtype: webgpu ? 'fp16' : 'q8',
      progress_callback: (event: { status: string; progress?: number }) => {
        if (event.status === 'progress' && typeof event.progress === 'number') onProgress(event.progress / 100)
        if (event.status === 'done') onProgress(1)
      },
    })

    return async (audio: Float32Array) => {
      const output = (await transcriber(audio, {
        language: language.startsWith('fr') ? 'french' : 'english',
        task: 'transcribe',
      })) as { text: string } | { text: string }[]
      return Array.isArray(output) ? (output[0]?.text ?? '') : output.text
    }
  })()

  return transcriberPromise
}

export function useRecogniser(settings: Ref<VoiceSettings>): Recogniser {
  const listening = ref(false)
  const partial = ref('')
  const ready = ref(false)
  const progress = ref(0)
  const error = ref<string | null>(null)

  let recognition: any = null
  let mediaRecorder: MediaRecorder | null = null
  let chunks: Blob[] = []
  let resolveTranscript: ((text: string) => void) | null = null

  async function startBrowser(): Promise<void> {
    const Recognition = (window as any).SpeechRecognition ?? (window as any).webkitSpeechRecognition
    if (!Recognition) {
      error.value = "Ce navigateur n'a pas la Web Speech API. Passe en moteur local dans les réglages."
      return
    }

    recognition = new Recognition()
    recognition.lang = settings.value.language
    recognition.interimResults = true
    recognition.continuous = false

    recognition.onresult = (event: any) => {
      let text = ''
      for (let index = event.resultIndex; index < event.results.length; index += 1) {
        text += event.results[index][0].transcript
      }
      partial.value = text
      if (event.results[event.results.length - 1].isFinal) {
        resolveTranscript?.(text.trim())
        resolveTranscript = null
      }
    }
    recognition.onerror = (event: any) => {
      error.value = String(event.error)
      listening.value = false
    }
    recognition.onend = () => {
      listening.value = false
      if (resolveTranscript) {
        resolveTranscript(partial.value.trim())
        resolveTranscript = null
      }
    }

    recognition.start()
    listening.value = true
    ready.value = true
  }

  async function startLocal(): Promise<void> {
    error.value = null
    const transcribe = await loadLocalTranscriber(settings.value.sttModel, settings.value.language, (ratio) => (progress.value = ratio))
    ready.value = true

    const stream = await navigator.mediaDevices.getUserMedia({ audio: { channelCount: 1, noiseSuppression: true, echoCancellation: true } })
    mediaRecorder = new MediaRecorder(stream)
    chunks = []

    mediaRecorder.ondataavailable = (event) => chunks.push(event.data)
    mediaRecorder.onstop = async () => {
      listening.value = false
      for (const track of stream.getTracks()) track.stop()

      // Whisper wants 16 kHz mono float32; decoding through an AudioContext at that rate
      // is the shortest correct path and avoids shipping a resampler.
      const blob = new Blob(chunks, { type: mediaRecorder?.mimeType ?? 'audio/webm' })
      const buffer = await blob.arrayBuffer()
      const context = new AudioContext({ sampleRate: 16_000 })
      const decoded = await context.decodeAudioData(buffer)
      const audio = decoded.getChannelData(0)
      await context.close()

      try {
        const text = await transcribe(audio)
        partial.value = text
        resolveTranscript?.(text.trim())
      } catch (transcribeError) {
        error.value = (transcribeError as Error).message
        resolveTranscript?.('')
      }
      resolveTranscript = null
    }

    mediaRecorder.start()
    listening.value = true
  }

  return {
    listening,
    partial,
    ready,
    progress,
    error,
    async start() {
      partial.value = ''
      if (settings.value.engine === 'local') await startLocal()
      else await startBrowser()
    },
    stop() {
      recognition?.stop()
      if (mediaRecorder?.state === 'recording') mediaRecorder.stop()
      listening.value = false
    },
  }
}

/** Promise-shaped wrapper: `const text = await listenOnce(settings)`. */
export function listenOnce(recogniser: Recogniser): Promise<string> {
  return new Promise((resolve) => {
    const stop = watch(recogniser.partial, () => undefined)
    const unwatch = watch(recogniser.listening, (value) => {
      if (value === false) {
        stop()
        unwatch()
        resolve(recogniser.partial.value.trim())
      }
    })
  })
}

// ---------------------------------------------------------------------------------------
// Text to speech
// ---------------------------------------------------------------------------------------

let kokoroPromise: Promise<any> | null = null

async function loadKokoro(onProgress: (ratio: number) => void) {
  if (kokoroPromise) return kokoroPromise
  kokoroPromise = (async () => {
    const { KokoroTTS } = await import('kokoro-js')
    const webgpu = typeof navigator !== 'undefined' && 'gpu' in navigator
    return KokoroTTS.from_pretrained('onnx-community/Kokoro-82M-v1.0-ONNX', {
      dtype: webgpu ? 'fp32' : 'q8',
      device: webgpu ? 'webgpu' : 'wasm',
      progress_callback: (event: { status: string; progress?: number }) => {
        if (event.status === 'progress' && typeof event.progress === 'number') onProgress(event.progress / 100)
      },
    })
  })()
  return kokoroPromise
}

export function useSpeaker(settings: Ref<VoiceSettings>) {
  const speaking = ref(false)
  const progress = ref(0)

  async function speak(input: string): Promise<void> {
    // Replies carry chips (`[[ph:lightning|4,4 W]]`); a voice reads the sentence they sit in.
    const text = stripRichText(input)
    if (!text.trim() || settings.value.engine === 'off') return
    speaking.value = true

    try {
      if (settings.value.engine === 'local') {
        const tts = await loadKokoro((ratio) => (progress.value = ratio))
        const audio = await tts.generate(text, { voice: settings.value.ttsVoice })
        const blob = audio.toBlob()
        const url = URL.createObjectURL(blob)
        const element = new Audio(url)
        await element.play()
        element.onended = () => URL.revokeObjectURL(url)
      } else {
        const utterance = new SpeechSynthesisUtterance(text)
        utterance.lang = settings.value.language
        utterance.rate = 1.05
        speechSynthesis.speak(utterance)
        await new Promise<void>((resolve) => {
          utterance.onend = () => resolve()
          utterance.onerror = () => resolve()
        })
      }
    } finally {
      speaking.value = false
    }
  }

  function stop(): void {
    speechSynthesis?.cancel()
    speaking.value = false
  }

  return { speak, stop, speaking, progress }
}
