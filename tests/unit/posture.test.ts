import { describe, expect, it } from "vitest";
import { postureScore } from "@/lib/posture";

describe("security posture score", () => {
  it("is 100 and Strong when nothing needs attention", () => {
    expect(postureScore({ openIncidents: {}, integrityFindings24h: 0, rulesDisabled: 0, connectorFailing: false })).toEqual({ score: 100, label: "Strong", deductions: [] });
  });

  it("subtracts by severity and lists every deduction, largest first", () => {
    const p = postureScore({ openIncidents: { critical: 1, high: 2, low: 3 }, integrityFindings24h: 0, rulesDisabled: 1, connectorFailing: false });
    expect(p.score).toBe(100 - 20 - 20 - 3 - 2);
    expect(p.label).toBe("Fair");
    expect(p.deductions.map((d) => d.points)).toEqual([20, 20, 3, 2]);
  });

  it("never goes below zero and flags integrity and connector problems", () => {
    const p = postureScore({ openIncidents: { critical: 6 }, integrityFindings24h: 2, rulesDisabled: 0, connectorFailing: true });
    expect(p.score).toBe(0);
    expect(p.label).toBe("At risk");
    expect(p.deductions.map((d) => d.reason)).toContain("NEXORA connector failing");
  });
});
