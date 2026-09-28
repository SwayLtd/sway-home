/**
 * MAC vendor lookup.
 *
 * Three tiers, in this order:
 *  1. A curated table below, compiled in. Small, instant, and covers what actually turns up
 *     in a house: the bridges, the bulbs, the TVs, the ISP boxes, the phones.
 *  2. The full IEEE registry at `data/oui.csv`, if `bun run oui:fetch` has been run. Around
 *     35000 rows, loaded lazily and only once.
 *  3. Nothing. An unknown vendor is reported as unknown rather than guessed, because a
 *     confident wrong vendor sends the fingerprinter down the wrong branch.
 *
 * There is deliberately no online lookup in the default path: sending the MAC addresses of
 * everything in someone's home to a third-party API is exactly the thing this product says
 * it does not do.
 */

import { readFile } from 'node:fs/promises'

/** Prefix (first 3 octets, lowercase, colon-free) -> vendor. */
const CURATED: Record<string, string> = {
  // Espressif - the silicon under Shelly, Tasmota, WLED, Sonoff, most DIY and a lot of
  // white-label smart plugs. By far the most common "unknown" device in a smart home.
  '240ac4': 'Espressif', '30aea4': 'Espressif', '3c71bf': 'Espressif', '84f3eb': 'Espressif',
  '5ccf7f': 'Espressif', '600194': 'Espressif', 'a020a6': 'Espressif', 'b4e62d': 'Espressif',
  'bcddc2': 'Espressif', 'cc50e3': 'Espressif', 'd8f15b': 'Espressif', 'dc4f22': 'Espressif',
  'e8db84': 'Espressif', 'ecfabc': 'Espressif', 'f4cfa2': 'Espressif', '7c9ebd': 'Espressif',
  '483fda': 'Espressif', '8caab5': 'Espressif', 'c44f33': 'Espressif', '2c3ae8': 'Espressif',
  '68c63a': 'Espressif', '807d3a': 'Espressif', '10521c': 'Espressif', '40f520': 'Espressif',
  'a4cf12': 'Espressif', '4c7525': 'Espressif', '2462ab': 'Espressif', '84cca8': 'Espressif',
  '94b97e': 'Espressif', 'c82b96': 'Espressif', 'e09806': 'Espressif', 'f008d1': 'Espressif',
  '246f28': 'Espressif', '3c6105': 'Espressif', '441793': 'Espressif', '98f4ab': 'Espressif',
  'ac67b2': 'Espressif', 'd8bfc0': 'Espressif', '087d5a': 'Espressif',

  // Philips / Signify - Hue bridge and Wiz
  '001788': 'Signify (Philips Hue)', 'ecb5fa': 'Signify (Philips Hue)',
  'a8bb50': 'Signify (WiZ)', '444f8e': 'Signify (WiZ)',

  // TP-Link - Kasa, Tapo, Deco, routers
  '50c7bf': 'TP-Link', '6032b1': 'TP-Link', '98dac4': 'TP-Link', 'b0be76': 'TP-Link',
  'ac84c6': 'TP-Link', '1c3bf3': 'TP-Link', '003192': 'TP-Link', '5c628b': 'TP-Link',
  '005f67': 'TP-Link', '3c52a1': 'TP-Link', '9c5322': 'TP-Link', 'c0c9e3': 'TP-Link',
  'd80d17': 'TP-Link', 'f4f26d': 'TP-Link', '5091e3': 'TP-Link', '788cb5': 'TP-Link',

  // Sonos
  '000e58': 'Sonos', '347e5c': 'Sonos', '48a6b8': 'Sonos', '5caafd': 'Sonos',
  '7828ca': 'Sonos', 'b8e937': 'Sonos', '949f3e': 'Sonos', '38420b': 'Sonos',

  // Google / Nest
  '546009': 'Google', 'f4f5d8': 'Google', '6cadf8': 'Google', '30fd38': 'Google',
  '20dfb9': 'Google', 'd86c63': 'Google', '1cf29a': 'Google', '3c5ab4': 'Google',
  'f4f5e8': 'Google', 'a47733': 'Google', '44070b': 'Google', 'e4f042': 'Google',
  '48d6d5': 'Google', '94eb2c': 'Google', '001a11': 'Google', '7cd9f3': 'Google',

  // Amazon - Echo, Fire TV, Ring
  '44650d': 'Amazon', '6837e9': 'Amazon', '74c246': 'Amazon', 'fc65de': 'Amazon',
  'f0272d': 'Amazon', '0c47c9': 'Amazon', '50dce7': 'Amazon', '84d6d0': 'Amazon',
  'ac63be': 'Amazon', 'b47c9c': 'Amazon', '38f73d': 'Amazon', 'ccf735': 'Amazon',
  '40b4cd': 'Amazon', '6854fd': 'Amazon', '10cea9': 'Amazon', '4cefc0': 'Amazon',

  // Apple
  '000393': 'Apple', '000a27': 'Apple', '001ec2': 'Apple', '3c15c2': 'Apple',
  '90b0ed': 'Apple', 'f01898': 'Apple', 'dca904': 'Apple', '1499e2': 'Apple',
  '040cce': 'Apple', 'a483e7': 'Apple', 'acbc32': 'Apple', 'f45c89': 'Apple',
  '784f43': 'Apple', '6c4008': 'Apple', '8866a5': 'Apple', '8c8590': 'Apple',
  'd0817a': 'Apple', '9c8bf1': 'Apple', '3408bc': 'Apple', '7c0464': 'Apple',

  // Samsung
  '0012fb': 'Samsung', '5c497d': 'Samsung', '78bdbc': 'Samsung', '8425db': 'Samsung',
  'e8508b': 'Samsung', 'fc039f': 'Samsung', '0808c2': 'Samsung', '40163b': 'Samsung',
  '8c71f8': 'Samsung', 'c8ba94': 'Samsung', '2cae2b': 'Samsung', '3423ba': 'Samsung',

  // LG
  '001c62': 'LG', '2c598a': 'LG', '3ccd93': 'LG', '58a2b5': 'LG', 'a823fe': 'LG', 'cc2d8c': 'LG',

  // Xiaomi / Aqara / Lumi
  '04cf8c': 'Xiaomi', '286c07': 'Xiaomi', '34ce00': 'Xiaomi', '508f4c': 'Xiaomi',
  '640980': 'Xiaomi', '7811dc': 'Xiaomi', '8cbebe': 'Xiaomi', 'f0b429': 'Xiaomi',
  '64cc2e': 'Xiaomi', '2082c0': 'Xiaomi', '54ef44': 'Aqara (Lumi)', '788b2a': 'Aqara (Lumi)',
  '34ea34': 'Aqara (Lumi)',

  // Roku
  'b0a737': 'Roku', 'cc6da0': 'Roku', 'd83134': 'Roku', 'dc3a5e': 'Roku',
  '88dea9': 'Roku', 'ac3a7a': 'Roku',

  // Sony
  '00041f': 'Sony', '30f9ed': 'Sony', 'fc0fe6': 'Sony', '544249': 'Sony', 'ac9b0a': 'Sony',

  // Raspberry Pi
  'b827eb': 'Raspberry Pi', 'dca632': 'Raspberry Pi', 'e45f01': 'Raspberry Pi',
  '28cdc1': 'Raspberry Pi', 'd83add': 'Raspberry Pi', '2ccf67': 'Raspberry Pi',

  // Networking
  '204e7f': 'Netgear', 'a040a0': 'Netgear', '9c3dcf': 'Netgear', '4494fc': 'Netgear',
  '3c3786': 'Netgear', '245a4c': 'Ubiquiti', '44d9e7': 'Ubiquiti', '788a20': 'Ubiquiti',
  'b4fbe4': 'Ubiquiti', 'fcecda': 'Ubiquiti', '68d79a': 'Ubiquiti', '7483c2': 'Ubiquiti',
  '00040e': 'AVM (FRITZ!Box)', '3431c4': 'AVM (FRITZ!Box)', '3810d5': 'AVM (FRITZ!Box)',
  'c80e14': 'AVM (FRITZ!Box)',

  // French ISP boxes
  '0024d4': 'Freebox SAS', '140c76': 'Freebox SAS', '342792': 'Freebox SAS',
  '68a378': 'Freebox SAS', '8c97ea': 'Freebox SAS', 'f4cae5': 'Freebox SAS',
  '001e74': 'Sagemcom', '44ce7d': 'Sagemcom', '7c034c': 'Sagemcom', '880355': 'Sagemcom',
  'e45d51': 'Sagemcom', '0007cb': 'Freebox SAS',

  // NAS and storage
  '001132': 'Synology', '0011d8': 'Synology', '00089b': 'QNAP', '245ebe': 'QNAP',

  // Cameras
  '00408c': 'Axis Communications', 'accc8e': 'Axis Communications',
  '4c11bf': 'Dahua', '3c1b6e': 'Dahua', 'bcad28': 'Hangzhou Hikvision', '44191c': 'Hangzhou Hikvision',
  'c0561d': 'Hangzhou Hikvision', '18680a': 'Reolink', 'ec71db': 'Reolink',

  // Printers
  '3c2af4': 'Brother', '008077': 'Brother', '001ba9': 'Brother',
  '0017c8': 'Kyocera', '3464a9': 'HP', '9c8e99': 'HP', 'b499ba': 'HP', '2c2bf9': 'HP',
  '0000aa': 'Xerox', '002673': 'Epson', '38f32e': 'Epson', '64eb8c': 'Seiko Epson',

  // Silicon that shows up under many brands
  '001b21': 'Intel', '3c970e': 'Intel', '94659c': 'Intel', '8c1645': 'Intel',
  'a0a4c5': 'Intel', '685d43': 'Intel', '50ebf6': 'Intel', '9c305b': 'Intel',
  '001a2b': 'Ayecom/Telink', 'a4c138': 'Telink Semiconductor', '54eaa8': 'Telink Semiconductor',
  '0c8c24': 'Realtek', '001bfc': 'ASUSTek', '2c56dc': 'ASUSTek', '04d9f5': 'ASUSTek',
  'd850e6': 'ASUSTek', '1c872c': 'ASUSTek',

  // Smart home odds and ends
  '70ee50': 'Netatmo', '94103e': 'Belkin (Wemo)', 'ec1a59': 'Belkin (Wemo)', 'b4750e': 'Belkin (Wemo)',
  '68572d': 'Tuya', '10d561': 'Tuya', '508a06': 'Tuya', 'd4a651': 'Tuya', '84e342': 'Tuya',
  'cc8cbf': 'Tuya', '18de50': 'Tuya', '4c4915': 'Tuya',
  'd073d5': 'LIFX', '000b57': 'Silicon Labs (Zigbee/Z-Wave)', '588e81': 'Silicon Labs (Zigbee/Z-Wave)',
  '0015bc': 'Advantech', '842e14': 'Shelly (Allterco)', '349454': 'Shelly (Allterco)',
  '00178d': 'Zigbee Alliance', 'e8fdf8': 'Tado', '5cf370': 'Withings', '0024e4': 'Withings',
  '001e42': 'Teltonika', '28ec9a': 'Tesla', '4cfcaa': 'Tesla', '98ed5c': 'Tesla',
  'c0ee40': 'Laird (BLE gateways)', '000fd9': 'Sonos legacy',
}

