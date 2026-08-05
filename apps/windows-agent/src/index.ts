import { telemetrySchemaVersion, type TelemetryEnvelope } from "@authenti8/event-schemas";

export const windowsAgentProtocol = {
  platform: "WINDOWS",
  telemetrySchemaVersion,
} as const;

export function eventSignature(event: TelemetryEnvelope) {
  return event.signature;
}
