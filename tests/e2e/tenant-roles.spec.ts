import { test, expect } from "./fixtures";

for (const role of ["OWNER", "MANAGER", "HR"] as const) {
  test(`${role} remains in the same organization`, async ({ page, loginAs }) => {
    await loginAs(role);
    await page.goto("/dashboard/team");
    await expect(page.getByText("Acme Hiring", { exact: true }).first()).toBeVisible();
    await expect(page.getByText(role, { exact: true }).first()).toBeVisible();
    await expect(page.getByRole("main").getByText("owner@acme.test")).toBeVisible();
    await expect(page.getByRole("main").getByText("manager@acme.test")).toBeVisible();
    await expect(page.getByRole("main").getByText("hr@acme.test")).toBeVisible();
  });
}

test("owner can invite managers and HR", async ({ page, loginAs }) => {
  await loginAs("OWNER"); await page.goto("/dashboard/team");
  await expect(page.getByLabel("Organization role")).toContainText("Manager");
  await expect(page.getByRole("button", { name: "Send invitation" })).toBeVisible();
});

test("manager can invite HR but not another manager", async ({ page, loginAs }) => {
  await loginAs("MANAGER"); await page.goto("/dashboard/team");
  await expect(page.getByLabel("Organization role")).not.toContainText("Manager");
  await expect(page.getByLabel("Organization role")).toHaveValue("HR");
});

test("HR cannot invite or manage organization members", async ({ page, loginAs }) => {
  await loginAs("HR"); await page.goto("/dashboard/team");
  await expect(page.getByRole("heading", { name: "Invite member" })).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Update" })).toHaveCount(0);
});

test("API rejects HR invitation escalation", async ({ page, loginAs }) => {
  await loginAs("HR");
  const response = await page.request.post("/api/v1/organization/members/invite", {
    data: { email: "attacker@acme.test", role: "MANAGER" },
  });
  expect(response.status()).toBe(403);
});

test("tenant members cannot be targeted through another organization", async ({
  page, browser, baseURL, runId, loginAs,
}) => {
  await loginAs("OWNER");
  const foreignContext = await browser.newContext();
  await foreignContext.addCookies([{ name: "authenti8_session", value: `HR:${runId}:hr:tenant-b`, url: baseURL! }]);
  const foreignMembers = await foreignContext.request.get(`${baseURL}/api/v1/organization/members`);
  const foreignHr = (await foreignMembers.json()).members.find((member: { role: string }) => member.role === "HR");
  await foreignContext.close();

  const request = (memberUserId: string) => page.request.post("/api/v1/organization/members/wallets", { data: {
    memberUserId, operation: "GRANT", quantity: 1, reason: "Isolation verification",
    idempotencyKey: crypto.randomUUID(),
  } });
  const foreign = await request(foreignHr.userId);
  const missing = await request("99999999-9999-4999-8999-999999999999");
  expect(foreign.status()).toBe(404);
  expect(missing.status()).toBe(404);
  expect(await foreign.json()).toEqual(await missing.json());
});
