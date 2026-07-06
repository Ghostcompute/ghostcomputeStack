import { Minus, X } from "lucide-react";
import { getCurrentWindow } from "@tauri-apps/api/window";

const LOGO = "/ghost-logo.png";

function isTauri() {
  return typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;
}

export function TitleBar() {
  if (!isTauri()) return null;

  const appWindow = getCurrentWindow();

  return (
    <header className="titlebar">
      <div className="titlebar-drag" data-tauri-drag-region>
        <div className="titlebar-brand">
          <img src={LOGO} alt="" aria-hidden />
        </div>
        <span className="titlebar-label">Ghost Worker</span>
      </div>
      <div className="titlebar-controls">
        <button
          type="button"
          className="titlebar-btn"
          title="Minimize"
          aria-label="Minimize"
          onClick={() => void appWindow.minimize()}
        >
          <Minus size={14} strokeWidth={2} />
        </button>
        <button
          type="button"
          className="titlebar-btn titlebar-btn-close"
          title="Close"
          aria-label="Close"
          onClick={() => void appWindow.close()}
        >
          <X size={13} strokeWidth={2.25} />
        </button>
      </div>
    </header>
  );
}
