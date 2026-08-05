import { telemetrySchemaVersion, type TelemetryEnvelope } from "@authenti8/event-schemas";

export const recruiterExtensionProtocol = {
  consumer: "recruiter-extension",
  telemetrySchemaVersion,
} as const;

export function eventSessionId(event: TelemetryEnvelope) {
  return event.verificationSessionId;
}
