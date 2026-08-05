import { telemetrySchemaVersion, type TelemetryEnvelope } from "@authenti8/event-schemas";

export const macosAgentProtocol = {
  platform: "MACOS",
  telemetrySchemaVersion,
} as const;

export function eventSignature(event: TelemetryEnvelope) {
  return event.signature;
}
