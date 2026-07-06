import { createFileRoute } from "@tanstack/react-router";

export const Route = createFileRoute("/dashboard")({
  head: () => ({
    meta: [
      { title: "Ghost Compute — Console" },
      { name: "description", content: "Ghost Compute operator console — confidential GPU substrate, private inference, dark pool, attestation." },
      { property: "og:title", content: "Ghost Compute — Console" },
      { property: "og:description", content: "Operator console for the Ghost Compute confidential substrate." },
    ],
  }),
  component: Dashboard,
});

function Dashboard() {
  return (
    <iframe
      src="/dashboard.html?v=max-tokens-20260706"
      title="Ghost Compute Console"
      style={{ position: "fixed", inset: 0, width: "100vw", height: "100vh", border: "none", margin: 0, padding: 0 }}
    />
  );
}
