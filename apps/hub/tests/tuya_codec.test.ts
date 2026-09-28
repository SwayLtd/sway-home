/**
 * Tuya local, the parts that do not need a device.
 *
 * A Tuya device listens on TCP 6668 and speaks framed messages: 0x000055AA, a sequence
 * number, a command, a length, the payload, a CRC32 and 0x0000AA55 (protocol 3.3). Payloads
 * are JSON encrypted with the device's local key (AES-128-ECB). Protocol 3.4 first agrees on
 * a session key (two nonces, HMAC-SHA256 on both sides) and signs frames with HMAC-SHA256;
 * 3.5 frames are 0x00006699 and AES-GCM. Devices announce themselves by UDP broadcast every
 * few seconds (6666 in clear, 6667 encrypted with a fixed key, 7000 for 3.5).
 *
 * Values are data points ("dps"), numbered by product category: a plug's 1 is its switch,
 * 19 its power in tenths of a watt; a bulb's 20 is its switch, 22 its brightness (10-1000).
 *
 * Sources: tinytuya (core/header.py, message_helper.py, crypto_helper.py, XenonDevice.py,
 * udp_helper.py), Tuya's standard instruction sets for plugs (cz), lights (dj), curtains (cl).
 */

import { describe, expect, test } from 'bun:test'
import { createHash, createHmac, randomBytes } from 'node:crypto'
import {
  COMMAND,
  UDP_KEY,
  TuyaReader,
  aesEcbDecrypt,
  aesEcbEncrypt,
  capabilitiesFor,
  crc32,
  decodeBroadcast,
  decodeResponse,
  detectProfile,
  discoveryRequest,
  dpsForCommand,
  encodeRequest,
  negotiateFinish,
  negotiateStart,
  packFrame,
  parseLocalKeys,
  requestJson,
  stateFromDps,
} from '#adapters/tuya_codec'

const KEY = Buffer.from('0123456789abcdef')
const ID = 'bf1234567890abcdef12ab'

describe('frames', () => {
  test('the CRC is the usual CRC-32', () => {
    expect(crc32(Buffer.from('123456789'))).toBe(0xcbf43926)
  })

  test('3.3: prefix, sequence, command, length, payload, CRC, suffix', () => {
    const frame = packFrame({ format: '55aa', seq: 1, cmd: COMMAND.dpQuery, payload: Buffer.from('abc') })
    expect(frame.subarray(0, 16).toString('hex')).toBe('000055aa' + '00000001' + '0000000a' + '0000000b')
    expect(frame.subarray(-4).toString('hex')).toBe('0000aa55')
    const [read] = new TuyaReader({ key: () => null, hmac: false, retcode: false }).push(frame)
    expect(read).toEqual({ seq: 1, cmd: COMMAND.dpQuery, retcode: null, payload: Buffer.from('abc'), valid: true })
  })

  test('answers from a device carry a return code; frames cut anywhere are put back together', () => {
    const frame = packFrame({ format: '55aa', seq: 9, cmd: COMMAND.status, payload: Buffer.from('{}'), retcode: 0 })
    const reader = new TuyaReader({ key: () => null, hmac: false, retcode: true })
    const out = [...Buffer.concat([frame, frame])].flatMap((byte) => reader.push(Buffer.from([byte])))
    expect(out.map((entry) => [entry.seq, entry.retcode, entry.payload.toString(), entry.valid])).toEqual([
      [9, 0, '{}', true],
      [9, 0, '{}', true],
    ])
  })

  test('3.4 signs with HMAC-SHA256; a wrong key shows as invalid', () => {
    const frame = packFrame({ format: '55aa', seq: 2, cmd: COMMAND.controlNew, payload: Buffer.from('x'), key: KEY })
    expect(frame.length).toBe(16 + 1 + 32 + 4)
    expect(new TuyaReader({ key: () => KEY, hmac: true, retcode: false }).push(frame)[0]?.valid).toBe(true)
    expect(new TuyaReader({ key: () => Buffer.from('fedcba9876543210'), hmac: true, retcode: false }).push(frame)[0]?.valid).toBe(false)
  })

  test('3.5 is AES-GCM with the header as additional data; one flipped bit and it does not open', () => {
    const frame = packFrame({ format: '6699', seq: 3, cmd: COMMAND.controlNew, payload: Buffer.from('{"a":1}'), key: KEY })
    expect(frame.subarray(0, 4).toString('hex')).toBe('00006699')
    expect(frame.subarray(-4).toString('hex')).toBe('00009966')
    expect(new TuyaReader({ key: () => KEY, hmac: false, retcode: false }).push(frame)[0]).toMatchObject({ seq: 3, payload: Buffer.from('{"a":1}'), valid: true })
    const tampered = Buffer.from(frame)
    tampered[25] = tampered[25]! ^ 0x01
    expect(new TuyaReader({ key: () => KEY, hmac: false, retcode: false }).push(tampered)[0]?.valid).toBe(false)
  })
})

