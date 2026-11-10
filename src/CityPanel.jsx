import { useEffect, useState } from 'react';
import { getJSON } from './api.js';
import { config } from './config.js';
import { formatLocalTime } from './astro.js';
import { SIZE_CLASSES } from './models.js';

const compact = new Intl.NumberFormat('en', { notation: 'compact', maximumFractionDigits: 1 });
const full = new Intl.NumberFormat('en');
const usd = (n) => `$${full.format(Math.round(n))}`;
const regionNames = new Intl.DisplayNames(['en'], { type: 'region' });
export const countryName = (cc) => {
  try {
    return regionNames.of(cc) ?? cc;
  } catch {
    return cc;
  }
};
export const flag = (cc) =>
  /^[A-Z]{2}$/.test(cc) ? String.fromCodePoint(...[...cc].map((c) => 0x1f1a5 + c.charCodeAt(0))) : '';

const WEATHER = [
  [0, 'Clear'], [3, 'Partly cloudy'], [48, 'Fog'], [57, 'Drizzle'], [67, 'Rain'], [77, 'Snow'],
  [82, 'Showers'], [86, 'Snow showers'], [99, 'Thunderstorm'],
];
const weatherText = (code) => (code == null ? null : (WEATHER.find(([max]) => code <= max) ?? [0, ''])[1]);
const aqiText = (v) => (v <= 50 ? 'good' : v <= 100 ? 'moderate' : v <= 150 ? 'unhealthy for some' : v <= 200 ? 'unhealthy' : 'very unhealthy');

// Live lookups are cached for the session so compare mode and re-selection are instant.
const cache = new Map();
function useRemote(key, path, refreshMs) {
  const [, bump] = useState(0);
  useEffect(() => {
    if (!key) return;
    let alive = true;
    const load = (silent) => {
      if (!silent) cache.set(key, undefined);
      getJSON(path)
        .then((d) => cache.set(key, d))
        .catch(() => silent || cache.set(key, null)) // a failed refresh keeps the last good value
        .finally(() => alive && bump((n) => n + 1));
    };
    if (!cache.has(key)) load(false);
    // While the panel stays open, re-fetch so weather, air quality and counts keep moving.
    const timer = refreshMs ? setInterval(() => load(true), refreshMs) : null;
    return () => {
      alive = false;
      clearInterval(timer);
      if (cache.get(key) === undefined) cache.delete(key); // let a later mount retry
    };
  }, [key, path, refreshMs]);
  return key ? cache.get(key) : null; // undefined = loading, null = failed
}
const useProfile = (city) => useRemote(city && `profile:${city.gid}`, city && `/api/cities/${city.gid}/profile`, config.refresh.cityProfileMs);

function Row({ label, badge, kind = 'est', children }) {
  if (children == null || children === false) return null;
  return (
    <div>
      <dt>{label}{badge && <> <span className={kind}>{badge}</span></>}</dt>
      <dd>{children}</dd>
    </div>
  );
}

function Amenities({ city }) {
  const [asked, setAsked] = useState(false);
  useEffect(() => setAsked(false), [city.gid]);
  const data = useRemote(asked && `osm:${city.gid}`, `/api/cities/${city.gid}/amenities`);
  if (!asked) return <button className="ghost" onClick={() => setAsked(true)}>Count bars, cafés, gyms… (slow)</button>;
  if (data === undefined) return <p className="muted small">Asking OpenStreetMap… this can take 20 seconds.</p>;
  if (data === null) return <p className="muted small">OpenStreetMap's query service didn't answer. Try again later.</p>;
  return (
    <dl>
      <Row label="Bars & pubs">{full.format(data.bars)}</Row>
      <Row label="Cafés">{full.format(data.cafes)}</Row>
      <Row label="Nightclubs">{full.format(data.nightclubs)}</Row>
      <Row label="Gyms">{full.format(data.gyms)}</Row>
      <Row label="Coworking spaces">{full.format(data.coworking)}</Row>
      <p className="muted small">Mapped in OpenStreetMap within {data.radiusKm} km of the centre.</p>
    </dl>
  );
}

function Compare({ a, b, pa, pb, countries }) {
  const rows = [
    ['Population', (c) => full.format(c.pop)],
    ['Monthly rent', (c) => `${usd(c.rent)}${c.rentReal ? '' : ' est.'}`],
    ['OnlyFans users est.', (c) => compact.format(c.of)],
    ['OnlyFans / 1k est.', (c) => c.ofk.toFixed(1)],
    ['Awake now est.', (c) => `${compact.format(c.awake)} (${Math.round(c.awakeFrac * 100)}%)`],
    ['Local time', (c) => formatLocalTime(c.hour)],
    ['Temperature', (_, p) => (p?.weather?.tempC != null ? `${Math.round(p.weather.tempC)}°C` : '—')],
    ['Air quality (US AQI)', (_, p) => p?.weather?.usAqi ?? '—'],
    ['GitHub developers', (_, p) => (p?.github ? compact.format(p.github.count) : '—')],
    ['Wikipedia views, 30 d', (_, p) => (p?.wikidata?.pageviews30d != null ? compact.format(p.wikidata.pageviews30d) : '—')],
    ['Notable people born', (_, p) => (p?.wikidata?.bornHere != null ? full.format(p.wikidata.bornHere) : '—')],
    ['Internet users', (c) => (countries[c.cc]?.internet != null ? `${Math.round(countries[c.cc].internet)}%` : '—')],
    ['GDP per person', (c) => (countries[c.cc]?.gdp != null ? usd(countries[c.cc].gdp) : '—')],
  ];
  return (
    <table className="compare">
      <thead>
        <tr><th /><th>{flag(a.cc)} {a.name}</th><th>{flag(b.cc)} {b.name}</th></tr>
      </thead>
      <tbody>
        {rows.map(([label, f]) => (
          <tr key={label}><th>{label}</th><td>{f(a, pa)}</td><td>{f(b, pb)}</td></tr>
        ))}
      </tbody>
    </table>
  );
}

