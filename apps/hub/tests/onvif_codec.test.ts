/**
 * ONVIF, the parts that do not need a camera.
 *
 * Cameras answer a WS-Discovery probe (UDP multicast 239.255.255.250:3702) with their device
 * service address; after that everything is SOAP 1.2 over HTTP, authenticated with a
 * WS-Security UsernameToken whose password digest is SHA-1(nonce + created + password), the
 * "created" time being the camera's clock (hence GetSystemDateAndTime first). Some cameras
 * also want HTTP Digest, snapshots almost always.
 *
 * Events come by pulling: a PullPoint subscription, then PullMessages in a long poll. Their
 * topics say what happened (tns1:RuleEngine/CellMotionDetector/Motion, Reolink's
 * MyRuleDetector/PeopleDetect or Visitor for the doorbell button...), their first data item
 * whether it started or stopped.
 *
 * Sources: ONVIF Core Specification and Application Programmer's Guide (the digest example
 * below is its own), RFC 2617 (digest example), WS-Discovery 1.0, onvif_parsers 2.3 (the event
 * topics Home Assistant knows).
 */

import { describe, expect, test } from 'bun:test'
import {
  ACTIONS,
  BODIES,
  classifyEvent,
  digestAuthorization,
  parseCapabilities,
  parseDeviceInformation,
  parseDigestChallenge,
  parseNotifications,
  parseProbeMatches,
  parseProfiles,
  parseSubscription,
  parseSystemDateAndTime,
  parseUri,
  passwordDigest,
  pickProfiles,
  probeMessage,
  rebaseXaddr,
  soapRequest,
  topicKinds,
  withoutCredentials,
} from '#adapters/onvif_codec'
import { createHash } from 'node:crypto'

const envelope = (body: string) =>
  `<?xml version="1.0" encoding="UTF-8"?><SOAP-ENV:Envelope xmlns:SOAP-ENV="http://www.w3.org/2003/05/soap-envelope" xmlns:tt="http://www.onvif.org/ver10/schema" xmlns:tds="http://www.onvif.org/ver10/device/wsdl" xmlns:trt="http://www.onvif.org/ver10/media/wsdl" xmlns:tev="http://www.onvif.org/ver10/events/wsdl" xmlns:wsnt="http://docs.oasis-open.org/wsn/b-2" xmlns:wsa5="http://www.w3.org/2005/08/addressing" xmlns:tns1="http://www.onvif.org/ver10/topics"><SOAP-ENV:Body>${body}</SOAP-ENV:Body></SOAP-ENV:Envelope>`

describe('finding cameras', () => {
  test('a probe for network video transmitters', () => {
    const probe = probeMessage('uuid:1234')
    expect(probe).toContain('<w:MessageID>uuid:1234</w:MessageID>')
    expect(probe).toContain('http://schemas.xmlsoap.org/ws/2005/04/discovery/Probe')
    expect(probe).toContain('<d:Types>dn:NetworkVideoTransmitter</d:Types>')
  })

  test('each match gives its service address, its name and its hardware', () => {
    const answer = `<?xml version="1.0"?><SOAP-ENV:Envelope xmlns:SOAP-ENV="http://www.w3.org/2003/05/soap-envelope" xmlns:wsa="http://schemas.xmlsoap.org/ws/2004/08/addressing" xmlns:d="http://schemas.xmlsoap.org/ws/2005/04/discovery"><SOAP-ENV:Body><d:ProbeMatches><d:ProbeMatch><wsa:EndpointReference><wsa:Address>urn:uuid:2419d68a-2dd2-21b2-a205-ec71dbd2c4a7</wsa:Address></wsa:EndpointReference><d:Types>dn:NetworkVideoTransmitter tds:Device</d:Types><d:Scopes>onvif://www.onvif.org/type/video_encoder onvif://www.onvif.org/name/Reolink%20Video%20Doorbell onvif://www.onvif.org/hardware/D340P onvif://www.onvif.org/location/country/france</d:Scopes><d:XAddrs>http://192.168.1.70:8000/onvif/device_service http://[fe80::1]:8000/onvif/device_service</d:XAddrs><d:MetadataVersion>1</d:MetadataVersion></d:ProbeMatch></d:ProbeMatches></SOAP-ENV:Body></SOAP-ENV:Envelope>`
    expect(parseProbeMatches(answer)).toEqual([
      {
        address: 'urn:uuid:2419d68a-2dd2-21b2-a205-ec71dbd2c4a7',
        xaddrs: ['http://192.168.1.70:8000/onvif/device_service', 'http://[fe80::1]:8000/onvif/device_service'],
        name: 'Reolink Video Doorbell',
        hardware: 'D340P',
      },
    ])
  })
})

