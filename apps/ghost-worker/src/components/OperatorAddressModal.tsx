import { Loader2, X } from "lucide-react";
import { useEffect, useState } from "react";
import { setOperatorWallet } from "../lib/daemon-api";
import {
  getStoredOperatorAddress,
  isValidOperatorAddress,
  storeOperatorAddress,
} from "../lib/operator-address";

interface OperatorAddressModalProps {
  open: boolean;
  initialAddress?: string | null;
  onClose: () => void;
  onSaved: (address: string) => void;
}

export function OperatorAddressModal({
  open,
  initialAddress,
  onClose,
  onSaved,
}: OperatorAddressModalProps) {
  const [value, setValue] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!open) return;
    setValue(initialAddress ?? getStoredOperatorAddress() ?? "");
    setError(null);
    setBusy(false);
  }, [open, initialAddress]);

  if (!open) return null;

  async function save() {
    const trimmed = value.trim();
    if (!isValidOperatorAddress(trimmed)) {
      setError(
        "Enter a valid Solana wallet address.",
      );
      return;
    }

    setBusy(true);
    setError(null);

    const result = await setOperatorWallet(trimmed);
    if (!result.ok) {
      setError(result.error ?? result.message ?? "Could not register with orchestrator.");
      setBusy(false);
      return;
    }

    storeOperatorAddress(trimmed);
    onSaved(trimmed);
    setBusy(false);
    onClose();
  }

  return (
    <div
      className="operator-modal-veil"
      role="presentation"
      onClick={(e) => {
        if (e.target === e.currentTarget && !busy) onClose();
      }}
    >
      <div
        className="operator-modal card fade-in"
        role="dialog"
        aria-labelledby="operator-modal-title"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="card-pad">
          <div className="operator-modal__head">
            <div className="operator-modal__intro">
              <h3 id="operator-modal-title" className="panel-title">
                Operator payout address
              </h3>
              <p className="panel-desc operator-modal__desc">
                <br />
                This Solana address receives worker earnings and identifies your node on
                the network.<br />
              </p>
            </div>
            <button
              type="button"
              className="ic-btn operator-modal__close"
              aria-label="Close"
              disabled={busy}
              onClick={onClose}
            >
              <X size={16} strokeWidth={2} />
            </button>
          </div>

          <label className="field operator-modal__field">
            <span className="kicker">// public address</span>
            <input
              type="text"
              value={value}
              placeholder="Paste your Solana public key…"
              autoComplete="off"
              spellCheck={false}
              disabled={busy}
              onChange={(e) => {
                setValue(e.target.value);
                setError(null);
              }}
              onKeyDown={(e) => {
                if (e.key === "Enter") void save();
              }}
            />
          </label>

          {error && <p className="operator-modal__error">{error}</p>}

          <div className="operator-modal__actions">
            <button type="button" className="chip" disabled={busy} onClick={onClose}>
              Cancel
            </button>
            <button
              type="button"
              className={`chip active${busy ? " busy" : ""}`}
              disabled={busy}
              onClick={() => void save()}
            >
              {busy ? <Loader2 size={12} className="spin" /> : null}
              {busy ? "Registering…" : "Save & register"}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