/** Normalised at module load so lookups never have to think about separators. */
const CURATED_INDEX = new Map<string, string>(
  Object.entries(CURATED).map(([prefix, vendor]) => [prefix.replace(/[^0-9a-f]/gi, '').toLowerCase(), vendor])
)

let ieeeIndex: Map<string, string> | null = null
let ieeeLoadAttempted = false

async function loadIeee(path: string): Promise<void> {
  if (ieeeLoadAttempted) return
  ieeeLoadAttempted = true
  try {
    const csv = await readFile(path, 'utf8')
    const index = new Map<string, string>()
    for (const line of csv.split(/\r?\n/)) {
      // IEEE CSV: Registry,Assignment,Organization Name,Organization Address
      const match = /^MA-[LMS],([0-9A-F]{6,9}),"?([^",]+)/i.exec(line)
      if (match?.[1] && match[2]) index.set(match[1].toLowerCase(), match[2].trim())
    }
    if (index.size > 0) ieeeIndex = index
  } catch {
    // No registry file. Curated table only, which is the documented default.
  }
}

export interface OuiOptions {
  /** Path to the IEEE CSV. Absent file is fine. */
  registryPath?: string
}

export async function primeOui(options: OuiOptions = {}): Promise<{ curated: number; registry: number }> {
  if (options.registryPath) await loadIeee(options.registryPath)
  return { curated: CURATED_INDEX.size, registry: ieeeIndex?.size ?? 0 }
}

