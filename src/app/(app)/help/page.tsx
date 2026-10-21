import { PageTitle, Panel } from "@/components/vigil/bits";
import { requireUser } from "@/server/session";

export const metadata = { title: "How VIGIL works" };

export default async function HelpPage() {
  await requireUser();
  return (
    <>
      <PageTitle title="How VIGIL works" description="A demonstration SIEM for NEXORA. It is not a replacement for Splunk, Elastic Security or Microsoft Sentinel." />
      <div className="grid gap-4 lg:grid-cols-2 [&>*]:min-w-0">
        <Panel title="1. Ingestion">
          <p className="text-sm">
            The worker polls NEXORA&apos;s security API with a read-only SIEM key, resuming from the last stored sequence number. Every event is validated against a copy of NEXORA&apos;s schema and appended to an
            append-only table. In demo mode a simulator writes the same format.
          </p>
        </Panel>
        <Panel title="2. Integrity">
          <p className="text-sm">
            Each event carries <code className="font-mono text-xs">hash = SHA-256(prev_hash + canonical JSON)</code>. VIGIL recomputes it, checks the link to the previous event and the sequence, and expects a heartbeat at least every 15
            minutes. Any break becomes a critical alert (VGL-015).
          </p>
        </Panel>
        <Panel title="3. Detection">
          <p className="text-sm">
            Fifteen JSON rules (single event, threshold, sequence, new value, integrity) mapped to MITRE ATT&amp;CK. Repeated hits update one alert; alerts about the same entity form one incident. Rules can be backtested over stored history.
          </p>
        </Panel>
        <Panel title="4. Response">
          <p className="text-sm">
            Analysts propose revoking an API key or disabling a user. Only an admin can approve, with a written reason, and never their own proposal (four eyes), and VIGIL then calls NEXORA&apos;s security-actions API with a separate respond key. Simulated incidents never call
            NEXORA. Nothing destructive happens automatically.
          </p>
        </Panel>
      </div>
      <p className="text-xs text-text-muted">Full documentation: README.md and docs/ in the repository (architecture, event schema, detection rules, response, drill, deployment, limitations).</p>
    </>
  );
}
