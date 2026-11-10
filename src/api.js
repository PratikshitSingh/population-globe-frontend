export const API = (import.meta.env.VITE_API_URL ?? 'http://localhost:8000').replace(/\/$/, '');

export async function getJSON(path, options) {
  const r = await fetch(`${API}${path}`, options);
  if (!r.ok) throw new Error(`HTTP ${r.status}`);
  return r.json();
}