describe('authentication', () => {
  test("the WS-Security digest, on the ONVIF programmer's guide own example", () => {
    expect(passwordDigest(Buffer.from('LKqI6G/AikKCQrN0zqZFlg==', 'base64'), '2010-09-16T07:50:45Z', 'userpassword')).toBe('tuOSpGlFlIXsozq4HFNeeGeFLEI=')
  })

  test('a request carries the token when there is a user, dated by the camera clock', () => {
    const request = soapRequest(BODIES.getDeviceInformation, {
      username: 'admin',
      password: 'secret',
      now: new Date('2026-09-26T10:00:00.123Z'),
      nonce: Buffer.alloc(16, 7),
    })
    expect(request).toContain('<Username>admin</Username>')
    expect(request).toContain('<Created xmlns="http://docs.oasis-open.org/wss/2004/01/oasis-200401-wss-wssecurity-utility-1.0.xsd">2026-09-26T10:00:00Z</Created>')
    expect(request).toContain(passwordDigest(Buffer.alloc(16, 7), '2026-09-26T10:00:00Z', 'secret'))
    expect(request).not.toContain('secret')
    expect(soapRequest(BODIES.getSystemDateAndTime, {})).not.toContain('Security')
  })

  test('user names are escaped, and event requests carry their addressing headers', () => {
    expect(soapRequest(BODIES.getProfiles, { username: 'a<b', password: 'x', nonce: Buffer.alloc(16) })).toContain('<Username>a&lt;b</Username>')
    const pull = soapRequest(BODIES.pullMessages(60, 100), { to: 'http://192.168.1.70:8000/onvif/Subscription?Idx=3', action: ACTIONS.pullMessages })
    expect(pull).toContain('<wsa:To>http://192.168.1.70:8000/onvif/Subscription?Idx=3</wsa:To>')
    expect(pull).toContain(`<wsa:Action>${ACTIONS.pullMessages}</wsa:Action>`)
    expect(pull).toContain('<tev:Timeout>PT1M</tev:Timeout>')
    expect(BODIES.createPullPointSubscription(600)).toContain('<tev:InitialTerminationTime>PT10M</tev:InitialTerminationTime>')
    expect(BODIES.renew(90)).toContain('<wsnt:TerminationTime>PT1M30S</wsnt:TerminationTime>')
  })

  test('HTTP Digest, on the RFC 2617 example', () => {
    const challenge = parseDigestChallenge('Digest realm="testrealm@host.com", qop="auth,auth-int", nonce="dcd98b7102dd2f0e8b11d0f600bfb0c093", opaque="5ccc069c403ebaf9f0171e9517f40e41"')
    expect(challenge).toEqual({ realm: 'testrealm@host.com', nonce: 'dcd98b7102dd2f0e8b11d0f600bfb0c093', qop: 'auth', opaque: '5ccc069c403ebaf9f0171e9517f40e41', algorithm: 'MD5' })
    const header = digestAuthorization({ method: 'GET', uri: '/dir/index.html', username: 'Mufasa', password: 'Circle Of Life', challenge: challenge!, nc: 1, cnonce: '0a4f113b' })
    expect(header).toContain('response="6629fae49393a05397450978507c4ef1"')
    expect(header).toContain('nc=00000001')
    expect(header).toContain('opaque="5ccc069c403ebaf9f0171e9517f40e41"')
    expect(parseDigestChallenge('Basic realm="x"')).toBeNull()
  })

  test('HTTP Digest with SHA-256, on the RFC 7616 example, even after a Basic challenge in the same header', () => {
    const challenge = parseDigestChallenge(
      'Basic realm="camera", Digest realm="http-auth@example.org", qop="auth, auth-int", algorithm=SHA-256, nonce="7ypf/xlj9XXwfDPEoM4URrv/xwf94BcCAzFZH4GiTo0v", opaque="FQhe/qaU925kfnzjCev0ciny7QMkPqMAFRtzCUYo5tdS"'
    )
    expect(challenge?.algorithm).toBe('SHA-256')
    expect(challenge?.realm).toBe('http-auth@example.org')
    const input = { method: 'GET', uri: '/dir/index.html', username: 'Mufasa', password: 'Circle of Life', nc: 1, cnonce: 'f2/wE4q74E6zIJEtWaHKaf5wv/H5QzzpXusqGemxURZJ' }
    expect(digestAuthorization({ ...input, challenge: challenge! })).toContain('response="753927fa0e85d155564e2e272a28d1802ca10daf4496794697cf8db5856cb6c1"')
    expect(digestAuthorization({ ...input, challenge: { ...challenge!, algorithm: 'MD5' } })).toContain('response="8ca523f5e9506fed4657c9700eebdbec"')
    expect(parseDigestChallenge('Digest realm="x", nonce="n", algorithm=SHA-512-256')).toBeNull()
  })

  test('HTTP Digest without qop, the old way some cameras still ask for', () => {
    const md5 = (text: string) => createHash('md5').update(text).digest('hex')
    const challenge = parseDigestChallenge('Digest realm="IP Camera", nonce="abc123"')
    expect(challenge).toEqual({ realm: 'IP Camera', nonce: 'abc123', qop: null, opaque: null, algorithm: 'MD5' })
    const header = digestAuthorization({ method: 'GET', uri: '/snap.jpg', username: 'admin', password: 'pw', challenge: challenge!, nc: 1, cnonce: 'c' })
    expect(header).toContain(`response="${md5(`${md5('admin:IP Camera:pw')}:abc123:${md5('GET:/snap.jpg')}`)}"`)
    expect(header).not.toContain('nc=')
  })
})

