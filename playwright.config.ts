import { defineConfig, devices } from "@playwright/test";

const PORT = Number(process.env.E2E_PORT ?? 3400);

/**
 * End-to-end tests run against a production build in demo mode with a fresh embedded database
 * (.data/e2e-pglite), so they never touch your local demo data.
 */
export default defineConfig({
  testDir: "tests/e2e",
  fullyParallel: false,
  workers: 1,
  retries: process.env.CI ? 1 : 0,
  reporter: process.env.CI ? "github" : "list",
  timeout: 90_000,
  use: { baseURL: `http://127.0.0.1:${PORT}`, trace: "retain-on-failure" },
  projects: [{ name: "chromium", use: { ...devices["Desktop Chrome"], viewport: { width: 1440, height: 900 } } }],
  webServer: {
    // Fresh embedded database every run (removed before the server opens it).
    command: `node -e "require('fs').rmSync('.data/e2e-pglite',{recursive:true,force:true})" && npm run build && npx next start -p ${PORT}`,
    url: `http://127.0.0.1:${PORT}/api/health`,
    timeout: 300_000,
    reuseExistingServer: false,
    env: { VIGIL_MODE: "demo", VIGIL_DATA_DIR: ".data/e2e-pglite", VIGIL_WORKER_INTERVAL_MS: "3000", NEXORA_URL: "", NEXORA_SECURITY_API_KEY: "" },
  },
});
