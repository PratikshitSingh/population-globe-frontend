// Sun position, the day/night line, and a rough "who is awake" curve. No API involved.

const RAD = Math.PI / 180;
const wrap180 = (d) => ((((d + 180) % 360) + 360) % 360) - 180;

/** Point on Earth where the sun is directly overhead (low-precision almanac formulas). */
export function subsolarPoint(date = new Date()) {
  const n = date.getTime() / 86400000 - 10957.5; // days since J2000.0
  const L = 280.46 + 0.9856474 * n;
  const g = (357.528 + 0.9856003 * n) * RAD;
  const lambda = (L + 1.915 * Math.sin(g) + 0.02 * Math.sin(2 * g)) * RAD;
  const eps = (23.439 - 0.0000004 * n) * RAD;
  const decl = Math.asin(Math.sin(eps) * Math.sin(lambda));
  const ra = Math.atan2(Math.cos(eps) * Math.sin(lambda), Math.cos(lambda));
  const gmst = 280.46061837 + 360.98564736629 * n;
  return { lat: decl / RAD, lon: wrap180(ra / RAD - gmst) };
}

/** GeoJSON polygon covering the night side of the Earth. */
export function nightPolygon(date = new Date()) {
  const sun = subsolarPoint(date);
  const tanDecl = Math.tan((Math.abs(sun.lat) < 0.01 ? 0.01 : sun.lat) * RAD);
  const ring = [];
  for (let lon = -180; lon <= 180; lon += 2) {
    ring.push([lon, Math.atan(-Math.cos((lon - sun.lon) * RAD) / tanDecl) / RAD]);
  }
  const darkPole = sun.lat > 0 ? -90 : 90;
  ring.push([180, darkPole], [-180, darkPole], ring[0]);
  return { type: 'Feature', properties: {}, geometry: { type: 'Polygon', coordinates: [ring] } };
}

// Share of people asleep at each local hour (0–23). A rough, made-up-but-plausible curve
// in the shape of time-use surveys; treat the result as an estimate.
const ASLEEP = [0.75, 0.85, 0.92, 0.95, 0.93, 0.85, 0.65, 0.4, 0.2, 0.1, 0.04, 0.04,
  0.04, 0.04, 0.04, 0.04, 0.04, 0.04, 0.04, 0.04, 0.04, 0.08, 0.2, 0.45];

export function awakeFraction(localHour) {
  const h = Math.floor(localHour) % 24;
  const t = localHour - Math.floor(localHour);
  return 1 - (ASLEEP[h] * (1 - t) + ASLEEP[(h + 1) % 24] * t);
}

const formatters = new Map();
/** Local time as fractional hours for an IANA time zone, or null if the zone is unknown. */
export function localHour(tz, date = new Date()) {
  let fmt = formatters.get(tz);
  if (fmt === undefined) {
    try {
      fmt = new Intl.DateTimeFormat('en-GB', { timeZone: tz, hour: '2-digit', minute: '2-digit', hourCycle: 'h23' });
    } catch {
      fmt = null;
    }
    formatters.set(tz, fmt);
  }
  if (!fmt) return null;
  const parts = fmt.formatToParts(date);
  const get = (type) => +parts.find((p) => p.type === type).value;
  return get('hour') + get('minute') / 60;
}

export const formatLocalTime = (h) =>
  h == null ? '' : `${String(Math.floor(h)).padStart(2, '0')}:${String(Math.round((h % 1) * 60) % 60).padStart(2, '0')}`;
