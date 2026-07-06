import { createFileRoute } from "@tanstack/react-router";

export const Route = createFileRoute("/terms")({
  head: () => ({
    meta: [
      { title: "Ghost Compute   Terms & Privacy" },
      { name: "description", content: "Terms of Service and Privacy Policy for Ghost Compute   the confidential GPU substrate." },
      { property: "og:title", content: "Ghost Compute   Terms & Privacy" },
      { property: "og:description", content: "Terms and Privacy Policy for Ghost Compute." },
    ],
  }),
  component: Terms,
});

function Terms() {
  return (
    <iframe
      src="/terms.html"
      title="Ghost Compute Terms & Privacy"
      style={{ position: "fixed", inset: 0, width: "100vw", height: "100vh", border: "none", margin: 0, padding: 0 }}
    />
  );
}
