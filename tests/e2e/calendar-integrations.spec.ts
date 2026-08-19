import { test, expect } from "./fixtures";

for (const role of ["OWNER", "MANAGER", "HR"] as const) {
  test(`${role} can connect and disconnect its own Google Calendar`, async ({ page, loginAs }) => {
    await loginAs(role); await page.goto("/dashboard/integrations");
    await page.getByRole("button", { name: "Connect Google Calendar" }).click();
    await expect(page).toHaveURL(/connected=google/);
    await expect(page.getByText(`Connected as ${role.toLowerCase()}@acme.test`)).toBeVisible();
    await expect(page.getByRole("button", { name: "Sync now" })).toBeVisible();
    await page.getByRole("button", { name: "Disconnect" }).click();
    await expect(page.getByRole("button", { name: "Connect Google Calendar" })).toBeVisible();
  });
}

test("calendar connections are isolated between HR interviewers", async ({ browser, baseURL, runId }) => {
  const firstHr = await browser.newContext();
  const secondHr = await browser.newContext();
  await firstHr.addCookies([{ name: "authenti8_session", value: `HR:${runId}:hr-one`, url: baseURL! }]);
  await secondHr.addCookies([{ name: "authenti8_session", value: `HR:${runId}:hr-two`, url: baseURL! }]);
  const firstPage = await firstHr.newPage(); const secondPage = await secondHr.newPage();
  const firstSession = await sessionIdentity(firstPage);
  const secondSession = await sessionIdentity(secondPage);
  expect(firstSession.id).not.toBe(secondSession.id);
  await firstPage.goto("/dashboard/integrations");
  await firstPage.getByRole("button", { name: "Connect Google Calendar" }).click();
  await expect(firstPage.getByText("Connected as hr-one@acme.test")).toBeVisible();
  await secondPage.goto("/dashboard/integrations");
  await expect(secondPage.getByRole("button", { name: "Connect Google Calendar" })).toBeVisible();
  await secondPage.getByRole("button", { name: "Connect Google Calendar" }).click();
  await expect(secondPage.getByText("Connected as hr-two@acme.test")).toBeVisible();
  await firstPage.reload();
  await expect(firstPage.getByText("Connected as hr-one@acme.test")).toBeVisible();
  await firstHr.close(); await secondHr.close();
});

test("ten HR calendars stay independently connected", async ({ browser, baseURL, runId }) => {
  test.setTimeout(90_000);
  const contexts = await Promise.all(Array.from({ length: 10 }, async (_, index) => {
    const context = await browser.newContext();
    const user = index ? `hr-${index}` : "hr";
    await context.addCookies([{ name: "authenti8_session", value: `HR:${runId}:${user}`,
      url: baseURL! }]);
    const page = await context.newPage();
    await page.goto("/dashboard/integrations");
    await page.getByRole("button", { name: "Connect Google Calendar" }).click();
    await expect(page.getByText(`Connected as ${user}@acme.test`)).toBeVisible();
    return { context, page, user };
  }));
  const disconnected = contexts[0]!.page.waitForResponse((response) =>
    response.url().endsWith("/integrations/google/disconnect"));
  await contexts[0]!.page.getByRole("button", { name: "Disconnect" }).click();
  expect((await disconnected).ok()).toBe(true);
  await contexts[0]!.page.reload();
  await expect(contexts[0]!.page.getByRole("button", { name: "Connect Google Calendar" })).toBeVisible();
  for (const connected of contexts.slice(1)) {
    await connected.page.reload();
    await expect(connected.page.getByText(`Connected as ${connected.user}@acme.test`)).toBeVisible();
  }
  await Promise.all(contexts.map(({ context }) => context.close()));
});

async function sessionIdentity(page: import("@playwright/test").Page) {
  const response = await page.request.get("/api/v1/auth/session");
  expect(response.ok()).toBe(true);
  return (await response.json() as { user: { id: string } }).user;
}