export default function CityPanel({ city, pinned, onPin, onClose, countries, peers }) {
  const profile = useProfile(city);
  const pinnedProfile = useProfile(pinned && pinned.id !== city.id ? pinned : null);
  const country = countries[city.cc] ?? {};
  const wd = profile?.wikidata;
  const wx = profile?.weather;
  const comparing = pinned && pinned.id !== city.id;

  return (
    <section className="city">
      <button className="close" onClick={onClose} aria-label="Close">×</button>
      <h3>{flag(city.cc)} {city.name}</h3>
      <p className="sub">
        {countryName(city.cc)} · {SIZE_CLASSES[city.cls].label} city{city.hour != null && ` · ${formatLocalTime(city.hour)} local`}
      </p>
      <button className="ghost" onClick={() => onPin(pinned?.id === city.id ? null : city.id)}>
        {pinned?.id === city.id ? 'Unpin' : comparing ? `Pin ${city.name} instead of ${pinned.name}` : 'Pin to compare with another city'}
      </button>

      {comparing ? (
        <>
          <Compare a={pinned} b={city} pa={pinnedProfile} pb={profile} countries={countries} />
          <button className="ghost" onClick={() => onPin(null)}>Stop comparing</button>
        </>
      ) : (
        <>
          <dl>
            <Row label="Population">{full.format(city.pop)}</Row>
            <Row label={`Latest on Wikidata${wd?.populationAsOf ? ` (${wd.populationAsOf.slice(0, 4)})` : ''}`} badge="live" kind="real">
              {wd?.population != null && full.format(wd.population)}
            </Row>
            <Row label="Awake right now" badge="est.">{compact.format(city.awake)} ({Math.round(city.awakeFrac * 100)}%)</Row>
            <Row label="OnlyFans users" badge="est.">{full.format(city.of)}</Row>
            <Row label="Per 1,000 people" badge="est.">{city.ofk.toFixed(1)}</Row>
            {city.rentReal
              ? <Row label="Typical rent" badge="Zillow" kind="real">{usd(city.rent)}/mo</Row>
              : <Row label="Avg rent, 1-bed" badge="est.">{usd(city.rent)}/mo</Row>}
            <Row
              label={`${SIZE_CLASSES[city.cls].label} cities in ${countryName(city.cc)} (${peers.n})`}
              badge={peers.allReal ? null : city.rentReal ? 'part est.' : 'est.'}
            >
              {usd(peers.rent)}/mo
            </Row>
          </dl>

          <h2>Right now</h2>
          {profile === undefined && <p className="muted small">Looking up live data…</p>}
          {profile === null && <p className="muted small">Live lookups failed. Is the backend reachable?</p>}
          {profile && (
            <dl>
              <Row label="Weather" badge="live" kind="real">
                {wx?.tempC != null && `${Math.round(wx.tempC)}°C · ${weatherText(wx.weatherCode)}`}
              </Row>
              <Row label="Wind">{wx?.windKmh != null && `${Math.round(wx.windKmh)} km/h`}</Row>
              <Row label="Air quality (US AQI)" badge="live" kind="real">{wx?.usAqi != null && `${wx.usAqi} · ${aqiText(wx.usAqi)}`}</Row>
            </dl>
          )}

          {profile && (
            <>
              <h2>Creators & attention</h2>
              <dl>
                <Row label={`GitHub profiles listing "${city.name}"`}>{profile.github && full.format(profile.github.count)}</Row>
                <Row label={`Geotagged Commons photos${profile.commons?.radiusKm ? `, ${profile.commons.radiusKm} km` : ''}`}>
                  {profile.commons && `${full.format(profile.commons.count)}${profile.commons.capped ? '+' : ''}`}
                </Row>
                <Row label={`YouTube videos nearby, ${profile.youtube?.days} days`}>{profile.youtube?.videos != null && `~${compact.format(profile.youtube.videos)}`}</Row>
                <Row label={`Flickr photos nearby, ${profile.flickr?.days} days`}>{profile.flickr && full.format(profile.flickr.photos)}</Row>
                <Row label="Wikipedia views, 30 days">{wd?.pageviews30d != null && full.format(wd.pageviews30d)}</Row>
                <Row label="Notable people born here">{wd?.bornHere != null && full.format(wd.bornHere)}</Row>
              </dl>
            </>
          )}

          {profile?.census && (
            <>
              <h2>US Census ({profile.census.survey})</h2>
              <dl>
                <Row label="Median 1-bed rent">{profile.census.rent1br && `${usd(profile.census.rent1br)}/mo`}</Row>
                <Row label="Median household income">{profile.census.income && usd(profile.census.income)}</Row>
                <Row label="Median age">{profile.census.medianAge}</Row>
              </dl>
            </>
          )}

          <h2>{countryName(city.cc)} <span className="muted">· World Bank</span></h2>
          <dl>
            <Row label={`Internet users (${country.internetYear})`}>{country.internet != null && `${Math.round(country.internet)}%`}</Row>
            <Row label={`GDP per person (${country.gdpYear})`}>{country.gdp != null && usd(country.gdp)}</Row>
            <Row label="Births / deaths per 1,000 a year">
              {country.birth != null && country.death != null && `${country.birth.toFixed(1)} / ${country.death.toFixed(1)}`}
            </Row>
          </dl>

          <h2>City character</h2>
          <Amenities city={city} />
        </>
      )}
    </section>
  );
}
