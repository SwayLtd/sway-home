/**
 * Turn taking for a GPT-Live call.
 *
 * The bug this exists for: in talk mode, nothing reached the house after the user stopped
 * speaking. The first version waited for GPT-Live to *decide* to delegate, and when it did
 * not - it answered on its own, or said nothing - no request was ever sent. The fix moves the
 * decision to the application, which OpenAI documents as a supported pattern ("use the
 * transcript itself to trigger application-owned work"): a pause after the user's words ends
 * the utterance, the utterance goes to the house agent, and the answer is handed back to
 * GPT-Live to speak - threaded to a delegation when one exists, as general commentary when
 * none arrives.
 *
 * Time is injected, so every rule here runs without a timer or a network.
 */

import { describe, expect, test } from 'bun:test'
import { LiveTurns, type LiveTurnReply } from '../src/live_turns'

function manualClock() {
  let now = 0
  const timers: { at: number; fn: () => void; cancelled: boolean }[] = []
  return {
    schedule(fn: () => void, ms: number) {
      const timer = { at: now + ms, fn, cancelled: false }
      timers.push(timer)
      return () => {
        timer.cancelled = true
      }
    },
    advance(ms: number) {
      now += ms
      for (const timer of timers.filter((entry) => !entry.cancelled && entry.at <= now).sort((a, b) => a.at - b.at)) {
        timer.cancelled = true
        timer.fn()
      }
    },
  }
}

/** Lets resolved promises run their continuations. */
async function settle(): Promise<void> {
  for (let index = 0; index < 5; index += 1) await Promise.resolve()
}

function harness(options: { answer?: (text: string) => Promise<LiveTurnReply>; silenceMs?: number; graceMs?: number } = {}) {
  const clock = manualClock()
  const asked: string[] = []
  const sent: Record<string, unknown>[] = []
  const utterances: string[] = []
  const replies: string[] = []

  const turns = new LiveTurns({
    silenceMs: options.silenceMs ?? 900,
    graceMs: options.graceMs ?? 1200,
    schedule: clock.schedule,
    ask: async (text) => {
      asked.push(text)
      return options.answer ? options.answer(text) : { text: `Réponse à : ${text}`, attachments: [] }
    },
    send: (event) => sent.push(event),
    onUtterance: (text) => utterances.push(text),
    onReply: (_text, reply) => replies.push(reply.text),
  })

  return { turns, clock, asked, sent, utterances, replies }
}

describe('when an utterance ends', () => {
  test('speech followed by a pause sends one request with the whole sentence', async () => {
    const { turns, clock, asked } = harness()
    turns.heard('Il fait ')
    turns.heard('combien dans ')
    turns.heard('le salon ?')
    clock.advance(900)
    await settle()
    expect(asked).toEqual(['Il fait combien dans le salon ?'])
  })

  test('fragments keep the utterance open: nothing is sent mid-sentence', async () => {
    const { turns, clock, asked } = harness()
    turns.heard('Allume ')
    clock.advance(600)
    turns.heard('la cuisine')
    clock.advance(600)
    await settle()
    expect(asked).toHaveLength(0)
    clock.advance(300)
    await settle()
    expect(asked).toEqual(['Allume la cuisine'])
  })

  test('the sentence is shown as soon as it ends, before the answer exists', () => {
    const { turns, clock, utterances } = harness({ answer: () => new Promise(() => undefined) })
    turns.heard('Éteins tout')
    clock.advance(900)
    expect(utterances).toEqual(['Éteins tout'])
  })

  test('silence alone sends nothing', async () => {
    const { turns, clock, asked } = harness()
    turns.heard('   ')
    clock.advance(2000)
    await settle()
    expect(asked).toHaveLength(0)
  })

  test('two sentences are two requests, in order', async () => {
    const { turns, clock, asked } = harness()
    turns.heard('Allume le salon')
    clock.advance(900)
    turns.heard('Et la cuisine')
    clock.advance(900)
    await settle()
    expect(asked).toEqual(['Allume le salon', 'Et la cuisine'])
  })
})

