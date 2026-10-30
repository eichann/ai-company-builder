/**
 * Which IP addresses the key broker's relay must not connect to
 * (.claude/rules/key-broker.md, owner decision 2026-10-30): loopback,
 * private (RFC 1918), shared / carrier-grade NAT, link-local (incl. the
 * cloud metadata address 169.254.169.254), unique-local IPv6, multicast,
 * documentation, benchmarking and reserved ranges. IPv4 embedded in IPv6
 * (mapped `::ffff:a.b.c.d`, NAT64 `64:ff9b::/96`, 6to4 `2002::/16`) is judged
 * by the embedded IPv4 address.
 *
 * Pure apart from node:net (BlockList, isIP). Anything that is not an IP
 * address counts as not allowed.
 */
import { BlockList, isIP } from 'net'

const BLOCKED = new BlockList()
for (const [address, prefix] of [
  ['0.0.0.0', 8], // "this network"
  ['10.0.0.0', 8],
  ['100.64.0.0', 10], // shared address space (carrier-grade NAT)
  ['127.0.0.0', 8],
  ['169.254.0.0', 16], // link-local, cloud metadata
  ['172.16.0.0', 12],
  ['192.0.0.0', 24], // IETF protocol assignments
  ['192.0.2.0', 24], // TEST-NET-1
  ['192.88.99.0', 24], // 6to4 relay anycast
  ['192.168.0.0', 16],
  ['198.18.0.0', 15], // benchmarking
  ['198.51.100.0', 24], // TEST-NET-2
  ['203.0.113.0', 24], // TEST-NET-3
  ['224.0.0.0', 4], // multicast
  ['240.0.0.0', 4], // reserved, broadcast
] as const) BLOCKED.addSubnet(address, prefix, 'ipv4')
for (const [address, prefix] of [
  ['::', 128], // unspecified
  ['::1', 128], // loopback
  ['::', 96], // IPv4-compatible (deprecated)
  ['100::', 64], // discard
  ['2001::', 23], // IETF protocol assignments (Teredo, ORCHID, …)
  ['2001:db8::', 32], // documentation
  ['fc00::', 7], // unique local
  ['fe80::', 10], // link-local
  ['fec0::', 10], // site-local (deprecated)
  ['ff00::', 8], // multicast
] as const) BLOCKED.addSubnet(address, prefix, 'ipv6')

/** The IPv4 address inside a NAT64 or 6to4 IPv6 address, if any. */
function embeddedIpv4(ipv6: string): string | null {
  const groups = expandIpv6(ipv6)
  if (!groups) return null
  const v4 = (hi: number, lo: number) => `${hi >> 8}.${hi & 0xff}.${lo >> 8}.${lo & 0xff}`
  // 64:ff9b::/96
  if (groups[0] === 0x64 && groups[1] === 0xff9b && groups.slice(2, 6).every(g => g === 0)) return v4(groups[6], groups[7])
  // 2002:AABB:CCDD::/48
  if (groups[0] === 0x2002) return v4(groups[1], groups[2])
  return null
}

function expandIpv6(ipv6: string): number[] | null {
  let text = ipv6.toLowerCase().split('%')[0]
  const dotted = /(\d+\.\d+\.\d+\.\d+)$/.exec(text)
  if (dotted) {
    const p = dotted[1].split('.').map(Number)
    text = text.slice(0, -dotted[1].length) + `${((p[0] << 8) | p[1]).toString(16)}:${((p[2] << 8) | p[3]).toString(16)}`
  }
  const [head, tail] = text.split('::')
  const h = head ? head.split(':') : []
  const t = tail !== undefined && tail ? tail.split(':') : []
  const fill = text.includes('::') ? 8 - h.length - t.length : 0
  const all = [...h, ...Array(fill).fill('0'), ...t]
  if (all.length !== 8) return null
  const out = all.map(g => parseInt(g, 16))
  return out.every(n => Number.isInteger(n) && n >= 0 && n <= 0xffff) ? out : null
}

/** true for any address the relay must not reach without the company's explicit exception. */
export function isPrivateAddress(address: string): boolean {
  const family = isIP(address)
  if (family === 4) return BLOCKED.check(address, 'ipv4')
  if (family === 6) {
    if (BLOCKED.check(address, 'ipv6')) return true
    const inner = embeddedIpv4(address)
    return inner !== null && BLOCKED.check(inner, 'ipv4')
  }
  return true
}
