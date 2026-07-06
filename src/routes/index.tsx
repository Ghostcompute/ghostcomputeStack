import { createFileRoute } from "@tanstack/react-router";

export const Route = createFileRoute("/")({
  head: () => ({
    meta: [
      { title: "CIRON   C1 Performance Bicycle" },
      { name: "description", content: "CIRON C1   a premium, cinematic, technical performance bicycle landing experience." },
      { property: "og:title", content: "CIRON   C1 Performance Bicycle" },
      { property: "og:description", content: "CIRON C1   a premium, cinematic, technical performance bicycle landing experience." },
    ],
  }),
  component: Index,
});

function Index() {
  return (
    <iframe
      src="/ciron.html?v=engineering-mobile-fullcover-20260629"
      title="CIRON"
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
