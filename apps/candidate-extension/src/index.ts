import { telemetrySchemaVersion, type TelemetryEnvelope } from "@authenti8/event-schemas";

export const candidateExtensionProtocol = {
  producer: "candidate-extension",
  telemetrySchemaVersion,
} as const;

export function eventSequence(event: TelemetryEnvelope) {
  return event.sequenceNumber;
}
