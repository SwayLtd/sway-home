/**
 * The little XML the SOAP adapters need.
 *
 * Sonos (UPnP) and ONVIF both speak SOAP, and a device description is XML. None of them
 * needs a full parser: elements by local name whatever their namespace prefix, attributes,
 * entities, and XML embedded as escaped text (Sonos's zone topology and track metadata).
 * These helpers do that and nothing more, and never throw on a malformed answer - a device
 * that returns garbage is a device that did not answer.
 */

import { describe, expect, test } from 'bun:test'
import { attributes, decodeXml, elements, encodeXml, firstText, soapEnvelope, soapFault } from '#adapters/soap_xml'

describe('reading', () => {
  test('the text of the first element, whatever its namespace prefix', () => {
    const xml = '<s:Envelope><s:Body><u:GetVolumeResponse xmlns:u="urn:x"><CurrentVolume>23</CurrentVolume></u:GetVolumeResponse></s:Body></s:Envelope>'
    expect(firstText(xml, 'CurrentVolume')).toBe('23')
    expect(firstText(xml, 'GetVolumeResponse')).toContain('<CurrentVolume>23</CurrentVolume>')
    expect(firstText(xml, 'Missing')).toBeNull()
  })

  test('entities are decoded, including numeric ones', () => {
    expect(decodeXml('Tom &amp; Jerry &lt;3 &#233;t&#xE9; &quot;x&quot; &apos;y&apos;')).toBe('Tom & Jerry <3 été "x" \'y\'')
    expect(firstText('<a>Caf&#233; &amp; Co</a>', 'a')).toBe('Café & Co')
  })

  test('every element with its attributes, self-closing or not', () => {
    const xml = '<ZoneGroups><ZoneGroup Coordinator="RINCON_A" ID="g1"><ZoneGroupMember UUID="RINCON_A" ZoneName="Salon &amp; Cuisine"/><ZoneGroupMember UUID="RINCON_B" Invisible="1"></ZoneGroupMember></ZoneGroup></ZoneGroups>'
    const members = elements(xml, 'ZoneGroupMember')
    expect(members.map((member) => member.attributes)).toEqual([
      { UUID: 'RINCON_A', ZoneName: 'Salon & Cuisine' },
      { UUID: 'RINCON_B', Invisible: '1' },
    ])
    expect(elements(xml, 'ZoneGroup')[0]!.inner).toContain('RINCON_B')
  })

  test('attributes with either quote style', () => {
    expect(attributes(`<x a="1" b='two' c = "3"/>`)).toEqual({ a: '1', b: 'two', c: '3' })
  })
})

describe('writing', () => {
  test('text is escaped for XML', () => {
    expect(encodeXml(`<b>"Tom" & 'Jerry'</b>`)).toBe('&lt;b&gt;&quot;Tom&quot; &amp; &apos;Jerry&apos;&lt;/b&gt;')
  })

  test('a SOAP 1.1 envelope with the action and its arguments, escaped', () => {
    const envelope = soapEnvelope('urn:schemas-upnp-org:service:AVTransport:1', 'Seek', { InstanceID: 0, Unit: 'REL_TIME', Target: '0:01:30' })
    expect(envelope).toContain('<s:Envelope xmlns:s="http://schemas.xmlsoap.org/soap/envelope/" s:encodingStyle="http://schemas.xmlsoap.org/soap/encoding/">')
    expect(envelope).toContain('<u:Seek xmlns:u="urn:schemas-upnp-org:service:AVTransport:1"><InstanceID>0</InstanceID><Unit>REL_TIME</Unit><Target>0:01:30</Target></u:Seek>')
    expect(soapEnvelope('urn:x', 'Set', { Meta: '<DIDL-Lite>&</DIDL-Lite>' })).toContain('<Meta>&lt;DIDL-Lite&gt;&amp;&lt;/DIDL-Lite&gt;</Meta>')
  })
})

describe('faults', () => {
  test('a UPnP error code and description', () => {
    const fault =
      '<s:Envelope><s:Body><s:Fault><faultcode>s:Client</faultcode><faultstring>UPnPError</faultstring><detail><UPnPError xmlns="urn:schemas-upnp-org:control-1-0"><errorCode>701</errorCode><errorDescription>Transition not available</errorDescription></UPnPError></detail></s:Fault></s:Body></s:Envelope>'
    expect(soapFault(fault)).toEqual({ code: '701', message: 'Transition not available' })
  })

  test('an ONVIF fault reason', () => {
    const fault = '<env:Envelope><env:Body><env:Fault><env:Code><env:Value>env:Sender</env:Value><env:Subcode><env:Value>ter:NotAuthorized</env:Value></env:Subcode></env:Code><env:Reason><env:Text xml:lang="en">Sender not Authorized</env:Text></env:Reason></env:Fault></env:Body></env:Envelope>'
    expect(soapFault(fault)).toEqual({ code: 'ter:NotAuthorized', message: 'Sender not Authorized' })
  })

  test('no fault is null', () => {
    expect(soapFault('<s:Envelope><s:Body><u:PlayResponse/></s:Body></s:Envelope>')).toBeNull()
  })
})
