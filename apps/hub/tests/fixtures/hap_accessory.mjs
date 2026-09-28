/**
 * A HomeKit bridge for the HomeKit adapter's tests, served by HAP-NodeJS - the library
 * Homebridge is built on, an implementation of the accessory side written by others.
 *
 * It runs under Node, not Bun: HAP-NodeJS needs Node's native ChaCha20-Poly1305, which Bun
 * lacks. The test drives it through stdin and reads it through stdout, one JSON object per
 * line:
 *
 *   node hap_accessory.mjs <port> <pincode> <storage dir> <username>
 *   -> {"ready":true,"setupURI":"X-HM://...","name":"Pont HomeKit","txt":{...}}
 *   <- {"set":{"accessory":"light","service":"Lightbulb","characteristic":"On","value":true}}
 *   -> {"wrote":{"accessory":"light","subtype":null,"characteristic":"On","value":true}}   (a controller wrote)
 *   -> {"paired":true,"txt":{...}} / {"unpaired":true,"txt":{...}}
 *   <- {"add":{"key":"office","name":"Lampe du bureau"}}
 *   -> {"added":"office","txt":{...}}   (once the configuration number moved)
 *
 * "txt" is the record the bridge advertises over mDNS, built by HAP-NodeJS itself, so a test
 * can hand it to the adapter as if it had been heard on the network.
 */

import { connect } from 'node:net'
import { createInterface } from 'node:readline'
import hap from 'hap-nodejs'
import advertiser from 'hap-nodejs/dist/lib/Advertiser.js'

const { Accessory, Bridge, Categories, Characteristic, HAPStorage, MDNSAdvertiser, Perms, Service, uuid } = hap
const { CiaoAdvertiser } = advertiser
const [, , port, pincode, storage, username] = process.argv
HAPStorage.setCustomStoragePath(storage)

const say = (message) => process.stdout.write(`${JSON.stringify(message)}\n`)
const bridge = new Bridge('Pont HomeKit', uuid.generate(`sway-test-bridge-${username}`))
bridge.getService(Service.AccessoryInformation)
  .setCharacteristic(Characteristic.Manufacturer, 'Sway Test')
  .setCharacteristic(Characteristic.Model, 'Pont de test')
  .setCharacteristic(Characteristic.SerialNumber, `bridge-${username}`)
  .setCharacteristic(Characteristic.FirmwareRevision, '1.2.3')

const accessories = new Map()

function accessory(key, name, build) {
  const item = new Accessory(name, uuid.generate(`sway-test-${key}-${username}`))
  item.getService(Service.AccessoryInformation)
    .setCharacteristic(Characteristic.Manufacturer, 'Sway Test')
    .setCharacteristic(Characteristic.Model, `Modèle ${name}`)
    .setCharacteristic(Characteristic.SerialNumber, `${key}-${username}`)
  build(item)
  for (const service of item.services) {
    for (const characteristic of service.characteristics) {
      characteristic.on('set', (value, callback) => {
        say({ wrote: { accessory: key, subtype: service.subtype ?? null, characteristic: characteristic.displayName.replace(/ /g, ''), value } })
        callback()
      })
    }
  }
  accessories.set(key, item)
  bridge.addBridgedAccessory(item)
  return item
}

accessory('light', 'Lampe du salon', (item) => {
  const bulb = item.addService(Service.Lightbulb, 'Lampe du salon')
  bulb.getCharacteristic(Characteristic.On)
  bulb.addCharacteristic(Characteristic.Brightness).updateValue(40)
  bulb.addCharacteristic(Characteristic.Hue).updateValue(0)
  bulb.addCharacteristic(Characteristic.Saturation).updateValue(0)
  bulb.addCharacteristic(Characteristic.ColorTemperature).updateValue(250)
})

accessory('sensor', 'Thermomètre du salon', (item) => {
  item.addService(Service.TemperatureSensor, 'Thermomètre').getCharacteristic(Characteristic.CurrentTemperature).updateValue(21.5)
  // Humidity that cannot notify, as some accessories have: the controller has to read it.
  item.addService(Service.HumiditySensor, 'Humidité').getCharacteristic(Characteristic.CurrentRelativeHumidity).setProps({ perms: [Perms.PAIRED_READ] }).updateValue(48)
  const battery = item.addService(Service.Battery, 'Pile')
  battery.getCharacteristic(Characteristic.BatteryLevel).updateValue(87)
  battery.getCharacteristic(Characteristic.StatusLowBattery).updateValue(0)
})

accessory('door', "Porte d'entrée", (item) => {
  item.addService(Service.ContactSensor, "Porte d'entrée").getCharacteristic(Characteristic.ContactSensorState).updateValue(0)
})

