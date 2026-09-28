/**
 * Just enough XML for SOAP devices.
 *
 * Sonos (UPnP) and ONVIF cameras answer in SOAP, and UPnP descriptions are XML. What they
 * need is small: elements found by local name whatever their namespace prefix, their
 * attributes, entity decoding, and escaping on the way out. A full parser would be a
 * dependency for that; these regular expressions are bounded to well-formed device answers
 * and return nothing, rather than throw, on anything else.
 */

const NAMED_ENTITIES: Record<string, string> = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" }

export function decodeXml(text: string): string {
  return text.replace(/&(#x[0-9a-fA-F]+|#\d+|amp|lt|gt|quot|apos);/g, (_match, entity: string) => {
    if (entity.startsWith('#x')) return String.fromCodePoint(Number.parseInt(entity.slice(2), 16))
    if (entity.startsWith('#')) return String.fromCodePoint(Number.parseInt(entity.slice(1), 10))
    return NAMED_ENTITIES[entity] ?? `&${entity};`
  })
}

export function encodeXml(text: string): string {
  return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&apos;')
}

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

/** `<a b="1" c='2'>` -> { b: '1', c: '2' }, decoded. */
export function attributes(tag: string): Record<string, string> {
  const out: Record<string, string> = {}
  const body = tag.replace(/^<\s*[^\s/>]+/, '').replace(/\/?>$/, '')
  for (const match of body.matchAll(/([A-Za-z_:][\w:.-]*)\s*=\s*("([^"]*)"|'([^']*)')/g)) {
    out[match[1]!] = decodeXml(match[3] ?? match[4] ?? '')
  }
  return out
}

export interface XmlElement {
  attributes: Record<string, string>
  /** Raw inner XML, not decoded: it may contain further elements. */
  inner: string
}

/** Every element with this local name, any prefix, self-closing or not. Not for nesting of the same name. */
export function elements(xml: string, localName: string): XmlElement[] {
  const name = escapeRegExp(localName)
  const pattern = new RegExp(`<((?:[\\w.-]+:)?${name})(\\s[^<>]*?)?(\\/>|>([\\s\\S]*?)<\\/\\1\\s*>)`, 'g')
  const found: XmlElement[] = []
  for (const match of xml.matchAll(pattern)) {
    found.push({ attributes: attributes(`<${match[1]}${match[2] ?? ''}>`), inner: match[4] ?? '' })
  }
  return found
}

/** The decoded text of the first element with this local name; its raw inner XML if it has children. */
export function firstText(xml: string, localName: string): string | null {
  const element = elements(xml, localName)[0]
  if (!element) return null
  return /<[A-Za-z_]/.test(element.inner) ? element.inner : decodeXml(element.inner.trim())
}

/** A SOAP 1.1 request body, as UPnP devices expect it. Argument values are escaped. */
export function soapEnvelope(serviceType: string, action: string, args: Record<string, string | number | boolean>): string {
  const body = Object.entries(args)
    .map(([key, value]) => `<${key}>${encodeXml(String(value))}</${key}>`)
    .join('')
  return (
    '<?xml version="1.0" encoding="utf-8"?>' +
    '<s:Envelope xmlns:s="http://schemas.xmlsoap.org/soap/envelope/" s:encodingStyle="http://schemas.xmlsoap.org/soap/encoding/">' +
    `<s:Body><u:${action} xmlns:u="${serviceType}">${body}</u:${action}></s:Body></s:Envelope>`
  )
}

/** The fault in a SOAP answer: a UPnP error code (Sonos) or a SOAP 1.2 subcode (ONVIF). */
export function soapFault(xml: string): { code: string; message: string } | null {
  if (!/<(?:[\w.-]+:)?Fault[\s>]/.test(xml)) return null
  const upnpCode = firstText(xml, 'errorCode')
  if (upnpCode) return { code: upnpCode, message: firstText(xml, 'errorDescription') ?? firstText(xml, 'faultstring') ?? `UPnP error ${upnpCode}` }
  const subcode = elements(xml, 'Subcode')[0]
  const code = (subcode ? firstText(subcode.inner, 'Value') : null) ?? firstText(xml, 'faultcode') ?? firstText(xml, 'Value') ?? 'fault'
  const reason = elements(xml, 'Reason')[0]
  const message = (reason ? firstText(reason.inner, 'Text') : null) ?? firstText(xml, 'faultstring') ?? 'SOAP fault'
  return { code: /</.test(code) ? 'fault' : code, message }
}
