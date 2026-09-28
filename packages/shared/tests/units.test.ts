/**
 * Unit conversions.
 *
 * These are the functions every adapter calls on the way in and out, so a wrong factor here
 * is a bug in twenty places at once. The tests pin the boundaries (0, max, out of range) and
 * the round trips, because that is where conversions actually break - the middle of the
 * range looks right even when the formula is wrong.
 */

import { describe, expect, test } from 'bun:test'
import {
  celsiusToFahrenheit,
  clamp,
  degreesToHue254,
  fahrenheitToCelsius,
  hsToRgb,
  hue254ToDegrees,
  kelvinToMired,
  kelvinToRgb,
  level254ToPercent,
  miredToKelvin,
  percentToLevel254,
  rgbToHs,
  rgbToXy,
  xyToRgb,
} from '../src/units.ts'

describe('colour temperature', () => {
  test('mired and kelvin are reciprocal', () => {
    expect(miredToKelvin(370)).toBe(2703)
    expect(miredToKelvin(153)).toBe(6536)
    expect(kelvinToMired(2700)).toBe(370)
    expect(kelvinToMired(6500)).toBe(154)
  })

  test('a zero or negative mired cannot produce Infinity', () => {
    // A bulb that reports 0 is reporting "unknown", and 1/0 kelvin would poison every
    // downstream computation with Infinity rather than failing visibly.
    expect(miredToKelvin(0)).toBe(0)
    expect(miredToKelvin(-5)).toBe(0)
    expect(kelvinToMired(0)).toBe(0)
  })

  test('round trips within rounding error', () => {
    for (const kelvin of [2000, 2700, 3000, 4000, 5000, 6500]) {
      const back = miredToKelvin(kelvinToMired(kelvin))
      expect(Math.abs(back - kelvin)).toBeLessThanOrEqual(kelvin * 0.005)
    }
  })
})

describe('temperature', () => {
  test('known fixed points', () => {
    expect(fahrenheitToCelsius(32)).toBeCloseTo(0, 10)
    expect(fahrenheitToCelsius(212)).toBeCloseTo(100, 10)
    expect(fahrenheitToCelsius(-40)).toBeCloseTo(-40, 10)
    expect(celsiusToFahrenheit(0)).toBe(32)
    expect(celsiusToFahrenheit(100)).toBe(212)
    expect(celsiusToFahrenheit(-40)).toBe(-40)
  })
})

describe('zigbee and matter levels', () => {
  test('the ends of the range map exactly', () => {
    expect(level254ToPercent(0)).toBe(0)
    expect(level254ToPercent(254)).toBe(100)
    expect(percentToLevel254(0)).toBe(0)
    expect(percentToLevel254(100)).toBe(254)
  })

  test('out of range input is clamped, never wrapped', () => {
    expect(level254ToPercent(300)).toBe(100)
    expect(level254ToPercent(-10)).toBe(0)
    expect(percentToLevel254(150)).toBe(254)
    expect(percentToLevel254(-1)).toBe(0)
  })

  test('a percent survives the round trip to within one step', () => {
    // One level out of 254 is 0.39 %, so a round trip can only move by one percent.
    for (let percent = 0; percent <= 100; percent += 1) {
      expect(Math.abs(level254ToPercent(percentToLevel254(percent)) - percent)).toBeLessThanOrEqual(1)
    }
  })

  test('hue maps the full wheel', () => {
    expect(hue254ToDegrees(0)).toBe(0)
    expect(hue254ToDegrees(254)).toBe(360)
    expect(degreesToHue254(0)).toBe(0)
    expect(degreesToHue254(360)).toBe(254)
    expect(hue254ToDegrees(127)).toBe(180)
  })
})

describe('clamp', () => {
  test('bounds and passthrough', () => {
    expect(clamp(5, 0, 10)).toBe(5)
    expect(clamp(-1, 0, 10)).toBe(0)
    expect(clamp(11, 0, 10)).toBe(10)
    expect(clamp(0, 0, 0)).toBe(0)
  })
})

