/**
 * Live drill: sends real requests to a NEXORA instance YOU OWN, to reproduce attack patterns that
 * VIGIL should then ingest and alert on. See docs/drill.md.
 *
 * Safety:
 * - runs only when DRILL_TARGET_URL is localhost/127.0.0.1/::1, or its host is listed in
 *   DRILL_ALLOWED_HOSTS (comma-separated) — never against someone else's system
 * - asks for --yes to proceed, sends a bounded number of requests, and never uses valid secrets
 *   except DRILL_API_KEY for the scope-denial step (an integration key you created for the drill)
 *
 * Usage:
 *   DRILL_TARGET_URL=http://localhost:3000 DRILL_API_KEY=nxk_int_… npm run drill -- --yes
 */
import { createHmac } from "node:crypto";

type Step = { name: string; expect: string; run: (base: string) => Promise<string> };

const target = process.env.DRILL_TARGET_URL ?? "";
const allowed = (process.env.DRILL_ALLOWED_HOSTS ?? "")
  .split(",")
  .map((h) => h.trim().toLowerCase())
  .filter(Boolean);

function guard(): URL {
  let url: URL;
  try {
    url = new URL(target);
  } catch {
    console.error("Set DRILL_TARGET_URL to the NEXORA instance you own, e.g. http://localhost:3000");
    process.exit(2);
  }
  const host = url.hostname.replace(/^\[|\]$/g, "").toLowerCase();
  const local = ["localhost", "127.0.0.1", "::1"].includes(host);
  if (!local && !allowed.includes(host)) {
    console.error(`Refusing to drill ${host}: only localhost or hosts listed in DRILL_ALLOWED_HOSTS are allowed, and only instances you own.`);
    process.exit(2);
  }
  if (!process.argv.includes("--yes")) {
    console.error(`This sends ~40 deliberately bad requests to ${url.origin}. Re-run with --yes to proceed.`);
    process.exit(2);
  }
  return url;
}

async function call(method: string, url: string, init: { headers?: Record<string, string>; body?: string } = {}): Promise<number> {
  const res = await fetch(url, { method, headers: { "User-Agent": "vigil-drill/1.0", ...init.headers }, body: init.body, signal: AbortSignal.timeout(10_000) });
  await res.arrayBuffer();
  return res.status;
}

const prefixOf = (key: string) => key.match(/^nxk_(?:int|siem)_([a-z0-9]{8})_/)?.[1] ?? "drill000";

const steps: Step[] = [
  {
    name: "API brute force: 8 requests with a wrong secret for a real key prefix",
    expect: "api.auth_failed ×8 → VGL-007 (API authentication failures burst)",
    async run(base) {
      const key = process.env.DRILL_API_KEY;
      if (!key) return "skipped: set DRILL_API_KEY so the prefix exists (a wrong secret for an unknown prefix is only logged on the server)";
      const wrong = `nxk_int_${prefixOf(key)}_${"x".repeat(43)}`;
      const codes = [];
      for (let i = 0; i < 8; i++) codes.push(await call("GET", `${base}/api/v1/companies`, { headers: { Authorization: `Bearer ${wrong}` } }));
      return `HTTP ${[...new Set(codes)].join(",")}`;
    },
  },
  {
    name: "Scope probing: 6 calls to the security API with an integration key",
    expect: "api.scope_denied ×6 → VGL-009 (API scope denials burst)",
    async run(base) {
      const key = process.env.DRILL_API_KEY;
      if (!key) return "skipped: set DRILL_API_KEY (an integration key without security scopes)";
      const codes = [];
      for (let i = 0; i < 6; i++) codes.push(await call("GET", `${base}/api/v1/security-events`, { headers: { Authorization: `Bearer ${key}` } }));
      return `HTTP ${[...new Set(codes)].join(",")}`;
    },
  },
  {
    name: "Forged integration callback: POST /api/v1/events with a bad signature",
    expect: "webhook.signature_invalid → VGL-014 (Forged cron or webhook request)",
    async run(base) {
      const key = process.env.DRILL_API_KEY;
      if (!key) return "skipped: set DRILL_API_KEY (needs events:write)";
      const body = JSON.stringify({ event_type: "drill.forged" });
      const t = Math.floor(Date.now() / 1000);
      const sig = createHmac("sha256", "not-the-secret").update(`${t}.${body}`).digest("hex");
      const code = await call("POST", `${base}/api/v1/events`, {
        headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json", "X-Nexora-Integration": "make", "X-Nexora-Signature": `t=${t},v1=${sig}` },
        body,
      });
      return `HTTP ${code}`;
    },
  },
  {
    name: "Forged scheduler call: /api/cron/scheduler with a wrong bearer token",
    expect: "cron.unauthorized → VGL-014 (needs CRON_SECRET set on NEXORA; otherwise NEXORA answers 503 and logs nothing)",
    async run(base) {
      const code = await call("POST", `${base}/api/cron/scheduler`, { headers: { Authorization: "Bearer drill-wrong-secret" } });
      return `HTTP ${code}`;
    },
  },
];

async function main() {
  const url = guard();
  const base = url.origin;
  console.log(`VIGIL drill against ${base}\n`);
  for (const s of steps) {
    try {
      const result = await s.run(base);
      console.log(`• ${s.name}\n  result: ${result}\n  expect: ${s.expect}\n`);
    } catch (error) {
      console.log(`• ${s.name}\n  failed: ${error instanceof Error ? error.message : String(error)}\n`);
    }
  }
  console.log("Not covered by this drill: failed sign-ins and IDOR probing need a browser session (NEXORA Supabase mode) and are covered by the simulator instead.");
  console.log("VIGIL ingests these within one poll interval (NEXORA_POLL_SECONDS, default 15 s). Check Alerts.");
}

void main();
