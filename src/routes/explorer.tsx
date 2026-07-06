import { createFileRoute } from "@tanstack/react-router";
import { useQuery } from "@tanstack/react-query";
import { useState } from "react";

export const Route = createFileRoute("/explorer")({
  head: () => ({
    meta: [
      { title: "Ghost Compute — Attestation Explorer" },
      { name: "description", content: "Public trust surface: network sealed share, worker reputation, per-job receipts, verify any attestation hash." },
    ],
  }),
  component: Explorer,
});

// Control-plane API base. Defaults to same-origin; override with VITE_API_URL
// to point at the off-Vercel orchestrator control plane.
const API = (import.meta as any).env?.VITE_API_URL ?? "";

async function getJSON<T>(path: string): Promise<T> {
  const res = await fetch(`${API}${path}`);
  if (!res.ok) throw new Error(`${res.status}`);
  return res.json();
}

interface NetworkStats {
  confidential_workers: number; total_workers: number; sealed_share: number;
  attestations_verified: number; attestations_rejected: number;
  proofs_recorded: number; proofs_verified: number;
}

function Explorer() {
  return (
    <div style={{ minHeight: "100vh", background: "#0a0a0b", color: "#e7e7ea", fontFamily: "ui-sans-serif, system-ui", padding: "32px 20px" }}>
      <div style={{ maxWidth: 1100, margin: "0 auto" }}>
        <header style={{ marginBottom: 28 }}>
          <div style={{ fontSize: 12, letterSpacing: "0.22em", textTransform: "uppercase", color: "#8a8a93" }}>Ghost Compute</div>
          <h1 style={{ fontSize: 30, fontWeight: 700, margin: "6px 0 4px" }}>Attestation Explorer</h1>
          <p style={{ color: "#9a9aa2", margin: 0 }}>Public trust surface — sealed by hardware, proven by attestation. Identities withheld.</p>
        </header>

        <NetworkPanel />
        <VerifyByHash />
        <WorkersPanel />
        <AuditPanel />
      </div>
    </div>
  );
}

function Card({ label, value }: { label: string; value: string }) {
  return (
    <div style={{ border: "1px solid #1f1f24", borderRadius: 12, padding: "16px 18px", background: "#0f0f12", minWidth: 150 }}>
      <div style={{ fontSize: 11, letterSpacing: "0.16em", textTransform: "uppercase", color: "#8a8a93" }}>{label}</div>
      <div style={{ fontSize: 26, fontWeight: 700, marginTop: 6 }}>{value}</div>
    </div>
  );
}

function NetworkPanel() {
  const { data, isLoading, isError } = useQuery({ queryKey: ["net"], queryFn: () => getJSON<NetworkStats>("/api/explorer/network"), retry: false });
  return (
    <section style={{ marginBottom: 28 }}>
      <h2 style={sectionH}>Network</h2>
      {isError && <Empty msg="Control plane unreachable (set VITE_API_URL)." />}
      {isLoading && <Empty msg="Loading…" />}
      {data && (
        <div style={{ display: "flex", gap: 12, flexWrap: "wrap" }}>
          <Card label="Sealed Share" value={`${Math.round(data.sealed_share * 100)}%`} />
          <Card label="Confidential Workers" value={`${data.confidential_workers}/${data.total_workers}`} />
          <Card label="Attestations ✓" value={`${data.attestations_verified}`} />
          <Card label="Attestations ✗" value={`${data.attestations_rejected}`} />
          <Card label="Receipts" value={`${data.proofs_verified}/${data.proofs_recorded}`} />
        </div>
      )}
    </section>
  );
}

