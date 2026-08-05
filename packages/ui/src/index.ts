export const brandTokens = {
  color: { primary: "#1268f3", ink: "#0b1220", surface: "#ffffff" },
  radius: { control: "0.75rem", card: "1.5rem" },
} as const;

export type StatusTone = "neutral" | "healthy" | "warning" | "confirmed";
