const paymentData = { data_collection: ['financialAndPaymentInfo'] };

// Firefox declares optional payment data in its manifest and can revoke it in the add-on manager.
export async function paymentConsent(request = false) {
  const api = globalThis.browser ?? chrome;
  if (!api.runtime.getManifest?.().browser_specific_settings?.gecko) return true;
  return request ? api.permissions.request(paymentData) : api.permissions.contains(paymentData);
}
