/**
 * Real Matter devices for the adapter's tests: matter.js device nodes, served over UDP on this
 * machine, commissioned by the adapter exactly as a bulb on the network would be.
 *
 * They keep their own storage (an in-memory SQLite behind the hub's driver) so the adapter
 * can be shut down and started again while they keep running.
 */

import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Endpoint, Environment, Logger, LogLevel, ServerNode, StorageService } from '@matter/main'
import { BridgedDeviceBasicInformationServer } from '@matter/main/behaviors/bridged-device-basic-information'
import { ColorControlServer } from '@matter/main/behaviors/color-control'
import { SwitchServer } from '@matter/main/behaviors/switch'
import { ThermostatServer } from '@matter/main/behaviors/thermostat'
import { WindowCoveringServer } from '@matter/main/behaviors/window-covering'
import { ColorControl, DoorLock, Switch, Thermostat, WindowCovering } from '@matter/main/clusters'
import { ContactSensorDevice } from '@matter/main/devices/contact-sensor'
import { DoorLockDevice } from '@matter/main/devices/door-lock'
import { ExtendedColorLightDevice } from '@matter/main/devices/extended-color-light'
import { GenericSwitchDevice } from '@matter/main/devices/generic-switch'
import { TemperatureSensorDevice } from '@matter/main/devices/temperature-sensor'
import { ThermostatDevice } from '@matter/main/devices/thermostat'
import { WindowCoveringDevice } from '@matter/main/devices/window-covering'
import { AggregatorEndpoint } from '@matter/main/endpoints/aggregator'
import { VendorId } from '@matter/main/types'
import { hubStorageDriver } from '#adapters/matter_storage'

Logger.level = LogLevel.ERROR
const environment = Environment.default
environment.vars.set('runtime.signals', false)
environment.vars.set('runtime.exitcode', false)
const devicesDir = mkdtempSync(join(tmpdir(), 'sway-matter-devices-'))
const deviceStorage = hubStorageDriver(':memory:', 'sway-test-devices')
environment.get(StorageService).registerDriver(deviceStorage.implementation)

let nextPort = 5700 + Math.floor(Math.random() * 1500)
let nextDiscriminator = 100 + Math.floor(Math.random() * 3000)

export interface TestDevice {
  node: ServerNode
  port: number
  passcode: number
  discriminator: number
  manualCode: string
  qrCode: string
  close(): Promise<void>
  /** The same device plugged back in: same identity, same storage, so still in the hub's fabric. */
  revive(): Promise<TestDevice>
}

/** Devices open their storage while they are created: with their own driver, not the hub's. */
async function create(
  label: string,
  build: (node: ServerNode) => Promise<void>,
  fixed?: { port: number; discriminator: number; passcode: number }
): Promise<TestDevice> {
  const service = environment.get(StorageService)
  const previousDriver = service.configuredDriver
  const previousPath = environment.vars.get('storage.path')
  service.configuredDriver = 'sway-test-devices'
  environment.vars.set('storage.path', devicesDir)
  const port = fixed?.port ?? nextPort++
  const discriminator = fixed?.discriminator ?? nextDiscriminator++ % 4096
  const passcode = fixed?.passcode ?? 20202021 + port
  try {
    const node = await ServerNode.create({
      id: `device-${port}`,
      network: { port },
      commissioning: { passcode, discriminator },
      productDescription: { name: label, deviceType: AggregatorEndpoint.deviceType },
      basicInformation: {
        vendorName: 'Sway Test',
        vendorId: VendorId(0xfff1),
        productName: `${label} (modèle)`,
        productId: 0x8000,
        nodeLabel: label,
        serialNumber: `sn-${port}`,
        uniqueId: `unique-${port}`,
      },
    })
    await build(node)
    await node.start()
    const codes = node.state.commissioning.pairingCodes
    return {
      node,
      port,
      passcode,
      discriminator,
      manualCode: codes.manualPairingCode,
      qrCode: codes.qrPairingCode,
      close: () => node.close(),
      revive: () => create(label, build, { port, discriminator, passcode }),
    }
  } finally {
    service.configuredDriver = previousDriver
    if (previousPath !== undefined) environment.vars.set('storage.path', previousPath)
  }
}

const ColorServer = ColorControlServer.with(ColorControl.Feature.Xy, ColorControl.Feature.ColorTemperature, ColorControl.Feature.HueSaturation)

