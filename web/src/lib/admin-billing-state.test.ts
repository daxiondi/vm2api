import { afterEach, describe, expect, it, vi } from 'vitest'
import { isAdminBillingPaused } from '@/lib/admin-billing-state'

afterEach(() => vi.unstubAllGlobals())

describe('isAdminBillingPaused', () => {
  it('keeps billing active when no pause flag is set', () => {
    expect(isAdminBillingPaused()).toBe(false)
  })

  it.each([undefined, false, 'true', 1, null])(
    'does not pause billing for the non-boolean flag %s',
    (flag) => {
      vi.stubGlobal('__VM2API_ADMIN_BILLING_PAUSED__', flag)
      expect(isAdminBillingPaused()).toBe(false)
    }
  )

  it('reads pause and resume changes without reloading the module', () => {
    vi.stubGlobal('__VM2API_ADMIN_BILLING_PAUSED__', true)
    expect(isAdminBillingPaused()).toBe(true)

    vi.stubGlobal('__VM2API_ADMIN_BILLING_PAUSED__', false)
    expect(isAdminBillingPaused()).toBe(false)
  })
})
