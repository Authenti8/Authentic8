const CHECKOUT_HOSTS = new Set([
  "checkout.dodopayments.com",
  "test.checkout.dodopayments.com",
  "test.dodopayments.com",
]);

const PORTAL_HOSTS = new Set([
  "customer.dodopayments.com",
  "test.customer.dodopayments.com",
]);

export function assertDodoCheckoutUrl(value: string) {
  assertDodoUrl(value, CHECKOUT_HOSTS, "checkout");
}

export function assertDodoPortalUrl(value: string) {
  assertDodoUrl(value, PORTAL_HOSTS, "portal");
}

function assertDodoUrl(value: string, hosts: ReadonlySet<string>, label: string) {
  try {
    const url = new URL(value);
    if (url.protocol !== "https:" || url.username || url.password || url.port
      || !hosts.has(url.hostname)) {
      throw new Error(`Untrusted ${label} URL`);
    }
  } catch {
    throw new Error(`Invalid Dodo ${label} URL`);
  }
}
