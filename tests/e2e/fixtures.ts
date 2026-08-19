import { test as base, expect, type BrowserContext } from "@playwright/test";

type Role = "OWNER" | "MANAGER" | "HR";
type Fixtures = { loginAs: (role: Role) => Promise<void>; runId: string };

export const test = base.extend<Fixtures>({
  runId: async ({}, provide, testInfo) => provide(`${testInfo.workerIndex}-${testInfo.repeatEachIndex}-${Date.now()}`),
  loginAs: async ({ context, baseURL, runId }, provide) => {
    await provide(async (role) => setSession(context, baseURL!, role, runId));
  },
});

async function setSession(context: BrowserContext, baseURL: string, role: Role, runId: string) {
  await context.addCookies([{ name: "authenti8_session", value: `${role}:${runId}`,
    url: baseURL, httpOnly: true, sameSite: "Lax" }]);
}

export { expect };
