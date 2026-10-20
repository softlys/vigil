/**
 * The simulated NEXORA tenant: people, IPs, API keys and integration domains. All fictional;
 * IPs come from documentation ranges (RFC 5737) and domains end in .example.
 */
import { createHash } from "node:crypto";

export const SIM_ORG_ID = "7f3c2a10-5b6d-4e8f-9a01-2c3d4e5f6a70";
export const SIM_ORG_NAME = "Atlasford Industrial Supply (simulated)";

export type SimUser = { id: string; name: string; email: string; role: "admin" | "manager" | "sales_rep"; ip: string; accountKey: string };

/** Same derivation as NEXORA: first 24 hex characters of SHA-256 of the lower-cased email. */
export function accountKey(email: string): string {
  return createHash("sha256").update(email.trim().toLowerCase()).digest("hex").slice(0, 24);
}

const user = (n: number, name: string, role: SimUser["role"], ip: string): SimUser => {
  const email = `${name.toLowerCase().replace(/[^a-z]+/g, ".")}@atlasford.example`;
  return { id: `0000a000-0000-4000-8000-00000000${String(100 + n).padStart(4, "0")}`, name, email, role, ip, accountKey: accountKey(email) };
};

export const USERS: SimUser[] = [
  user(1, "Olivia Hart", "admin", "192.0.2.10"),
  user(2, "Marcus Lindqvist", "manager", "192.0.2.11"),
  user(3, "Daniel Okafor", "sales_rep", "192.0.2.12"),
  user(4, "Sofia Marin", "sales_rep", "192.0.2.13"),
  user(5, "Ethan Brooks", "sales_rep", "192.0.2.14"),
  user(6, "Priya Natarajan", "sales_rep", "192.0.2.15"),
  user(7, "Lukas Brenner", "manager", "192.0.2.16"),
  user(8, "Hannah Okoye", "sales_rep", "192.0.2.17"),
];

export const byName = (first: string) => USERS.find((u) => u.name.startsWith(first))!;

/** Integration API keys: id, prefix and the IP the integration normally calls from. */
export const API_KEYS = [
  { id: "0000a000-0000-4000-8000-00000000a201", prefix: "mk7q2ld9", name: "Make: lead notifications", ip: "198.51.100.20" },
  { id: "0000a000-0000-4000-8000-00000000a202", prefix: "n8x4vr1p", name: "n8n: routing", ip: "198.51.100.21" },
  { id: "0000a000-0000-4000-8000-00000000a203", prefix: "wf9k3m2t", name: "Website form", ip: "198.51.100.22" },
];

export const KNOWN_WEBHOOK_DOMAINS = ["hook.eu1.make.example", "n8n.atlasford.example", "erp.atlasford.example"];

/** Attacker infrastructure (RFC 5737 TEST-NET-3). */
export const ATTACKER_IPS = ["203.0.113.45", "203.0.113.77", "203.0.113.102", "203.0.113.160", "203.0.113.201"];

export const WORKFLOW_IDS = ["0000a000-0000-4000-8000-00000000b301", "0000a000-0000-4000-8000-00000000b302", "0000a000-0000-4000-8000-00000000b303"];

export const USER_AGENT = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0 Safari/537.36";
export const ATTACK_AGENT = "python-requests/2.32.3";