export function lookupVendor(mac: string | null | undefined): string | null {
  if (!mac) return null
  const hex = mac.replace(/[^0-9a-f]/gi, '').toLowerCase()
  if (hex.length < 6) return null

  // Locally administered addresses carry no vendor: the device randomised it on purpose.
  const firstOctet = Number.parseInt(hex.slice(0, 2), 16)
  if (Number.isFinite(firstOctet) && (firstOctet & 0b10) !== 0) return null

  const oui = hex.slice(0, 6)
  const curated = CURATED_INDEX.get(oui)
  if (curated) return curated

  if (ieeeIndex) {
    // MA-L is 6 hex digits, MA-M 7, MA-S 9. Try the longest assignment first.
    for (const length of [9, 7, 6]) {
      const found = ieeeIndex.get(hex.slice(0, length))
      if (found) return found
    }
  }

  return null
}

/** True when the address was randomised by the device for privacy. */
export function isLocallyAdministered(mac: string): boolean {
  const first = Number.parseInt(mac.replace(/[^0-9a-f]/gi, '').slice(0, 2), 16)
  return Number.isFinite(first) && (first & 0b10) !== 0
}

export function ouiStats(): { curated: number; registry: number; registryLoaded: boolean } {
  return { curated: CURATED_INDEX.size, registry: ieeeIndex?.size ?? 0, registryLoaded: ieeeIndex !== null }
}
