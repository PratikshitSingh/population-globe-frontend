// Optional live layers drawn on top of the globe. Each layer owns its sources,
// map layers and timers, and reports a one-line status back to the UI.
import maplibregl from 'maplibre-gl';
import { degreesLat, degreesLong, eciToGeodetic, gstime, propagate, twoline2satrec } from 'satellite.js';
import { getJSON } from './api.js';
import { nightPolygon } from './astro.js';

export const LIVE_LAYERS = [
  { id: 'daynight', label: 'Day / night', group: 'Earth right now', on: true },
  { id: 'earthquakes', label: 'Earthquakes (24 h)', group: 'Earth right now', on: true },
  { id: 'events', label: 'Wildfires, storms, volcanoes', group: 'Earth right now', on: true },
  { id: 'aurora', label: 'Aurora forecast', group: 'Earth right now', on: false },
  { id: 'aircraft', label: 'Aircraft', group: 'Things moving', on: false },
  { id: 'satellites', label: 'ISS + Starlink', group: 'Things moving', on: false },
  { id: 'pulse', label: 'Births & deaths', group: 'Human activity', on: true },
  { id: 'wikiedits', label: 'Wikipedia edits, live', group: 'Human activity', on: false },
  { id: 'cables', label: 'Submarine cables', group: 'Internet', on: false },
];

const UNDER_CITIES = 'cities-0';
const fc = (features) => ({ type: 'FeatureCollection', features });
const point = (lon, lat, properties) => ({ type: 'Feature', geometry: { type: 'Point', coordinates: [lon, lat] }, properties });
const num = new Intl.NumberFormat('en');
const ago = (ms) => {
  const m = Math.max(0, Math.round((Date.now() - ms) / 60000));
  return m < 60 ? `${m} min ago` : `${Math.round(m / 60)} h ago`;
};

const PULSE_COLORS = { birth: '#7ef0a0', death: '#b9a3ff', edit: '#ffffff' };
const PULSE_LIFE_MS = 1800;

