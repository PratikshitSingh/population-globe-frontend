import { useEffect, useMemo, useRef, useState } from 'react';
import maplibregl from 'maplibre-gl';
import 'maplibre-gl/dist/maplibre-gl.css';
import { API, getJSON } from './api.js';
import { awakeFraction, localHour } from './astro.js';
import CityPanel, { flag } from './CityPanel.jsx';
import { config } from './config.js';
import { createLiveLayers, LIVE_LAYERS } from './liveLayers.js';
import { sizeClass, SIZE_CLASSES } from './models.js';


const compact = new Intl.NumberFormat('en', { notation: 'compact', maximumFractionDigits: 1 });
const full = new Intl.NumberFormat('en');
const usd = (n) => `$${full.format(Math.round(n))}`;
const duration = (s) =>
  s < 90 ? `${Math.round(s)} s` : s < 5400 ? `${Math.round(s / 60)} min` : s < 129600 ? `${Math.round(s / 3600)} h` : `${Math.round(s / 86400)} d`;

const METRICS = {
  pop: {
    label: 'Population', tab: 'People', log: true, domain: [2e4, 2.5e7],
    colors: ['#1d4e89', '#1f8fb8', '#3fd0c9', '#b8f2a6', '#fdfbc8'],
    fmt: (n) => compact.format(n), est: false,
  },
  of: {
    label: 'OnlyFans users', tab: 'OF', log: true, domain: [50, 2e6],
    colors: ['#3b1c6b', '#7b2fa8', '#c2409e', '#f4728a', '#ffd3b0'],
    fmt: (n) => compact.format(n), est: true,
  },
  ofk: {
    label: 'OnlyFans users per 1,000 people', tab: 'OF / 1k', log: false, domain: [0, 130],
    colors: ['#3b1c6b', '#7b2fa8', '#c2409e', '#f4728a', '#ffd3b0'],
    fmt: (n) => n.toFixed(1), est: true,
  },
  rent: {
    label: 'Monthly rent', tab: 'Rent', log: false, domain: [100, 3200],
    colors: ['#234d3a', '#4f9a52', '#d7c64a', '#f08a3c', '#e8463f'],
    fmt: usd, est: true,
  },
  // Dot size is population, colour is the share of people awake at local time.
  awake: {
    label: 'People awake right now', tab: 'Awake', domain: [0.05, 1],
    colors: ['#16224f', '#4b3f8f', '#b0668f', '#f0a35e', '#ffe9a8'],
    fmt: (n) => compact.format(n), est: true, ends: ['asleep', 'awake'],
  },
};

const TIER_MINZOOM = config.map.cityTierMinZoom;
const tierOf = (pop) => (pop >= 1e6 ? 0 : pop >= 3e5 ? 1 : pop >= 1e5 ? 2 : 3);
const LAYERS = TIER_MINZOOM.map((_, i) => `cities-${i}`);

const RENT_SLIDER_MAX = config.ui.rentSliderMax;
const DEFAULT_FILTERS = { minPop: 4.3, rentMin: 0, rentMax: RENT_SLIDER_MAX, ofkMin: 0, classes: [0, 1, 2, 3], realRent: false };
const SECONDS_PER_YEAR = 31_557_600;
const WORLD_RATES = { birth: 17, death: 7.7 }; // per 1,000 a year, used when a country has no figure

// A city's value for a metric is an estimate unless it's population or a measured rent.
const isEst = (key, c) => METRICS[key].est && !(key === 'rent' && c.rentReal);