describe('payloads', () => {
  test('AES-128-ECB with PKCS#7 padding, both ways', () => {
    const sealed = aesEcbEncrypt(KEY, Buffer.from('{"dps":{"1":true}}'))
    expect(sealed.length).toBe(32)
    expect(aesEcbDecrypt(KEY, sealed).toString()).toBe('{"dps":{"1":true}}')
  })

  test('3.3: a command carries "3.3" and twelve zero bytes before the ciphertext; a query does not', () => {
    const control = encodeRequest('3.3', COMMAND.control, { dps: { 1: true } }, KEY)
    expect(control.subarray(0, 15).toString('latin1')).toBe('3.3' + '\0'.repeat(12))
    expect(aesEcbDecrypt(KEY, control.subarray(15)).toString()).toBe('{"dps":{"1":true}}')
    const query = encodeRequest('3.3', COMMAND.dpQuery, { gwId: ID }, KEY)
    expect(aesEcbDecrypt(KEY, query).toString()).toBe(`{"gwId":"${ID}"}`)
  })

  test('3.4: the header is inside the encryption', () => {
    const control = encodeRequest('3.4', COMMAND.controlNew, { protocol: 5 }, KEY)
    expect(aesEcbDecrypt(KEY, control).subarray(0, 3).toString()).toBe('3.4')
  })

  test('what devices send back, whatever the version, becomes the same JSON', () => {
    const push33 = Buffer.concat([Buffer.from('3.3' + '\0'.repeat(12), 'latin1'), aesEcbEncrypt(KEY, Buffer.from('{"dps":{"1":false},"t":1}'))])
    expect(decodeResponse('3.3', push33, KEY)).toEqual({ dps: { 1: false }, t: 1 })
    const push34 = aesEcbEncrypt(KEY, Buffer.from('3.4' + '\0'.repeat(12) + '{"protocol":4,"data":{"dps":{"20":true}}}', 'latin1'))
    expect(decodeResponse('3.4', push34, KEY)).toMatchObject({ dps: { 20: true } })
    expect(decodeResponse('3.5', Buffer.from('3.5' + '\0'.repeat(12) + '{"dps":{"2":40}}', 'latin1'), KEY)).toEqual({ dps: { 2: 40 } })
    expect(decodeResponse('3.3', aesEcbEncrypt(KEY, Buffer.from('json obj data unvalid')), KEY)).toEqual({ error: 'data unvalid' })
    expect(decodeResponse('3.3', Buffer.alloc(0), KEY)).toBeNull()
  })

  test('requests as each version wants them', () => {
    const now = 1_700_000_000_000
    expect(requestJson('3.3', 'control', ID, { 1: true }, now)).toEqual({ devId: ID, uid: ID, t: '1700000000', dps: { 1: true } })
    expect(requestJson('3.3', 'query', ID, undefined, now)).toEqual({ gwId: ID, devId: ID, uid: ID, t: '1700000000' })
    expect(requestJson('3.4', 'control', ID, { 20: true }, now)).toEqual({ protocol: 5, t: 1_700_000_000, data: { dps: { 20: true } } })
    expect(requestJson('3.5', 'query', ID, undefined, now)).toEqual({})
  })
})

