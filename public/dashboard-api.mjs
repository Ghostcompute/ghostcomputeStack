/** Orchestrator base URL for static dashboard.html (not Vite). */
export function orchestratorBase() {
  if (typeof window !== 'undefined' && window.__GHOST_API_BASE__) {
    return String(window.__GHOST_API_BASE__).replace(/\/$/, '');
  }
  const host = typeof location !== 'undefined' ? location.hostname : '';
  if (host === 'localhost' || host === '127.0.0.1') {
    return 'http://localhost:3001';
  }
  return 'https://api.ghostcompute.tech';
}

export function apiUrl(path) {
  const base = orchestratorBase();
  return path.startsWith('/') ? `${base}${path}` : `${base}/${path}`;
}
