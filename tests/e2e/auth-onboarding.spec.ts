import { test, expect } from "./fixtures";

test("protected routes send anonymous visitors to login", async ({ page }) => {
  await page.goto("/dashboard/team");
  await expect(page).toHaveURL(/\/login\?next=%2Fdashboard%2Fteam/);
});

test("login rejects bad credentials and accepts a valid account", async ({ page }) => {
  await page.goto("/login");
  await page.getByLabel("Work email").fill("owner@acme.test");
  await page.getByLabel("Password").fill("WrongPassword!1");
  await page.getByRole("button", { name: "Log in" }).click();
  await expect(page.getByText("Invalid email or password.")).toBeVisible();
  await page.getByLabel("Password").fill("StrongPassword!1");
  await page.getByRole("button", { name: "Log in" }).click();
  await expect(page).toHaveURL(/\/dashboard$/);
});

test("login does not honor an external next URL", async ({ page }) => {
  await page.goto("/login?next=https://evil.example/steal");
  await page.getByLabel("Work email").fill("owner@acme.test");
  await page.getByLabel("Password").fill("StrongPassword!1");
  await page.getByRole("button", { name: "Log in" }).click();
  await expect(page).toHaveURL(/\/dashboard$/);
});

test("signup applies password validation and rejects personal email", async ({ page }) => {
  await page.goto("/signup");
  await page.getByLabel("Full name").fill("New Owner");
  await page.getByLabel("Work email").fill("owner@gmail.com");
  await page.getByLabel("Password").fill("short");
  await page.getByRole("button", { name: "Create workspace account" }).click();
  await expect(page.getByLabel("Password")).toHaveJSProperty("validity.valid", false);
  await page.getByLabel("Password").fill("StrongPassword!1");
  await page.getByRole("button", { name: "Create workspace account" }).click();
  await expect(page.getByText("Use a work email address.")).toBeVisible();
});

test("verified account can complete organization onboarding", async ({ page, context, baseURL, runId }) => {
  await context.addCookies([{ name: "authenti8_session", value: `OWNER:${runId}:new-owner`, url: baseURL! }]);
  await page.goto("/onboarding");
  await page.getByLabel("Organization name").fill("New Hiring Company");
  await page.getByLabel("Company domain").fill("new-hiring.test");
  await page.getByLabel("Your role").selectOption({ label: "Founder" });
  await page.getByLabel("Company size").selectOption({ label: "11-50" });
  await page.getByRole("button", { name: "Create workspace" }).click();
  await expect(page).toHaveURL(/\/dashboard$/);
  await expect(page.getByText("New Hiring Company", { exact: true }).first()).toBeVisible();
});

test("signup verification establishes a session and reaches onboarding", async ({ page }) => {
  await page.goto("/signup");
  await page.getByLabel("Full name").fill("Verified Owner");
  await page.getByLabel("Work email").fill("verified-owner@company.test");
  await page.getByLabel("Password").fill("StrongPassword!1");
  await page.getByRole("button", { name: "Create workspace account" }).click();
  await page.getByRole("link", { name: "Development preview: verify email" }).click();
  await page.getByLabel("Confirm your signup password").fill("StrongPassword!1");
  await page.getByRole("button", { name: "Verify email and continue" }).click();
  await expect(page).toHaveURL(/\/onboarding$/);
});