describe('the 3.4 and 3.5 session key', () => {
  for (const version of ['3.4', '3.5'] as const) {
    test(`${version}: both sides end with the same key, and a wrong local key is caught`, () => {
      const localNonce = randomBytes(16)
      const remoteNonce = randomBytes(16)
      const start = negotiateStart(version, KEY, localNonce)
      // The device's side: it reads the client nonce, answers with its own and a proof.
      const received = version === '3.4' ? aesEcbDecrypt(KEY, start) : start
      expect(received).toEqual(localNonce)
      const proof = createHmac('sha256', KEY).update(localNonce).digest()
      const answer = version === '3.4' ? aesEcbEncrypt(KEY, Buffer.concat([remoteNonce, proof])) : Buffer.concat([remoteNonce, proof])

      const result = negotiateFinish(version, KEY, localNonce, answer)
      if ('error' in result) throw new Error(result.error)
      const finish = version === '3.4' ? aesEcbDecrypt(KEY, result.finish) : result.finish
      expect(finish).toEqual(createHmac('sha256', KEY).update(remoteNonce).digest())
      expect(result.sessionKey.length).toBe(16)

      const other = negotiateFinish(version, Buffer.from('fedcba9876543210'), localNonce, answer)
      expect('error' in other && other.error).toMatch(/clé locale/)
    })
  }

  test('3.4 session key: the local key encrypts the XOR of the two nonces', () => {
    const localNonce = Buffer.alloc(16, 1)
    const remoteNonce = Buffer.alloc(16, 3)
    const proof = createHmac('sha256', KEY).update(localNonce).digest()
    const result = negotiateFinish('3.4', KEY, localNonce, aesEcbEncrypt(KEY, Buffer.concat([remoteNonce, proof])))
    if ('error' in result) throw new Error(result.error)
    expect(result.sessionKey).toEqual(aesEcbEncrypt(KEY, Buffer.alloc(16, 2)).subarray(0, 16))
  })
})

describe('announcements', () => {
  const announce = { ip: '192.168.1.44', gwId: ID, active: 2, ability: 0, mode: 0, encrypt: true, productKey: 'keyabc', version: '3.3' }

  test('a 3.3 broadcast on 6667, encrypted with the fixed UDP key', () => {
    const payload = aesEcbEncrypt(UDP_KEY, Buffer.from(JSON.stringify(announce)))
    const frame = packFrame({ format: '55aa', seq: 0, cmd: 0x13, payload, retcode: 0 })
    expect(decodeBroadcast(frame)).toEqual({ id: ID, ip: '192.168.1.44', version: '3.3', productKey: 'keyabc' })
  })

  test('a 3.5 broadcast on 7000, and the request that makes 3.5 devices speak', () => {
    const payload = Buffer.concat([Buffer.from([0, 0, 0, 0]), Buffer.from(JSON.stringify({ ...announce, version: '3.5' }))])
    const frame = packFrame({ format: '6699', seq: 0, cmd: 0x13, payload, key: UDP_KEY })
    expect(decodeBroadcast(frame)).toMatchObject({ id: ID, version: '3.5' })
    const request = new TuyaReader({ key: () => UDP_KEY, hmac: false, retcode: false }).push(discoveryRequest('192.168.1.10'))[0]
    expect(request?.cmd).toBe(COMMAND.reqDevinfo)
    expect(JSON.parse(request!.payload.toString())).toEqual({ from: 'app', ip: '192.168.1.10' })
  })

  test('the UDP key is the MD5 of a string every Tuya app knows', () => {
    expect(UDP_KEY).toEqual(createHash('md5').update('yGAdlopoPVldABfn').digest())
  })
})