export function createLiveLayers(map, { onStatus, getPulseData }) {
  const active = new Map(); // id -> stop()
  const popup = new maplibregl.Popup({ closeButton: false, closeOnClick: false, offset: 10 });

  const hover = (layerId, describe) => {
    const move = (e) => {
      const lines = describe(e.features[0].properties);
      const el = document.createElement('div');
      lines.filter(Boolean).forEach((text, i) => {
        const node = document.createElement(i === 0 ? 'strong' : 'span');
        node.textContent = text;
        node.style.display = 'block';
        el.append(node);
      });
      map.getCanvas().style.cursor = 'pointer';
      popup.setLngLat(e.lngLat).setDOMContent(el).addTo(map);
    };
    const leave = () => {
      map.getCanvas().style.cursor = '';
      popup.remove();
    };
    map.on('mousemove', layerId, move);
    map.on('mouseleave', layerId, leave);
    return () => {
      map.off('mousemove', layerId, move);
      map.off('mouseleave', layerId, leave);
      popup.remove();
    };
  };

  const remove = (layerIds, sourceIds) => {
    layerIds.forEach((l) => map.getLayer(l) && map.removeLayer(l));
    sourceIds.forEach((s) => map.getSource(s) && map.removeSource(s));
  };

  /** Shared helper: fetch a backend feed now and on an interval. */
  const poll = (id, path, everyMs, apply) => {
    let dead = false;
    const run = async () => {
      try {
        const data = await getJSON(path);
        if (!dead) apply(data);
      } catch {
        if (!dead) onStatus(id, 'unavailable right now');
      }
    };
    onStatus(id, 'loading…');
    run();
    const timer = everyMs ? setInterval(run, everyMs) : null;
    return () => {
      dead = true;
      clearInterval(timer);
    };
  };

  // ── Expanding-ring pulses, shared by births/deaths and Wikipedia edits ──
  const pulses = [];
  let pulseRaf = null;
  const ensurePulseLayer = () => {
    if (map.getSource('pulses')) return;
    map.addSource('pulses', { type: 'geojson', data: fc([]) });
    map.addLayer({
      id: 'pulses',
      type: 'circle',
      source: 'pulses',
      paint: {
        'circle-radius': ['interpolate', ['linear'], ['get', 'a'], 0, 2, 1, 16],
        'circle-color': 'rgba(0,0,0,0)',
        'circle-stroke-width': 1.5,
        'circle-stroke-color': ['match', ['get', 'k'], 'birth', PULSE_COLORS.birth, 'death', PULSE_COLORS.death, PULSE_COLORS.edit],
        'circle-stroke-opacity': ['-', 1, ['get', 'a']],
      },
    });
  };
  const drawPulses = () => {
    const now = performance.now();
    while (pulses.length && now - pulses[0].t > PULSE_LIFE_MS) pulses.shift();
    map.getSource('pulses')?.setData(fc(pulses.map((p) => point(p.lon, p.lat, { k: p.k, a: (now - p.t) / PULSE_LIFE_MS }))));
    pulseRaf = pulses.length ? requestAnimationFrame(drawPulses) : null;
  };
  const addPulse = (lon, lat, k) => {
    ensurePulseLayer();
    if (pulses.length > 400) return;
    pulses.push({ lon, lat, k, t: performance.now() });
    if (!pulseRaf) pulseRaf = requestAnimationFrame(drawPulses);
  };

  const starters = {
    daynight() {
      map.addSource('night', { type: 'geojson', data: nightPolygon() });
      map.addLayer({ id: 'night', type: 'fill', source: 'night', paint: { 'fill-color': '#000814', 'fill-opacity': 0.5 } }, UNDER_CITIES);
      onStatus('daynight', 'night side shaded');
      const timer = setInterval(() => map.getSource('night')?.setData(nightPolygon()), 60000);
      return () => {
        clearInterval(timer);
        remove(['night'], ['night']);
      };
    },

    cables() {
      map.addSource('cables', { type: 'geojson', data: fc([]) });
      map.addLayer({
        id: 'cables', type: 'line', source: 'cables',
        paint: { 'line-color': ['coalesce', ['get', 'color'], '#5ad1e6'], 'line-width': 1.1, 'line-opacity': 0.65 },
      }, UNDER_CITIES);
      const unhover = hover('cables', (p) => [p.name, 'Submarine cable']);
      const stop = poll('cables', '/api/live/cables', 0, (d) => {
        map.getSource('cables')?.setData(d);
        onStatus('cables', `${num.format(new Set(d.features.map((f) => f.properties.name)).size)} cables`);
      });
      return () => {
        stop();
        unhover();
        remove(['cables'], ['cables']);
      };
    },

    earthquakes() {
      map.addSource('quakes', { type: 'geojson', data: fc([]) });
      map.addLayer({
        id: 'quakes', type: 'circle', source: 'quakes',
        paint: {
          'circle-radius': ['interpolate', ['linear'], ['get', 'mag'], 2.5, 5, 5, 12, 7, 26],
          'circle-color': ['interpolate', ['linear'], ['get', 'mag'], 2.5, '#ffd166', 5, '#ff7b3d', 7, '#ff2e4c'],
          'circle-opacity': 0.22,
          'circle-stroke-color': ['interpolate', ['linear'], ['get', 'mag'], 2.5, '#ffd166', 5, '#ff7b3d', 7, '#ff2e4c'],
          'circle-stroke-width': 1.6,
        },
      });
      const unhover = hover('quakes', (p) => [`M${(+p.mag).toFixed(1)} earthquake`, p.place, `${ago(p.time)} · ${Math.round(p.depth)} km deep`]);
      const stop = poll('earthquakes', '/api/live/earthquakes', 60000, (d) => {
        map.getSource('quakes')?.setData(fc(d.rows.map(([lon, lat, depth, mag, place, time]) => point(lon, lat, { depth, mag, place, time }))));
        const top = d.rows.reduce((m, r) => Math.max(m, r[3]), 0);
        onStatus('earthquakes', `${d.rows.length} of M2.5+, largest M${top.toFixed(1)}`);
      });
      return () => {
        stop();
        unhover();
        remove(['quakes'], ['quakes']);
      };
    },

    events() {
      const color = ['match', ['get', 'cat'], 'wildfires', '#ff6a3d', 'volcanoes', '#ff3d8b', '#b48cff'];
      map.addSource('events', { type: 'geojson', data: fc([]) });
      map.addLayer({
        id: 'events', type: 'circle', source: 'events',
        paint: { 'circle-radius': 6, 'circle-color': color, 'circle-opacity': 0.35, 'circle-stroke-color': color, 'circle-stroke-width': 2 },
      });
      const names = { wildfires: 'Wildfire', volcanoes: 'Volcano', severeStorms: 'Severe storm' };
      const unhover = hover('events', (p) => [p.title, [names[p.cat] ?? p.cat, p.mag].filter(Boolean).join(' · '), `Updated ${ago(Date.parse(p.date))}`]);
      const stop = poll('events', '/api/live/events', 15 * 60000, (d) => {
        map.getSource('events')?.setData(fc(d.rows.map(([lon, lat, cat, title, date, mag]) => point(lon, lat, { cat, title, date, mag }))));
        const n = (c) => d.rows.filter((r) => r[2] === c).length;
        onStatus('events', `${n('wildfires')} fires · ${n('severeStorms')} storms · ${n('volcanoes')} volcanoes`);
      });
      return () => {
        stop();
        unhover();
        remove(['events'], ['events']);
      };
    },

    aurora() {
      map.addSource('aurora', { type: 'geojson', data: fc([]) });
      map.addLayer({
        id: 'aurora', type: 'circle', source: 'aurora',
        paint: {
          'circle-radius': ['interpolate', ['exponential', 2], ['zoom'], 0, 4, 2, 8, 5, 60],
          'circle-color': ['interpolate', ['linear'], ['get', 'v'], 8, '#2bd97c', 50, '#a6ff7a', 90, '#ff7ad9'],
          'circle-opacity': ['interpolate', ['linear'], ['get', 'v'], 8, 0.08, 60, 0.45],
          'circle-blur': 1,
        },
      }, UNDER_CITIES);
      const stop = poll('aurora', '/api/live/aurora', 10 * 60000, (d) => {
        map.getSource('aurora')?.setData(fc(d.rows.map(([lon, lat, v]) => point(lon, lat, { v }))));
        const peak = d.rows.reduce((m, r) => Math.max(m, r[2]), 0);
        onStatus('aurora', d.rows.length ? `peak ${peak}% chance near the poles` : 'quiet right now');
      });
      return () => {
        stop();
        remove(['aurora'], ['aurora']);
      };
    },

    aircraft() {
      if (!map.hasImage('plane')) {
        const size = 32;
        const ctx = Object.assign(document.createElement('canvas'), { width: size, height: size }).getContext('2d');
        ctx.fillStyle = '#eaf6ff';
        ctx.beginPath();
        ctx.moveTo(16, 3);
        ctx.lineTo(25, 28);
        ctx.lineTo(16, 22);
        ctx.lineTo(7, 28);
        ctx.closePath();
        ctx.fill();
        map.addImage('plane', ctx.getImageData(0, 0, size, size));
      }
      map.addSource('aircraft', { type: 'geojson', data: fc([]) });
      map.addLayer({
        id: 'aircraft', type: 'symbol', source: 'aircraft',
        layout: {
          'icon-image': 'plane',
          'icon-size': ['interpolate', ['linear'], ['zoom'], 1, 0.22, 6, 0.5, 10, 0.8],
          'icon-rotate': ['get', 'h'],
          'icon-rotation-alignment': 'map',
          'icon-allow-overlap': true,
          'icon-ignore-placement': true,
        },
        paint: { 'icon-opacity': 0.85 },
      });
      let snapshot = null;
      // Between snapshots each aircraft is moved along its last known heading and speed.
      const draw = () => {
        if (!snapshot) return;
        const dt = Math.min(20 * 60, Math.max(0, Date.now() / 1000 - snapshot.time));
        map.getSource('aircraft')?.setData(fc(snapshot.rows.map(([lon, lat, h, v, call, alt]) => {
          const d = (v * dt) / 111320;
          const la = Math.max(-89, Math.min(89, lat + d * Math.cos((h * Math.PI) / 180)));
          const lo = lon + (d * Math.sin((h * Math.PI) / 180)) / Math.max(0.05, Math.cos((lat * Math.PI) / 180));
          return point(lo, la, { h, v, call, alt });
        })));
        onStatus('aircraft', `${num.format(snapshot.rows.length)} airborne · positions from ${ago(snapshot.time * 1000)}, projected forward`);
      };
      const unhover = hover('aircraft', (p) => [p.call || 'Aircraft', `${num.format(Math.round(p.alt))} m · ${Math.round(p.v * 3.6)} km/h`]);
      const stop = poll('aircraft', '/api/live/aircraft', 5 * 60000, (d) => {
        snapshot = d;
        draw();
      });
      const timer = setInterval(draw, 2000);
      return () => {
        stop();
        clearInterval(timer);
        unhover();
        remove(['aircraft'], ['aircraft']);
      };
    },

    satellites() {
      map.addSource('starlink', { type: 'geojson', data: fc([]) });
      map.addSource('iss', { type: 'geojson', data: fc([]) });
      map.addLayer({
        id: 'starlink', type: 'circle', source: 'starlink',
        paint: { 'circle-radius': ['interpolate', ['linear'], ['zoom'], 1, 1.1, 6, 2.5], 'circle-color': '#9fd0ff', 'circle-opacity': 0.75 },
      });
      map.addLayer({
        id: 'iss', type: 'circle', source: 'iss',
        paint: { 'circle-radius': 7, 'circle-color': '#ffe45c', 'circle-stroke-color': '#ffffff', 'circle-stroke-width': 2 },
      });
      const locate = (rec, date, gmst) => {
        const pos = propagate(rec, date)?.position;
        if (!pos || Number.isNaN(pos.x)) return null;
        const geo = eciToGeodetic(pos, gmst);
        return [degreesLong(geo.longitude), degreesLat(geo.latitude), geo.height];
      };
      let iss = null;
      let fleet = [];
      const drawIss = () => {
        if (!iss) return;
        const now = new Date();
        const p = locate(iss, now, gstime(now));
        if (p) map.getSource('iss')?.setData(fc([point(p[0], p[1], { name: 'International Space Station', alt: p[2] })]));
      };
      const drawFleet = () => {
        const now = new Date();
        const gmst = gstime(now);
        const features = [];
        for (const s of fleet) {
          const p = locate(s.rec, now, gmst);
          if (p) features.push(point(p[0], p[1], { name: s.name, alt: p[2] }));
        }
        map.getSource('starlink')?.setData(fc(features));
      };
      const describe = (p) => [p.name, `${Math.round(p.alt)} km up · position computed from orbit data`];
      const unhover = [hover('iss', describe), hover('starlink', describe)];
      const stop = poll('satellites', '/api/live/satellites', 30 * 60000, (d) => {
        iss = d.iss ? twoline2satrec(d.iss[1], d.iss[2]) : null;
        fleet = d.starlink.map(([name, l1, l2]) => ({ name, rec: twoline2satrec(l1, l2) }));
        drawIss();
        drawFleet();
        onStatus('satellites', [iss && 'ISS', fleet.length ? `${num.format(fleet.length)} Starlink` : 'Starlink data unavailable right now'].filter(Boolean).join(' · '));
      });
      const t1 = setInterval(drawIss, 1000);
      const t2 = setInterval(drawFleet, 5000);
      return () => {
        stop();
        clearInterval(t1);
        clearInterval(t2);
        unhover.forEach((f) => f());
        remove(['starlink', 'iss'], ['starlink', 'iss']);
      };
    },

    // Births and deaths: real yearly rates per country (World Bank) applied to each city's
    // population, played back in real time. Which city flashes at which moment is random.
    pulse() {
      let births = 0;
      let deaths = 0;
      const poisson = (mean) => {
        let k = 0;
        for (let p = Math.exp(-mean), s = p, u = Math.random(); u > s && k < 50; ) s += p *= mean / ++k;
        return k;
      };
      const pick = (cum) => {
        const target = Math.random() * cum[cum.length - 1];
        let lo = 0;
        let hi = cum.length - 1;
        while (lo < hi) {
          const mid = (lo + hi) >> 1;
          if (cum[mid] < target) lo = mid + 1;
          else hi = mid;
        }
        return lo;
      };
      const TICK = 250;
      const timer = setInterval(() => {
        const d = getPulseData();
        if (!d || !d.cities.length || document.hidden) return;
        for (const [kind, cum] of [['birth', d.cumBirths], ['death', d.cumDeaths]]) {
          const perSecond = cum[cum.length - 1];
          for (let n = poisson((perSecond * TICK) / 1000); n > 0; n--) {
            const c = d.cities[pick(cum)];
            addPulse(c.lon, c.lat, kind);
            kind === 'birth' ? births++ : deaths++;
          }
        }
        onStatus('pulse', `${num.format(births)} births · ${num.format(deaths)} deaths since switched on (est.)`);
      }, TICK);
      onStatus('pulse', 'green = birth, violet = death');
      return () => clearInterval(timer);
    },

    // Live edits to English Wikipedia articles that have coordinates, flashed where the subject is.
    wikiedits() {
      let stream;
      let seen = 0;
      const queue = new Set();
      try {
        stream = new EventSource('https://stream.wikimedia.org/v2/stream/recentchange');
      } catch {
        onStatus('wikiedits', 'unavailable right now');
        return () => {};
      }
      onStatus('wikiedits', 'listening…');
      stream.onmessage = (e) => {
        try {
          const ev = JSON.parse(e.data);
          if (ev.wiki === 'enwiki' && ev.namespace === 0 && ev.type === 'edit' && !ev.bot) queue.add(ev.title);
        } catch { /* ignore malformed events */ }
      };
      stream.onerror = () => onStatus('wikiedits', 'reconnecting…');
      const timer = setInterval(async () => {
        const titles = [...queue].slice(0, 50);
        queue.clear();
        if (!titles.length) return;
        try {
          const url = `https://en.wikipedia.org/w/api.php?action=query&prop=coordinates&colimit=50&format=json&origin=*&titles=${encodeURIComponent(titles.join('|'))}`;
          const pages = Object.values((await (await fetch(url)).json()).query?.pages ?? {});
          let last = null;
          for (const p of pages) {
            const c = p.coordinates?.[0];
            if (!c) continue;
            addPulse(c.lon, c.lat, 'edit');
            seen++;
            last = p.title;
          }
          if (last) onStatus('wikiedits', `${num.format(seen)} place edits · latest: ${last}`);
        } catch { /* next batch will retry */ }
      }, 4000);
      return () => {
        stream.close();
        clearInterval(timer);
      };
    },
  };

  return {
    set(id, on) {
      if (on && !active.has(id)) active.set(id, starters[id]());
      else if (!on && active.has(id)) {
        active.get(id)();
        active.delete(id);
        onStatus(id, '');
      }
    },
    destroy() {
      active.forEach((stop) => {
        try {
          stop();
        } catch { /* map may already be gone */ }
      });
      active.clear();
      cancelAnimationFrame(pulseRaf);
      popup.remove();
    },
  };
}
