const localOrigin = "http://localhost:3000";

export function dashboardOrigin() {
  return origin(process.env.DASHBOARD_ORIGIN ?? process.env.APP_ORIGIN ?? localOrigin);
}

export function paymentOrigin() {
  return origin(process.env.PAYMENT_ORIGIN ?? dashboardOrigin());
}

function origin(value: string) {
  return new URL(value).origin;
}
