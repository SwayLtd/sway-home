/**
 * The house, in one sentence, with its values set in it.
 *
 * `house_snapshot` returns a dense multi-line summary because a model reads it on every turn.
 * A person asking "comment va la maison ?" wants the opposite: one sentence, in the order
 * they would want to hear it. Danger first (smoke, water), then what is left open, then that
 * all is well. Every value is a chip - `[[ph:icon|text|tone]]`, see `rich_text.ts` - so the
 * screen can set it apart with an icon and a rounded background while the spoken form stays
 * an ordinary sentence.
 */

import { chip, currencyIcon, formatMoney, formatQuantity, type WidgetData } from '@sway-home/shared'
import { isOutdoorArea, type houseService } from '#services/house'

type Snapshot = ReturnType<typeof houseService.snapshot>


function plural(count: number, one: string, many: string): string {
  return `${count} ${count > 1 ? many : one}`
}

function list(names: string[], max = 2): string {
  if (names.length <= max) return joinFr(names)
  return `${names.slice(0, max).join(', ')} et ${names.length - max} autre${names.length - max > 1 ? 's' : ''}`
}

/** "a, b et c". */
function joinFr(items: string[]): string {
  if (items.length <= 1) return items.join('')
  return `${items.slice(0, -1).join(', ')} et ${items.at(-1)}`
}

export function houseSentence(snapshot: Snapshot): string {
  const urgent: string[] = []
  const { smoke, leaks, locksUnlocked, openContacts } = snapshot.security

  if (smoke.length > 0) urgent.push(chip('ph:fire', `Fumée : ${list(smoke)}`, 'alert'))
  if (leaks.length > 0) urgent.push(chip('ph:drop', `Fuite d'eau : ${list(leaks)}`, 'alert'))
  if (locksUnlocked.length > 0) urgent.push(chip('ph:lock-simple-open', `${list(locksUnlocked)} déverrouillé${locksUnlocked.length > 1 ? 's' : 'e'}`, 'warn'))
  if (openContacts.length > 0) urgent.push(chip('ph:door-open', `${list(openContacts)} ouvert${openContacts.length > 1 ? 's' : ''}`, 'warn'))

  // Alerts not already said above are counted rather than recited: twenty titles in a row is
  // a report, not an answer.
  const named = [...smoke, ...leaks]
  const otherAlerts = snapshot.openAlerts.filter((alert) => !named.some((name) => alert.title.includes(name)))

  if (urgent.length > 0) {
    const tail = otherAlerts.length > 0 ? `, et ${chip('ph:warning', plural(otherAlerts.length, 'autre alerte', 'autres alertes'), 'warn')}` : ''
    return oneLine(`${joinFr(urgent)}${tail}.`)
  }

  const facts: string[] = []
  const { online, total } = snapshot.counts
  facts.push(chip('ph:wifi-high', `${online}/${total} en ligne`, online < total ? 'warn' : 'default'))
  facts.push(chip('ph:lightning', formatQuantity(snapshot.power.total, 'W')))

  const outdoor = new Set(snapshot.areas.filter((area) => isOutdoorArea(area)).map((area) => area.name))
  const indoor = snapshot.climate
    .filter((entry) => !outdoor.has(entry.area) && !isOutdoorArea({ name: entry.area }))
    .map((entry) => entry.temperature)
    .filter((value): value is number => value !== null)
  if (indoor.length > 0) {
    facts.push(chip('ph:thermometer-simple', formatQuantity(indoor.reduce((sum, value) => sum + value, 0) / indoor.length, '°C', 1)))
  }

  facts.push(chip('ph:lightbulb', snapshot.lightsOn.length > 0 ? plural(snapshot.lightsOn.length, 'lumière allumée', 'lumières allumées') : "rien d'allumé"))

  const locks = snapshot.devices.filter((device) => typeof device.state.locked === 'boolean').length
  if (locks > 0) facts.push(chip('ph:lock-simple', 'tout est verrouillé', 'ok'))

  let text = `Tout va bien : ${joinFr(facts)}.`
  if (otherAlerts.length === 1) {
    text += ` Une chose : ${chip('ph:warning', otherAlerts[0]!.title, 'warn')}.`
  } else if (otherAlerts.length > 1) {
    text += ` ${chip('ph:warning', `${otherAlerts.length} alertes`, 'warn')} à regarder, dont ${otherAlerts[0]!.title}.`
  }
  return oneLine(text)
}

