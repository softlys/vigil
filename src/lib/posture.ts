/**
 * Security posture score for the overview: a simple, explainable number, not a model.
 * Start at 100 and subtract for what needs attention right now:
 * - open incidents by severity: critical 20, high 10, medium 4, low 1;
 * - integrity findings in the last 24 hours: 10 each (the log itself may be unreliable);
 * - detection rules turned off: 2 each (blind spots);
 * - the NEXORA connector failing or stopped: 15.
 * The result is clamped to 0..100. Every deduction is listed next to the score.
 */
export type PostureInput = {
  openIncidents: Partial<Record<"critical" | "high" | "medium" | "low", number>>;
  integrityFindings24h: number;
  rulesDisabled: number;
  connectorFailing: boolean;
};

export type Posture = { score: number; label: "Strong" | "Fair" | "At risk"; deductions: Array<{ reason: string; points: number }> };

const WEIGHTS = { critical: 20, high: 10, medium: 4, low: 1 } as const;

export function postureScore(input: PostureInput): Posture {
  const deductions: Posture["deductions"] = [];
  for (const sev of ["critical", "high", "medium", "low"] as const) {
    const n = input.openIncidents[sev] ?? 0;
    if (n > 0) deductions.push({ reason: `${n} open ${sev} incident${n === 1 ? "" : "s"}`, points: n * WEIGHTS[sev] });
  }
  if (input.integrityFindings24h > 0) deductions.push({ reason: `${input.integrityFindings24h} integrity finding${input.integrityFindings24h === 1 ? "" : "s"} in 24 h`, points: input.integrityFindings24h * 10 });
  if (input.rulesDisabled > 0) deductions.push({ reason: `${input.rulesDisabled} detection rule${input.rulesDisabled === 1 ? "" : "s"} turned off`, points: input.rulesDisabled * 2 });
  if (input.connectorFailing) deductions.push({ reason: "NEXORA connector failing", points: 15 });
  const score = Math.max(0, Math.min(100, 100 - deductions.reduce((s, d) => s + d.points, 0)));
  return { score, label: score >= 80 ? "Strong" : score >= 50 ? "Fair" : "At risk", deductions: deductions.sort((a, b) => b.points - a.points) };
}
