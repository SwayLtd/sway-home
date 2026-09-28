/**
 * The ONVIF adapter against a camera that speaks the protocol for real.
 *
 * WS-Discovery on UDP, SOAP over HTTP with WS-Security tokens checked against the camera's own
 * clock, a PullPoint subscription that long-polls, HTTP Digest on the snapshot. The camera can
 * take the shapes real ones take: a clock two hours off, service addresses naming another
 * host, Axis reference parameters, a doorbell topic set, SOAP behind HTTP Digest, a login
 * written into the URIs it hands out.
 */

import { afterEach, describe, expect, test } from 'bun:test'
import { createHash, randomUUID } from 'node:crypto'
import { createSocket, type Socket } from 'node:dgram'
import { OnvifAdapter, type OnvifOptions } from '#adapters/onvif'
import { eventually, recordingContext, type RecordingContext } from './adapter_harness.ts'

const USER = 'admin'
const PASSWORD = 'secret-pw'
const JPEG = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46, 0x00, 0x01, 0xff, 0xd9])

interface CameraShape {
  name: string
  clockOffsetMs: number
  ptz: boolean
  doorbell: boolean
  events: boolean
  /** Axis: the subscription is told apart by a reference parameter, not by its address. */
  axis: boolean
  /** SOAP answered only behind HTTP Digest as well. */
  soapDigest: boolean
  /** GetCapabilities names a host the camera is not on. */
  wrongServiceHost: boolean
  /** The login written into the stream and snapshot URIs. */
  credentialsInUris: boolean
}

const envelope = (body: string) =>
  `<?xml version="1.0" encoding="UTF-8"?><SOAP-ENV:Envelope xmlns:SOAP-ENV="http://www.w3.org/2003/05/soap-envelope" xmlns:tt="http://www.onvif.org/ver10/schema" xmlns:tds="http://www.onvif.org/ver10/device/wsdl" xmlns:trt="http://www.onvif.org/ver10/media/wsdl" xmlns:tptz="http://www.onvif.org/ver20/ptz/wsdl" xmlns:tev="http://www.onvif.org/ver10/events/wsdl" xmlns:wsnt="http://docs.oasis-open.org/wsn/b-2" xmlns:wsa5="http://www.w3.org/2005/08/addressing" xmlns:wstop="http://docs.oasis-open.org/wsn/t-1" xmlns:tns1="http://www.onvif.org/ver10/topics"><SOAP-ENV:Body>${body}</SOAP-ENV:Body></SOAP-ENV:Envelope>`

const fault = (subcode: string, reason: string) =>
  envelope(
    `<SOAP-ENV:Fault><SOAP-ENV:Code><SOAP-ENV:Value>SOAP-ENV:Sender</SOAP-ENV:Value><SOAP-ENV:Subcode><SOAP-ENV:Value>${subcode}</SOAP-ENV:Value></SOAP-ENV:Subcode></SOAP-ENV:Code><SOAP-ENV:Reason><SOAP-ENV:Text xml:lang="en">${reason}</SOAP-ENV:Text></SOAP-ENV:Reason></SOAP-ENV:Fault>`
  )

const notification = (topic: string, data: Record<string, string>, operation: string, at: Date) =>
  `<wsnt:NotificationMessage><wsnt:Topic Dialect="http://www.onvif.org/ver10/tev/topicExpression/ConcreteSet">${topic}</wsnt:Topic><wsnt:Message><tt:Message UtcTime="${at.toISOString()}" PropertyOperation="${operation}"><tt:Source><tt:SimpleItem Name="VideoSourceConfigurationToken" Value="000"/></tt:Source><tt:Data>${Object.entries(
    data
  )
    .map(([name, value]) => `<tt:SimpleItem Name="${name}" Value="${value}"/>`)
    .join('')}</tt:Data></tt:Message></wsnt:Message></wsnt:NotificationMessage>`

const topic = (name: string, item: string) =>
  `<${name} wstop:topic="true"><tt:MessageDescription IsProperty="true"><tt:Source><tt:SimpleItemDescription Name="VideoSourceConfigurationToken" Type="tt:ReferenceToken"/></tt:Source><tt:Data><tt:SimpleItemDescription Name="${item}" Type="xs:boolean"/></tt:Data></tt:MessageDescription></${name}>`

const md5 = (text: string) => createHash('md5').update(text).digest('hex')

