/**
 * Plays the Windows Bluetooth scanner in tests: prints the JSON lines of a file, then behaves
 * as told. With "radio-off" it ends like the real one when Bluetooth is switched off (its
 * stopped notice, exit code 2); otherwise it waits for stdin to close, as the real one does,
 * and writes "closed" into the marker file when it does.
 *
 * Usage: bun fake_ble_scanner.ts <lines file> [radio-off | wait] [marker file]
 */

import { appendFileSync, readFileSync } from 'node:fs'

const [file, mode, marker] = process.argv.slice(2)
for (const line of readFileSync(file!, 'utf8').split('\n').filter(Boolean)) process.stdout.write(`${line}\n`)
if (mode === 'radio-off') {
  process.stdout.write('{"stopped":"RadioNotAvailable"}\n')
  process.exit(2)
}
process.stdin.resume()
process.stdin.on('end', () => {
  if (marker) appendFileSync(marker, 'closed\n')
  process.exit(0)
})
