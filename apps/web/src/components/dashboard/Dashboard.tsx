import { useState } from 'react';
import { FleetCard } from './FleetCard.js';
import { InferencePanel } from './InferencePanel.js';
import { DarkPoolPanel } from './DarkPoolPanel.js';
import { WorkerPanel } from './WorkerPanel.js';

type Tab = 'fleet' | 'inference' | 'darkpool' | 'worker';

export function Dashboard() {
  const [tab, setTab] = useState<Tab>('fleet');

  return (
    <div className="dashboard">
      <header className="dashboard__header">
        <h1>Ghost Compute</h1>
        <p className="dashboard__tagline">Confidential compute layer on Solana</p>
        <nav className="dashboard__tabs">
          <button className={tab === 'fleet' ? 'active' : ''} onClick={() => setTab('fleet')}>
            GPU Fleet
          </button>
          <button className={tab === 'inference' ? 'active' : ''} onClick={() => setTab('inference')}>
            Inference
          </button>
          <button className={tab === 'darkpool' ? 'active' : ''} onClick={() => setTab('darkpool')}>
            Dark Pool
          </button>
          <button className={tab === 'worker' ? 'active' : ''} onClick={() => setTab('worker')}>
            My Worker
          </button>
        </nav>
      </header>

      <main className="dashboard__content">
        {tab === 'fleet'     && <FleetCard />}
        {tab === 'inference' && <InferencePanel />}
        {tab === 'darkpool'  && <DarkPoolPanel />}
        {tab === 'worker'    && <WorkerPanel />}
      </main>
    </div>
  );
}
