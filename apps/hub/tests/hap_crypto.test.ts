/**
 * The cryptography HomeKit asks of a controller, on a runtime that lacks half of it.
 *
 * Bun has no ChaCha20-Poly1305 (oven-sh/bun#8072), so it is written here from RFC 8439 and
 * checked against the RFC's own vectors and against Node's native implementation. SRP-6a
 * (RFC 5054, 3072-bit group, SHA-512, as HomeKit uses it) is checked against fast-srp-hap,
 * the server side HAP-NodeJS runs, so both ends agree on every byte.
 */

import { describe, expect, test } from 'bun:test'
import { spawnSync } from 'node:child_process'
import { randomBytes } from 'node:crypto'
import { SRP, SrpServer } from 'fast-srp-hap'
import { chacha20, counterNonce, hapNonce, HapSession, open, poly1305, seal, SRP_K, SrpClient, tlvDecode, tlvEncode } from '#adapters/hap_crypto'

const SUNSCREEN = Buffer.from("Ladies and Gentlemen of the class of '99: If I could offer you only one tip for the future, sunscreen would be it.")
const nodeAvailable = spawnSync('node', ['--version']).status === 0

describe('ChaCha20-Poly1305 (RFC 8439)', () => {
  test('ChaCha20, section 2.4.2', () => {
    const key = Buffer.from(Array.from({ length: 32 }, (_, index) => index))
    const nonce = Buffer.from('000000000000004a00000000', 'hex')
    expect(chacha20(key, nonce, 1, SUNSCREEN).toString('hex')).toBe(
      '6e2e359a2568f98041ba0728dd0d6981e97e7aec1d4360c20a27afccfd9fae0bf91b65c5524733ab8f593dabcd62b3571639d624e65152ab8f530c359f0861d807ca0dbf500d6a6156a38e088a22b65e52bc514d16ccf806818ce91ab77937365af90bbf74a35be6b40b8eedf2785e42874d'
    )
  })

  test('Poly1305, section 2.5.2', () => {
    const key = Buffer.from('85d6be7857556d337f4452fe42d506a80103808afb0db2fd4abff6af4149f51b', 'hex')
    expect(poly1305(key, Buffer.from('Cryptographic Forum Research Group')).toString('hex')).toBe('a8061dc1305136c6c22b8baf0c0127a9')
  })

  test('the AEAD, section 2.8.2: sealed, opened, and refused when touched', () => {
    const key = Buffer.from(Array.from({ length: 32 }, (_, index) => 0x80 + index))
    const nonce = Buffer.from('070000004041424344454647', 'hex')
    const aad = Buffer.from('50515253c0c1c2c3c4c5c6c7', 'hex')
    const sealed = seal(key, nonce, SUNSCREEN, aad)
    expect(sealed.subarray(0, SUNSCREEN.length).toString('hex')).toBe(
      'd31a8d34648e60db7b86afbc53ef7ec2a4aded51296e08fea9e2b5a736ee62d63dbea45e8ca9671282fafb69da92728b1a71de0a9e060b2905d6a5b67ecd3b3692ddbd7f2d778b8c9803aee328091b58fab324e4fad675945585808b4831d7bc3ff4def08e4b7a9de576d26586cec64b6116'
    )
    expect(sealed.subarray(SUNSCREEN.length).toString('hex')).toBe('1ae10b594f09e26a7e902ecbd0600691')
    expect(open(key, nonce, sealed, aad)?.equals(SUNSCREEN)).toBe(true)
    const touched = Buffer.from(sealed)
    touched[3]! ^= 1
    expect(open(key, nonce, touched, aad)).toBeNull()
    expect(open(key, nonce, sealed, Buffer.from('other aad'))).toBeNull()
  })

  test.if(nodeAvailable)('the same bytes as Node\'s native cipher, for any size', () => {
    const cases = [0, 1, 15, 16, 17, 63, 64, 65, 255, 1024, 1500, 4097].map((size) => ({
      key: randomBytes(32).toString('hex'),
      nonce: randomBytes(12).toString('hex'),
      aad: randomBytes(size % 7).toString('hex'),
      plaintext: randomBytes(size).toString('hex'),
    }))
    const script = `
      const c = require('crypto'); const cases = JSON.parse(process.argv[1]);
      console.log(JSON.stringify(cases.map((t) => {
        const cipher = c.createCipheriv('chacha20-poly1305', Buffer.from(t.key, 'hex'), Buffer.from(t.nonce, 'hex'), { authTagLength: 16 });
        cipher.setAAD(Buffer.from(t.aad, 'hex'), { plaintextLength: t.plaintext.length / 2 });
        const out = Buffer.concat([cipher.update(Buffer.from(t.plaintext, 'hex')), cipher.final(), cipher.getAuthTag()]);
        return out.toString('hex');
      })))`
    const result = spawnSync('node', ['-e', script, JSON.stringify(cases)], { encoding: 'utf8' })
    const expected = JSON.parse(result.stdout) as string[]
    cases.forEach((entry, index) => {
      const ours = seal(Buffer.from(entry.key, 'hex'), Buffer.from(entry.nonce, 'hex'), Buffer.from(entry.plaintext, 'hex'), Buffer.from(entry.aad, 'hex'))
      expect(ours.toString('hex')).toBe(expected[index]!)
    })
  })

  test('HomeKit nonces: four zero bytes, then a label or a little-endian counter', () => {
    expect(hapNonce('PS-Msg05').toString('hex')).toBe('00000000' + Buffer.from('PS-Msg05').toString('hex'))
    expect(counterNonce(1).toString('hex')).toBe('000000000100000000000000')
    expect(counterNonce(258).toString('hex')).toBe('000000000201000000000000')
  })
})

