/**
 * Standalone scan, so discovery can be exercised without booting the hub.
 *   bun run scripts/scan.ts            quick pass, about 8 seconds
 *   bun run scripts/scan.ts --full     full sweep of the subnet
 *   bun run scripts/scan.ts --json     machine-readable output
 */
import { scanNetwork } from '../packages/discovery/src/scanner.ts'
import { fallbackName } from '../packages/discovery/src/fingerprint.ts'

const args = new Set(process.argv.slice(2))
const quick = !args.has('--full')
const json = args.has('--json')

const result = await scanNetwork({
  quick,
  deep: args.has('--deep'),
  ouiRegistryPath: new URL('../data/oui.csv', import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1'),
  onProgress: (p) => {
    if (json) return
    const bar = p.total > 1 ? ` ${p.done}/${p.total}` : ''
    process.stdout.write(`\r  ${p.phase.padEnd(12)}${bar.padEnd(14)} found ${p.found}${p.message ? ` (${p.message})` : ''}          `)
  },
})

if (json) {
  console.log(JSON.stringify({ ...result, fingerprints: Object.fromEntries(result.fingerprints) }, null, 2))
} else {
  process.stdout.write('\n\n')
  console.log(`Interface  ${result.interface?.name ?? 'unknown'}  ${result.interface?.address ?? ''}  ${result.interface?.cidr ?? ''}`)
  console.log(`Duration   ${result.durationMs} ms   hosts ${result.stats.total}  (arp ${result.stats.arp}, mdns ${result.stats.mdns}, ssdp ${result.stats.ssdp}, tcp ${result.stats.sweep})\n`)
  const rows = result.hosts.map((host) => {
    const fp = result.fingerprints.get(host.ip)
    return {
      ip: host.ip,
      name: fallbackName(host, fp!),
      category: fp?.category ?? 'unknown',
      vendor: fp?.vendor ?? host.macVendor ?? '-',
      conf: fp ? `${Math.round(fp.confidence * 100)}%` : '-',
      mac: host.mac ?? '-',
      ports: host.openPorts.slice(0, 8).join(',') || '-',
      adapters: (fp?.suggestedAdapters ?? []).slice(0, 3).join(',') || '-',
    }
  })
  console.table(rows)
  if (result.unrecognisedServices.length > 0) {
    console.log('\nmDNS service types seen with no rule yet:')
    for (const type of result.unrecognisedServices) console.log(`  ${type}`)
  }
  for (const host of result.hosts) {
    const fp = result.fingerprints.get(host.ip)
    if (fp && fp.evidence.length > 0) console.log(`\n${host.ip}  ${fp.evidence.join(' | ')}`)
  }
}
