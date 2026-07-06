import type { LucideIcon } from "lucide-react";
import type { TabId } from "../types";

const LOGO = "/ghost-logo.png";

interface NavItem {
  id: TabId;
  icon: LucideIcon;
  label: string;
}

interface SidebarProps {
  items: NavItem[];
  active: TabId;
  onSelect: (id: TabId) => void;
}

export function Sidebar({ items, active, onSelect }: SidebarProps) {
  const mainItems = items.filter((i) => i.id !== "about");
  const about = items.find((i) => i.id === "about");

  return (
    <aside className="sidebar">
      <div className="sb-brand">
        <img src={LOGO} alt="Ghost" />
      </div>
      <div className="sb-divider" />
      {mainItems.map(({ id, icon: Icon, label }) => (
        <button
          key={id}
          type="button"
          className={`sb-btn${active === id ? " active" : ""}`}
          onClick={() => onSelect(id)}
          aria-label={label}
        >
          <Icon size={20} strokeWidth={1.85} />
          <span className="sb-tip">{label}</span>
        </button>
      ))}
      {about && (() => {
        const AboutIcon = about.icon;
        return (
        <div className="sb-bottom">
          <button
            type="button"
            className={`sb-btn${active === about.id ? " active" : ""}`}
            onClick={() => onSelect(about.id)}
            aria-label={about.label}
          >
            <AboutIcon size={20} strokeWidth={1.85} />
            <span className="sb-tip">{about.label}</span>
          </button>
        </div>
        );
      })()}
    </aside>
  );
}
