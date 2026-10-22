import { describe, expect, it } from "vitest";
import { clientIp, trustedHops } from "@/lib/client-ip";

describe("client IP behind proxies", () => {
  it("ignores addresses the client put in X-Forwarded-For", () => {
    // The attacker sends "X-Forwarded-For: 1.2.3.4"; one proxy appends the real address.
    expect(clientIp("1.2.3.4, 203.0.113.7", null, 1)).toBe("203.0.113.7");
    expect(clientIp("203.0.113.7", null, 1)).toBe("203.0.113.7");
  });

  it("walks back one entry per trusted proxy", () => {
    expect(clientIp("1.2.3.4, 203.0.113.7, 10.0.0.2", null, 2)).toBe("203.0.113.7");
    // Fewer entries than hops: the leftmost one is the best we have.
    expect(clientIp("203.0.113.7", null, 3)).toBe("203.0.113.7");
  });

  it("uses only X-Real-IP when no proxy is trusted", () => {
    expect(clientIp("1.2.3.4", "198.51.100.5", 0)).toBe("198.51.100.5");
    expect(clientIp(null, null, 1)).toBeNull();
  });

  it("reads the hop count from the environment with a safe default", () => {
    expect(trustedHops({} as NodeJS.ProcessEnv)).toBe(1);
    expect(trustedHops({ VIGIL_TRUSTED_PROXY_HOPS: "0" } as unknown as NodeJS.ProcessEnv)).toBe(0);
    expect(trustedHops({ VIGIL_TRUSTED_PROXY_HOPS: "abc" } as unknown as NodeJS.ProcessEnv)).toBe(1);
  });
});
