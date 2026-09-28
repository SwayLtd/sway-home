/**
 * What kind of place a room is, as far as the logic that branches on it cares.
 *
 * The garden is not a room. Asked for the indoor temperature or "la pièce la plus froide",
 * a sensor on the terrace is the wrong answer that looks right, and a light on the terrace
 * is not a light left on in an empty room. Every place that means "inside" filters through
 * here: by kind when it was set, by name when it was not.
 */

const OUTDOOR_KINDS = new Set(['garden', 'balcony'])
const OUTDOOR_NAMES = /(jardin|terrasse|balcon|ext[eé]rieur|dehors|garden|outside|patio|cour)/i

export function isOutdoorArea(area: { kind?: string | null; name: string }): boolean {
  return (area.kind !== null && area.kind !== undefined && OUTDOOR_KINDS.has(area.kind)) || OUTDOOR_NAMES.test(area.name)
}
