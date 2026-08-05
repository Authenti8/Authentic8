import { telemetrySchemaVersion, type TelemetryEnvelope } from "@authenti8/event-schemas";

const eventTypes = new Set([
  "HEARTBEAT", "MONITORING_STARTED", "MONITORING_STOPPED",
  "PROCESS_OBSERVED", "WINDOW_OBSERVED", "PERMISSION_CHANGED",
]);
const platforms = new Set(["WINDOWS", "MACOS", "CHROME"]);
const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const sha256Pattern = /^[0-9a-f]{64}$/i;
const rfc3339Pattern = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.\d{1,9})?(Z|[+-]\d{2}:\d{2})$/;

export function isTelemetryEnvelope(value: unknown): value is TelemetryEnvelope {
  if (!isRecord(value)) return false;
  return value.schemaVersion === telemetrySchemaVersion
    && isUuid(value.eventId)
    && isUuid(value.verificationSessionId)
    && isNonNegativeSafeInteger(value.sequenceNumber)
    && typeof value.eventType === "string" && eventTypes.has(value.eventType)
    && isIsoTimestamp(value.eventTimestamp)
    && isNonNegativeSafeInteger(value.monotonicTimestamp)
    && typeof value.platform === "string" && platforms.has(value.platform)
    && isNonEmptyString(value.agentVersion)
    && isNonEmptyString(value.rulePackVersion)
    && isRecord(value.payload)
    && isSha256(value.payloadHash)
    && (value.previousEventHash === undefined || isSha256(value.previousEventHash))
    && isNonEmptyString(value.signature);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}

function isUuid(value: unknown) {
  return typeof value === "string" && uuidPattern.test(value);
}

function isNonNegativeSafeInteger(value: unknown) {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

function isIsoTimestamp(value: unknown) {
  if (typeof value !== "string") return false;
  const match = rfc3339Pattern.exec(value);
  if (!match) return false;
  const [, yearText, monthText, dayText, hourText, minuteText, secondText, zone] = match;
  const year = Number(yearText);
  const month = Number(monthText);
  const day = Number(dayText);
  const timeIsValid = Number(hourText) <= 23
    && Number(minuteText) <= 59
    && Number(secondText) <= 59;
  return year > 0
    && month >= 1 && month <= 12
    && day >= 1 && day <= daysInMonth(year, month)
    && timeIsValid
    && validOffset(zone!);
}

function daysInMonth(year: number, month: number) {
  if (month === 2) return isLeapYear(year) ? 29 : 28;
  return [4, 6, 9, 11].includes(month) ? 30 : 31;
}

function isLeapYear(year: number) {
  return year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
}

function validOffset(zone: string) {
  if (zone === "Z") return true;
  const [hours, minutes] = zone.slice(1).split(":").map(Number);
  return hours! <= 23 && minutes! <= 59;
}

function isNonEmptyString(value: unknown) {
  return typeof value === "string" && value.trim().length > 0;
}

function isSha256(value: unknown) {
  return typeof value === "string" && sha256Pattern.test(value);
}