accessory('lock', 'Serrure', (item) => {
  const lock = item.addService(Service.LockMechanism, 'Serrure')
  lock.getCharacteristic(Characteristic.LockCurrentState).updateValue(1)
  lock.getCharacteristic(Characteristic.LockTargetState).updateValue(1)
  // A real lock reports the move once it is done.
  lock.getCharacteristic(Characteristic.LockTargetState).on('change', ({ newValue }) => {
    setTimeout(() => lock.getCharacteristic(Characteristic.LockCurrentState).updateValue(newValue), 50)
  })
})

accessory('button', 'Bouton', (item) => {
  item.addService(Service.StatelessProgrammableSwitch, 'Bouton').getCharacteristic(Characteristic.ProgrammableSwitchEvent)
})

accessory('shade', 'Store', (item) => {
  const covering = item.addService(Service.WindowCovering, 'Store')
  covering.getCharacteristic(Characteristic.CurrentPosition).updateValue(100)
  covering.getCharacteristic(Characteristic.TargetPosition).updateValue(100)
  covering.getCharacteristic(Characteristic.PositionState).updateValue(2)
  covering.getCharacteristic(Characteristic.TargetPosition).on('change', ({ newValue }) => {
    setTimeout(() => covering.getCharacteristic(Characteristic.CurrentPosition).updateValue(newValue), 50)
  })
})

accessory('strip', 'Multiprise', (item) => {
  item.addService(Service.Outlet, 'Prise gauche', 'left').getCharacteristic(Characteristic.On).updateValue(false)
  item.addService(Service.Outlet, 'Prise droite', 'right').getCharacteristic(Characteristic.On).updateValue(true)
})

accessory('bell', 'Sonnette', (item) => {
  item.addService(Service.Doorbell, 'Sonnette').getCharacteristic(Characteristic.ProgrammableSwitchEvent)
})

/** The mDNS TXT record HAP-NodeJS advertises for the bridge right now, values as text. */
function txt() {
  const info = bridge._accessoryInfo
  const record = CiaoAdvertiser.createTxt(info, CiaoAdvertiser.computeSetupHash(info))
  return Object.fromEntries(Object.entries(record).map(([key, value]) => [key, String(value)]))
}

bridge.on('paired', () => say({ paired: true, txt: txt() }))
bridge.on('unpaired', () => say({ unpaired: true, txt: txt() }))

createInterface({ input: process.stdin }).on('line', (line) => {
  let message
  try {
    message = JSON.parse(line)
  } catch {
    return
  }
  if (message.set) {
    const { accessory: key, service, subtype, characteristic, value } = message.set
    const item = accessories.get(key)
    const found = subtype ? item?.getServiceById(Service[service], subtype) : item?.getService(Service[service])
    const target = found?.getCharacteristic(Characteristic[characteristic])
    if (target) {
      if (characteristic === 'ProgrammableSwitchEvent') target.sendEventNotification(value)
      else target.updateValue(value)
    }
  }
  if (message.add) {
    // A lamp added while the bridge runs: HAP-NodeJS raises its configuration number and
    // advertises it again, as Homebridge does when a plugin brings a new accessory.
    const before = txt()['c#']
    accessory(message.add.key, message.add.name, (item) => item.addService(Service.Lightbulb, message.add.name))
    const check = setInterval(() => {
      if (txt()['c#'] === before) return
      clearInterval(check)
      say({ added: message.add.key, txt: txt() })
    }, 20)
  }
  if (message.stop) void bridge.unpublish().then(() => process.exit(0))
})
process.stdin.on('end', () => void bridge.unpublish().finally(() => process.exit(0)))

await bridge.publish({
  username,
  pincode,
  port: Number(port),
  category: Categories.BRIDGE,
  bind: '127.0.0.1',
  advertiser: MDNSAdvertiser.CIAO,
})
if (process.env.HAP_DUMP) {
  // What GET /accessories answers, for the codec's tests.
  process.stdout.write(JSON.stringify({ accessories: await bridge.toHAP(undefined, false) }))
  await bridge.unpublish()
  process.exit(0)
}
// publish() resolves before the HTTP server takes connections: ready once it does.
for (let attempt = 0; attempt < 100; attempt++) {
  const open = await new Promise((resolve) => {
    const probe = connect({ host: '127.0.0.1', port: Number(port) }, () => {
      probe.destroy()
      resolve(true)
    })
    probe.on('error', () => resolve(false))
  })
  if (open) break
  await new Promise((resolve) => setTimeout(resolve, 50))
}
say({ ready: true, setupURI: bridge.setupURI(), name: bridge.displayName, txt: txt() })
