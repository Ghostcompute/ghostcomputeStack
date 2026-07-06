import type { ReactNode } from "react";

export function Card({
  children,
  className = "",
}: {
  children: ReactNode;
  className?: string;
}) {
  return <div className={`card ${className}`.trim()}>{children}</div>;
}

export function CardPad({
  children,
  className = "",
}: {
  children: ReactNode;
  className?: string;
}) {
  return <div className={`card-pad ${className}`.trim()}>{children}</div>;
}

export function Tag({
  children,
  variant = "default",
}: {
  children: ReactNode;
  variant?: "default" | "ok" | "warn" | "danger";
}) {
  const cls =
    variant === "ok"
      ? "tag tag-ok"
      : variant === "warn"
        ? "tag tag-warn"
        : variant === "danger"
          ? "tag tag-danger"
          : "tag";
  return <span className={cls}>{children}</span>;
}
