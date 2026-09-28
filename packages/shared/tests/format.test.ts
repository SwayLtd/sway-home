/**
 * Numbers the way a person says them.
 *
 * The assistant's sentences are read on screen and spoken aloud, in French. "1962 W" and
 * "0.006 kWh" are correct and unreadable; "2 kW" and "6 Wh" are what anyone would say. The
 * rules live in one place so a chip, a card and a spoken answer never disagree about how a
 * value is written.
 */

import { describe, expect, test } from 'bun:test'
import { currencyIcon, formatMoney, formatQuantity } from '../src/format'

describe('quantities', () => {
  test('a French decimal comma, never a dot', () => {
    expect(formatQuantity(19.5, '°C', 1)).toBe('19,5 °C')
    expect(formatQuantity(45, '%', 0)).toBe('45 %')
  })

  test('a trailing zero says nothing and goes', () => {
    expect(formatQuantity(20, '°C', 1)).toBe('20 °C')
    expect(formatQuantity(20.25, '°C', 2)).toBe('20,25 °C')
  })

  test('small draws keep one decimal, the rest are whole watts', () => {
    expect(formatQuantity(4.4, 'W', 0)).toBe('4,4 W')
    expect(formatQuantity(0, 'W', 0)).toBe('0 W')
    expect(formatQuantity(42.4, 'W', 0)).toBe('42 W')
  })

  test('a kilowatt and more is said in kilowatts', () => {
    expect(formatQuantity(1920, 'W', 0)).toBe('1,9 kW')
    expect(formatQuantity(2000, 'W', 0)).toBe('2 kW')
  })

  test('energy under a kilowatt-hour is said in watt-hours', () => {
    expect(formatQuantity(0.006, 'kWh', 2)).toBe('6 Wh')
    expect(formatQuantity(0.5, 'kWh', 2)).toBe('500 Wh')
    expect(formatQuantity(2.46, 'kWh', 2)).toBe('2,5 kWh')
    expect(formatQuantity(312.4, 'kWh', 2)).toBe('312 kWh')
  })

  test('no unit is just the number', () => {
    expect(formatQuantity(3.14159, null, 2)).toBe('3,14')
  })

  test('minus zero is zero', () => {
    expect(formatQuantity(-0.01, 'W', 0)).toBe('0 W')
  })
})

describe('money', () => {
  test('two decimals, the symbol after, the way a bill prints it', () => {
    expect(formatMoney(3.1234, 'EUR')).toBe('3,12 €')
    expect(formatMoney(12, 'USD')).toBe('12,00 $')
    expect(formatMoney(1.5, 'GBP')).toBe('1,50 £')
    expect(formatMoney(1.5, 'CHF')).toBe('1,50 CHF')
  })

  test('less than a cent is not "0,00", which reads as nothing at all', () => {
    expect(formatMoney(0.0015, 'EUR')).toBe('moins de 0,01 €')
    expect(formatMoney(0, 'EUR')).toBe('0,00 €')
  })

  test('each currency has its icon, and an unknown one still has coins', () => {
    expect(currencyIcon('EUR')).toBe('ph:currency-eur')
    expect(currencyIcon('USD')).toBe('ph:currency-dollar')
    expect(currencyIcon('GBP')).toBe('ph:currency-gbp')
    expect(currencyIcon('JPY')).toBe('ph:coins')
  })
})
