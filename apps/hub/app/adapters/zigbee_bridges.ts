/**
 * Which zigbee2mqtt bridges the Zigbee adapter is watching, in this process.
 *
 * The generic MQTT adapter can import zigbee2mqtt devices too. When both watch the same
 * bridge, the Zigbee adapter wins and the MQTT adapter skips it, so no device appears twice.
 * A module of its own so the two adapters can share it without importing each other.
 */

export const activeZigbeeBridges = new Set<string>()

export function bridgeKey(host: string, port: number, base: string): string {
  return `${host}:${port}/${base}`
}