function metricValue(key, awakeExpr) {
  if (key === 'awake') return awakeExpr;
  return METRICS[key].log ? ['log10', ['max', ['get', key], 1]] : ['get', key];
}
const metricDomain = (key) => (METRICS[key].log ? METRICS[key].domain.map(Math.log10) : METRICS[key].domain);
function colorExpr(key, awakeExpr) {
  const [lo, hi] = metricDomain(key);
  const { colors } = METRICS[key];
  const stops = colors.flatMap((c, i) => [lo + ((hi - lo) * i) / (colors.length - 1), c]);
  return ['interpolate', ['linear'], metricValue(key, awakeExpr), ...stops];
}
function radiusExpr(key) {
  if (key === 'awake') key = 'pop';
  const [lo, hi] = metricDomain(key);
  const t = ['interpolate', ['linear'], metricValue(key), lo, 0, hi, 1];
  return [
    'interpolate', ['exponential', 1.4], ['zoom'],
    1, ['+', 1.5, ['*', 6, t]],
    6, ['+', 3, ['*', 16, t]],
    12, ['+', 7, ['*', 34, t]],
  ];
}
function filterExpr(tier, f) {
  return [
    'all',
    ['==', ['get', 'tier'], tier],
    ['>=', ['get', 'pop'], Math.pow(10, f.minPop)],
    ['>=', ['get', 'rent'], f.rentMin],
    ['<=', ['get', 'rent'], f.rentMax >= RENT_SLIDER_MAX ? Infinity : f.rentMax],
    ['>=', ['get', 'ofk'], f.ofkMin],
    ['in', ['get', 'cls'], ['literal', f.classes]],
    ['>=', ['get', 'rr'], f.realRent ? 1 : 0],
  ];
}
const toGeoJSON = (cities) => ({
  type: 'FeatureCollection',
  features: cities.map((c) => ({
    type: 'Feature',
    geometry: { type: 'Point', coordinates: [c.lon, c.lat] },
    properties: { id: c.id, pop: c.pop, of: c.of, ofk: c.ofk, rent: c.rent, cls: c.cls, tier: c.tier, tz: c.tz, rr: c.rentReal ? 1 : 0 },
  })),
});

/** Recomputes local time and awake share for every city; returns the map expression for colouring. */
function refreshAwake(cities, tzNames) {
  const now = new Date();
  const hours = tzNames.map((tz) => localHour(tz, now));
  const fracs = hours.map((h) => (h == null ? 0.6 : awakeFraction(h)));
  for (const c of cities) {
    c.hour = hours[c.tz];
    c.awakeFrac = fracs[c.tz];
    c.awake = Math.round(c.pop * c.awakeFrac);
  }
  return ['match', ['get', 'tz'], ...fracs.flatMap((f, i) => [i, +f.toFixed(3)]), 0.6];
}

