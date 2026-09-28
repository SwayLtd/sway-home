/**
 * Where Bluetooth advertisements come from: the hub's own radio, or gateways on MQTT.
 *
 *  - **Windows**: a small scanner written in C#, compiled on the spot with the compiler every
 *    Windows ships (.NET Framework 4.8, `csc.exe`), watches advertisements through WinRT's
 *    BluetoothLEAdvertisementWatcher and writes one JSON line per advertisement. Nothing to
 *    install; the compiled scanner is kept in a cache and rebuilt only when its source
 *    changes. It ends when its input closes, so it never outlives the hub.
 *  - **Theengs Gateway / OpenMQTTGateway**: an ESP32 or a Raspberry Pi near the sensors
 *    forwards what it hears over MQTT, which is also how a hub that is not on Windows listens.
 *
 * Linux's BlueZ is not read directly: a gateway covers it.
 */

import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process'
import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { createInterface } from 'node:readline'
import { MqttClient } from '#adapters/mqtt'
import { advertFromGateway, parseScannerLine, type Advert, type Values } from '#adapters/ble_codec'

export interface AdvertSource {
  readonly name: string
  /** False when it could not start; `onProblem` says why. It may still come up later. */
  start(onAdvert: (advert: Advert, decoded?: Values | null) => void, onProblem: (problem: string | null) => void): Promise<boolean>
  stop(): Promise<void>
}

// ---------------------------------------------------------------------------------------
// A scanner process that writes JSON lines
// ---------------------------------------------------------------------------------------

export type ScannerCommand = { command: string[] } | { problem: string }

const WATCHER_ERRORS: Record<string, string> = {
  RadioNotAvailable: 'le Bluetooth de cette machine est éteint ou absent',
  DisabledByPolicy: 'le Bluetooth est désactivé par une stratégie Windows',
  DisabledByUser: "le Bluetooth est désactivé dans les paramètres de Windows",
  ConsentRequired: 'Windows demande une autorisation pour le Bluetooth',
  ResourceInUse: 'le Bluetooth est occupé par une autre application',
  NotSupported: "cet adaptateur Bluetooth ne sait pas écouter les annonces",
}

export class ProcessScanner implements AdvertSource {
  readonly name: string
  readonly #resolve: () => Promise<ScannerCommand>
  readonly #restartMs: number
  readonly #maxRestartMs: number
  #child: ChildProcessWithoutNullStreams | null = null
  #timer: ReturnType<typeof setTimeout> | null = null
  #delay: number
  #stopped = false

  constructor(options: { name: string; resolve: () => Promise<ScannerCommand>; restartMs?: number; maxRestartMs?: number }) {
    this.name = options.name
    this.#resolve = options.resolve
    this.#restartMs = options.restartMs ?? 5000
    this.#maxRestartMs = options.maxRestartMs ?? 300_000
    this.#delay = this.#restartMs
  }

  async start(onAdvert: (advert: Advert) => void, onProblem: (problem: string | null) => void): Promise<boolean> {
    this.#stopped = false
    return this.#launch(onAdvert, onProblem)
  }

  async #launch(onAdvert: (advert: Advert) => void, onProblem: (problem: string | null) => void): Promise<boolean> {
    const resolved = await this.#resolve()
    if (this.#stopped) return false
    if ('problem' in resolved) {
      onProblem(resolved.problem)
      return false
    }
    const [program, ...args] = resolved.command
    let child: ChildProcessWithoutNullStreams
    try {
      child = spawn(program!, args, { stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true })
    } catch (error) {
      onProblem(`le scanner Bluetooth ne démarre pas : ${(error as Error).message}`)
      this.#again(onAdvert, onProblem)
      return false
    }
    this.#child = child
    let heard = false
    let notice: string | null = null
    createInterface({ input: child.stdout }).on('line', (line) => {
      const advert = parseScannerLine(line)
      if (advert) {
        if (!heard) {
          heard = true
          this.#delay = this.#restartMs
          onProblem(null)
        }
        onAdvert(advert)
        return
      }
      const said = /^\{"(stopped|error)":"(\w+)"\}$/.exec(line.trim())
      if (said) notice = said[2]!
    })
    child.stderr.resume()
    child.on('error', (error) => onProblem(`le scanner Bluetooth ne démarre pas : ${error.message}`))
    child.on('exit', (code) => {
      if (this.#child === child) this.#child = null
      if (this.#stopped) return
      const why = notice ? (WATCHER_ERRORS[notice] ?? `arrêt du scanner (${notice})`) : `arrêt du scanner (code ${code})`
      onProblem(`Écoute Bluetooth interrompue : ${why}${notice && WATCHER_ERRORS[notice] ? ` (${notice})` : ''}.`)
      this.#again(onAdvert, onProblem)
    })
    return true
  }

  #again(onAdvert: (advert: Advert) => void, onProblem: (problem: string | null) => void): void {
    if (this.#stopped || this.#timer) return
    const delay = this.#delay
    this.#delay = Math.min(this.#delay * 2, this.#maxRestartMs)
    this.#timer = setTimeout(() => {
      this.#timer = null
      void this.#launch(onAdvert, onProblem)
    }, delay)
  }

