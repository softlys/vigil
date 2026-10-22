import { expect, test, type Page } from "@playwright/test";

const PASSWORD = "vigil-demo-2026";

async function login(page: Page, email: string) {
  await page.goto("/login");
  await page.getByLabel("Email").fill(email);
  await page.getByLabel("Password").fill(PASSWORD);
  await page.getByRole("button", { name: "Sign in" }).click();
  await expect(page.getByRole("heading", { level: 1, name: "Security Operations Center" })).toBeVisible();
}

/** The worker backfills the simulated history on first start; wait until incidents exist. */
async function waitForIncidents(page: Page) {
  await expect(async () => {
    await page.goto("/incidents");
    await expect(page.getByTestId("incident-row").first()).toBeVisible({ timeout: 2_000 });
  }).toPass({ timeout: 60_000 });
}

test.describe("VIGIL", () => {
  test("requires authentication everywhere and rejects wrong passwords", async ({ page, request }) => {
    await page.goto("/incidents");
    await expect(page).toHaveURL(/\/login\?next=%2Fincidents$/);
    await expect(page.getByTestId("demo-credentials")).toBeVisible();
    await page.getByLabel("Email").fill("admin@vigil.example");
    await page.getByLabel("Password").fill("wrong-password");
    await page.getByRole("button", { name: "Sign in" }).click();
    await expect(page.getByText("Email or password is incorrect.")).toBeVisible();
    // The email stays filled in after a failed attempt.
    await expect(page.getByLabel("Email")).toHaveValue("admin@vigil.example");
    expect((await request.get("/api/health")).status()).toBe(200);
    const headers = (await request.get("/login")).headers();
    expect(headers["content-security-policy"]).toContain("frame-ancestors 'none'");
    expect(headers["strict-transport-security"]).toContain("max-age");
  });

  test("analyst: open an alert, pivot to related events, see the raw event and its chain position", async ({ page }) => {
    await login(page, "analyst@vigil.example");
    await waitForIncidents(page);
    await expect(page.getByTestId("simulated-banner")).toBeVisible();

    await page.goto("/alerts?rule=VGL-001");
    const alert = page.getByTestId("alert-row").first();
    await expect(alert).toContainText("Brute force against one account");
    await expect(alert).toContainText("Simulated");
    await alert.getByRole("link").first().click();

    await expect(page.getByTestId("incident-alert").first()).toContainText("VGL-001");
    await expect(page.getByRole("link", { name: "T1110.001" })).toBeVisible();
    // Pivot: from a related event to everything from the attacker IP.
    const ipLink = page.getByTestId("related-event").first().getByRole("link", { name: /^203\.0\.113\./ });
    const ip = (await ipLink.innerText()).trim();
    await ipLink.click();
    await expect(page).toHaveURL(new RegExp(`/events\\?range=30d&ip=${ip.replace(/\./g, "\\.")}`));
    await expect(page.getByTestId("event-row").first()).toContainText(ip);
    // The same attacker IP shows up across scenarios; the brute-force failures are among them.
    const failure = page.getByTestId("event-row").filter({ hasText: "auth.login_failed" }).first();
    await expect(failure).toBeVisible();

    await failure.getByRole("link").first().click();
    await expect(page.getByTestId("raw-json")).toContainText('"prev_hash"');
    await expect(page.getByText("Verified on ingest: sequence, link and hash.")).toBeVisible();

    // Analysts cannot reach admin settings.
    await page.goto("/settings");
    await expect(page.getByRole("heading", { name: "You don't have access to this page" })).toBeVisible();
  });

  test("response: analyst proposes, admin approves a simulated action with a reason", async ({ page }) => {
    await login(page, "analyst@vigil.example");
    await waitForIncidents(page);
    await page.goto("/alerts?rule=VGL-008");
    await page.getByTestId("alert-row").first().getByRole("link").first().click();
    await page.getByRole("button", { name: /^Revoke API key/ }).first().click();
    await expect(page.getByTestId("response-action").first()).toContainText("Proposed".toLowerCase(), { ignoreCase: true });
    await expect(page.getByText("Waiting for an admin to approve or reject.")).toBeVisible();
    const incidentUrl = page.url();

    await page.context().clearCookies();
    await login(page, "admin@vigil.example");
    await page.goto(incidentUrl);
    await page.getByRole("button", { name: "Approve" }).click();
    const dialog = page.getByRole("dialog");
    await expect(dialog).toContainText("no request is sent to NEXORA");
    await expect(dialog.getByRole("button", { name: "Approve and execute" })).toBeDisabled();
    await dialog.getByLabel("Reason (required)").fill("Revoked key used from attacker infrastructure");
    await dialog.getByRole("button", { name: "Approve and execute" }).click();
    await expect(page.getByTestId("response-action").first()).toContainText("Executed");
    await expect(page.getByTestId("timeline-entry").filter({ hasText: "Executed (simulated)" })).toBeVisible();

    await page.goto("/audit");
    await expect(page.getByTestId("audit-row").filter({ hasText: "response.executed" })).toBeVisible();
  });

  test("admin: run a scenario from Settings and backtest a rule", async ({ page }) => {
    await login(page, "admin@vigil.example");
    await waitForIncidents(page);
    await page.goto("/settings");
    await page.getByTestId("run-ssrf_attempt").click();
    await expect(page.getByText(/SSRF attempt: \d+ simulated events?, \d+ new alerts?/)).toBeVisible({ timeout: 30_000 });

    await page.goto("/rules/VGL-002");
    await page.getByRole("button", { name: "Run backtest" }).click();
    await expect(page.getByTestId("backtest-result")).toContainText(/1 alert over \d+ evaluated events/);
  });

  test("QA regressions: return to the requested page, admin-only nav, 404, filters and paging", async ({ page }) => {
    await page.goto("/rules/VGL-003");
    await expect(page).toHaveURL(/\/login\?next=%2Frules%2FVGL-003$/);
    await page.getByLabel("Email").fill("analyst@vigil.example");
    await page.getByLabel("Password").fill(PASSWORD);
    await page.getByRole("button", { name: "Sign in" }).click();
    await expect(page).toHaveURL(/\/rules\/VGL-003$/);
    // Analysts do not see Settings in the navigation.
    await expect(page.getByRole("navigation", { name: "Main" }).getByRole("link", { name: "Settings" })).toHaveCount(0);

    const missing = await page.goto("/no-such-page");
    expect(missing!.status()).toBe(404);
    await expect(page.getByRole("heading", { name: "This page does not exist" })).toBeVisible();

    await page.goto("/alerts?severity=bogus");
    await expect(page.getByTestId("ignored-filters")).toContainText("severity=bogus");
    await page.goto("/audit?page=999");
    await expect(page).not.toHaveURL(/page=999/);
  });

  test("admin: integrity rules stay on, turning a rule off needs a reason, new users must change their password", async ({ page }) => {
    await login(page, "admin@vigil.example");
    await page.goto("/rules");
    await expect(page.getByRole("switch", { name: "VGL-015 is always on" })).toBeDisabled();
    await page.getByRole("switch", { name: "Disable VGL-013" }).click();
    const confirm = page.getByRole("alertdialog");
    await expect(confirm).toContainText("Turn off VGL-013?");
    await confirm.getByRole("button", { name: "Cancel" }).click();
    await expect(page.getByRole("switch", { name: "Disable VGL-013" })).toBeChecked();

    const email = `qa.${Date.now().toString(36)}@vigil.example`;
    await page.goto("/settings");
    await page.getByLabel("Name").fill("QA Tester");
    await page.getByLabel("Email").fill(email);
    await page.getByLabel("Initial password").fill("initial-password-1");
    await page.getByRole("button", { name: "Create user" }).click();
    await expect(page.getByText(email)).toBeVisible();

    await page.context().clearCookies();
    await page.goto("/login");
    await page.getByLabel("Email").fill(email);
    await page.getByLabel("Password").fill("initial-password-1");
    await page.getByRole("button", { name: "Sign in" }).click();
    await expect(page).toHaveURL(/\/account\/password\?first=1$/);
    await page.goto("/incidents");
    await expect(page).toHaveURL(/\/account\/password/);
    await page.getByLabel("Current password").fill("initial-password-1");
    await page.getByLabel("New password", { exact: true }).fill("my-own-password-42");
    await page.getByLabel("Repeat the new password").fill("my-own-password-42");
    await page.getByRole("button", { name: "Change password" }).click();
    await expect(page.getByRole("heading", { level: 1, name: "Security Operations Center" })).toBeVisible();
  });
});
