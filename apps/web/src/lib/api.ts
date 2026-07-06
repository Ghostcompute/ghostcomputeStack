/** Orchestrator / control-plane base URL (browser + SSR). */
export const API_URL =
  (import.meta as any).env?.VITE_ORCHESTRATOR_URL
  ?? (import.meta as any).env?.VITE_API_URL
  ?? 'http://localhost:3001';

export function apiUrl(path: string): string {
  const base = API_URL.replace(/\/$/, '');
  return path.startsWith('/') ? `${base}${path}` : `${base}/${path}`;
}
