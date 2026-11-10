# Population Globe — frontend

Interactive 3D globe of ~25,000 cities, built with Vite, React and MapLibre GL.
All data comes from the [backend](https://github.com/PratikshitSingh/population-globe-backend).

```bash
npm install
npm run dev        # http://localhost:5199, expects the backend on http://localhost:8000
```

Set `VITE_API_URL` to the backend's URL at build time (see `.env.example`).

## Features

- **Globe:** spin, tilt, zoom to street level; city search.
- **Metrics:** population, OnlyFans users (estimate), OnlyFans per 1,000 (estimate), rent, people awake right now (estimate).
- **Filters:** population, rent range, OnlyFans per 1k, city size, measured-rent-only.
- **Live layers:** day/night line, earthquakes, wildfires/storms/volcanoes, aurora forecast, aircraft,
  ISS + Starlink, births & deaths pulse, live Wikipedia edits, submarine cables.
- **City panel:** live weather and air quality, Wikidata population, GitHub developers, geotagged photos,
  Wikipedia views, notable people born there, country stats, and nearby bars/cafés/gyms on request.
- **Compare:** pin a city, pick another, see them side by side.
- **Rent time-lapse:** play US rent from 2015 to today.

## Files

| File | What it holds |
| --- | --- |
| `src/App.jsx` | globe, metrics, filters, stats |
| `src/CityPanel.jsx` | city details, live profile, compare table |
| `src/liveLayers.js` | every optional live layer |
| `src/astro.js` | sun position, day/night polygon, awake curve |

The live Wikipedia edit layer talks to Wikimedia directly from the browser; everything else goes through the backend.