export default function App() {
  const [data, setData] = useState(null); // { cities, meta, tzNames, countries }
  const [error, setError] = useState(null);
  const [metric, setMetric] = useState('pop');
  const [filters, setFilters] = useState(DEFAULT_FILTERS);
  const [selectedId, setSelectedId] = useState(null);
  const [pinnedId, setPinnedId] = useState(null);
  const [query, setQuery] = useState('');
  const [spin, setSpin] = useState(true);
  const [view, setView] = useState({ zoom: config.map.startZoom, bounds: null });
  const [ready, setReady] = useState(null); // the map instance once its layers exist
  const [clock, setClock] = useState(0); // bumped whenever per-city values are recomputed in place
  const [layers, setLayers] = useState(() => Object.fromEntries(LIVE_LAYERS.map((l) => [l.id, config.layers.onAtStart.includes(l.id)])));
  const [layerStatus, setLayerStatus] = useState({});
  const [history, setHistory] = useState(null); // Zillow rent by year
  const [yearIdx, setYearIdx] = useState(null); // null = latest
  const [playing, setPlaying] = useState(false);
  const [status, setStatus] = useState(null); // backend /api/status, polled
  const [syncedAt, setSyncedAt] = useState(null); // when this page last received city data

  const container = useRef(null);
  const mapRef = useRef(null);
  const liveRef = useRef(null);
  const metricRef = useRef(metric);
  const spinRef = useRef(spin);
  const awakeExprRef = useRef(0.6);
  const pulseRef = useRef(null);
  metricRef.current = metric;
  spinRef.current = spin;

  const cities = data?.cities ?? null;

  // Load cities from the backend.
  useEffect(() => {
    // Bump `v` whenever the response shape changes, so browser and CDN caches of the old shape are skipped.
    getJSON(`/api/cities?v=${config.citiesApiVersion}`)
      .then(({ meta, rows, tz, countries }) => {
        const list = rows.map(([gid, name, cc, lat, lon, pop, rent, rentReal, ofk, tzi], id) => ({
          id, gid, name, cc, lat, lon, pop, rent, ofk, tz: tzi,
          rentReal: rentReal === 1,
          rentLatest: rent,
          rentRealLatest: rentReal === 1,
          of: Math.round((pop * ofk) / 1000),
          cls: sizeClass(pop),
          tier: tierOf(pop),
        }));
        awakeExprRef.current = refreshAwake(list, tz);
        setData({ cities: list, meta, tzNames: tz, countries });
        setSyncedAt(Date.now());
      })
      .catch((e) => setError(`Couldn't load city data from ${API} (${e.message}). Is the backend running?`));
  }, []);

  // Poll the backend's status (config.refresh.statusPollMs). When it holds a newer city dataset than the one on
  // screen (or its copy has passed its refresh interval), re-fetch and update cities in place.
  const dataRef = useRef(null);
  dataRef.current = data;
  const timeLapseRef = useRef(false);
  useEffect(() => {
    if (!cities) return;
    let busy = false;
    const check = async () => {
      let st;
      try {
        st = await getJSON('/api/status');
      } catch {
        return;
      }
      setStatus({ ...st, receivedAt: Date.now() });
      const ds = st.sources.find((s) => s.id === 'dataset');
      const have = dataRef.current.meta.fetchedAt;
      const expired = ds.ageSeconds == null || ds.ageSeconds >= ds.refreshSeconds;
      const newer = ds.fetchedAt != null && ds.fetchedAt > have + 5;
      if (busy || (!expired && !newer)) return;
      busy = true;
      try {
        // `t` names the version being asked for, so the answer is cacheable but never stale.
        const t = expired ? `r${Math.floor(st.now / ds.refreshSeconds)}` : ds.fetchedAt;
        const fresh = await getJSON(`/api/cities?v=${config.citiesApiVersion}&t=${t}`);
        if (fresh.meta.fetchedAt <= have) return;
        const byGid = new Map(fresh.rows.map((r) => [r[0], r]));
        for (const c of cities) {
          const r = byGid.get(c.gid);
          if (!r) continue;
          c.pop = r[5];
          c.rentLatest = r[6];
          c.rentRealLatest = r[7] === 1;
          c.ofk = r[8];
          c.of = Math.round((c.pop * c.ofk) / 1000);
          c.cls = sizeClass(c.pop);
          c.tier = tierOf(c.pop);
          if (!timeLapseRef.current) {
            c.rent = c.rentLatest;
            c.rentReal = c.rentRealLatest;
          }
        }
        awakeExprRef.current = refreshAwake(cities, dataRef.current.tzNames);
        mapRef.current?.getSource('cities')?.setData(toGeoJSON(cities));
        setData((d) => ({ ...d, meta: fresh.meta, countries: fresh.countries }));
        setSyncedAt(Date.now());
        setClock((n) => n + 1);
      } catch { /* try again on the next poll */ } finally {
        busy = false;
      }
    };
    check();
    const timer = setInterval(check, config.refresh.statusPollMs);
    return () => clearInterval(timer);
  }, [cities]);

  // Re-render periodically so "x min ago" labels stay honest.
  const [, setTick] = useState(0);
  useEffect(() => {
    const timer = setInterval(() => setTick((n) => n + 1), config.refresh.labelsMs);
    return () => clearInterval(timer);
  }, []);

  // Keep "awake right now" current.
  useEffect(() => {
    if (!data) return;
    const timer = setInterval(() => {
      awakeExprRef.current = refreshAwake(data.cities, data.tzNames);
      setClock((n) => n + 1);
    }, config.refresh.awakeMs);
    return () => clearInterval(timer);
  }, [data]);

  // Create the globe once data is in.
  useEffect(() => {
    if (!cities) return;
    const map = new maplibregl.Map({
      container: container.current,
      style: config.mapStyle,
      center: config.map.startCenter,
      zoom: config.map.startZoom,
      maxPitch: config.map.maxPitch,
      attributionControl: { compact: true },
    });
    mapRef.current = map;
    map.addControl(new maplibregl.NavigationControl({ visualizePitch: true }), 'bottom-right');

    const popup = new maplibregl.Popup({ closeButton: false, closeOnClick: false, offset: 12 });
    let viewTimer;
    let raf;
    let last = performance.now();

    map.on('style.load', () => {
      map.setProjection({ type: 'globe' });
      map.setSky({ 'atmosphere-blend': ['interpolate', ['linear'], ['zoom'], 0, 1, 5, 1, 7, 0] });
    });

    map.on('load', () => {
      map.addSource('cities', { type: 'geojson', data: toGeoJSON(cities) });
      LAYERS.forEach((id, tier) => {
        map.addLayer({
          id,
          type: 'circle',
          source: 'cities',
          minzoom: TIER_MINZOOM[tier],
          filter: filterExpr(tier, DEFAULT_FILTERS),
          paint: {
            'circle-color': colorExpr(metricRef.current, awakeExprRef.current),
            'circle-radius': radiusExpr(metricRef.current),
            'circle-opacity': 0.78,
            'circle-stroke-color': 'rgba(255,255,255,0.55)',
            'circle-stroke-width': 0.6,
          },
        });
        map.on('mousemove', id, (e) => {
          const c = cities[e.features[0].properties.id];
          const key = metricRef.current;
          map.getCanvas().style.cursor = 'pointer';
          const el = document.createElement('div');
          const title = document.createElement('strong');
          title.textContent = `${c.name}, ${c.cc}`;
          const val = document.createElement('span');
          val.textContent = `${METRICS[key].fmt(c[key])}${key === 'awake' ? ' awake' : ''}${isEst(key, c) ? ' est.' : ''}`;
          el.append(title, val);
          popup.setLngLat([c.lon, c.lat]).setDOMContent(el).addTo(map);
        });
        map.on('mouseleave', id, () => {
          map.getCanvas().style.cursor = '';
          popup.remove();
        });
        map.on('click', id, (e) => setSelectedId(e.features[0].properties.id));
      });
      map.addLayer({
        id: 'selected',
        type: 'circle',
        source: 'cities',
        filter: ['in', ['get', 'id'], ['literal', []]],
        paint: { 'circle-radius': 11, 'circle-color': 'rgba(0,0,0,0)', 'circle-stroke-color': '#ffffff', 'circle-stroke-width': 2 },
      });
      liveRef.current = createLiveLayers(map, {
        onStatus: (id, text) => setLayerStatus((s) => (s[id] === text ? s : { ...s, [id]: text })),
        getPulseData: () => pulseRef.current,
      });
      setReady(map);
    });

    const stop = () => spinRef.current && setSpin(false);
    map.on('mousedown', stop);
    map.on('touchstart', stop);
    map.on('wheel', stop);

    map.on('move', () => {
      clearTimeout(viewTimer);
      viewTimer = setTimeout(() => setView({ zoom: map.getZoom(), bounds: map.getBounds() }), config.map.viewDebounceMs);
    });

    const tick = (now) => {
      const dt = (now - last) / 1000;
      last = now;
      if (spinRef.current && !map.isMoving() && map.getZoom() < config.map.spinMaxZoom) {
        const c = map.getCenter();
        map.jumpTo({ center: [c.lng + dt * config.map.spinDegreesPerSecond, c.lat] });
      }
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);

    return () => {
      cancelAnimationFrame(raf);
      clearTimeout(viewTimer);
      liveRef.current?.destroy();
      liveRef.current = null;
      map.remove();
      mapRef.current = null;
      setReady(null);
    };
  }, [cities]);

  // Rent time-lapse: only cities with a Zillow value for that year are shown.
  const lastYearIdx = history ? history.years.length - 1 : null;
  const timeLapse = history != null && yearIdx != null && yearIdx !== lastYearIdx;
  const effFilters = useMemo(() => (timeLapse ? { ...filters, realRent: true } : filters), [filters, timeLapse]);
  timeLapseRef.current = timeLapse;

  useEffect(() => {
    if (metric === 'rent' && !history) getJSON('/api/rent/history').then(setHistory).catch(() => {});
  }, [metric, history]);

  useEffect(() => {
    const map = mapRef.current;
    if (!cities || !history || !map || ready !== map) return;
    for (const c of cities) {
      const past = timeLapse ? history.rows[c.gid]?.[yearIdx] : null;
      if (timeLapse) {
        c.rent = past ?? c.rentLatest;
        c.rentReal = past != null;
      } else {
        c.rent = c.rentLatest;
        c.rentReal = c.rentRealLatest;
      }
    }
    map.getSource('cities').setData(toGeoJSON(cities));
    setClock((n) => n + 1);
  }, [yearIdx, timeLapse, history, cities, ready]);

  useEffect(() => {
    if (!playing || !history) return;
    const timer = setInterval(() => {
      setYearIdx((i) => {
        const next = (i ?? lastYearIdx) + 1;
        if (next >= lastYearIdx) {
          setPlaying(false);
          return null;
        }
        return next;
      });
    }, config.ui.timeLapseStepMs);
    return () => clearInterval(timer);
  }, [playing, history, lastYearIdx]);

  // Push metric / filter / selection changes into the map.
  useEffect(() => {
    const map = mapRef.current;
    if (!map || ready !== map) return;
    LAYERS.forEach((id, tier) => {
      map.setPaintProperty(id, 'circle-color', colorExpr(metric, awakeExprRef.current));
      map.setPaintProperty(id, 'circle-radius', radiusExpr(metric));
      map.setFilter(id, filterExpr(tier, effFilters));
    });
  }, [metric, effFilters, ready, clock]);

  useEffect(() => {
    const map = mapRef.current;
    if (!map || ready !== map) return;
    map.setFilter('selected', ['in', ['get', 'id'], ['literal', [selectedId, pinnedId].filter((v) => v != null)]]);
  }, [selectedId, pinnedId, ready]);

  useEffect(() => {
    if (!liveRef.current || !ready) return;
    for (const l of LIVE_LAYERS) liveRef.current.set(l.id, layers[l.id]);
  }, [layers, ready]);

  const selected = selectedId != null && cities ? cities[selectedId] : null;
  const pinned = pinnedId != null && cities ? cities[pinnedId] : null;

  const goTo = (c) => {
    setSpin(false);
    setSelectedId(c.id);
    setQuery('');
    mapRef.current?.flyTo({ center: [c.lon, c.lat], zoom: Math.max(mapRef.current.getZoom(), config.map.flyToZoom), speed: config.map.flyToSpeed });
  };

  const matches = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!cities || q.length < 2) return [];
    const out = [];
    for (const c of cities) {
      if (c.name.toLowerCase().startsWith(q)) out.push(c);
      if (out.length === config.ui.searchResults) break;
    }
    return out;
  }, [cities, query]);

  const passes = useMemo(() => {
    const f = effFilters;
    const minPop = Math.pow(10, f.minPop);
    const rentMax = f.rentMax >= RENT_SLIDER_MAX ? Infinity : f.rentMax;
    const classes = new Set(f.classes);
    return (c) =>
      c.pop >= minPop && c.rent >= f.rentMin && c.rent <= rentMax &&
      c.ofk >= f.ofkMin && classes.has(c.cls) && (!f.realRent || c.rentReal);
  }, [effFilters]);

  const whole = view.zoom < config.map.worldStatsMaxZoom || !view.bounds;
  const stats = useMemo(() => {
    if (!cities) return null;
    let pop = 0, of = 0, rentW = 0, awake = 0, rentAllReal = true;
    const visible = [];
    for (const c of cities) {
      if (!passes(c)) continue;
      if (!whole && !view.bounds.contains([c.lon, c.lat])) continue;
      if (!c.rentReal) rentAllReal = false;
      pop += c.pop;
      of += c.of;
      awake += c.awake;
      rentW += c.rent * c.pop;
      visible.push(c);
    }
    const top = [...visible].sort((a, b) => b[metric] - a[metric]).slice(0, config.ui.topListSize);
    return { count: visible.length, pop, of, awake, rent: pop ? rentW / pop : 0, rentAllReal: visible.length > 0 && rentAllReal, top, visible };
    // `clock` is a dependency because rent and awake values are updated in place.
  }, [cities, passes, view, whole, metric, clock]);

  // Births and deaths per second for the cities on screen, for the pulse layer.
  useEffect(() => {
    if (!stats || !data) return;
    const cumBirths = [];
    const cumDeaths = [];
    let b = 0, d = 0;
    for (const c of stats.visible) {
      const rates = data.countries[c.cc] ?? WORLD_RATES;
      b += (c.pop * (rates.birth ?? WORLD_RATES.birth)) / 1000 / SECONDS_PER_YEAR;
      d += (c.pop * (rates.death ?? WORLD_RATES.death)) / 1000 / SECONDS_PER_YEAR;
      cumBirths.push(b);
      cumDeaths.push(d);
    }
    pulseRef.current = { cities: stats.visible, cumBirths, cumDeaths };
  }, [stats, data]);

  const peers = useMemo(() => {
    if (!selected) return null;
    const same = cities.filter((c) => c.cc === selected.cc && c.cls === selected.cls);
    return { n: same.length, rent: same.reduce((s, c) => s + c.rent, 0) / same.length, allReal: same.every((c) => c.rentReal) };
  }, [selected, cities, clock]);

  const setF = (patch) => setFilters((f) => ({ ...f, ...patch }));
  const toggleClass = (i) =>
    setF({ classes: filters.classes.includes(i) ? filters.classes.filter((x) => x !== i) : [...filters.classes, i] });
  const m = METRICS[metric];
  const gradient = `linear-gradient(90deg, ${m.colors.join(', ')})`;
  const meta = data?.meta;
  const groups = [...new Set(LIVE_LAYERS.map((l) => l.group))];
  const shownYear = history ? history.years[yearIdx ?? lastYearIdx] : null;

  return (
    <div className="app">
      <div ref={container} className="map" />
      {!ready && <div className="loading">{error ?? 'Loading globe…'}</div>}

      <aside className="panel left">
        <h1>Population Globe</h1>
        <p className="sub">{cities ? `${full.format(cities.length)} cities` : '…'} · drag to spin, scroll to zoom</p>

        <div className="search">
          <input
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={(e) => e.key === 'Enter' && matches[0] && goTo(matches[0])}
            placeholder="Search a city…"
            aria-label="Search a city"
          />
          {matches.length > 0 && (
            <ul className="results">
              {matches.map((c) => (
                <li key={c.id}>
                  <button onClick={() => goTo(c)}>
                    <span>{flag(c.cc)} {c.name}</span>
                    <em>{compact.format(c.pop)}</em>
                  </button>
                </li>
              ))}
            </ul>
          )}
        </div>

        <h2>Show on globe</h2>
        <div className="tabs" role="tablist">
          {Object.entries(METRICS).map(([k, v]) => (
            <button key={k} role="tab" aria-selected={metric === k} className={metric === k ? 'on' : ''} onClick={() => setMetric(k)}>
              {v.tab}
            </button>
          ))}
        </div>
        <div className="legend">
          <div className="legend-title">
            {m.label}
            {m.est && <span className="est">{metric === 'rent' ? (effFilters.realRent ? null : 'US measured · rest est.') : 'estimate'}</span>}
          </div>
          <div className="bar" style={{ background: gradient }} />
          <div className="legend-ends">
            <span>{m.ends ? m.ends[0] : m.fmt(m.domain[0])}</span>
            <span>{m.ends ? m.ends[1] : `${m.fmt(m.domain[1])}+`}</span>
          </div>
          {metric === 'awake' && <p className="note">Dot size is population; colour is the share awake at local time.</p>}
        </div>

        {metric === 'rent' && history && (
          <div className="timelapse">
            <label className="slider">
              <span>US rent in <b>{shownYear}{timeLapse ? '' : ' (latest)'}</b></span>
              <input
                type="range" min="0" max={lastYearIdx} step="1" value={yearIdx ?? lastYearIdx}
                onChange={(e) => {
                  setPlaying(false);
                  setYearIdx(+e.target.value === lastYearIdx ? null : +e.target.value);
                }}
              />
            </label>
            <button
              className="ghost"
              onClick={() => {
                if (!playing && !timeLapse) setYearIdx(0);
                setPlaying((p) => !p);
              }}
            >
              {playing ? '❚❚ Pause' : `▶ Play ${history.years[0]} → ${history.years[lastYearIdx]}`}
            </button>
            {timeLapse && <p className="note">Showing only the US cities Zillow has data for in {shownYear}.</p>}
          </div>
        )}

        <h2>Live layers</h2>
        {groups.map((g) => (
          <div key={g} className="layer-group">
            <div className="group-name">{g}</div>
            {LIVE_LAYERS.filter((l) => l.group === g).map((l) => (
              <label key={l.id} className="check layer">
                <input type="checkbox" checked={layers[l.id]} onChange={(e) => setLayers((s) => ({ ...s, [l.id]: e.target.checked }))} />
                <span>
                  {l.label}
                  {layers[l.id] && layerStatus[l.id] && <small>{layerStatus[l.id]}</small>}
                </span>
              </label>
            ))}
          </div>
        ))}

        <h2>Filters <button className="link" onClick={() => setFilters(DEFAULT_FILTERS)}>reset</button></h2>
        <label className="slider">
          <span>Min population <b>{compact.format(Math.pow(10, filters.minPop))}</b></span>
          <input type="range" min="4.3" max="7" step="0.05" value={filters.minPop} onChange={(e) => setF({ minPop: +e.target.value })} />
        </label>
        <label className="slider">
          <span>Min rent <b>{usd(filters.rentMin)}</b></span>
          <input type="range" min="0" max={RENT_SLIDER_MAX} step="50" value={filters.rentMin} onChange={(e) => setF({ rentMin: Math.min(+e.target.value, filters.rentMax) })} />
        </label>
        <label className="slider">
          <span>Max rent <b>{filters.rentMax >= RENT_SLIDER_MAX ? 'any' : usd(filters.rentMax)}</b></span>
          <input type="range" min="0" max={RENT_SLIDER_MAX} step="50" value={filters.rentMax} onChange={(e) => setF({ rentMax: Math.max(+e.target.value, filters.rentMin) })} />
        </label>
        <label className="slider">
          <span>Min OnlyFans users / 1k <b>{filters.ofkMin}</b></span>
          <input type="range" min="0" max="130" step="1" value={filters.ofkMin} onChange={(e) => setF({ ofkMin: +e.target.value })} />
        </label>
        <div className="chips">
          {SIZE_CLASSES.map((s, i) => (
            <button key={s.label} className={filters.classes.includes(i) ? 'on' : ''} aria-pressed={filters.classes.includes(i)} onClick={() => toggleClass(i)}>
              {s.label} <em>{s.hint}</em>
            </button>
          ))}
        </div>
        <label className="check">
          <input type="checkbox" checked={effFilters.realRent} disabled={timeLapse} onChange={(e) => setF({ realRent: e.target.checked })} />
          Only cities with measured rent
        </label>

        <h2>Data freshness</h2>
        {status ? (
          <ul className="fresh">
            {status.sources.map((s) => {
              const age = s.ageSeconds == null ? null : s.ageSeconds + (Date.now() - status.receivedAt) / 1000;
              return (
                <li key={s.id}>
                  <span>{s.label}<small>{s.upstream}</small></span>
                  <em>
                    {age == null ? 'not requested yet' : `pulled ${duration(age)} ago`}
                    <small>every {duration(s.refreshSeconds)}</small>
                  </em>
                </li>
              );
            })}
          </ul>
        ) : <p className="note">Checking the backend…</p>}
        <p className="note">
          This page checks the backend every {duration(config.refresh.statusPollMs / 1000)}{syncedAt ? ` and last received city data ${duration((Date.now() - syncedAt) / 1000)} ago` : ''}.
          Live layers only fetch while switched on.
        </p>

        <button className="spin" onClick={() => setSpin((s) => !s)}>{spin ? '❚❚ Pause rotation' : '▶ Auto-rotate'}</button>
        <p className="note">
          Population: GeoNames daily feed. Rent for {meta?.rent.measuredCities ? full.format(meta.rent.measuredCities) : 'no'} US cities is measured:
          Zillow Observed Rent Index{meta?.rent.month ? `, ${meta.rent.month.slice(0, 7)}` : ''} (typical rent, all home types).
          Rent elsewhere, all OnlyFans figures and "awake" are <b>modeled estimates</b>.
        </p>
      </aside>

      <aside className="panel right">
        {selected && (
          <CityPanel
            city={selected}
            pinned={pinned}
            onPin={setPinnedId}
            onClose={() => setSelectedId(null)}
            countries={data.countries}
            peers={peers}
          />
        )}
        {!selected && pinned && (
          <p className="pinned-hint">
            {flag(pinned.cc)} <b>{pinned.name}</b> is pinned. Pick another city to compare. <button className="link" onClick={() => setPinnedId(null)}>unpin</button>
          </p>
        )}
        {stats && (
          <section>
            <h2>{whole ? 'Worldwide' : 'In view'} <span className="muted">· {full.format(stats.count)} cities</span></h2>
            <div className="tiles">
              <div><b>{compact.format(stats.pop)}</b><span>people</span></div>
              <div><b>{compact.format(stats.of)}</b><span>OF users est.</span></div>
              <div><b>{usd(stats.rent)}</b><span>{stats.rentAllReal ? 'avg rent' : 'avg rent est.'}</span></div>
            </div>
            <p className="awake-line">
              <b>{compact.format(stats.awake)}</b> awake right now
              {stats.pop > 0 && ` · ${Math.round((stats.awake / stats.pop) * 100)}%`} <span className="est">est.</span>
            </p>
            <h2>Top by {m.tab.toLowerCase()}</h2>
            <ol className="top">
              {stats.top.map((c) => (
                <li key={c.id}>
                  <button className={c.id === selectedId ? 'on' : ''} onClick={() => goTo(c)}>
                    <span>{flag(c.cc)} {c.name}</span>
                    <em>{m.fmt(c[metric])}</em>
                  </button>
                </li>
              ))}
              {stats.top.length === 0 && <li className="muted">No cities match these filters.</li>}
            </ol>
          </section>
        )}
      </aside>
    </div>
  );
}
