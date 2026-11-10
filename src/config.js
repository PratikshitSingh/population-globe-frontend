// All tunable settings for the frontend live here: where the backend is, how often
// each thing refreshes, and the map and UI defaults. Edit this file to change them.
// The three values most likely to differ per deployment can also be set at build
// time with environment variables (see .env.example).

const env = import.meta.env;
const SECOND = 1000;
const MINUTE = 60 * SECOND;
const seconds = (value, fallback) => (value == null || value === '' || Number.isNaN(+value) ? fallback : +value * SECOND);

export const config = {
  // Base URL of the FastAPI backend, no trailing slash.            env: VITE_API_URL
  apiUrl: (env.VITE_API_URL ?? 'http://localhost:8000').replace(/\/$/, ''),
  // Bump when the shape of /api/cities changes, so cached copies of the old shape are skipped.
  citiesApiVersion: 2,
  // MapLibre style for the basemap.                                env: VITE_MAP_STYLE
  mapStyle: env.VITE_MAP_STYLE ?? 'https://basemaps.cartocdn.com/gl/dark-matter-gl-style/style.json',

  // How often the page asks the backend for things (milliseconds).
  refresh: {
    // Poll /api/status; city data is re-fetched when it reports newer data.  env: VITE_STATUS_POLL_SECONDS
    statusPollMs: seconds(env.VITE_STATUS_POLL_SECONDS, 30 * SECOND),
    // Re-fetch the open city's live profile (weather, air quality, counts).
    cityProfileMs: 5 * MINUTE,
    // Recompute local time and "awake right now" for every city (no network).
    awakeMs: 1 * MINUTE,
    // Redraw "x min ago" labels (no network).
    labelsMs: 10 * SECOND,
  },

  // Live layers: which start switched on, and each one's timers.
  layers: {
    onAtStart: ['daynight', 'earthquakes', 'events', 'pulse'],
    daynight: { redrawMs: 1 * MINUTE },
    earthquakes: { pollMs: 1 * MINUTE },
    events: { pollMs: 15 * MINUTE },
    aurora: { pollMs: 10 * MINUTE },
    aircraft: {
      pollMs: 5 * MINUTE,          // the backend itself refreshes from OpenSky every 15 min
      redrawMs: 2 * SECOND,        // how often aircraft are moved along their heading
      maxProjectionSeconds: 20 * 60, // stop projecting a position forward after this long
    },
    satellites: { pollMs: 30 * MINUTE, issRedrawMs: 1 * SECOND, starlinkRedrawMs: 5 * SECOND },
    cables: {},
    pulse: {
      tickMs: 250,        // how often births/deaths are sampled
      lifeMs: 1800,       // how long one ring stays on screen
      maxOnScreen: 400,
    },
    wikiedits: {
      streamUrl: 'https://stream.wikimedia.org/v2/stream/recentchange',
      coordinatesApiUrl: 'https://en.wikipedia.org/w/api.php',
      wiki: 'enwiki',
      batchMs: 4 * SECOND, // how often queued article titles are looked up for coordinates
      batchSize: 50,       // API maximum per request
    },
  },

  map: {
    startCenter: [15, 25],
    startZoom: 1.6,
    maxPitch: 80,
    // Smaller cities appear as you zoom in: [1M+, 300k+, 100k+, the rest].
    cityTierMinZoom: [0, 2.2, 3.8, 5.2],
    spinDegreesPerSecond: 5,
    spinMaxZoom: 4,          // auto-rotate pauses when zoomed in past this
    worldStatsMaxZoom: 3,    // below this zoom the stats panel says "Worldwide"
    viewDebounceMs: 180,     // wait this long after the map stops moving before recomputing stats
    flyToZoom: 8.5,
    flyToSpeed: 1.1,
  },

  ui: {
    searchResults: 7,
    topListSize: 8,
    rentSliderMax: 4500,     // at the top of the slider, "max rent" means no limit
    timeLapseStepMs: 1100,   // time each year stays on screen during rent playback
  },
};