describe('what the camera says about itself', () => {
  test('its clock, to date the tokens', () => {
    const xml = envelope(
      '<tds:GetSystemDateAndTimeResponse><tds:SystemDateAndTime><tt:DateTimeType>NTP</tt:DateTimeType><tt:UTCDateTime><tt:Time><tt:Hour>9</tt:Hour><tt:Minute>58</tt:Minute><tt:Second>30</tt:Second></tt:Time><tt:Date><tt:Year>2026</tt:Year><tt:Month>9</tt:Month><tt:Day>26</tt:Day></tt:Date></tt:UTCDateTime></tds:SystemDateAndTime></tds:GetSystemDateAndTimeResponse>'
    )
    expect(parseSystemDateAndTime(xml)?.toISOString()).toBe('2026-09-26T09:58:30.000Z')
  })

  test('who made it, and which services it has', () => {
    expect(
      parseDeviceInformation(
        envelope('<tds:GetDeviceInformationResponse><tds:Manufacturer>Reolink</tds:Manufacturer><tds:Model>Reolink Video Doorbell PoE</tds:Model><tds:FirmwareVersion>v3.0.0.2033</tds:FirmwareVersion><tds:SerialNumber>00000000000000</tds:SerialNumber><tds:HardwareId>DB_566128M5MP_P</tds:HardwareId></tds:GetDeviceInformationResponse>')
      )
    ).toEqual({ manufacturer: 'Reolink', model: 'Reolink Video Doorbell PoE', firmware: 'v3.0.0.2033', serial: '00000000000000', hardware: 'DB_566128M5MP_P' })
    const capabilities = envelope(
      '<tds:GetCapabilitiesResponse><tds:Capabilities><tt:Device><tt:XAddr>http://192.168.1.70:8000/onvif/device_service</tt:XAddr></tt:Device><tt:Events><tt:XAddr>http://192.168.1.70:8000/onvif/event_service</tt:XAddr><tt:WSPullPointSupport>true</tt:WSPullPointSupport></tt:Events><tt:Media><tt:XAddr>http://192.168.1.70:8000/onvif/media_service</tt:XAddr></tt:Media><tt:PTZ><tt:XAddr>http://192.168.1.70:8000/onvif/ptz_service</tt:XAddr></tt:PTZ></tds:Capabilities></tds:GetCapabilitiesResponse>'
    )
    expect(parseCapabilities(capabilities)).toEqual({
      media: 'http://192.168.1.70:8000/onvif/media_service',
      ptz: 'http://192.168.1.70:8000/onvif/ptz_service',
      events: 'http://192.168.1.70:8000/onvif/event_service',
    })
  })

  test('its profiles: the sharpest for watching, the lightest for thumbnails', () => {
    const xml = envelope(
      '<trt:GetProfilesResponse>' +
        '<trt:Profiles token="000" fixed="true"><tt:Name>mainStream</tt:Name><tt:VideoEncoderConfiguration token="000"><tt:Encoding>H264</tt:Encoding><tt:Resolution><tt:Width>2560</tt:Width><tt:Height>1920</tt:Height></tt:Resolution></tt:VideoEncoderConfiguration><tt:PTZConfiguration token="ptz0"><tt:Name>ptz</tt:Name></tt:PTZConfiguration></trt:Profiles>' +
        '<trt:Profiles token="001" fixed="true"><tt:Name>subStream</tt:Name><tt:VideoEncoderConfiguration token="001"><tt:Encoding>H264</tt:Encoding><tt:Resolution><tt:Width>640</tt:Width><tt:Height>480</tt:Height></tt:Resolution></tt:VideoEncoderConfiguration></trt:Profiles>' +
        '</trt:GetProfilesResponse>'
    )
    const profiles = parseProfiles(xml)
    expect(profiles).toEqual([
      { token: '000', name: 'mainStream', width: 2560, height: 1920, encoding: 'H264', ptz: true },
      { token: '001', name: 'subStream', width: 640, height: 480, encoding: 'H264', ptz: false },
    ])
    expect(pickProfiles(profiles)).toEqual({ main: profiles[0], sub: profiles[1] })
    expect(pickProfiles([])).toEqual({ main: null, sub: null })
    const jpeg = { token: '002', name: 'jpeg', width: 3840, height: 2160, encoding: 'JPEG', ptz: false }
    expect(pickProfiles([jpeg, profiles[1]!])).toEqual({ main: profiles[1], sub: null })
    expect(pickProfiles([jpeg])).toEqual({ main: jpeg, sub: null })
  })

  test('a service address that names another host is brought back to the camera we reached', () => {
    expect(rebaseXaddr('http://10.0.0.5:8000/onvif/media_service', 'http://192.168.1.70:8000/onvif/device_service')).toBe('http://192.168.1.70:8000/onvif/media_service')
    expect(rebaseXaddr('http://192.168.1.70/onvif/Subscription?Idx=3', 'http://192.168.1.70:8000/onvif/device_service')).toBe('http://192.168.1.70/onvif/Subscription?Idx=3')
    expect(rebaseXaddr('not a url', 'http://192.168.1.70/onvif/device_service')).toBe('not a url')
  })

  test('request bodies escape tokens and write velocities as the camera expects', () => {
    expect(BODIES.getStreamUri('a&b')).toContain('<trt:ProfileToken>a&amp;b</trt:ProfileToken>')
    expect(BODIES.getStreamUri('000')).toContain('<tt:Stream>RTP-Unicast</tt:Stream><tt:Transport><tt:Protocol>RTSP</tt:Protocol></tt:Transport>')
    const move = BODIES.continuousMove('000', { pan: 0.5, tilt: -0.25 })
    expect(move).toContain('<tt:PanTilt x="0.5" y="-0.25"/>')
    expect(move).not.toContain('Zoom')
    expect(BODIES.absoluteZoom('000', 0.3)).toContain('<tptz:Position><tt:Zoom x="0.3"/></tptz:Position>')
    expect(BODIES.stop('000')).toContain('<tptz:PanTilt>true</tptz:PanTilt><tptz:Zoom>true</tptz:Zoom>')
  })

  test('stream and snapshot addresses; a password written into one never goes further', () => {
    expect(parseUri(envelope('<trt:GetStreamUriResponse><trt:MediaUri><tt:Uri>rtsp://192.168.1.70:554/h264Preview_01_main</tt:Uri><tt:Timeout>PT60S</tt:Timeout></trt:MediaUri></trt:GetStreamUriResponse>'))).toBe(
      'rtsp://192.168.1.70:554/h264Preview_01_main'
    )
    expect(parseUri(envelope('<trt:GetSnapshotUriResponse><trt:MediaUri><tt:Uri>http://192.168.1.70/cgi-bin/api.cgi?cmd=Snap&amp;channel=0</tt:Uri></trt:MediaUri></trt:GetSnapshotUriResponse>'))).toBe(
      'http://192.168.1.70/cgi-bin/api.cgi?cmd=Snap&channel=0'
    )
    expect(withoutCredentials('rtsp://admin:secret@192.168.1.70:554/stream1')).toBe('rtsp://192.168.1.70:554/stream1')
    expect(withoutCredentials('http://192.168.1.70/snap.jpg?user=admin&password=secret&channel=1')).toBe('http://192.168.1.70/snap.jpg?channel=1')
  })
})