export async function colorLight(label: string) {
  let light!: Endpoint
  const device = await create(label, async (node) => {
    light = await node.add(ExtendedColorLightDevice.with(ColorServer), {
      id: 'light',
      levelControl: { currentLevel: 100, minLevel: 1, maxLevel: 254, options: {}, onLevel: null, remainingTime: 0, startUpCurrentLevel: null, managedTransitionTimeHandling: false },
      colorControl: {
        colorMode: ColorControl.ColorMode.ColorTemperatureMireds,
        enhancedColorMode: ColorControl.EnhancedColorMode.ColorTemperatureMireds,
        colorTempPhysicalMinMireds: 153,
        colorTempPhysicalMaxMireds: 500,
        coupleColorTempToLevelMinMireds: 153,
        startUpColorTemperatureMireds: null,
        colorTemperatureMireds: 250,
        remainingTime: 0,
        options: {},
        managedTransitionTimeHandling: false,
      },
    })
  })
  return { ...device, light }
}

export async function bridge(label: string) {
  let door!: Endpoint
  let temperature!: Endpoint
  const device = await create(label, async (node) => {
    const aggregator = new Endpoint(AggregatorEndpoint, { id: 'aggregator' })
    await node.add(aggregator)
    door = new Endpoint(ContactSensorDevice.with(BridgedDeviceBasicInformationServer), {
      id: 'door',
      bridgedDeviceBasicInformation: { nodeLabel: "Porte d'entrée", productName: 'Contact', reachable: true, uniqueId: `door-${label}` },
      booleanState: { stateValue: true },
    })
    temperature = new Endpoint(TemperatureSensorDevice.with(BridgedDeviceBasicInformationServer), {
      id: 'temperature',
      bridgedDeviceBasicInformation: { nodeLabel: 'Salon', productName: 'Thermomètre', reachable: true, uniqueId: `temperature-${label}` },
      temperatureMeasurement: { measuredValue: 2150 },
    })
    await aggregator.add(door)
    await aggregator.add(temperature)
  })
  return { ...device, door, temperature }
}

/** One node, four endpoints: a thermostat, a roller shade, a lock and a button. */
export async function appliances(label: string) {
  let thermostat!: Endpoint
  let cover!: Endpoint
  let lock!: Endpoint
  let button!: Endpoint
  const device = await create(label, async (node) => {
    thermostat = await node.add(ThermostatDevice.with(ThermostatServer.with(Thermostat.Feature.Heating)), {
      id: 'thermostat',
      thermostat: {
        localTemperature: 2100,
        occupiedHeatingSetpoint: 2000,
        systemMode: Thermostat.SystemMode.Heat,
        controlSequenceOfOperation: Thermostat.ControlSequenceOfOperation.HeatingOnly,
        minHeatSetpointLimit: 700,
        maxHeatSetpointLimit: 3000,
        absMinHeatSetpointLimit: 700,
        absMaxHeatSetpointLimit: 3000,
      },
    })
    cover = await node.add(WindowCoveringDevice.with(WindowCoveringServer.with(WindowCovering.Feature.Lift, WindowCovering.Feature.PositionAwareLift)), {
      id: 'cover',
      windowCovering: {
        type: WindowCovering.WindowCoveringType.Rollershade,
        endProductType: WindowCovering.EndProductType.RollerShade,
        currentPositionLiftPercent100ths: 0,
        targetPositionLiftPercent100ths: 0,
      },
    })
    lock = await node.add(DoorLockDevice, {
      id: 'lock',
      doorLock: {
        lockState: DoorLock.LockState.Locked,
        lockType: DoorLock.LockType.DeadBolt,
        actuatorEnabled: true,
        operatingMode: DoorLock.OperatingMode.Normal,
        // The default lock server validates these even without the features that use them.
        wrongCodeEntryLimit: 5,
        userCodeTemporaryDisableTime: 10,
      },
    } as never)
    button = await node.add(
      GenericSwitchDevice.with(SwitchServer.with(Switch.Feature.MomentarySwitch, Switch.Feature.MomentarySwitchRelease, Switch.Feature.MomentarySwitchMultiPress)),
      { id: 'button', switch: { numberOfPositions: 2, currentPosition: 0, multiPressMax: 3 } }
    )
  })
  return { ...device, thermostat, cover, lock, button }
}

/** A press as a finger makes it: the switch goes to 1 and back. */
export async function press(button: Endpoint, times = 1): Promise<void> {
  for (let index = 0; index < times; index++) {
    await button.set({ switch: { currentPosition: 1 } } as never)
    await button.set({ switch: { currentPosition: 0 } } as never)
  }
}

/** What a device holds for one of its clusters, as its own firmware would see it. */
export function held(endpoint: Endpoint, cluster: string): Record<string, unknown> {
  return (endpoint.state as unknown as Record<string, Record<string, unknown>>)[cluster] ?? {}
}
