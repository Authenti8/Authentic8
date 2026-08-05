export function trimString(value: unknown) {
  return typeof value === "string" ? value.trim() : value;
}

export function normalizeEmailValue(value: unknown) {
  const trimmed = trimString(value);
  return typeof trimmed === "string" ? trimmed.toLowerCase() : trimmed;
}