describe('SRP-6a as HomeKit does it', () => {
  test('the multiplier is the one every HomeKit controller uses', () => {
    expect(SRP_K.toString(16)).toBe(
      'a9c2e2559bf0ebb53f0cbbf62282906bede7f2182f00678211fbd5bde5b285033a4993503b87397f9be5ec02080fedbc0835587ad039060879b8621e8c3659e0'
    )
  })

  test('against the server HAP-NodeJS runs: both ends prove the same session key', async () => {
    const salt = await SRP.genKey(16)
    const server = new SrpServer(SRP.params.hap, salt, Buffer.from('Pair-Setup'), Buffer.from('031-45-154'), await SRP.genKey(32))
    const client = new SrpClient('Pair-Setup', '031-45-154')
    client.setSalt(salt)
    client.setServerPublicKey(server.computeB())
    server.setA(client.publicKey)
    expect(() => server.checkM1(client.proof)).not.toThrow()
    expect(client.verifyServerProof(server.computeM2())).toBe(true)
    expect(client.sessionKey.equals(server.computeK())).toBe(true)
    expect(client.publicKey).toHaveLength(384)
  })

  test('a wrong code does not prove anything', async () => {
    const salt = await SRP.genKey(16)
    const server = new SrpServer(SRP.params.hap, salt, Buffer.from('Pair-Setup'), Buffer.from('031-45-154'), await SRP.genKey(32))
    const client = new SrpClient('Pair-Setup', '031-45-155')
    client.setSalt(salt)
    client.setServerPublicKey(server.computeB())
    server.setA(client.publicKey)
    expect(() => server.checkM1(client.proof)).toThrow()
    expect(client.verifyServerProof(randomBytes(64))).toBe(false)
  })

  test('a server key that is zero modulo N is refused', () => {
    const client = new SrpClient('Pair-Setup', '031-45-154')
    client.setSalt(randomBytes(16))
    expect(() => client.setServerPublicKey(Buffer.alloc(384))).toThrow()
  })
})

describe('TLV8', () => {
  test('types, lengths and values, and a state byte', () => {
    expect(tlvEncode([[6, 1], [0, 0]]).toString('hex')).toBe('060101000100')
    expect(tlvEncode([[1, 'Pair-Setup']]).toString('hex')).toBe('010a' + Buffer.from('Pair-Setup').toString('hex'))
    expect(tlvEncode([[5, Buffer.alloc(0)]]).toString('hex')).toBe('0500')
  })

  test('a value over 255 bytes is cut into fragments, and joined back', () => {
    const key = randomBytes(384)
    const encoded = tlvEncode([[6, 3], [3, key], [4, randomBytes(64)]])
    expect(encoded[3]).toBe(3)
    expect(encoded[4]).toBe(255)
    expect(encoded[4 + 1 + 255]).toBe(3)
    expect(encoded[4 + 1 + 255 + 1]).toBe(129)
    const decoded = tlvDecode(encoded)
    expect(decoded.get(3)?.equals(key)).toBe(true)
    expect(decoded.get(6)?.[0]).toBe(3)
    expect(decoded.get(4)).toHaveLength(64)
  })

  test('items of different types stay apart; a full fragment continues into the next', () => {
    const decoded = tlvDecode(Buffer.concat([Buffer.from([1, 2]), Buffer.from('ab'), Buffer.from([7, 1, 2])]))
    expect(decoded.get(1)?.toString()).toBe('ab')
    expect(decoded.get(7)?.[0]).toBe(2)
    const long = Buffer.concat([Buffer.from([9, 255]), Buffer.alloc(255, 1), Buffer.from([9, 10]), Buffer.alloc(10, 2)])
    expect(tlvDecode(long).get(9)).toHaveLength(265)
  })
})

describe('the encrypted session', () => {
  const keys = () => ({ write: randomBytes(32), read: randomBytes(32) })

  test('one side seals, the other opens, frame after frame', () => {
    const { write, read } = keys()
    const controller = new HapSession(write, read)
    const accessory = new HapSession(read, write)
    const request = Buffer.from('GET /accessories HTTP/1.1\r\nHost: lampe\r\n\r\n')
    expect(accessory.decrypt(controller.encrypt(request)).equals(request)).toBe(true)
    const second = Buffer.from('PUT /characteristics HTTP/1.1\r\n\r\n')
    expect(accessory.decrypt(controller.encrypt(second)).equals(second)).toBe(true)
    const reply = Buffer.from('HTTP/1.1 204 No Content\r\n\r\n')
    expect(controller.decrypt(accessory.encrypt(reply)).equals(reply)).toBe(true)
  })

  test('big payloads go in frames of 1024 bytes, and arrive in any pieces', () => {
    const { write, read } = keys()
    const controller = new HapSession(write, read)
    const accessory = new HapSession(read, write)
    const body = randomBytes(2500)
    const wire = controller.encrypt(body)
    expect(wire.readUInt16LE(0)).toBe(1024)
    expect(wire).toHaveLength(2500 + 3 * (2 + 16))
    const received: Buffer[] = []
    for (let offset = 0; offset < wire.length; offset += 7) received.push(accessory.decrypt(wire.subarray(offset, offset + 7)))
    expect(Buffer.concat(received).equals(body)).toBe(true)
  })

  test('a frame touched on the way is refused', () => {
    const { write, read } = keys()
    const controller = new HapSession(write, read)
    const accessory = new HapSession(read, write)
    const wire = controller.encrypt(Buffer.from('hello'))
    wire[4]! ^= 0xff
    expect(() => accessory.decrypt(wire)).toThrow()
  })
})