describe('events', () => {
  test('the subscription address to pull from', () => {
    const xml = envelope(
      '<tev:CreatePullPointSubscriptionResponse><tev:SubscriptionReference><wsa5:Address>http://192.168.1.70:8000/onvif/Subscription?Idx=3</wsa5:Address></tev:SubscriptionReference><wsnt:CurrentTime>2026-09-26T10:00:00Z</wsnt:CurrentTime><wsnt:TerminationTime>2026-09-26T10:10:00Z</wsnt:TerminationTime></tev:CreatePullPointSubscriptionResponse>'
    )
    expect(parseSubscription(xml)).toEqual({ address: 'http://192.168.1.70:8000/onvif/Subscription?Idx=3', terminationTime: new Date('2026-09-26T10:10:00Z'), referenceParameters: '' })
  })

  test('reference parameters (Axis, Pelco) go back in the header of every call to the subscription', () => {
    const axis = envelope(
      '<tev:CreatePullPointSubscriptionResponse><tev:SubscriptionReference><wsa5:Address>http://192.168.1.71/onvif/services</wsa5:Address><wsa5:ReferenceParameters><dom0:SubscriptionId xmlns:dom0="http://www.axis.com/2009/event">0</dom0:SubscriptionId></wsa5:ReferenceParameters></tev:SubscriptionReference><wsnt:TerminationTime>2026-09-26T10:10:00Z</wsnt:TerminationTime></tev:CreatePullPointSubscriptionResponse>'
    )
    const subscription = parseSubscription(axis)!
    expect(subscription.referenceParameters).toBe('<dom0:SubscriptionId xmlns:dom0="http://www.axis.com/2009/event" wsa:IsReferenceParameter="true">0</dom0:SubscriptionId>')
    const pull = soapRequest(BODIES.pullMessages(60, 100), { to: subscription.address, action: ACTIONS.pullMessages, referenceParameters: subscription.referenceParameters })
    expect(pull).toContain('<s:Header><wsa:MessageID>')
    expect(pull).toContain(subscription.referenceParameters)

    const declaredAbove = envelope(
      '<tev:CreatePullPointSubscriptionResponse><tev:SubscriptionReference><wsa5:Address>http://192.168.1.72/onvif/events</wsa5:Address><wsa5:ReferenceParameters><tev:SubscriptionId>5</tev:SubscriptionId><SubscriptionId xmlns="urn:schemas-pelco-com:ws:addressing:1" MustUnderstand="1">urn:uuid:e526</SubscriptionId></wsa5:ReferenceParameters></tev:SubscriptionReference></tev:CreatePullPointSubscriptionResponse>'
    )
    expect(parseSubscription(declaredAbove)!.referenceParameters).toBe(
      '<tev:SubscriptionId xmlns:tev="http://www.onvif.org/ver10/events/wsdl" wsa:IsReferenceParameter="true">5</tev:SubscriptionId>' +
        '<SubscriptionId xmlns="urn:schemas-pelco-com:ws:addressing:1" MustUnderstand="1" wsa:IsReferenceParameter="true">urn:uuid:e526</SubscriptionId>'
    )
    expect(parseSubscription(envelope('<tev:CreatePullPointSubscriptionResponse/>'))).toBeNull()
  })

  const message = (topic: string, name: string, value: string, operation = 'Changed') =>
    `<wsnt:NotificationMessage><wsnt:Topic Dialect="http://www.onvif.org/ver10/tev/topicExpression/ConcreteSet">${topic}</wsnt:Topic><wsnt:Message><tt:Message UtcTime="2026-09-26T10:00:05Z" PropertyOperation="${operation}"><tt:Source><tt:SimpleItem Name="Source" Value="000"/></tt:Source><tt:Data><tt:SimpleItem Name="${name}" Value="${value}"/></tt:Data></tt:Message></wsnt:Message></wsnt:NotificationMessage>`

  test('pulled messages: topic, source, data, and whether it is the initial state', () => {
    const xml = envelope(
      `<tev:PullMessagesResponse><tev:CurrentTime>2026-09-26T10:00:06Z</tev:CurrentTime><tev:TerminationTime>2026-09-26T10:10:06Z</tev:TerminationTime>${message('tns1:RuleEngine/CellMotionDetector/Motion', 'IsMotion', 'true')}${message('tns1:RuleEngine/MyRuleDetector/Visitor', 'State', 'false', 'Initialized')}</tev:PullMessagesResponse>`
    )
    expect(parseNotifications(xml)).toEqual([
      { topic: 'tns1:RuleEngine/CellMotionDetector/Motion', source: { Source: '000' }, data: { IsMotion: 'true' }, operation: 'Changed', time: '2026-09-26T10:00:05Z' },
      { topic: 'tns1:RuleEngine/MyRuleDetector/Visitor', source: { Source: '000' }, data: { State: 'false' }, operation: 'Initialized', time: '2026-09-26T10:00:05Z' },
    ])
    expect(parseNotifications(envelope('<tev:PullMessagesResponse><tev:CurrentTime>x</tev:CurrentTime></tev:PullMessagesResponse>'))).toEqual([])
  })

  test('what each topic means', () => {
    const event = (topic: string, data: Record<string, string>) => ({ topic, source: {}, data, operation: 'Changed' as const, time: null })
    expect(classifyEvent(event('tns1:RuleEngine/CellMotionDetector/Motion', { IsMotion: 'true' }))).toEqual({ kind: 'motion', active: true })
    expect(classifyEvent(event('tns1:VideoSource/MotionAlarm', { State: 'false' }))).toEqual({ kind: 'motion', active: false })
    expect(classifyEvent(event('tns1:RuleEngine/MyRuleDetector/PeopleDetect', { State: 'true' }))).toEqual({ kind: 'person', active: true })
    expect(classifyEvent(event('tns1:RuleEngine/MyRuleDetector/VehicleDetect', { State: 'true' }))).toEqual({ kind: 'vehicle', active: true })
    expect(classifyEvent(event('tns1:RuleEngine/MyRuleDetector/DogCatDetect', { State: 'true' }))).toEqual({ kind: 'animal', active: true })
    expect(classifyEvent(event('tns1:RuleEngine/MyRuleDetector/Visitor', { State: 'true' }))).toEqual({ kind: 'doorbell', active: true })
    expect(classifyEvent(event('tns1:RuleEngine/TamperDetector/Tamper', { IsTamper: 'true' }))).toEqual({ kind: 'tamper', active: true })
    expect(classifyEvent(event('tns1:Monitoring/ProcessorUsage', { Value: '12' }))).toBeNull()
  })

  test('the topics a camera can raise tell what it is before anything happens', () => {
    const description = (items: string) => `<tt:MessageDescription IsProperty="true"><tt:Source><tt:SimpleItemDescription Name="VideoSourceConfigurationToken" Type="tt:ReferenceToken"/></tt:Source><tt:Data>${items}</tt:Data></tt:MessageDescription>`
    const doorbell = envelope(
      '<tev:GetEventPropertiesResponse><tev:TopicNamespaceLocation>http://www.onvif.org/onvif/ver10/topics/topicns.xml</tev:TopicNamespaceLocation><wsnt:FixedTopicSet>true</wsnt:FixedTopicSet>' +
        '<wstop:TopicSet xmlns:wstop="http://docs.oasis-open.org/wsn/t-1"><tns1:RuleEngine wstop:topic="false">' +
        `<CellMotionDetector wstop:topic="false"><Motion wstop:topic="true">${description('<tt:SimpleItemDescription Name="IsMotion" Type="xs:boolean"/>')}</Motion></CellMotionDetector>` +
        `<MyRuleDetector wstop:topic="false"><Visitor wstop:topic="true">${description('<tt:SimpleItemDescription Name="State" Type="xs:boolean"/>')}</Visitor><PeopleDetect wstop:topic="true">${description('<tt:SimpleItemDescription Name="State" Type="xs:boolean"/>')}</PeopleDetect></MyRuleDetector>` +
        '</tns1:RuleEngine><tns1:Monitoring wstop:topic="false"><ProcessorUsage wstop:topic="true"/></tns1:Monitoring></wstop:TopicSet></tev:GetEventPropertiesResponse>'
    )
    expect(topicKinds(doorbell).sort()).toEqual(['doorbell', 'motion', 'person'])
    const tapo = envelope(
      `<tev:GetEventPropertiesResponse><wstop:TopicSet xmlns:wstop="http://docs.oasis-open.org/wsn/t-1"><tns1:RuleEngine><TPSmartEventDetector><TPSmartEvent wstop:topic="true">${description('<tt:SimpleItemDescription Name="IsVehicle" Type="xs:boolean"/>')}</TPSmartEvent></TPSmartEventDetector></tns1:RuleEngine></wstop:TopicSet></tev:GetEventPropertiesResponse>`
    )
    expect(topicKinds(tapo)).toEqual(['vehicle'])
    expect(topicKinds(envelope('<tev:GetEventPropertiesResponse/>'))).toEqual([])
    expect(BODIES.getEventProperties).toContain('<tev:GetEventProperties')
  })

  test('vendors that say it another way', () => {
    const event = (topic: string, data: Record<string, string>) => ({ topic, source: {}, data, operation: 'Changed' as const, time: null })
    expect(classifyEvent(event('tns1:RuleEngine/TPSmartEventDetector/TPSmartEvent', { IsVehicle: 'true' }))).toEqual({ kind: 'vehicle', active: true })
    expect(classifyEvent(event('tns1:RuleEngine/PeopleDetector/People', { IsPeople: 'false' }))).toEqual({ kind: 'person', active: false })
    expect(classifyEvent(event('tns1:UserAlarm/IVA/HumanShapeDetect', { State: 'true' }))).toEqual({ kind: 'person', active: true })
    expect(classifyEvent(event('tns1:RuleEngine/FieldDetector/ObjectsInside', { IsInside: 'true' }))).toEqual({ kind: 'motion', active: true })
    expect(classifyEvent(event('tns1:Device/Trigger/DigitalInput', { InputToken: '1', LogicalState: 'true' }))).toEqual({ kind: 'input', active: true })
    expect(classifyEvent(event('tnsaxis:CameraApplicationPlatform/VMD/Camera1ProfileANY', { active: '1' }))).toEqual({ kind: 'motion', active: true })
    expect(classifyEvent(event('tns1:RuleEngine/MyRuleDetector/Package', { State: 'true' }))).toEqual({ kind: 'package', active: true })
    // "Monitoring" ends in "ring" and is still not a doorbell; a relay is our output, not an event.
    expect(classifyEvent(event('tns1:Monitoring/OperatingTime/LastReset', { Status: 'true' }))).toBeNull()
    expect(classifyEvent(event('tns1:Device/Trigger/Relay', { LogicalState: 'active' }))).toBeNull()
    expect(classifyEvent(event('tns1:RuleEngine/LineDetector/Crossed', { ObjectId: '12' }))).toBeNull()
  })
})
