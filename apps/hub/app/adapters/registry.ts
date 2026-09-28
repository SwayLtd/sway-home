/**
 * The adapter registry, and the honest compatibility matrix.
 *
 * Two lists live here. The first is the adapters that are implemented and tested. The
 * second is `DECLARED`: protocols the capability model already covers but whose code is not
 * written yet. They appear in the integrations screen greyed out, with what they need and
 * what they would unlock.
 *
 * Declaring them is not padding. It is the roadmap in the one place that cannot go stale,
 * and it means the fingerprinter can already say "this is a Z-Wave stick" and point at the
 * row rather than shrug at an unknown host.
 */

import type { AdapterDescriptor } from '@sway-home/shared'
import { adapters } from '#services/adapter_manager'
import { VirtualAdapter } from '#adapters/virtual'
import { ShellyAdapter } from '#adapters/shelly'
import { WledAdapter } from '#adapters/wled'
import { TasmotaAdapter } from '#adapters/tasmota'
import { HueAdapter } from '#adapters/hue'
import { KasaAdapter } from '#adapters/kasa'
import { RokuAdapter } from '#adapters/roku'
import { GoogleCastAdapter } from '#adapters/googlecast'
import { MqttAdapter } from '#adapters/mqtt'
import { EsphomeAdapter } from '#adapters/esphome'
import { LifxAdapter } from '#adapters/lifx'
import { HomekitAdapter } from '#adapters/homekit'
import { MatterAdapter } from '#adapters/matter'
import { BleAdapter } from '#adapters/ble'
import { FreeboxAdapter } from '#adapters/freebox'
import { OnvifAdapter } from '#adapters/onvif'
import { TuyaAdapter } from '#adapters/tuya'
import { KnxAdapter } from '#adapters/knx'
import { ModbusAdapter } from '#adapters/modbus'
import { SamsungAdapter } from '#adapters/samsung'
import { WebosAdapter } from '#adapters/webos'
import { SonosAdapter } from '#adapters/sonos'
import { ZwaveAdapter } from '#adapters/zwave'
import { ZigbeeAdapter } from '#adapters/zigbee'
import { HomeAssistantAdapter } from '#adapters/homeassistant'

export function registerAdapters(): void {
  adapters.register(new VirtualAdapter())
  adapters.register(new ShellyAdapter())
  adapters.register(new WledAdapter())
  adapters.register(new TasmotaAdapter())
  adapters.register(new HueAdapter())
  adapters.register(new KasaAdapter())
  adapters.register(new RokuAdapter())
  adapters.register(new GoogleCastAdapter())
  adapters.register(new MqttAdapter())
  adapters.register(new EsphomeAdapter())
  adapters.register(new LifxAdapter())
  adapters.register(new HomekitAdapter())
  adapters.register(new MatterAdapter())
  adapters.register(new BleAdapter())
  adapters.register(new FreeboxAdapter())
  adapters.register(new OnvifAdapter())
  adapters.register(new TuyaAdapter())
  adapters.register(new KnxAdapter())
  adapters.register(new ModbusAdapter())
  adapters.register(new SamsungAdapter())
  adapters.register(new WebosAdapter())
  adapters.register(new SonosAdapter())
  adapters.register(new ZwaveAdapter())
  adapters.register(new ZigbeeAdapter())
  adapters.register(new HomeAssistantAdapter())
}

/**
 * Not yet implemented. Each row says what it needs, so the integrations screen can tell the
 * difference between "buy a dongle" and "we have not written this yet". Empty for now: every
 * protocol declared so far has its adapter above.
 */
export const DECLARED: (AdapterDescriptor & { unlocks: string; status: 'planned' | 'in_progress' | 'needs_hardware' })[] = []

export function allDescriptors(): (AdapterDescriptor & { declared?: boolean; unlocks?: string; status?: string })[] {
  const implemented = adapters.descriptors().map((descriptor) => ({ ...descriptor, declared: false }))
  const declared = DECLARED.map((descriptor) => ({ ...descriptor, declared: true }))
  return [...implemented, ...declared]
}
