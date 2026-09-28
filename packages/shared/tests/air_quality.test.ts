/**
 * The air-quality verdict from the readings behind it.
 *
 * The `airQuality` capability carries a level, but most sensors only report CO2 or fine
 * particles. Every adapter that reads one derives the level the same way, here, so a CO2
 * meter behind Home Assistant and one on ESPHome never disagree about the same air.
 */

import { describe, expect, test } from 'bun:test'
import { airQualityFrom } from '../src/capabilities'

describe('airQualityFrom', () => {
  test('from CO2 alone', () => {
    expect(airQualityFrom({ co2: 600 })).toBe('good')
    expect(airQualityFrom({ co2: 900 })).toBe('fair')
    expect(airQualityFrom({ co2: 1250 })).toBe('moderate')
    expect(airQualityFrom({ co2: 1600 })).toBe('poor')
    expect(airQualityFrom({ co2: 2500 })).toBe('very_poor')
  })

  test('from fine particles alone', () => {
    expect(airQualityFrom({ pm25: 8 })).toBe('good')
    expect(airQualityFrom({ pm25: 25 })).toBe('moderate')
    expect(airQualityFrom({ pm25: 40 })).toBe('poor')
    expect(airQualityFrom({ pm25: 80 })).toBe('very_poor')
  })

  test('the worse of the two wins', () => {
    expect(airQualityFrom({ co2: 500, pm25: 40 })).toBe('poor')
  })

  test('nothing to go on is unknown, not good', () => {
    expect(airQualityFrom({})).toBe('unknown')
    expect(airQualityFrom({ co2: null, pm25: Number.NaN })).toBe('unknown')
  })
})
