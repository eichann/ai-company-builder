/**
 * Unit Test: which addresses the key broker's relay refuses (SSRF guard,
 * lib/net-ranges.ts), and that the request log never prints a relay query.
 *
 * Every internal form an attacker could make a destination name resolve to is
 * refused — loopback, RFC 1918, carrier-grade NAT, link-local / the cloud
 * metadata address, IPv6 unique-local and link-local, IPv4 hidden in IPv6
 * (mapped, NAT64, 6to4) — and ordinary public addresses pass.
 */
import { describe, it, expect } from 'vitest'
import { isPrivateAddress } from '../../src/lib/net-ranges'
import { redactBrokerQuery } from '../../src/lib/log-redaction'

describe('the relay refuses private and internal addresses', () => {
  it.each([
    '127.0.0.1', '127.255.255.254', '10.0.0.1', '172.16.0.1', '172.31.255.255', '192.168.1.10', '100.64.0.1',
    '169.254.169.254', '169.254.0.1', '0.0.0.0', '224.0.0.1', '255.255.255.255', '198.18.0.1', '192.0.2.1',
    '::1', '::', 'fe80::1', 'fd00::1', 'fc00::abcd', 'ff02::1', 'fec0::1',
    '::ffff:127.0.0.1', '::ffff:169.254.169.254', '::ffff:a9fe:a9fe', '::ffff:10.0.0.1',
    '64:ff9b::a9fe:a9fe', '64:ff9b::7f00:1', '2002:7f00:1::', '2002:a9fe:a9fe::1',
    'not-an-ip', '',
  ])('%s is refused', (address) => {
    expect(isPrivateAddress(address)).toBe(true)
  })

  it.each(['8.8.8.8', '142.250.196.10', '172.32.0.1', '100.128.0.1', '2607:f8b0:4004:800::200e', '::ffff:8.8.8.8', '64:ff9b::808:808', '2002:808:808::1'])(
    '%s passes', (address) => {
      expect(isPrivateAddress(address)).toBe(false)
    })
})

describe('request log', () => {
  it('never prints the query of a relay request (a token may be in ?key=)', () => {
    const token = `acb_tok_${'a'.repeat(64)}`
    const line = `<-- POST /api/broker/gemini/v1beta/models/gemini-2.5-flash:generateContent?key=${token}&alt=sse`
    expect(redactBrokerQuery(line)).not.toContain(token)
    expect(redactBrokerQuery(line)).toContain('/api/broker/gemini/v1beta/models/gemini-2.5-flash:generateContent')
    expect(redactBrokerQuery('<-- GET /api/companies/x/files/search?q=hello')).toContain('q=hello')
  })
})
