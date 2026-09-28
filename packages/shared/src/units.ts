/**
 * Canonical units.
 *
 * Every adapter converts into these on the way in and out of the hub. The agent, the
 * automation engine and the UI therefore only ever see one unit per physical quantity,
 * whatever the device reported. Conversions live here so that a wrong factor is a single
 * failing test rather than a bug spread across twenty adapters.
 */

export const UNITS = {
  celsius: '°C',
  percent: '%',
  lux: 'lx',
  kelvin: 'K',
  watt: 'W',
  kilowattHour: 'kWh',
  volt: 'V',
  ampere: 'A',
  hertz: 'Hz',
  ppm: 'ppm',
  microgramPerCubicMetre: 'µg/m³',
  pascal: 'Pa',
  hectopascal: 'hPa',
  metrePerSecond: 'm/s',
  millimetre: 'mm',
  second: 's',
  decibel: 'dB',
  degree: '°',
  litre: 'L',
  cubicMetre: 'm³',
} as const

export type Unit = (typeof UNITS)[keyof typeof UNITS]

/** Mired is what most bulbs speak; the hub stores colour temperature in kelvin. */
export function miredToKelvin(mired: number): number {
  if (mired <= 0) return 0
  return Math.round(1_000_000 / mired)
}

export function kelvinToMired(kelvin: number): number {
  if (kelvin <= 0) return 0
  return Math.round(1_000_000 / kelvin)
}

export function fahrenheitToCelsius(f: number): number {
  return (f - 32) * (5 / 9)
}

export function celsiusToFahrenheit(c: number): number {
  return c * (9 / 5) + 32
}

/** Zigbee and Matter report level on 0..254; the hub stores brightness as 0..100 %. */
export function level254ToPercent(level: number): number {
  return clamp(Math.round((level / 254) * 100), 0, 100)
}

export function percentToLevel254(percent: number): number {
  return clamp(Math.round((percent / 100) * 254), 0, 254)
}

/** Zigbee/Matter hue is 0..254 for a 0..360° wheel. */
export function hue254ToDegrees(hue: number): number {
  return clamp(Math.round((hue / 254) * 360), 0, 360)
}

export function degreesToHue254(degrees: number): number {
  return clamp(Math.round((degrees / 360) * 254), 0, 254)
}

export function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value))
}

/** CIE 1931 xy -> sRGB, the conversion Hue, Matter and LIFX all need. */
export function xyToRgb(x: number, y: number, brightness = 1): [number, number, number] {
  // y is the luminance coordinate: at zero the point has no chromaticity at all, which is
  // what a bulb reports when it does not know its colour yet. Guarding only the divisions
  // leaves X and Z at zero while Y stays at full brightness, and the matrix below then turns
  // "unknown" into pure green - a lamp that flashes green on every reconnect.
  if (y <= 0) return [0, 0, 0]

  const z = 1 - x - y
  const Y = brightness
  const X = (Y / y) * x
  const Z = (Y / y) * z

  let r = X * 1.656492 - Y * 0.354851 - Z * 0.255038
  let g = -X * 0.707196 + Y * 1.655397 + Z * 0.036152
  let b = X * 0.051713 - Y * 0.121364 + Z * 1.011530

  const gamma = (v: number) => (v <= 0.0031308 ? 12.92 * v : 1.055 * Math.pow(v, 1 / 2.4) - 0.055)
  r = gamma(Math.max(0, r))
  g = gamma(Math.max(0, g))
  b = gamma(Math.max(0, b))

  const max = Math.max(r, g, b)
  if (max > 1) {
    r /= max
    g /= max
    b /= max
  }

  return [clamp(Math.round(r * 255), 0, 255), clamp(Math.round(g * 255), 0, 255), clamp(Math.round(b * 255), 0, 255)]
}

export function rgbToXy(r: number, g: number, b: number): [number, number] {
  const linear = (v: number) => {
    const s = v / 255
    return s > 0.04045 ? Math.pow((s + 0.055) / 1.055, 2.4) : s / 12.92
  }
  const R = linear(r)
  const G = linear(g)
  const B = linear(b)

  const X = R * 0.664511 + G * 0.154324 + B * 0.162028
  const Y = R * 0.283881 + G * 0.668433 + B * 0.047685
  const Z = R * 0.000088 + G * 0.072310 + B * 0.986039

  const sum = X + Y + Z
  if (sum === 0) return [0, 0]
  return [Number((X / sum).toFixed(4)), Number((Y / sum).toFixed(4))]
}

export function hsToRgb(hue: number, saturation: number, value = 100): [number, number, number] {
  const h = (hue % 360) / 60
  const s = clamp(saturation, 0, 100) / 100
  const v = clamp(value, 0, 100) / 100
  const c = v * s
  const x = c * (1 - Math.abs((h % 2) - 1))
  const m = v - c

  const [r, g, b] =
    h < 1 ? [c, x, 0] : h < 2 ? [x, c, 0] : h < 3 ? [0, c, x] : h < 4 ? [0, x, c] : h < 5 ? [x, 0, c] : [c, 0, x]

  return [Math.round((r + m) * 255), Math.round((g + m) * 255), Math.round((b + m) * 255)]
}

export function rgbToHs(r: number, g: number, b: number): [number, number] {
  const rn = r / 255
  const gn = g / 255
  const bn = b / 255
  const max = Math.max(rn, gn, bn)
  const min = Math.min(rn, gn, bn)
  const delta = max - min

  let hue = 0
  if (delta !== 0) {
    if (max === rn) hue = 60 * (((gn - bn) / delta) % 6)
    else if (max === gn) hue = 60 * ((bn - rn) / delta + 2)
    else hue = 60 * ((rn - gn) / delta + 4)
  }
  if (hue < 0) hue += 360

  const saturation = max === 0 ? 0 : delta / max
  return [Math.round(hue), Math.round(saturation * 100)]
}

/**
 * Colour temperature to sRGB, so the UI can tint a warm-white bulb without pretending it
 * is an RGB one. Tanner Helland's approximation, good enough between 1000 K and 12000 K.
 */
export function kelvinToRgb(kelvin: number): [number, number, number] {
  const t = clamp(kelvin, 1000, 12000) / 100
  let r: number
  let g: number
  let b: number

  if (t <= 66) {
    r = 255
    g = 99.4708025861 * Math.log(t) - 161.1195681661
    b = t <= 19 ? 0 : 138.5177312231 * Math.log(t - 10) - 305.0447927307
  } else {
    r = 329.698727446 * Math.pow(t - 60, -0.1332047592)
    g = 288.1221695283 * Math.pow(t - 60, -0.0755148492)
    b = 255
  }

  return [clamp(Math.round(r), 0, 255), clamp(Math.round(g), 0, 255), clamp(Math.round(b), 0, 255)]
}

/** Colours people name, as hue (degrees) and saturation (percent), in French and English. */
export const NAMED_COLOURS: Record<string, [number, number]> = {
  rouge: [0, 100], red: [0, 100],
  orange: [30, 100],
  jaune: [55, 100], yellow: [55, 100],
  vert: [120, 100], green: [120, 100],
  cyan: [180, 100],
  bleu: [220, 100], blue: [220, 100],
  violet: [275, 100], purple: [275, 100],
  rose: [320, 80], pink: [320, 80],
  blanc: [0, 0], white: [0, 0],
  'blanc chaud': [30, 25], warm: [30, 25],
  'blanc froid': [210, 10], cool: [210, 10],
}
