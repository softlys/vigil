import { afterEach, describe, expect, it } from "vitest";
import { bootstrap, DEMO_USERS } from "@/lib/bootstrap";
import { ConfigError, getConfig } from "@/lib/config";
import { freshDb } from "./helpers";

const env = (vars: Record<string, string>) => vars as unknown as NodeJS.ProcessEnv;

describe("mode selection", () => {
  it("refuses to guess the mode on a production server", () => {
    expect(() => getConfig(env({ NODE_ENV: "production" }))).toThrow(ConfigError);
    expect(getConfig(env({ NODE_ENV: "production", VIGIL_MODE: "production" })).mode).toBe("production");
    expect(getConfig(env({ NODE_ENV: "production", VIGIL_MODE: "demo" })).mode).toBe("demo");
  });

  it("allows the build step and development without a mode", () => {
    expect(getConfig(env({ NODE_ENV: "production", NEXT_PHASE: "phase-production-build" })).mode).toBe("demo");
    expect(getConfig(env({ NODE_ENV: "development" })).mode).toBe("demo");
  });

  it("rejects unknown modes", () => {
    expect(() => getConfig(env({ VIGIL_MODE: "prod" }))).toThrow(/Unknown VIGIL_MODE/);
  });
});

describe("production bootstrap", () => {
  const saved = process.env.VIGIL_MODE;
  afterEach(() => {
    if (saved === undefined) delete process.env.VIGIL_MODE;
    else process.env.VIGIL_MODE = saved;
  });

  it("deactivates demo accounts left over from a demo installation", async () => {
    const sql = await freshDb();
    process.env.VIGIL_MODE = "demo";
    await bootstrap(sql);
    expect((await sql.query<{ n: number }>("select count(*)::int as n from users where active"))[0]!.n).toBe(DEMO_USERS.length);
    process.env.VIGIL_MODE = "production";
    await bootstrap(sql);
    expect((await sql.query<{ n: number }>("select count(*)::int as n from users where active"))[0]!.n).toBe(0);
    await sql.close();
  });
});