function oneLine(text: string): string {
  return text.replace(/\s*\n+\s*/g, ' ')
}

function capitalise(text: string): string {
  return text.charAt(0).toUpperCase() + text.slice(1)
}

/** "de consommation", "d'humidité": French elides before a vowel or a mute h. */
function of(label: string): string {
  return /^[aeiouyhàâéèêëîïôûù]/i.test(label) ? `d'${label}` : `de ${label}`
}

// ---------------------------------------------------------------------------------------
// Rankings: "quelle pièce consomme le plus", "où fait-il le plus froid"
// ---------------------------------------------------------------------------------------

/**
 * Who is first, with how much, and who comes next - nothing more. The leader and its value
 * are chips; the runner-up is said plainly, because three chips in a row stop reading as a
 * sentence. Wording stays neutral ("en tête", "au plus bas") so it holds for any measure and
 * any room name, whose gender the hub cannot know.
 */
export function describeRanking(
  data: WidgetData,
  options: { label: string; icon: string; decimals: number; period?: string | null }
): string {
  const period = options.period ?? null
  if (data.kind !== 'ranking' || data.entries.length === 0) {
    return `Aucune mesure ${of(options.label)} ${period ?? "pour l'instant"}.`
  }

  const format = (value: number) => formatQuantity(value, data.unit, options.decimals)

  if (data.total === 0) {
    return period ? `Aucune ${options.label} ${period}.` : 'Rien ne consomme en ce moment.'
  }

  const prefix = period ? `${capitalise(period)}, ` : ''
  const [first, second] = data.entries
  const leader = chip(first!.icon, first!.label)
  const amount = chip(options.icon, format(first!.value))

  if (data.count === 1) {
    return oneLine(`${prefix}${leader} : ${amount}, ${data.by === 'area' ? 'seule pièce mesurée' : 'seul appareil mesuré'}.`)
  }

  const place = data.order === 'desc' ? 'en tête' : 'au plus bas'
  // "42 W sur 42 W" says the same number twice; the total is only worth saying when the
  // leader is not all of it.
  const outOf = data.total !== null && first!.share !== null && first!.share < 0.995 ? ` sur ${format(data.total)}` : ''
  const next = second ? `, puis ${second.label} (${format(second.value)})` : ''
  return oneLine(`${prefix}${leader} ${place} avec ${amount}${outOf}${next}.`)
}

// ---------------------------------------------------------------------------------------
// Energy over a period: "combien j'ai consommé cette semaine"
// ---------------------------------------------------------------------------------------

export function describeEnergy(input: {
  period: string
  kwh: number
  cost: number
  currency: string
  /** The device that weighs most, when there is more than one to weigh. */
  top: { label: string; icon: string; share: number } | null
  /** Set when the question named one device. */
  device?: { label: string; icon: string } | null
}): string {
  const energy = chip('ph:lightning', formatQuantity(input.kwh, 'kWh'))
  const money = chip(currencyIcon(input.currency), formatMoney(input.cost, input.currency))

  if (input.device) {
    return oneLine(`${chip(input.device.icon, input.device.label)} : ${energy} ${input.period}, soit ${money}.`)
  }
  if (input.kwh <= 0) return `Aucune consommation mesurée ${input.period}.`

  const top = input.top ? `, surtout ${chip(input.top.icon, input.top.label)} (${Math.round(input.top.share * 100)} %)` : ''
  return oneLine(`${capitalise(input.period)} : ${energy} pour ${money}${top}.`)
}
