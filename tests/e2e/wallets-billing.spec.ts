import { test, expect } from "./fixtures";

test("owner allocates only existing organization credits to HR", async ({ page, loginAs }) => {
  await loginAs("OWNER"); await page.goto("/dashboard/wallets");
  await expect(page.getByLabel("HR wallet totals").getByText("0", { exact: true }).first()).toBeVisible();
  await page.getByRole("spinbutton", { name: "Credits" }).fill("5");
  await page.getByPlaceholder("Why is this allocation changing?").fill("Initial interview allocation");
  await page.getByRole("button", { name: "Apply change" }).click();
  await expect(page.getByLabel("HR wallet totals").getByText("5", { exact: true })).toBeVisible();
  await expect(page.getByText("5 credits available", { exact: false }).first()).toBeVisible();
});

test("backend rejects allocation beyond organization balance", async ({ page, loginAs }) => {
  await loginAs("OWNER");
  const response = await page.request.post("/api/v1/organization/members/wallets", { data: {
    memberUserId: "33333333-3333-4333-8333-333333333333", operation: "GRANT",
    quantity: 11, reason: "Attempt excessive allocation", idempotencyKey: crypto.randomUUID(),
  } });
  expect(response.status()).toBe(409);
  await expect(response.json()).resolves.toMatchObject({ error: "Insufficient organization credits." });
});

test("manager can allocate HR credits but cannot access purchase delegation", async ({ page, loginAs }) => {
  await loginAs("MANAGER"); await page.goto("/dashboard/wallets");
  await expect(page.getByRole("button", { name: "Apply change" })).toBeVisible();
  await expect(page.getByRole("heading", { name: "Manager purchase access" })).toHaveCount(0);
});

test("HR sees its wallet but cannot alter allocation or billing", async ({ page, loginAs }) => {
  await loginAs("HR"); await page.goto("/dashboard/wallets");
  await expect(page.getByRole("article").getByText("hr@acme.test")).toBeVisible();
  await expect(page.getByRole("button", { name: "Apply change" })).toHaveCount(0);
  await expect(page.getByRole("heading", { name: "Manager purchase access" })).toHaveCount(0);
});

test("HR cannot bypass wallet controls through the API", async ({ page, loginAs }) => {
  await loginAs("HR");
  const response = await page.request.post("/api/v1/organization/members/wallets", { data: {
    memberUserId: "33333333-3333-4333-8333-333333333333", operation: "GRANT",
    quantity: 1, reason: "Unauthorized self allocation", idempotencyKey: crypto.randomUUID(),
  } });
  expect(response.status()).toBe(403);
});

test("reservation worker can reserve exactly five HR interviews and not a sixth", async ({ page, loginAs }) => {
  await loginAs("OWNER");
  const allocation = await page.request.post("/api/v1/organization/members/wallets", { data: {
    memberUserId: "33333333-3333-4333-8333-333333333333", operation: "GRANT",
    quantity: 5, reason: "Five HR interviews", idempotencyKey: crypto.randomUUID(),
  } });
  expect(allocation.status()).toBe(200);

  const meetings = Array.from({ length: 6 }, () => crypto.randomUUID());
  const reserve = (meetingId: string) => page.request.post(
    `/api/v1/internal/workspace/meetings/${meetingId}/reserve`,
    { headers: { authorization: "Bearer e2e-cron-secret" } },
  );
  const publicRoute = await page.request.post(`/api/v1/meetings/${meetings[0]}/reserve`);
  expect(publicRoute.status()).toBe(404);
  const unauthorized = await page.request.post(
    `/api/v1/internal/workspace/meetings/${meetings[0]}/reserve`,
  );
  expect(unauthorized.status()).toBe(401);

  let firstReservationId = "";
  for (const meetingId of meetings.slice(0, 5)) {
    const reserved = await reserve(meetingId);
    expect(reserved.status()).toBe(201);
    const result = await reserved.json();
    expect(result).toMatchObject({ reserved: true });
    if (!firstReservationId) firstReservationId = result.reservationId;
  }
  const repeated = await reserve(meetings[0]);
  expect(repeated.status()).toBe(201);
  await expect(repeated.json()).resolves.toEqual({ reserved: true, reservationId: firstReservationId });

  const sixth = await reserve(meetings[5]);
  expect(sixth.status()).toBe(201);
  await expect(sixth.json()).resolves.toEqual({ reserved: false, reason: "NO_HR_ALLOCATION" });
  const wallets = await (await page.request.get("/api/v1/organization/members/wallets")).json();
  expect(wallets.wallets[0]).toMatchObject({ available: 0, reserved: 5, consumed: 0 });
  const overview = await (await page.request.get("/api/v1/overview")).json();
  expect(overview.balance).toBe(5);
});
