const hostnamePattern = /^(?=.{3,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/;

export function normalizeDomain(input: string) {
  let value = input.trim().toLowerCase();
  value = value.replace(/^https?:\/\//, "").split("/")[0] ?? "";
  value = value.replace(/^www\./, "").replace(/\.$/, "");
  if (!hostnamePattern.test(value)) return null;
  return value;
}

export function isValidTimezone(timezone: string) {
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: timezone }).format();
    return true;
  } catch {
    return false;
  }
}
