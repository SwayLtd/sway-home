/**
 * Who may talk to the hub from a browser.
 *
 * The hub has no login: it trusts the house's network, like most local hubs. What it must not
 * trust is a web page. A site open in any browser on the LAN can send requests to
 * http://localhost:3333 or to the hub's LAN address, and a DNS-rebinding page can even make
 * the browser treat the hub as its own origin. Two checks close that:
 *
 *  - **Origin**: a browser names the page behind every cross-origin request (and every
 *    same-origin request that is not a GET). Only pages served from the house pass: loopback,
 *    private and link-local addresses, Tailscale's range, mDNS (`.local`) and other names
 *    that never resolve on the internet (`sway-hub`, `.lan`, `.home.arpa`...). `null` - a
 *    sandboxed frame, a file - is refused.
 *  - **Host**: a rebound page reaches the hub under the attacker's public name, so a request
 *    for a public name is refused whatever its Origin says.
 *
 * Scripts and devices send no Origin and are not affected. A public name the house really
 * uses (a reverse proxy) is listed in `HUB_ALLOWED_HOSTS`.
 */

/** Names that never resolve on the internet: mDNS, and the suffixes reserved for home networks. */
const LOCAL_SUFFIXES = ['.local', '.lan', '.home', '.home.arpa', '.internal', '.localdomain']

function privateIpv4(address: string): boolean {
  const parts = address.split('.').map(Number)
  if (parts.length !== 4 || parts.some((part) => !Number.isInteger(part) || part < 0 || part > 255)) return false
  const [a, b] = parts as [number, number, number, number]
  return (
    a === 127 ||
    a === 10 ||
    (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && b === 168) ||
    (a === 169 && b === 254) ||
    // Carrier-grade NAT, where Tailscale puts every machine of a tailnet.
    (a === 100 && b >= 64 && b <= 127)
  )
}

function privateIpv6(address: string): boolean {
  const lower = address.toLowerCase()
  if (lower === '::1') return true
  const mapped = /^::ffff:(\d{1,3}(?:\.\d{1,3}){3})$/.exec(lower)
  if (mapped) return privateIpv4(mapped[1]!)
  // fc00::/7 (unique local) and fe80::/10 (link-local).
  return /^f[cd][0-9a-f]{2}:/.test(lower) || /^fe[89ab][0-9a-f]:/.test(lower)
}

/** A host name, without port or brackets, is the house's own. */
function localName(hostname: string, allowed: string[]): boolean {
  const name = hostname.toLowerCase().replace(/\.$/, '')
  if (!name) return false
  if (allowed.some((entry) => entry.toLowerCase() === name)) return true
  if (name === 'localhost') return true
  if (/^\d{1,3}(\.\d{1,3}){3}$/.test(name)) return privateIpv4(name)
  if (name.includes(':')) return privateIpv6(name)
  // A single label ("sway-hub") only resolves through the LAN's own DNS or hosts file.
  if (!name.includes('.')) return /^[a-z0-9-]+$/.test(name)
  return LOCAL_SUFFIXES.some((suffix) => name.endsWith(suffix))
}

/** Names from HUB_ALLOWED_HOSTS, comma separated. */
export function configuredHosts(): string[] {
  return (process.env.HUB_ALLOWED_HOSTS ?? '')
    .split(',')
    .map((entry) => entry.trim())
    .filter(Boolean)
}

export function isAllowedOrigin(origin: string, allowed: string[] = configuredHosts()): boolean {
  let url: URL
  try {
    url = new URL(origin)
  } catch {
    return false
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') return false
  return localName(url.hostname.replace(/^\[|\]$/g, ''), allowed)
}

/** The Host header, "name:port" or "[v6]:port". Absent is fine: every browser sends one. */
export function isAllowedHost(host: string | undefined, allowed: string[] = configuredHosts()): boolean {
  if (host === undefined) return true
  const match = /^\[([^\]]+)\](?::\d+)?$/.exec(host) ?? /^([^:]*)(?::\d+)?$/.exec(host)
  return !!match && localName(match[1]!, allowed)
}

/** Why a request must be refused, or null when it may go on. */
export function refusal(headers: { origin?: string; host?: string }, allowed: string[] = configuredHosts()): string | null {
  if (!isAllowedHost(headers.host, allowed)) return `Requête refusée : le hub ne répond pas sous le nom d'hôte "${headers.host}".`
  if (headers.origin !== undefined && !isAllowedOrigin(headers.origin, allowed)) {
    return `Requête refusée : une page d'une autre origine (${headers.origin}) ne peut pas commander la maison.`
  }
  return null
}