function seconds(duration: string): number {
  const match = /PT(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?/.exec(duration)
  return match ? Number(match[1] ?? 0) * 3600 + Number(match[2] ?? 0) * 60 + Number(match[3] ?? 0) : 1
}

class FakeCamera {
  readonly uuid = randomUUID()
  readonly shape: CameraShape
  port = 0
  discoveryPort = 0
  calls: { path: string; operation: string; body: string }[] = []
  ptz: string[] = []
  created = 0
  renewals = 0
  unsubscribed = 0
  challenges = 0
  #server: ReturnType<typeof Bun.serve> | null = null
  #discovery: Socket | null = null
  #queue: string[] = []
  #wake: (() => void) | null = null
  #subscriptions = new Set<number>()
  #nextSubscription = 1
  #nonces = new Set<string>()

  constructor(shape: Partial<CameraShape> = {}) {
    this.shape = {
      name: 'Reolink Video Doorbell',
      clockOffsetMs: 0,
      ptz: false,
      doorbell: true,
      events: true,
      axis: false,
      soapDigest: false,
      wrongServiceHost: false,
      credentialsInUris: true,
      ...shape,
    }
  }

  async start(port = this.port): Promise<this> {
    this.#server = Bun.serve({ hostname: '127.0.0.1', port, fetch: (request) => this.#handle(request) })
    this.port = this.#server.port!
    if (!this.#discovery) {
      const socket = createSocket('udp4')
      socket.on('message', (message, remote) => {
        const text = message.toString('utf8')
        if (text.includes('discovery/Probe')) socket.send(this.#probeMatch(text), remote.port, remote.address)
      })
      await new Promise<void>((resolve) => socket.bind(0, '127.0.0.1', () => resolve()))
      this.#discovery = socket
      this.discoveryPort = socket.address().port
    }
    return this
  }

  /** Unplugged: nothing answers any more. */
  stop(): void {
    this.#server?.stop(true)
    this.#server = null
    this.#wake?.()
  }

  close(): void {
    this.stop()
    this.#discovery?.close()
    this.#discovery = null
  }

  now(): Date {
    return new Date(Date.now() + this.shape.clockOffsetMs)
  }

  /** Like a real camera, nothing is kept for a subscription that does not exist yet. */
  push(topicName: string, data: Record<string, string>, operation = 'Changed'): void {
    if (this.#subscriptions.size === 0) return
    this.#queue.push(notification(topicName, data, operation, this.now()))
    this.#wake?.()
  }

  /** A reboot: every subscription is gone. */
  forgetSubscriptions(): void {
    this.#subscriptions.clear()
    this.#wake?.()
  }

  operations(): string[] {
    return this.calls.map((call) => call.operation)
  }

  #probeMatch(probe: string): string {
    const relatesTo = /<w:MessageID>([^<]+)<\/w:MessageID>/.exec(probe)?.[1] ?? ''
    return `<?xml version="1.0" encoding="UTF-8"?><SOAP-ENV:Envelope xmlns:SOAP-ENV="http://www.w3.org/2003/05/soap-envelope" xmlns:wsa="http://schemas.xmlsoap.org/ws/2004/08/addressing" xmlns:d="http://schemas.xmlsoap.org/ws/2005/04/discovery"><SOAP-ENV:Header><wsa:RelatesTo>${relatesTo}</wsa:RelatesTo></SOAP-ENV:Header><SOAP-ENV:Body><d:ProbeMatches><d:ProbeMatch><wsa:EndpointReference><wsa:Address>urn:uuid:${this.uuid}</wsa:Address></wsa:EndpointReference><d:Types>dn:NetworkVideoTransmitter tds:Device</d:Types><d:Scopes>onvif://www.onvif.org/type/video_encoder onvif://www.onvif.org/name/${encodeURIComponent(this.shape.name)} onvif://www.onvif.org/hardware/D340P</d:Scopes><d:XAddrs>http://127.0.0.1:${this.port}/onvif/device_service</d:XAddrs><d:MetadataVersion>1</d:MetadataVersion></d:ProbeMatch></d:ProbeMatches></SOAP-ENV:Body></SOAP-ENV:Envelope>`
  }

  #tokenOk(body: string): boolean {
    const field = (name: string) => new RegExp(`<${name}[^>]*>([^<]*)</${name}>`).exec(body)?.[1]
    const [username, digest, nonce, created] = [field('Username'), field('Password'), field('Nonce'), field('Created')]
    if (username !== USER || !digest || !nonce || !created) return false
    const expected = createHash('sha1')
      .update(Buffer.concat([Buffer.from(nonce, 'base64'), Buffer.from(created), Buffer.from(PASSWORD)]))
      .digest('base64')
    return digest === expected && Math.abs(new Date(created).getTime() - this.now().getTime()) < 5000
  }

  #digestOk(request: Request): boolean {
    const header = request.headers.get('authorization') ?? ''
    if (!header.startsWith('Digest ')) return false
    const part = (name: string) => new RegExp(`(?:^Digest |, )${name}="?([^",]*)"?`).exec(header)?.[1]
    const nonce = part('nonce')
    if (!nonce || !this.#nonces.has(nonce) || part('username') !== USER) return false
    const ha1 = md5(`${USER}:camera:${PASSWORD}`)
    const ha2 = md5(`${request.method}:${part('uri')}`)
    return part('response') === md5(`${ha1}:${nonce}:${part('nc')}:${part('cnonce')}:${part('qop')}:${ha2}`)
  }

  #challenge(): Response {
    this.challenges += 1
    const nonce = randomUUID().replace(/-/g, '')
    this.#nonces.add(nonce)
    return new Response('Unauthorized', { status: 401, headers: { 'www-authenticate': `Digest realm="camera", qop="auth", nonce="${nonce}", algorithm=MD5` } })
  }

  async #handle(request: Request): Promise<Response> {
    const url = new URL(request.url)
    if (request.method === 'GET' && url.pathname === '/cgi-bin/snap.jpg') {
      if (!this.#digestOk(request)) return this.#challenge()
      return new Response(JPEG, { headers: { 'content-type': 'image/jpeg' } })
    }
    const body = await request.text()
    const operation = /<(?:[\w-]+:)?Body>\s*<(?:[\w-]+:)?(\w+)/.exec(body)?.[1] ?? '?'
    this.calls.push({ path: url.pathname + url.search, operation, body })
    const xml = (text: string, status = 200) => new Response(envelope(text), { status, headers: { 'content-type': 'application/soap+xml; charset=utf-8' } })
    const failure = (subcode: string, reason: string, status = 400) => new Response(fault(subcode, reason), { status, headers: { 'content-type': 'application/soap+xml; charset=utf-8' } })

    if (operation === 'GetSystemDateAndTime') {
      const now = this.now()
      return xml(
        `<tds:GetSystemDateAndTimeResponse><tds:SystemDateAndTime><tt:DateTimeType>NTP</tt:DateTimeType><tt:DaylightSavings>false</tt:DaylightSavings><tt:UTCDateTime><tt:Time><tt:Hour>${now.getUTCHours()}</tt:Hour><tt:Minute>${now.getUTCMinutes()}</tt:Minute><tt:Second>${now.getUTCSeconds()}</tt:Second></tt:Time><tt:Date><tt:Year>${now.getUTCFullYear()}</tt:Year><tt:Month>${now.getUTCMonth() + 1}</tt:Month><tt:Day>${now.getUTCDate()}</tt:Day></tt:Date></tt:UTCDateTime></tds:SystemDateAndTime></tds:GetSystemDateAndTimeResponse>`
      )
    }
    if (this.shape.soapDigest && !this.#digestOk(request)) return this.#challenge()
    if (!this.#tokenOk(body)) return failure('ter:NotAuthorized', 'Sender not Authorized')

    const host = this.shape.wrongServiceHost ? '10.255.255.1' : '127.0.0.1'
    const service = (path: string) => `http://${host}:${this.port}/onvif/${path}`
    switch (operation) {
      case 'GetDeviceInformation':
        return xml(
          '<tds:GetDeviceInformationResponse><tds:Manufacturer>Reolink</tds:Manufacturer><tds:Model>Reolink Video Doorbell PoE</tds:Model><tds:FirmwareVersion>v3.0.0.2033</tds:FirmwareVersion><tds:SerialNumber>00000000000000</tds:SerialNumber><tds:HardwareId>DB_566128M5MP_P</tds:HardwareId></tds:GetDeviceInformationResponse>'
        )
      case 'GetCapabilities':
        return xml(
          `<tds:GetCapabilitiesResponse><tds:Capabilities><tt:Device><tt:XAddr>${service('device_service')}</tt:XAddr></tt:Device>` +
            (this.shape.events ? `<tt:Events><tt:XAddr>${service('event_service')}</tt:XAddr><tt:WSPullPointSupport>true</tt:WSPullPointSupport></tt:Events>` : '') +
            `<tt:Media><tt:XAddr>${service('media_service')}</tt:XAddr></tt:Media>` +
            (this.shape.ptz ? `<tt:PTZ><tt:XAddr>${service('ptz_service')}</tt:XAddr></tt:PTZ>` : '') +
            '</tds:Capabilities></tds:GetCapabilitiesResponse>'
        )
      case 'GetProfiles':
        return xml(
          '<trt:GetProfilesResponse>' +
            `<trt:Profiles token="000" fixed="true"><tt:Name>mainStream</tt:Name><tt:VideoEncoderConfiguration token="000"><tt:Encoding>H264</tt:Encoding><tt:Resolution><tt:Width>2560</tt:Width><tt:Height>1920</tt:Height></tt:Resolution></tt:VideoEncoderConfiguration>${this.shape.ptz ? '<tt:PTZConfiguration token="ptz0"><tt:Name>ptz</tt:Name></tt:PTZConfiguration>' : ''}</trt:Profiles>` +
            '<trt:Profiles token="001" fixed="true"><tt:Name>subStream</tt:Name><tt:VideoEncoderConfiguration token="001"><tt:Encoding>H264</tt:Encoding><tt:Resolution><tt:Width>640</tt:Width><tt:Height>480</tt:Height></tt:Resolution></tt:VideoEncoderConfiguration></trt:Profiles>' +
            '</trt:GetProfilesResponse>'
        )
      case 'GetStreamUri': {
        const token = /<(?:\w+:)?ProfileToken>([^<]+)</.exec(body)?.[1]
        const login = this.shape.credentialsInUris ? `${USER}:${PASSWORD}@` : ''
        return xml(`<trt:GetStreamUriResponse><trt:MediaUri><tt:Uri>rtsp://${login}${host}:554/h264Preview_01_${token === '000' ? 'main' : 'sub'}</tt:Uri><tt:Timeout>PT60S</tt:Timeout></trt:MediaUri></trt:GetStreamUriResponse>`)
      }
      case 'GetSnapshotUri': {
        const login = this.shape.credentialsInUris ? `&amp;user=${USER}&amp;password=${PASSWORD}` : ''
        return xml(`<trt:GetSnapshotUriResponse><trt:MediaUri><tt:Uri>http://${host}:${this.port}/cgi-bin/snap.jpg?channel=0${login}</tt:Uri></trt:MediaUri></trt:GetSnapshotUriResponse>`)
      }
      case 'ContinuousMove': {
        const velocity = /PanTilt x="([^"]+)" y="([^"]+)"/.exec(body)
        this.ptz.push(`move ${velocity?.[1]} ${velocity?.[2]}`)
        return xml('<tptz:ContinuousMoveResponse/>')
      }
      case 'Stop':
        this.ptz.push('stop')
        return xml('<tptz:StopResponse/>')
      case 'AbsoluteMove':
        this.ptz.push(`zoom ${/Zoom x="([^"]+)"/.exec(body)?.[1]}`)
        return xml('<tptz:AbsoluteMoveResponse/>')
      case 'GetEventProperties':
        return xml(
          '<tev:GetEventPropertiesResponse><wstop:TopicSet><tns1:RuleEngine wstop:topic="false">' +
            `<CellMotionDetector wstop:topic="false">${topic('Motion', 'IsMotion')}</CellMotionDetector>` +
            (this.shape.doorbell ? `<MyRuleDetector wstop:topic="false">${topic('Visitor', 'State')}${topic('PeopleDetect', 'State')}</MyRuleDetector>` : '') +
            '</tns1:RuleEngine></wstop:TopicSet></tev:GetEventPropertiesResponse>'
        )
      case 'CreatePullPointSubscription': {
        this.created += 1
        const id = this.#nextSubscription++
        this.#subscriptions.add(id)
        this.#queue.push(notification('tns1:RuleEngine/CellMotionDetector/Motion', { IsMotion: 'false' }, 'Initialized', this.now()))
        if (this.shape.doorbell) this.#queue.push(notification('tns1:RuleEngine/MyRuleDetector/Visitor', { State: 'false' }, 'Initialized', this.now()))
        const reference = this.shape.axis
          ? `<wsa5:Address>http://127.0.0.1:${this.port}/onvif/services</wsa5:Address><wsa5:ReferenceParameters><dom0:SubscriptionId xmlns:dom0="http://www.axis.com/2009/event">${id}</dom0:SubscriptionId></wsa5:ReferenceParameters>`
          : `<wsa5:Address>http://127.0.0.1:${this.port}/onvif/Subscription?Idx=${id}</wsa5:Address>`
        return xml(
          `<tev:CreatePullPointSubscriptionResponse><tev:SubscriptionReference>${reference}</tev:SubscriptionReference><wsnt:CurrentTime>${this.now().toISOString()}</wsnt:CurrentTime><wsnt:TerminationTime>${new Date(this.now().getTime() + 600_000).toISOString()}</wsnt:TerminationTime></tev:CreatePullPointSubscriptionResponse>`
        )
      }
      case 'PullMessages':
      case 'Renew':
      case 'Unsubscribe': {
        const id = this.shape.axis
          ? Number(/<dom0:SubscriptionId[^>]*IsReferenceParameter="true"[^>]*>(\d+)</.exec(body)?.[1] ?? Number.NaN)
          : Number(url.searchParams.get('Idx'))
        if (this.shape.axis && Number.isNaN(id)) return failure('ter:InvalidArgs', 'Missing subscription id', 500)
        if (!this.#subscriptions.has(id)) return failure('wsrf-rw:ResourceUnknownFault', 'Unknown subscription', 500)
        if (operation === 'Renew') {
          this.renewals += 1
          return xml(`<wsnt:RenewResponse><wsnt:TerminationTime>${new Date(this.now().getTime() + 600_000).toISOString()}</wsnt:TerminationTime></wsnt:RenewResponse>`)
        }
        if (operation === 'Unsubscribe') {
          this.unsubscribed += 1
          this.#subscriptions.delete(id)
          return xml('<wsnt:UnsubscribeResponse/>')
        }
        if (this.#queue.length === 0) {
          await new Promise<void>((resolve) => {
            const timer = setTimeout(() => wake(), seconds(/<(?:\w+:)?Timeout>([^<]+)</.exec(body)?.[1] ?? 'PT1S') * 1000)
            const wake = () => {
              clearTimeout(timer)
              this.#wake = null
              resolve()
            }
            this.#wake = wake
          })
        }
        if (!this.#subscriptions.has(id)) return failure('wsrf-rw:ResourceUnknownFault', 'Unknown subscription', 500)
        const messages = this.#queue.splice(0, 100)
        return xml(`<tev:PullMessagesResponse><tev:CurrentTime>${this.now().toISOString()}</tev:CurrentTime><tev:TerminationTime>${new Date(this.now().getTime() + 600_000).toISOString()}</tev:TerminationTime>${messages.join('')}</tev:PullMessagesResponse>`)
      }
      default:
        return failure('ter:ActionNotSupported', `${operation} is not supported`)
    }
  }
}

// ---------------------------------------------------------------------------------------

let camera: FakeCamera | null = null
let adapter: OnvifAdapter | null = null

afterEach(async () => {
  await adapter?.shutdown()
  adapter = null
  camera?.close()
  camera = null
})

function options(extra: OnvifOptions = {}): OnvifOptions {
  return {
    discoveryTargets: [{ address: '127.0.0.1', port: camera!.discoveryPort }],
    probeMs: 250,
    requestTimeoutMs: 1500,
    pullSeconds: 1,
    retryMs: 150,
    cooldownMs: 10,
    moveMs: 60,
    offlineAfter: 2,
    ...extra,
  }
}

async function started(shape: Partial<CameraShape> = {}, config: Record<string, unknown> = { username: USER, password: PASSWORD }, extra: OnvifOptions = {}) {
  camera = await new FakeCamera(shape).start()
  const context = recordingContext()
  adapter = new OnvifAdapter(options(extra))
  await adapter.init(context, config)
  return context
}

const leaks = (context: RecordingContext, ...more: unknown[]) =>
  JSON.stringify([context.states, context.events, context.logs, context.discovered, adapter!.status(), ...more]).includes(PASSWORD)

describe('finding cameras', () => {
  test('a camera answering the probe is found, named, described, and its password stays in the hub', async () => {
    const context = await started()
    const devices = await adapter!.discover([])
    expect(devices).toHaveLength(1)
    const device = devices[0]!
    expect(device).toMatchObject({
      adapterId: 'onvif',
      nativeId: camera!.uuid,
      uid: `onvif:${camera!.uuid}`,
      name: 'Reolink Video Doorbell',
      category: 'camera',
      manufacturer: 'Reolink',
      model: 'Reolink Video Doorbell PoE',
      firmwareVersion: 'v3.0.0.2033',
      network: { ip: '127.0.0.1' },
    })
    expect(device.capabilities.sort()).toEqual(['camera', 'doorbell', 'motion'])
    expect(device.requiresPairing ?? null).toBeNull()

    const state = await adapter!.getState(device.nativeId)
    expect(state).toMatchObject({
      streaming: false,
      recording: false,
      streamUrl: 'rtsp://127.0.0.1:554/h264Preview_01_main',
      snapshotUrl: `/api/cameras/onvif/${encodeURIComponent(device.nativeId)}/snapshot`,
    })
    expect(leaks(context, devices, state)).toBe(false)
  })

  test('tokens are dated on the camera clock, two hours ahead of ours', async () => {
    await started({ clockOffsetMs: 2 * 3600_000 })
    const [device] = await adapter!.discover([])
    expect(device?.requiresPairing ?? null).toBeNull()
    expect(device?.manufacturer).toBe('Reolink')
  })

  test('a refused password: the camera waits for its login, said in French, and pairing fixes it', async () => {
    const context = await started({}, { username: USER, password: 'wrong' })
    const [device] = await adapter!.discover([])
    expect(device?.requiresPairing?.kind).toBe('token')
    expect(device?.requiresPairing?.instructions).toMatch(/mot de passe/i)
    expect(adapter!.status().health).toBe('degraded')

    const paired = await adapter!.pair({ nativeId: device!.nativeId, username: USER, password: PASSWORD })
    expect(paired.ok).toBe(true)
    expect(paired.device?.requiresPairing ?? null).toBeNull()
    expect(paired.device?.capabilities).toContain('camera')
    expect(paired.message).not.toContain(PASSWORD)
    expect(adapter!.status().health).toBe('ok')
    expect(leaks(context, paired)).toBe(false)
  })

  test('pairing from the settings form tries its login on every camera waiting for one', async () => {
    const context = await started({}, { username: USER, password: 'wrong' })
    const [device] = await adapter!.discover([])
    expect(device?.requiresPairing).toBeTruthy()
    const refused = await adapter!.pair({ username: USER, password: 'still-wrong' })
    expect(refused.ok).toBe(false)
    expect(refused.message).toMatch(/refuse/)
    const paired = await adapter!.pair({ username: USER, password: PASSWORD, hosts: '' })
    expect(paired.ok).toBe(true)
    expect(paired.message).toMatch(/1 caméra/)
    expect(paired.device?.nativeId).toBe(device!.nativeId)
    expect(adapter!.status().health).toBe('ok')
    expect(leaks(context, refused, paired)).toBe(false)
  })

  test('a blank password in the form means the one already saved', async () => {
    await started({}, { username: USER, password: PASSWORD })
    await adapter!.discover([])
    const other = await new FakeCamera().start()
    try {
      const paired = await adapter!.pair({ username: USER, password: '', hosts: `127.0.0.1:${other.port}` })
      expect(paired.ok).toBe(true)
      expect(paired.device?.nativeId).toBe(`127.0.0.1:${other.port}`)
    } finally {
      other.close()
    }
  })

  test('without any login, cameras are listed and the settings are asked for', async () => {
    await started({}, {})
    const [device] = await adapter!.discover([])
    expect(device?.requiresPairing?.instructions).toMatch(/identifiant/i)
    expect(adapter!.status().health).toBe('needs_setup')
  })

  test('a camera that ignores the probe is reached from the settings', async () => {
    camera = await new FakeCamera().start()
    adapter = new OnvifAdapter(options({ discoveryTargets: [] }))
    await adapter.init(recordingContext(), { username: USER, password: PASSWORD, hosts: `127.0.0.1:${camera.port}` })
    const [device] = await adapter.discover([])
    expect(device?.nativeId).toBe(`127.0.0.1:${camera.port}`)
    expect(device?.requiresPairing ?? null).toBeNull()
  })

  test('service addresses naming another host are brought back to the camera', async () => {
    await started({ wrongServiceHost: true })
    const [device] = await adapter!.discover([])
    expect(device?.requiresPairing ?? null).toBeNull()
    expect((await adapter!.getState(device!.nativeId)).streamUrl).toBe('rtsp://127.0.0.1:554/h264Preview_01_main')
  })

  test('a camera that wants HTTP Digest on SOAP as well', async () => {
    await started({ soapDigest: true })
    const [device] = await adapter!.discover([])
    expect(device?.requiresPairing ?? null).toBeNull()
    expect(camera!.challenges).toBeGreaterThanOrEqual(1)
  })

  test('a camera found again is the same camera', async () => {
    await started()
    const first = await adapter!.discover([])
    const second = await adapter!.discover([])
    expect(second.map((device: { nativeId: string }) => device.nativeId)).toEqual(first.map((device: { nativeId: string }) => device.nativeId))
  })
})

describe('events', () => {
  test('motion then its end; the doorbell rings once; the state at subscription is no event', async () => {
    const context = await started()
    const [device] = await adapter!.discover([])
    const id = device!.nativeId
    await eventually(() => camera!.created === 1)
    await new Promise((resolve) => setTimeout(resolve, 100))
    expect(context.stateOf(id).motion).toBe(false)
    expect(context.events.filter((event) => event.event === 'doorbell')).toHaveLength(0)

    camera!.push('tns1:RuleEngine/CellMotionDetector/Motion', { IsMotion: 'true' })
    await eventually(() => context.stateOf(id).motion === true)
    expect(typeof context.stateOf(id).lastMotionAt).toBe('string')
    expect(context.events.filter((event) => event.event === 'motion')).toHaveLength(1)
    camera!.push('tns1:RuleEngine/CellMotionDetector/Motion', { IsMotion: 'false' })
    await eventually(() => context.stateOf(id).motion === false)

    camera!.push('tns1:RuleEngine/MyRuleDetector/Visitor', { State: 'true' })
    await eventually(() => context.events.some((event) => event.event === 'doorbell'))
    expect(typeof context.stateOf(id).lastRingAt).toBe('string')
    camera!.push('tns1:RuleEngine/MyRuleDetector/Visitor', { State: 'false' })
    camera!.push('tns1:RuleEngine/MyRuleDetector/PeopleDetect', { State: 'true' })
    await eventually(() => context.stateOf(id).person === true)
    expect(context.events.filter((event) => event.event === 'doorbell')).toHaveLength(1)
    expect(context.events.some((event) => event.event === 'person')).toBe(true)
  })

  test('two topics for one movement: motion lasts until both say it ended', async () => {
    const context = await started({ doorbell: false })
    const [device] = await adapter!.discover([])
    const id = device!.nativeId
    await eventually(() => camera!.created === 1)
    camera!.push('tns1:RuleEngine/CellMotionDetector/Motion', { IsMotion: 'true' })
    camera!.push('tns1:VideoSource/MotionAlarm', { State: 'true' })
    await eventually(() => context.stateOf(id).motion === true)
    camera!.push('tns1:RuleEngine/CellMotionDetector/Motion', { IsMotion: 'false' })
    await new Promise((resolve) => setTimeout(resolve, 150))
    expect(context.stateOf(id).motion).toBe(true)
    camera!.push('tns1:VideoSource/MotionAlarm', { State: 'false' })
    await eventually(() => context.stateOf(id).motion === false)
    expect(context.events.filter((event) => event.event === 'motion')).toHaveLength(1)
  })

  test('Axis: the reference parameters come back with every pull', async () => {
    const context = await started({ axis: true })
    const [device] = await adapter!.discover([])
    await eventually(() => camera!.created === 1)
    camera!.push('tns1:RuleEngine/CellMotionDetector/Motion', { IsMotion: 'true' })
    await eventually(() => context.stateOf(device!.nativeId).motion === true)
  })

  test('a subscription the camera forgot is made again', async () => {
    const context = await started()
    const [device] = await adapter!.discover([])
    await eventually(() => camera!.created === 1 && context.stateOf(device!.nativeId).motion === false)
    camera!.forgetSubscriptions()
    await eventually(() => camera!.created === 2, 3000)
    camera!.push('tns1:RuleEngine/CellMotionDetector/Motion', { IsMotion: 'true' })
    await eventually(() => context.stateOf(device!.nativeId).motion === true, 3000)
  })

  test('the subscription is renewed before it lapses', async () => {
    await started({}, { username: USER, password: PASSWORD }, { renewMs: 200 })
    await adapter!.discover([])
    await eventually(() => camera!.renewals >= 1, 3000)
  })

  test('a camera that goes away is offline, and back once it answers', async () => {
    const context = await started()
    const [device] = await adapter!.discover([])
    const id = device!.nativeId
    await eventually(() => camera!.created === 1)
    camera!.stop()
    await eventually(() => context.availability.at(-1)?.online === false && context.availability.at(-1)?.nativeId === id, 4000)
    await camera!.start()
    await eventually(() => context.availability.at(-1)?.online === true && camera!.created === 2, 4000)
    camera!.push('tns1:RuleEngine/CellMotionDetector/Motion', { IsMotion: 'true' })
    await eventually(() => context.stateOf(id).motion === true, 3000)
  })

  test('cameras known before a restart are watched again without a new discovery', async () => {
    const context = await started()
    const [device] = await adapter!.discover([])
    await adapter!.shutdown()
    const again = new OnvifAdapter(options())
    adapter = again
    await again.init(context, { username: USER, password: PASSWORD })
    expect((await again.getState(device!.nativeId)).streamUrl).toBe('rtsp://127.0.0.1:554/h264Preview_01_main')
    await eventually(() => camera!.created === 2)
    camera!.push('tns1:RuleEngine/CellMotionDetector/Motion', { IsMotion: 'true' })
    await eventually(() => context.stateOf(device!.nativeId).motion === true, 3000)
  })

  test('shutdown unsubscribes and stops asking', async () => {
    await started()
    await adapter!.discover([])
    await eventually(() => camera!.created === 1)
    await adapter!.shutdown()
    adapter = null
    expect(camera!.unsubscribed).toBe(1)
    const calls = camera!.calls.length
    await new Promise((resolve) => setTimeout(resolve, 400))
    expect(camera!.calls.length).toBe(calls)
  })
})

describe('pictures and moves', () => {
  test('a snapshot goes through the hub behind HTTP Digest, and one challenge serves the next ones', async () => {
    await started()
    const [device] = await adapter!.discover([])
    const first = await adapter!.snapshot(device!.nativeId)
    expect(first?.contentType).toBe('image/jpeg')
    expect(Buffer.from(first!.body).equals(JPEG)).toBe(true)
    const second = await adapter!.snapshot(device!.nativeId)
    expect(Buffer.from(second!.body).equals(JPEG)).toBe(true)
    expect(camera!.challenges).toBe(1)
    expect(await adapter!.snapshot('unknown')).toBeNull()
  })

  test('the snapshot command points at the hub, recording is refused with a reason', async () => {
    await started()
    const [device] = await adapter!.discover([])
    const snapshot = await adapter!.execute(device!.nativeId, 'snapshot', {})
    expect(snapshot.ok).toBe(true)
    expect(String(snapshot.state?.snapshotUrl)).toMatch(/^\/api\/cameras\/onvif\/.+\/snapshot\?t=\d+$/)
    const recording = await adapter!.execute(device!.nativeId, 'startRecording', {})
    expect(recording.ok).toBe(false)
    expect(recording.error).toMatch(/enregistre/i)
  })

  test('PTZ: a nudge moves then stops, a zoom goes to its position', async () => {
    await started({ ptz: true })
    const [device] = await adapter!.discover([])
    const moved = await adapter!.execute(device!.nativeId, 'ptz', { pan: 0.5 })
    expect(moved.ok).toBe(true)
    expect(camera!.ptz).toEqual(['move 0.5 0', 'stop'])
    expect((await adapter!.execute(device!.nativeId, 'ptz', { zoom: 0.3 })).ok).toBe(true)
    expect(camera!.ptz.at(-1)).toBe('zoom 0.3')
  })

  test('a fixed camera says it does not move', async () => {
    await started({ ptz: false })
    const [device] = await adapter!.discover([])
    const result = await adapter!.execute(device!.nativeId, 'ptz', { pan: 0.5 })
    expect(result.ok).toBe(false)
    expect(result.error).toMatch(/PTZ/)
    expect(camera!.ptz).toEqual([])
  })
})