describe('getting the answer spoken', () => {
  test('with no delegation, the answer is handed to GPT-Live anyway, as general commentary', async () => {
    const { turns, clock, sent } = harness()
    turns.heard('Comment va la maison ?')
    clock.advance(900)
    await settle()
    expect(sent).toHaveLength(0)
    clock.advance(1200)
    expect(sent).toHaveLength(1)
    expect(sent[0]).toMatchObject({ type: 'session.commentary.append', delegation_id: null, content: 'Réponse à : Comment va la maison ?' })
  })

  test('a delegation that arrives while the answer is pending receives it, once', async () => {
    let release: (reply: LiveTurnReply) => void = () => undefined
    const { turns, clock, sent } = harness({ answer: () => new Promise((resolve) => (release = resolve)) })
    turns.heard('Quelle heure est-il ?')
    clock.advance(900)
    turns.delegated('del_1')
    release({ text: 'Il est midi.', attachments: [] })
    await settle()
    clock.advance(5000)
    expect(sent).toHaveLength(1)
    expect(sent[0]).toMatchObject({ delegation_id: 'del_1', content: 'Il est midi.' })
  })

  test('a delegation that arrives after the answer is ready still gets it, and it is not sent twice', async () => {
    const { turns, clock, sent } = harness({ graceMs: 1200 })
    turns.heard('Il fait combien ?')
    clock.advance(900)
    await settle()
    clock.advance(500)
    turns.delegated('del_2')
    clock.advance(5000)
    expect(sent).toHaveLength(1)
    expect(sent[0]).toMatchObject({ delegation_id: 'del_2' })
  })

  test('a delegation during the sentence ends it now and threads its answer', async () => {
    const { turns, clock, asked, sent } = harness()
    turns.heard('Ferme les volets')
    turns.delegated('del_3')
    await settle()
    expect(asked).toEqual(['Ferme les volets'])
    clock.advance(5000)
    expect(sent).toHaveLength(1)
    expect(sent[0]).toMatchObject({ delegation_id: 'del_3' })
  })

  test('the screen gets the reply too, with its cards', async () => {
    const { turns, clock, replies } = harness()
    turns.heard('Analyse l humidité du mois')
    clock.advance(900)
    await settle()
    expect(replies).toEqual(['Réponse à : Analyse l humidité du mois'])
  })

  test('a failed request is spoken as a failure, not thrown', async () => {
    const { turns, clock, sent } = harness({ answer: async () => Promise.reject(new Error('ECONNREFUSED')) })
    turns.heard('Allume le salon')
    clock.advance(900)
    await settle()
    clock.advance(1200)
    expect(sent).toHaveLength(1)
    expect(String(sent[0]!.content)).toContain('ECONNREFUSED')
  })

  test('chips are spoken as their text, never as markup', async () => {
    const { turns, clock, sent } = harness({ answer: async () => ({ text: 'On consomme [[ph:lightning|4,4 W]].', attachments: [] }) })
    turns.heard('Combien je consomme ?')
    clock.advance(900)
    await settle()
    clock.advance(1200)
    expect(sent[0]).toMatchObject({ content: 'On consomme 4,4 W.' })
  })

  test('a long answer is cut to what one append may carry', async () => {
    const { turns, clock, sent } = harness({ answer: async () => ({ text: 'x'.repeat(5000), attachments: [] }) })
    turns.heard('Raconte')
    clock.advance(900)
    await settle()
    clock.advance(1200)
    expect(String(sent[0]!.content).length).toBeLessThanOrEqual(1400)
  })

  test('a delegation with nothing heard is told so, rather than left hanging', async () => {
    const { turns, clock, sent } = harness()
    turns.delegated('del_4')
    clock.advance(3000)
    expect(sent).toHaveLength(1)
    expect(sent[0]).toMatchObject({ type: 'session.thinking.append', delegation_id: 'del_4' })
  })
})

describe('hanging up', () => {
  test('flush sends whatever was being said', async () => {
    const { turns, asked } = harness()
    turns.heard('Bonne nuit')
    turns.flush()
    await settle()
    expect(asked).toEqual(['Bonne nuit'])
  })

  test('the live caption is what is being said right now', () => {
    const { turns, clock } = harness()
    turns.heard('Allume ')
    turns.heard('le salon')
    expect(turns.caption()).toBe('Allume le salon')
    clock.advance(900)
    expect(turns.caption()).toBe('')
  })
})
