import { CircleHelp, Cpu, LayoutDashboard, Layers } from "lucide-react";
import { useState } from "react";
import { Sidebar } from "./components/Sidebar";
import { TitleBar } from "./components/TitleBar";
import { Topbar } from "./components/Topbar";
import { useDaemon } from "./hooks/useDaemon";
import { HardwarePanel } from "./panels/HardwarePanel";
import { OverviewPanel } from "./panels/OverviewPanel";
import { AboutPanel } from "./panels/AboutPanel";
import { ModelsPanel } from "./panels/ModelsPanel";
import { getStoredOperatorAddress, resolveOperatorAddress } from "./lib/operator-address";
import type { TabId } from "./types";

const NAV = [
  { id: "overview" as TabId, icon: LayoutDashboard, label: "Overview" },
  { id: "hardware" as TabId, icon: Cpu, label: "Hardware" },
  { id: "models" as TabId, icon: Layers, label: "Models" },
  { id: "about" as TabId, icon: CircleHelp, label: "About" },
];

export default function App() {
  const [tab, setTab] = useState<TabId>("overview");
  const [walletModalOpen, setWalletModalOpen] = useState(false);
  const {
    daemonOnline,
    processStatus,
    workerStatus,
    refresh,
    restartDaemon,
  } = useDaemon();

  return (
    <>
      <div className="grid-bg" />
      <div className="app-shell">
        <TitleBar />
        <div className="app-layout">
          <Sidebar items={NAV} active={tab} onSelect={setTab} />
          <main className="shell">
            <Topbar
              onRefresh={() => void refresh()}
              daemonOnline={daemonOnline}
              onRestartDaemon={() => void restartDaemon()}
              operatorAddress={resolveOperatorAddress(
                getStoredOperatorAddress(),
                workerStatus?.worker_address,
              )}
              onOperatorAddressSaved={() => void refresh()}
              walletModalOpen={walletModalOpen}
              onWalletModalOpenChange={setWalletModalOpen}
              worker={workerStatus}
              onWorkerRefresh={refresh}
            />
            <div className={`shell-body${tab === "models" ? " shell-body--fill" : ""}`}>
              {tab === "overview" && (
                <OverviewPanel process={processStatus} worker={workerStatus} />
              )}
              {tab === "hardware" && <HardwarePanel worker={workerStatus} />}
              {tab === "models" && (
                <ModelsPanel worker={workerStatus} onRefresh={refresh} />
              )}
              {tab === "about" && (
                <AboutPanel
                  worker={workerStatus}
                  process={processStatus}
                  operatorAddress={resolveOperatorAddress(
                    getStoredOperatorAddress(),
                    workerStatus?.worker_address,
                  )}
                  onOpenWalletModal={() => setWalletModalOpen(true)}
                />
              )}
            </div>
          </main>
        </div>
      </div>
    </>
  );
}