function VerifyByHash() {
  const [hash, setHash] = useState("");
  const [result, setResult] = useState<any>(null);
  const [err, setErr] = useState<string | null>(null);
  async function check() {
    setErr(null); setResult(null);
    try { setResult(await getJSON(`/api/attestation/${encodeURIComponent(hash.trim())}`)); }
    catch { setErr("Not found or unreachable."); }
  }
  return (
    <section style={{ marginBottom: 28 }}>
      <h2 style={sectionH}>Verify by hash</h2>
      <div style={{ display: "flex", gap: 8 }}>
        <input value={hash} onChange={(e) => setHash(e.target.value)} placeholder="attestation report_hash (sha256 hex)"
          style={{ flex: 1, background: "#0f0f12", border: "1px solid #1f1f24", borderRadius: 8, padding: "10px 12px", color: "#e7e7ea", fontFamily: "ui-monospace, monospace" }} />
        <button onClick={check} style={{ background: "#e7e7ea", color: "#0a0a0b", border: "none", borderRadius: 8, padding: "0 18px", fontWeight: 700, cursor: "pointer" }}>Verify</button>
      </div>
      {err && <div style={{ color: "#d97777", marginTop: 8, fontSize: 13 }}>{err}</div>}
      {result && (
        <pre style={{ marginTop: 12, background: "#0f0f12", border: "1px solid #1f1f24", borderRadius: 8, padding: 14, overflowX: "auto", fontSize: 12 }}>
          {JSON.stringify(result, null, 2)}
        </pre>
      )}
    </section>
  );
}

function WorkersPanel() {
  const { data } = useQuery({ queryKey: ["workers"], queryFn: () => getJSON<any[]>("/api/explorer/workers"), retry: false });
  return (
    <section style={{ marginBottom: 28 }}>
      <h2 style={sectionH}>Worker reputation</h2>
      {!data?.length ? <Empty msg="No workers yet." /> : (
        <div style={tableWrap}>
          <table style={table}>
            <thead><tr>{["Worker", "TEE", "Confidential", "Pass rate", "Jobs"].map((h) => <th key={h} style={th}>{h}</th>)}</tr></thead>
            <tbody>
              {data.map((w, i) => (
                <tr key={i}>
                  <td style={tdMono}>{w.worker}</td>
                  <td style={td}>{w.tee_type}</td>
                  <td style={td}>{w.confidential_ok ? "✓" : "—"}</td>
                  <td style={td}>{w.verify_pass_rate}</td>
                  <td style={td}>{w.jobs_completed}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </section>
  );
}

function AuditPanel() {
  const { data } = useQuery({ queryKey: ["audits"], queryFn: () => getJSON<any[]>("/api/explorer/audits"), retry: false });
  return (
    <section style={{ marginBottom: 40 }}>
      <h2 style={sectionH}>Audit feed</h2>
      {!data?.length ? <Empty msg="No events yet." /> : (
        <div style={tableWrap}>
          <table style={table}>
            <thead><tr>{["Event", "Subject", "When"].map((h) => <th key={h} style={th}>{h}</th>)}</tr></thead>
            <tbody>
              {data.map((a, i) => (
                <tr key={i}>
                  <td style={td}>{a.event_type}</td>
                  <td style={tdMono}>{a.subject}</td>
                  <td style={td}>{a.created_at ? new Date(a.created_at).toLocaleString() : "—"}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </section>
  );
}

function Empty({ msg }: { msg: string }) {
  return <div style={{ color: "#7a7a82", fontSize: 13, padding: "10px 0" }}>{msg}</div>;
}

const sectionH = { fontSize: 13, letterSpacing: "0.16em", textTransform: "uppercase" as const, color: "#8a8a93", marginBottom: 12 };
const tableWrap = { border: "1px solid #1f1f24", borderRadius: 12, overflow: "hidden" };
const table = { width: "100%", borderCollapse: "collapse" as const, fontSize: 13 };
const th = { textAlign: "left" as const, padding: "10px 14px", background: "#0f0f12", color: "#8a8a93", fontWeight: 600, borderBottom: "1px solid #1f1f24" };
const td = { padding: "10px 14px", borderBottom: "1px solid #141418" };
const tdMono = { ...td, fontFamily: "ui-monospace, monospace" as const };
