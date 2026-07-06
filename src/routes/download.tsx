import { createFileRoute } from "@tanstack/react-router";

export const Route = createFileRoute("/download")({
  head: () => ({
    meta: [
      { title: "Ghost Compute — Download Ghost Worker" },
      {
        name: "description",
        content:
          "Download Ghost Worker for macOS, Windows, and Linux. Install, connect wallet, run the capability probe — confidential GPU earning in three clicks.",
      },
      { property: "og:title", content: "Ghost Compute — Download Ghost Worker" },
      {
        property: "og:description",
        content: "Official Ghost Worker desktop releases for macOS, Windows, and Linux.",
      },
    ],
  }),
  component: Download,
});

function Download() {
  return (
    <iframe
      src="/download.html?v=20260706b"
      title="Download Ghost Worker"
      style={{
        position: "fixed",
        inset: 0,
        width: "100vw",
        height: "100vh",
        border: "none",
        margin: 0,
        padding: 0,
      }}
    />
  );
}
