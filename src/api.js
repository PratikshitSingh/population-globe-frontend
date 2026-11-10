import { config } from './config.js';

export const API = config.apiUrl;

export async function getJSON(path, options) {
  const r = await fetch(`${API}${path}`, options);
  if (!r.ok) throw new Error(`HTTP ${r.status}`);
  return r.json();
}
