/**
 * The permission model.
 *
 * This is the safety-critical table in the product: it decides whether the assistant may
 * unlock a door on its own. Every test here is written as the question a user would ask -
 * "can it open my garage without me?" - because that is the failure that matters, not
 * whether an enum parses.
 */

import { describe, expect, test } from 'bun:test'
import {
  AUTONOMY,
  AUTONOMY_LEVELS,
  COMMAND_RISK,
  RISK_ORDER,
  agentSettingsSchema,
  commandRisk,
  memorySchema,
  proposalSchema,
  riskAllowed,
  type AutonomyLevel,
  type RiskLevel,
} from '../src/agent.ts'

describe('the ladder', () => {
  test('has exactly the four documented levels, in increasing order of trust', () => {
    expect(AUTONOMY_LEVELS).toEqual(['observer', 'assistant', 'copilot', 'autopilot'])
  })

  test('each level describes itself and declares a ceiling', () => {
    for (const level of AUTONOMY_LEVELS) {
      const entry = AUTONOMY[level]
      expect(entry.label.length).toBeGreaterThan(2)
      expect(entry.description.length).toBeGreaterThan(10)
      expect(RISK_ORDER).toContain(entry.maxRiskWithoutApproval)
    }
  })

  test('ceilings rise monotonically with the level', () => {
    const ceilings = AUTONOMY_LEVELS.map((level) => RISK_ORDER.indexOf(AUTONOMY[level].maxRiskWithoutApproval))
    for (let index = 1; index < ceilings.length; index += 1) {
      expect(ceilings[index]!).toBeGreaterThanOrEqual(ceilings[index - 1]!)
    }
  })

  test('only copilot and autopilot may act unprompted', () => {
    expect(AUTONOMY.observer.mayActUnprompted).toBe(false)
    expect(AUTONOMY.assistant.mayActUnprompted).toBe(false)
    expect(AUTONOMY.copilot.mayActUnprompted).toBe(true)
    expect(AUTONOMY.autopilot.mayActUnprompted).toBe(true)
  })
})

describe('riskAllowed', () => {
  test('observer may do nothing that changes anything', () => {
    expect(riskAllowed('observer', 'low')).toBe(false)
    expect(riskAllowed('observer', 'medium')).toBe(false)
    expect(riskAllowed('observer', 'high')).toBe(false)
  })

  test('observer may still perform a no-risk read', () => {
    expect(riskAllowed('observer', 'none')).toBe(true)
  })

  test('assistant turns lights on but does not open covers on its own', () => {
    expect(riskAllowed('assistant', 'low')).toBe(true)
    expect(riskAllowed('assistant', 'medium')).toBe(false)
  })

  test('copilot handles everyday things but not the front door', () => {
    expect(riskAllowed('copilot', 'medium')).toBe(true)
    expect(riskAllowed('copilot', 'high')).toBe(false)
  })

  test('autopilot goes up to high and no further', () => {
    expect(riskAllowed('autopilot', 'high')).toBe(true)
    expect(riskAllowed('autopilot', 'forbidden')).toBe(false)
  })

  test('forbidden is refused at every level, including the highest', () => {
    for (const level of AUTONOMY_LEVELS) {
      expect(riskAllowed(level, 'forbidden')).toBe(false)
    }
  })

  test('no level allows a risk above its own ceiling', () => {
    for (const level of AUTONOMY_LEVELS) {
      const ceiling = RISK_ORDER.indexOf(AUTONOMY[level].maxRiskWithoutApproval)
      for (const risk of RISK_ORDER) {
        const expected = risk !== 'forbidden' && RISK_ORDER.indexOf(risk) <= ceiling
        expect(riskAllowed(level, risk)).toBe(expected)
      }
    }
  })
})

