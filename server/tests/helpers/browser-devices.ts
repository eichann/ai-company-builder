/**
 * A PC check that lets every step through and binds nothing, for the plan services' own tests (their rules are not the
 * PC's). The PC registration itself — with the real plan services — is tests/unit/browser-devices.test.ts.
 */
import type { BrowserDeviceGate } from '../../src/services/browser-devices'

export const anyPc: BrowserDeviceGate = {
  check: () => ({ ok: true, value: { deviceId: null } }),
  bind: () => {},
}