describe('data points', () => {
  test('the kind of device, from the points it reports', () => {
    expect(detectProfile({ 1: true, 9: 0, 18: 120, 19: 254, 20: 2301 })).toBe('plug')
    expect(detectProfile({ 1: true, 2: false })).toBe('switch')
    expect(detectProfile({ 20: true, 21: 'white', 22: 500, 23: 0, 24: '000003e803e8' })).toBe('bulb')
    expect(detectProfile({ 1: true, 2: 'colour', 3: 255, 4: 0, 5: 'ff00000000ffff' })).toBe('bulb_v1')
    expect(detectProfile({ 1: 'stop', 2: 50, 3: 50 })).toBe('cover')
    expect(detectProfile({ 101: 'x' })).toBeNull()
  })

  test('capabilities follow the points actually there', () => {
    expect(capabilitiesFor('plug', { 1: true, 19: 254 })).toEqual(['onoff', 'power'])
    expect(capabilitiesFor('bulb', { 20: true, 22: 500 })).toEqual(['onoff', 'brightness'])
    expect(capabilitiesFor('bulb', { 20: true, 21: 'white', 22: 500, 23: 0, 24: '000003e803e8' })).toEqual(['onoff', 'brightness', 'colorTemperature', 'color'])
    expect(capabilitiesFor('cover', { 1: 'stop', 2: 0 })).toEqual(['position'])
  })

  test('a plug: power in tenths of a watt, voltage in tenths of a volt, current in milliamps', () => {
    expect(stateFromDps('plug', { 1: true, 18: 1200, 19: 2543, 20: 2301 })).toEqual({ on: true, power: 254.3, voltage: 230.1, current: 1.2 })
  })

  test('a bulb in white, then in colour', () => {
    expect(stateFromDps('bulb', { 20: true, 21: 'white', 22: 505, 23: 1000 })).toEqual({ on: true, brightness: 50, colorTemperature: 6500 })
    expect(stateFromDps('bulb', { 20: true, 21: 'colour', 22: 1000, 24: '007803e801f4' })).toEqual({ on: true, brightness: 50, hue: 120, saturation: 100 })
  })

  test('commands become points to write', () => {
    expect(dpsForCommand('plug', 'turnOff', {}, {})).toEqual({ dps: { 1: false }, expect: { on: false } })
    expect(dpsForCommand('bulb', 'setBrightness', { brightness: 100 }, { 21: 'white' })).toEqual({ dps: { 20: true, 22: 1000 }, expect: { on: true, brightness: 100 } })
    expect(dpsForCommand('bulb', 'setColorTemperature', { kelvin: 2700 }, {})).toEqual({ dps: { 20: true, 21: 'white', 23: 0 }, expect: { on: true, colorTemperature: 2700 } })
    expect(dpsForCommand('bulb', 'setColor', { hue: 240, saturation: 50 }, { 22: 1000 })).toEqual({
      dps: { 20: true, 21: 'colour', 24: '00f001f403e8' },
      expect: { on: true, hue: 240, saturation: 50 },
    })
    expect(dpsForCommand('bulb', 'setColorName', { name: 'rouge' }, {})).toMatchObject({ dps: { 21: 'colour' }, expect: { hue: 0, saturation: 100 } })
    expect(dpsForCommand('cover', 'setPosition', { position: 30 }, {})).toEqual({ dps: { 2: 30 }, expect: { position: 30 } })
    expect(dpsForCommand('cover', 'stop', {}, {})).toEqual({ dps: { 1: 'stop' }, expect: {} })
    expect(dpsForCommand('switch', 'setBrightness', { brightness: 3 }, {})).toHaveProperty('error')
  })
})

describe('the local keys in the settings', () => {
  test('a key per device id, or an object with a name and a kind', () => {
    const { devices, errors } = parseLocalKeys(JSON.stringify({ [ID]: '0123456789abcdef', bf99: { key: 'abcdef0123456789', name: 'Prise salon', type: 'plug', ip: '192.168.1.45', version: '3.4' } }))
    expect(errors).toEqual([])
    expect(devices).toEqual([
      { id: ID, key: '0123456789abcdef', name: null, profile: null, ip: null, version: null },
      { id: 'bf99', key: 'abcdef0123456789', name: 'Prise salon', profile: 'plug', ip: '192.168.1.45', version: '3.4' },
    ])
  })

  test('mistakes are said per device, and the key itself is never repeated', () => {
    const { devices, errors } = parseLocalKeys(JSON.stringify({ bf1: 'short', bf2: { key: '0123456789abcdef', type: 'aspirateur' }, bf3: { key: '0123456789abcdef', version: '3.1' } }))
    expect(devices).toEqual([])
    expect(errors).toEqual([
      'bf1 : une clé locale de 16 caractères est attendue.',
      'bf2 : type "aspirateur" inconnu (switch, plug, bulb, bulb_v1, cover).',
      'bf3 : version "3.1" non prise en charge (3.3, 3.4, 3.5).',
    ])
    expect(parseLocalKeys('nope').errors[0]).toMatch(/JSON/)
  })
})
