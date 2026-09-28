/**
 * Numbers the way a person says them, in French.
 *
 * One set of rules for the chip in a sentence, the card and the spoken answer, so the three
 * never disagree: a decimal comma, no trailing zero, kilowatts past a thousand watts and
 * watt-hours under a kilowatt-hour, because that is how anyone reads a meter aloud.
 */

/** Fixed digits, then the zeros that say nothing go, then the comma. */
function decimal(value: number, digits: number): string {
  let text = value.toFixed(digits)
  if (text.includes('.')) text = text.replace(/0+$/, '').replace(/\.$/, '')
  // A tiny negative rounds to "-0", and nobody says "moins zéro".
  if (text === '-0') text = '0'
  return text.replace('.', ',')
}

export function formatQuantity(value: number, unit: string | null, decimals = 1): string {
  const magnitude = Math.abs(value)
  if (unit === 'W') {
    if (magnitude >= 1000) return `${decimal(value / 1000, 1)} kW`
    return `${decimal(value, magnitude < 10 ? 1 : 0)} W`
  }
  if (unit === 'kWh') {
    if (magnitude < 1) return `${decimal(value * 1000, 0)} Wh`
    return `${decimal(value, magnitude < 100 ? 1 : 0)} kWh`
  }
  const number = decimal(value, decimals)
  return unit ? `${number} ${unit}` : number
}

const CURRENCIES: Record<string, { symbol: string; icon: string }> = {
  EUR: { symbol: '€', icon: 'ph:currency-eur' },
  USD: { symbol: '$', icon: 'ph:currency-dollar' },
  GBP: { symbol: '£', icon: 'ph:currency-gbp' },
}

/** Two decimals and the symbol after, the way a French bill prints it. */
export function formatMoney(amount: number, currency: string): string {
  const symbol = CURRENCIES[currency.toUpperCase()]?.symbol ?? currency
  // "0,00 €" for a few watt-hours reads as "nothing", which is not what was measured.
  if (amount > 0 && amount < 0.005) return `moins de 0,01 ${symbol}`
  return `${amount.toFixed(2).replace('.', ',')} ${symbol}`
}

export function currencyIcon(currency: string): string {
  return CURRENCIES[currency.toUpperCase()]?.icon ?? 'ph:coins'
}