  async stop(): Promise<void> {
    this.#stopped = true
    if (this.#timer) clearTimeout(this.#timer)
    this.#timer = null
    const child = this.#child
    this.#child = null
    if (!child || child.exitCode !== null) return
    // Closing its input is how the scanner is told to stop; a kill only if it does not.
    await new Promise<void>((resolve) => {
      const killer = setTimeout(() => {
        child.kill()
        resolve()
      }, 2000)
      child.once('exit', () => {
        clearTimeout(killer)
        resolve()
      })
      child.stdin.end()
    })
  }
}

// ---------------------------------------------------------------------------------------
// The Windows scanner
// ---------------------------------------------------------------------------------------

/**
 * Every value it writes is hex or a number, so no string ever needs escaping; the device's
 * name travels inside its data sections.
 */
export const WINDOWS_SCANNER_SOURCE = `using System;
using System.Text;
using Windows.Devices.Bluetooth;
using Windows.Devices.Bluetooth.Advertisement;
using Windows.Storage.Streams;

// Sway Home: Bluetooth LE advertisements from WinRT, one JSON line each on stdout:
// {"address":"a4c1380283f4","rssi":-70,"sections":["0106","16d2fc4002ca09"]}
// Each section is its AD type then its data, in hex. It stops when stdin closes.
public static class Program {
  static readonly object Gate = new object();

  static void Write(string line) {
    lock (Gate) {
      Console.Out.WriteLine(line);
      Console.Out.Flush();
    }
  }

  public static int Main(string[] args) {
    try {
      var watcher = new BluetoothLEAdvertisementWatcher();
      watcher.ScanningMode = args.Length > 0 && args[0] == "passive" ? BluetoothLEScanningMode.Passive : BluetoothLEScanningMode.Active;
      watcher.Received += (sender, e) => {
        var sections = new StringBuilder();
        foreach (var section in e.Advertisement.DataSections) {
          var bytes = new byte[section.Data.Length];
          DataReader.FromBuffer(section.Data).ReadBytes(bytes);
          if (sections.Length > 0) sections.Append(',');
          sections.Append('"').Append(section.DataType.ToString("x2")).Append(BitConverter.ToString(bytes).Replace("-", "").ToLowerInvariant()).Append('"');
        }
        Write("{\\"address\\":\\"" + e.BluetoothAddress.ToString("x12") + "\\",\\"rssi\\":" + e.RawSignalStrengthInDBm + ",\\"sections\\":[" + sections + "]}");
      };
      watcher.Stopped += (sender, e) => {
        if (e.Error == BluetoothError.Success) return;
        Write("{\\"stopped\\":\\"" + e.Error + "\\"}");
        Environment.Exit(2);
      };
      watcher.Start();
      Console.In.ReadToEnd();
      watcher.Stop();
      return 0;
    } catch (Exception error) {
      Write("{\\"error\\":\\"" + error.GetType().Name + "\\"}");
      return 3;
    }
  }
}
`

const FACADE = 'v4.0_4.0.0.0__b03f5f7f11d50a3a'

/** The scanner to run, compiled if needed; or why there is none on this machine. */
export async function windowsScanner(cacheDir: string, options: { active?: boolean } = {}): Promise<ScannerCommand> {
  if (process.platform !== 'win32') {
    return { problem: "L'écoute Bluetooth du hub n'existe que sous Windows : ailleurs, passer par une passerelle Theengs ou OpenMQTTGateway (MQTT)." }
  }
  const windows = process.env.WINDIR ?? process.env.SystemRoot ?? 'C:\\Windows'
  const compiler = [join(windows, 'Microsoft.NET', 'Framework64', 'v4.0.30319', 'csc.exe'), join(windows, 'Microsoft.NET', 'Framework', 'v4.0.30319', 'csc.exe')].find((path) => existsSync(path))
  const metadata = join(windows, 'System32', 'WinMetadata')
  const gac = join(windows, 'Microsoft.NET', 'assembly', 'GAC_MSIL')
  const references = [
    join(metadata, 'Windows.Devices.winmd'),
    join(metadata, 'Windows.Foundation.winmd'),
    join(metadata, 'Windows.Storage.winmd'),
    join(gac, 'System.Runtime', FACADE, 'System.Runtime.dll'),
    join(gac, 'System.Runtime.InteropServices.WindowsRuntime', FACADE, 'System.Runtime.InteropServices.WindowsRuntime.dll'),
  ]
  if (!compiler || references.some((path) => !existsSync(path))) {
    return { problem: "Ce Windows n'a pas le compilateur du .NET Framework ou les métadonnées WinRT : écoute Bluetooth du hub impossible, passer par une passerelle MQTT." }
  }
  const hash = createHash('sha256').update(WINDOWS_SCANNER_SOURCE).digest('hex').slice(0, 12)
  const executable = join(cacheDir, `sway-ble-scan-${hash}.exe`)
  if (!existsSync(executable)) {
    mkdirSync(cacheDir, { recursive: true })
    const source = join(cacheDir, `sway-ble-scan-${hash}.cs`)
    writeFileSync(source, WINDOWS_SCANNER_SOURCE)
    const output = await new Promise<{ code: number | null; text: string }>((resolve) => {
      const child = spawn(compiler, ['-nologo', '-target:exe', `-out:${executable}`, ...references.map((path) => `-r:${path}`), source], { windowsHide: true })
      let text = ''
      child.stdout.on('data', (chunk: Buffer) => (text += chunk.toString('utf8')))
      child.stderr.on('data', (chunk: Buffer) => (text += chunk.toString('utf8')))
      child.on('error', (error) => resolve({ code: -1, text: error.message }))
      child.on('exit', (code) => resolve({ code, text }))
    })
    if (output.code !== 0 || !existsSync(executable)) {
      const line = output.text.split(/\r?\n/).find((entry) => /error/i.test(entry))?.trim() ?? `code ${output.code}`
      return { problem: `Le scanner Bluetooth ne se compile pas : ${line}` }
    }
  }
  return { command: [executable, options.active === false ? 'passive' : 'active'] }
}

// ---------------------------------------------------------------------------------------
// A gateway on MQTT
// ---------------------------------------------------------------------------------------

export class GatewaySource implements AdvertSource {
  readonly name: string
  readonly #options: { host: string; port: number; username?: string; password?: string; topic: string; connectTimeoutMs?: number }
  #client: MqttClient | null = null