describe('commandRisk', () => {
  test('everyday light commands are low', () => {
    for (const command of ['turnOn', 'turnOff', 'toggle', 'setBrightness', 'setColor']) {
      expect(commandRisk(command)).toBe('low')
    }
  })

  test('anything physical or thermal is at least medium', () => {
    for (const command of ['open', 'close', 'setPosition', 'setTargetTemperature']) {
      expect(RISK_ORDER.indexOf(commandRisk(command))).toBeGreaterThanOrEqual(RISK_ORDER.indexOf('medium'))
    }
  })

  test('unlocking is high wherever it appears', () => {
    expect(RISK_ORDER.indexOf(commandRisk('unlock'))).toBeGreaterThanOrEqual(RISK_ORDER.indexOf('high'))
  })

  test('an unknown command is medium, not low', () => {
    // The default has to be pessimistic: a command nobody classified is a command nobody
    // thought about, and guessing "harmless" is how an assistant does something surprising.
    expect(commandRisk('frobnicate')).toBe('medium')
  })

  test('marking a device critical raises everything below high up to high', () => {
    expect(commandRisk('turnOn', true)).toBe('high')
    expect(commandRisk('setPosition', true)).toBe('high')
  })

  test('marking a device critical never lowers an already higher risk', () => {
    for (const command of Object.keys(COMMAND_RISK)) {
      const normal = commandRisk(command, false)
      const critical = commandRisk(command, true)
      expect(RISK_ORDER.indexOf(critical)).toBeGreaterThanOrEqual(RISK_ORDER.indexOf(normal))
    }
  })

  test('a critical device cannot be commanded unprompted below copilot', () => {
    // The scenario: someone marks the front door critical, then sets autonomy to assistant.
    // Every command on that device must now need approval.
    const risk = commandRisk('turnOn', true)
    expect(riskAllowed('assistant', risk)).toBe(false)
    expect(riskAllowed('copilot', risk)).toBe(false)
    expect(riskAllowed('autopilot', risk)).toBe(true)
  })
})

describe('the risk table itself', () => {
  test('every entry is a valid risk level', () => {
    for (const [command, risk] of Object.entries(COMMAND_RISK)) {
      expect(RISK_ORDER).toContain(risk as RiskLevel)
      expect(command.length).toBeGreaterThan(1)
    }
  })

  test('the dangerous verbs are all classified rather than falling through to the default', () => {
    for (const command of ['unlock', 'lock', 'openGarage', 'closeGarage', 'triggerSiren', 'disarm']) {
      if (command in COMMAND_RISK) {
        expect(RISK_ORDER.indexOf(COMMAND_RISK[command]!)).toBeGreaterThanOrEqual(RISK_ORDER.indexOf('medium'))
      }
    }
  })
})

describe('proposals', () => {
  const base = {
    id: 'p1',
    conversationId: 'c1',
    summary: 'Éteindre le salon',
    reason: 'Personne depuis 30 minutes',
    risk: 'low' as const,
    commands: [{ deviceId: 'd1', deviceName: 'Plafonnier', command: 'turnOff' }],
    createdAt: '2026-09-26T10:00:00.000Z',
    expiresAt: '2026-09-26T10:05:00.000Z',
  }

  test('a proposal starts pending, never approved', () => {
    expect(proposalSchema.parse(base).status).toBe('pending')
  })

  test('command arguments default to empty', () => {
    expect(proposalSchema.parse(base).commands[0]!.args).toEqual({})
  })

  test('a proposal carries the reason, which is the whole point of showing it', () => {
    expect(proposalSchema.parse(base).reason).toBe('Personne depuis 30 minutes')
  })

  test('an expiry is required, so a stale proposal cannot be approved days later', () => {
    const { expiresAt, ...withoutExpiry } = base
    void expiresAt
    expect(() => proposalSchema.parse(withoutExpiry)).toThrow()
  })
})

describe('memories', () => {
  const base = { id: 'm1', kind: 'preference' as const, content: 'Salon à 21 degrés', createdAt: '2026-09-26T10:00:00.000Z', updatedAt: '2026-09-26T10:00:00.000Z' }

  test('defaults place a new memory at the house level with middling strength', () => {
    const memory = memorySchema.parse(base)
    expect(memory.subjectType).toBe('house')
    expect(memory.strength).toBeGreaterThan(0)
    expect(memory.strength).toBeLessThanOrEqual(1)
    expect(memory.evidenceCount).toBe(1)
  })

  test('confidence and strength are bounded to 0..1', () => {
    expect(() => memorySchema.parse({ ...base, confidence: 1.5 })).toThrow()
    expect(() => memorySchema.parse({ ...base, strength: -0.2 })).toThrow()
  })

  test('an unknown memory kind is rejected', () => {
    expect(() => memorySchema.parse({ ...base, kind: 'vibes' })).toThrow()
  })
})

describe('agent settings', () => {
  test('a blank settings object is filled with safe defaults', () => {
    const settings = agentSettingsSchema.parse({})
    expect(AUTONOMY_LEVELS).toContain(settings.autonomy as AutonomyLevel)
    expect(settings.llm.dailyBudgetUsd).toBeGreaterThan(0)
    expect(settings.privacy.retainAudio).toBe(false)
  })

  test('the default autonomy is not autopilot', () => {
    // A hub that shipped on autopilot would act on its own before anyone chose that.
    expect(agentSettingsSchema.parse({}).autonomy).not.toBe('autopilot')
  })

  test('quiet hours survive a partial patch', () => {
    const settings = agentSettingsSchema.parse({ proactivity: { quietHours: ['23:00', '06:30'] } })
    expect(settings.proactivity.quietHours).toEqual(['23:00', '06:30'])
  })
})