describe('CIE xy', () => {
  test('a known white point is near white', () => {
    const [r, g, b] = xyToRgb(0.3127, 0.329, 1)
    expect(r).toBeGreaterThan(200)
    expect(g).toBeGreaterThan(200)
    expect(b).toBeGreaterThan(200)
  })

  test('primaries survive the round trip through xy', () => {
    const [rx, ry] = rgbToXy(255, 0, 0)
    expect(rx).toBeGreaterThan(ry)
    const [red] = xyToRgb(rx, ry, 1)
    expect(red).toBe(255)

    const [bx, by] = rgbToXy(0, 0, 255)
    const [, , blue] = xyToRgb(bx, by, 1)
    expect(blue).toBe(255)
  })

  test('black has no chromaticity rather than NaN', () => {
    expect(rgbToXy(0, 0, 0)).toEqual([0, 0])
  })

  test('a zero y does not divide by zero', () => {
    expect(xyToRgb(0.5, 0, 1)).toEqual([0, 0, 0])
  })
})

describe('hue and saturation', () => {
  test('the six primaries', () => {
    expect(hsToRgb(0, 100)).toEqual([255, 0, 0])
    expect(hsToRgb(60, 100)).toEqual([255, 255, 0])
    expect(hsToRgb(120, 100)).toEqual([0, 255, 0])
    expect(hsToRgb(180, 100)).toEqual([0, 255, 255])
    expect(hsToRgb(240, 100)).toEqual([0, 0, 255])
    expect(hsToRgb(300, 100)).toEqual([255, 0, 255])
  })

  test('zero saturation is grey at the value given', () => {
    expect(hsToRgb(210, 0, 100)).toEqual([255, 255, 255])
    expect(hsToRgb(210, 0, 50)).toEqual([128, 128, 128])
  })

  test('hue wraps past 360', () => {
    expect(hsToRgb(360, 100)).toEqual(hsToRgb(0, 100))
    expect(hsToRgb(420, 100)).toEqual(hsToRgb(60, 100))
  })

  test('rgb back to hue and saturation', () => {
    expect(rgbToHs(255, 0, 0)).toEqual([0, 100])
    expect(rgbToHs(0, 255, 0)).toEqual([120, 100])
    expect(rgbToHs(0, 0, 255)).toEqual([240, 100])
    expect(rgbToHs(255, 255, 255)).toEqual([0, 0])
    expect(rgbToHs(0, 0, 0)).toEqual([0, 0])
  })

  test('round trip holds for saturated colours', () => {
    for (const hue of [0, 45, 90, 135, 180, 225, 270, 315]) {
      const [r, g, b] = hsToRgb(hue, 100)
      const [backHue, backSaturation] = rgbToHs(r, g, b)
      expect(Math.abs(backHue - hue)).toBeLessThanOrEqual(1)
      expect(backSaturation).toBe(100)
    }
  })
})

describe('kelvin to rgb', () => {
  test('warm is redder than cold, cold is bluer than warm', () => {
    const warm = kelvinToRgb(2000)
    const cold = kelvinToRgb(8000)
    expect(warm[0]).toBeGreaterThanOrEqual(cold[0])
    expect(warm[2]).toBeLessThan(cold[2])
  })

  test('every channel stays a byte across the whole range', () => {
    for (let kelvin = 500; kelvin <= 15000; kelvin += 250) {
      for (const channel of kelvinToRgb(kelvin)) {
        expect(channel).toBeGreaterThanOrEqual(0)
        expect(channel).toBeLessThanOrEqual(255)
        expect(Number.isNaN(channel)).toBe(false)
      }
    }
  })

  test('daylight is roughly neutral', () => {
    const [r, g, b] = kelvinToRgb(6500)
    expect(Math.abs(r - b)).toBeLessThan(40)
    expect(g).toBeGreaterThan(200)
  })
})
