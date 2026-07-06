import { startWorker } from './worker.js';

startWorker().catch((err) => {
  console.error('Fatal:', err.message);
  process.exit(1);
});
