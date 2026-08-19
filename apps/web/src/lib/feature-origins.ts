const localOrigin = "http://localhost:3000";
const testOrigin = process.env.NODE_ENV !== "production"
  ? process.env.AUTHENTI8_E2E_ORIGIN
  : undefined;

export function dashboardOrigin() {
  return origin(testOrigin ?? process.env.DASHBOARD_ORIGIN
    ?? process.env.APP_ORIGIN ?? localOrigin);
}

export function paymentOrigin() {
  return origin(testOrigin ?? process.env.PAYMENT_ORIGIN ?? dashboardOrigin());
}

function origin(value: string) {
  return new URL(value).origin;
}