  constructor(options: { host: string; port: number; username?: string; password?: string; topic: string; connectTimeoutMs?: number }) {
    this.#options = options
    this.name = `passerelle MQTT ${options.host}`
  }

  async start(onAdvert: (advert: Advert, decoded?: Values | null) => void, onProblem: (problem: string | null) => void): Promise<boolean> {
    const client = new MqttClient({ host: this.#options.host, port: this.#options.port, username: this.#options.username, password: this.#options.password, clientId: 'sway-home-ble' })
    this.#client = client
    client.onMessage = (_topic, payload) => {
      let json: unknown
      try {
        json = JSON.parse(payload)
      } catch {
        return
      }
      const message = advertFromGateway(json)
      if (message && (message.advert.manufacturer.size > 0 || message.advert.serviceData.size > 0 || message.decoded)) onAdvert(message.advert, message.decoded)
    }
    client.onConnect = () => onProblem(null)
    client.onClose = (reason) => onProblem(`La passerelle MQTT ${this.#options.host} a coupé (${reason}).`)
    client.subscribe(this.#options.topic)
    const ok = await client.connect(this.#options.connectTimeoutMs)
    if (!ok) onProblem(`La passerelle MQTT ${this.#options.host}:${this.#options.port} ne répond pas.`)
    return ok
  }

  async stop(): Promise<void> {
    this.#client?.disconnect()
    this.#client = null
  }
}
