/**
 * The LIFX LAN wire format.
 *
 * The golden vector is the worked example from LIFX's own documentation
 * (https://lan.developer.lifx.com/docs/encoding-a-packet): a SetColor turning the light
 * d073d5001337 full-brightness green, source 2, sequence 1, ack required. If the encoder
 * reproduces those 49 bytes exactly, the header bit packing - the part every home-grown LIFX
 * client gets wrong at least once - is right.
 */

import { describe, expect, test } from 'bun:test'
import {
  LIFX_HEADER_SIZE,
  LIFX_TYPE,
  decodeLifx,
  encodeLifx,
  fromHsbk,
  lightStatePayload,
  parseLightState,
  parseStateService,
  setColorPayload,
  setLightPowerPayload,
  targetFromMac,
  toHsbk,
} from '#adapters/lifx_codec'

const GOLDEN_SET_COLOR_GREEN =
  '3100001402000000' +
  'd073d50013370000' +
  '0000000000000201' +
  '0000000000000000' +
  '66000000005555ff' +
  'ffffffac0d000000' +
  '00'

function hex(bytes: Uint8Array): string {
  return [...bytes].map((byte) => byte.toString(16).padStart(2, '0')).join('')
}

describe('the header', () => {
  test('reproduces the documented SetColor packet byte for byte', () => {
    const packet = encodeLifx({
      type: LIFX_TYPE.SetColor,
      source: 2,
      sequence: 1,
      target: targetFromMac('d0:73:d5:00:13:37'),
      ackRequired: true,
      resRequired: false,
      tagged: false,
      payload: setColorPayload({ hue: 21845, saturation: 65535, brightness: 65535, kelvin: 3500 }, 0),
    })
    expect(hex(packet)).toBe(GOLDEN_SET_COLOR_GREEN)
  })

  test('is 36 bytes, and size counts the payload', () => {
    const packet = encodeLifx({ type: LIFX_TYPE.GetService, source: 7, sequence: 0, tagged: true })
    expect(packet.length).toBe(LIFX_HEADER_SIZE)
    expect(packet[0]).toBe(36)
  })

  test('a broadcast is tagged and targets nobody', () => {
    const packet = encodeLifx({ type: LIFX_TYPE.GetService, source: 7, sequence: 0, tagged: true })
    // Byte 3 carries addressable (bit 4) and tagged (bit 5) of the protocol word.
    expect(packet[3]! & 0b0011_0000).toBe(0b0011_0000)
    expect(hex(packet.subarray(8, 16))).toBe('0000000000000000')
  })

  test('decoding reverses encoding', () => {
    const packet = encodeLifx({
      type: LIFX_TYPE.SetLightPower,
      source: 0xdeadbeef,
      sequence: 200,
      target: targetFromMac('d073d5aabbcc'),
      ackRequired: true,
      payload: setLightPowerPayload(true, 500),
    })
    const decoded = decodeLifx(packet)!
    expect(decoded).toMatchObject({ type: LIFX_TYPE.SetLightPower, source: 0xdeadbeef, sequence: 200, mac: 'd0:73:d5:aa:bb:cc', ackRequired: true })
    expect(decoded.payload.length).toBe(6)
  })

  test('a truncated or foreign packet decodes to null rather than throwing', () => {
    expect(decodeLifx(new Uint8Array([1, 2, 3]))).toBeNull()
    const packet = encodeLifx({ type: LIFX_TYPE.GetService, source: 1, sequence: 0, tagged: true })
    packet[0] = 200 // claims more bytes than it has
    expect(decodeLifx(packet)).toBeNull()
    const wrongProtocol = encodeLifx({ type: LIFX_TYPE.GetService, source: 1, sequence: 0, tagged: true })
    wrongProtocol[2] = 0x01 // protocol 1025
    expect(decodeLifx(wrongProtocol)).toBeNull()
  })
})

describe('payloads', () => {
  test('SetLightPower carries the level and the transition', () => {
    const payload = setLightPowerPayload(true, 1000)
    expect(hex(payload)).toBe('ffff' + 'e8030000')
    expect(hex(setLightPowerPayload(false, 0))).toBe('0000' + '00000000')
  })

  test('StateService says which UDP port the light listens on', () => {
    const payload = new Uint8Array([1, 0x7c, 0xdd, 0, 0]) // service 1 (UDP), port 56700
    expect(parseStateService(payload)).toEqual({ service: 1, port: 56700 })
  })

  test('LightState reads colour, power and the label', () => {
    const state = parseLightState(lightStatePayload({ hue: 21845, saturation: 65535, brightness: 32768, kelvin: 2700 }, 65535, 'Plafonnier'))
    expect(state).toMatchObject({ on: true, label: 'Plafonnier' })
    expect(state.hsbk).toEqual({ hue: 21845, saturation: 65535, brightness: 32768, kelvin: 2700 })
  })

  test('a label padded with zero bytes is trimmed', () => {
    const state = parseLightState(lightStatePayload({ hue: 0, saturation: 0, brightness: 0, kelvin: 3500 }, 0, 'A'))
    expect(state.label).toBe('A')
    expect(state.on).toBe(false)
  })
})

describe('colour conversion', () => {
  test('the documented green is hue 21845', () => {
    expect(toHsbk({ hue: 120, saturation: 100, brightness: 100, kelvin: 3500 })).toEqual({ hue: 21845, saturation: 65535, brightness: 65535, kelvin: 3500 })
  })

  test('there and back lands on the same numbers a person would say', () => {
    const round = fromHsbk(toHsbk({ hue: 220, saturation: 80, brightness: 40, kelvin: 2700 }))
    expect(round).toEqual({ hue: 220, saturation: 80, brightness: 40, kelvin: 2700 })
  })

  test('hue 360 wraps to 0 rather than overflowing the field', () => {
    expect(toHsbk({ hue: 360, saturation: 0, brightness: 0, kelvin: 3500 }).hue).toBe(0)
  })

  test('out-of-range values are clamped, never sent raw', () => {
    const value = toHsbk({ hue: -10, saturation: 150, brightness: -5, kelvin: 99999 })
    expect(value.saturation).toBe(65535)
    expect(value.brightness).toBe(0)
    expect(value.kelvin).toBeLessThanOrEqual(9000)
    expect(value.hue).toBeGreaterThanOrEqual(0)
  })
})

describe('targets', () => {
  test('accepts a MAC with or without separators', () => {
    expect(hex(targetFromMac('d0:73:d5:00:13:37'))).toBe('d073d50013370000')
    expect(hex(targetFromMac('D073D5001337'))).toBe('d073d50013370000')
  })

  test('refuses anything that is not six bytes', () => {
    expect(() => targetFromMac('d0:73:d5')).toThrow()
  })
})
