/**
 * The icon of a thing, the same everywhere it appears.
 *
 * A room shows the same icon on its card, in the sidebar and in a chip inside one of the
 * assistant's sentences; a device the same in the list and in "Bouilloire en tête". The maps
 * used to live in the console only, which left the hub unable to put an icon in a sentence
 * without inventing a second, diverging set.
 */

export const CATEGORY_ICON: Record<string, string> = {
  light: 'ph:lightbulb-filament',
  switch: 'ph:toggle-left',
  outlet: 'ph:plug',
  sensor: 'ph:thermometer-simple',
  climate: 'ph:thermometer',
  cover: 'ph:app-window',
  lock: 'ph:lock-key',
  camera: 'ph:video-camera',
  media: 'ph:play-circle',
  speaker: 'ph:speaker-high',
  display: 'ph:television-simple',
  appliance: 'ph:washing-machine',
  vacuum: 'ph:fan',
  energy: 'ph:lightning',
  network: 'ph:wifi-high',
  computer: 'ph:desktop',
  phone: 'ph:device-mobile',
  wearable: 'ph:watch',
  vehicle: 'ph:car',
  hub: 'ph:cube',
  printer: 'ph:printer',
  gateway: 'ph:cell-tower',
  unknown: 'ph:question',
}

export const AREA_ICON: Record<string, string> = {
  living_room: 'ph:armchair',
  kitchen: 'ph:cooking-pot',
  bedroom: 'ph:bed',
  bathroom: 'ph:bathtub',
  office: 'ph:desk',
  hallway: 'ph:door-open',
  entrance: 'ph:door',
  garage: 'ph:garage',
  garden: 'ph:tree',
  balcony: 'ph:plant',
  basement: 'ph:stairs',
  attic: 'ph:house-line',
  laundry: 'ph:washing-machine',
  dining_room: 'ph:fork-knife',
  kids_room: 'ph:baby',
  guest_room: 'ph:bed',
  other: 'ph:square',
}

const PHOSPHOR = /^ph:[a-z0-9-]+$/

/** The icon a person chose for the room if it is one we can draw, else the one of its kind. */
export function areaIcon(area: { icon?: string | null; kind?: string | null }): string {
  if (area.icon && PHOSPHOR.test(area.icon)) return area.icon
  return AREA_ICON[area.kind ?? 'other'] ?? 'ph:house-line'
}

export function deviceIcon(device: { category?: string | null }): string {
  return CATEGORY_ICON[device.category ?? 'unknown'] ?? 'ph:question'
}
