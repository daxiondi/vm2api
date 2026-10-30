type AdminBillingGlobal = typeof globalThis & {
  __VM2API_ADMIN_BILLING_PAUSED__?: unknown
}

export function isAdminBillingPaused(): boolean {
  return (
    (globalThis as AdminBillingGlobal).__VM2API_ADMIN_BILLING_PAUSED__ === true
  )
}
