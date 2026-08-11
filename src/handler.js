// HTTP app: (Request, env, store) -> Response, on Web-standard APIs.
//
// Production does NOT use this — the bucket is served directly, with nothing
// in the request path. This backs server.js for local use and self-hosting, so
// it can still do things the bucket cannot: compute a reading on demand when
// the store has none, and re-check a provider when a stored zone has gone
// stale. Keep the served shapes identical to the objects the pipeline writes.
//
// Single source of truth: sync.sh computes the snapshot and writes data/. This
// app SERVES that precomputed data (via `store`) and never recomputes it when a
// snapshot exists. Responses are served verbatim, so a reading is byte-identical
// whether it comes from here or straight out of the bucket.
// If no precomputed file is available, it computes on demand as a fallback.
//
// Routes:
//   /                         landing page
//   /v1/last-hour/<CODE>      last-hour reading for one country (ISO-2 / ISO-3)
//   /v1/zones/<CODE>/<ZONE>   same for a bidding zone / balancing region,
//                             where the provider publishes below national level
//                             (see `zones` in /v1/countries). Measured only.
//   /v1/latest.json           combined snapshot
//   /v1/countries             supported countries (+ data source per country)

import { ATTRIBUTION, ProviderlessZone, UnknownCountry, lastHour, listCountries, resolveCode } from "./data.js";
import { measuredLastHour, zonesFor } from "./live.js";

const SOURCE_URL = "https://github.com/fabiocicerchia/carbon-intensity-api";
const STALE_AFTER_SECONDS = 3900; // a fresh snapshot is expected hourly

function json(body, status = 200) {
  return new Response(`${JSON.stringify(body, null, 2)}\n`, {
    status,
    headers: { "content-type": "application/json; charset=utf-8" },
  });
}

// Staleness is no longer published as a field: responses are served verbatim so
// they stay identical whether they come from here or straight out of the bucket, and a
// caller derives freshness from `generated_at`. This stays internal, used only
// to decide whether a stored zone reading is worth rechecking with its provider.
function isStale(doc, now) {
  const gen = Date.parse(doc.generated_at);
  if (Number.isNaN(gen)) return true;
  return (now - gen) / 1000 > STALE_AFTER_SECONDS;
}

export async function handleRequest(request, env = {}, store = null, now = Date.now()) {
  const url = new URL(request.url);
  const path = url.pathname.replace(/\/+$/, "") || "/";

  // Landing page (served from the deployed data/ dir).
  if (path === "/" || path === "/index.html") {
    const html = store && await store.get("index.html");
    if (html) return new Response(html, { headers: { "content-type": "text/html; charset=utf-8" } });
    return json({ service: "carbon-intensity-api", endpoints: ["/v1/last-hour/<CODE>", "/v1/zones/<CODE>/<ZONE>", "/v1/latest.json", "/v1/countries"] });
  }

  if (path === "/v1/countries") {
    const entries = listCountries();
    return json({ count: entries.length, attribution: ATTRIBUTION, countries: entries });
  }

  if (path === "/v1/latest.json") {
    const latest = store && await store.get("v1/latest.json");
    if (latest) return json(JSON.parse(latest));
    return json({ detail: "No precomputed snapshot yet." }, 503);
  }

  // Zone lookup: /v1/zones/<CODE>/<ZONE>. A separate prefix, not a child of
  // last-hour: the pipeline writes to a directory before syncing, and a
  // filesystem cannot have v1/last-hour/AU be both a file and a folder.
  const z = path.match(/^\/v1\/zones\/([^/]+)\/([^/]+)$/);
  if (z) {
    let code;
    try {
      code = resolveCode(decodeURIComponent(z[1]));
    } catch (e) {
      if (e instanceof UnknownCountry) {
        return json({ detail: `Unknown country ${JSON.stringify(z[1])}. See /v1/countries.` }, 404);
      }
      throw e;
    }
    const zone = decodeURIComponent(z[2]).toUpperCase();
    const known = zonesFor(code);
    if (!known.includes(zone)) {
      return json({
        detail: known.length
          ? `Unknown zone ${JSON.stringify(zone)} for ${code}.`
          : `${code} has no sub-country zones.`,
        zones: known,
      }, 404);
    }
    let cachedDoc = null;
    if (store) {
      const cached = await store.get(`v1/zones/${code}/${zone}`);
      if (cached) {
        cachedDoc = JSON.parse(cached);
        // Fresh snapshot: serve it and leave the provider alone.
        if (!isStale(cachedDoc, now)) return json(cachedDoc);
      }
    }
    // Either nothing stored, or what is stored has gone stale because a run
    // missed this zone. One attempt only — a client should not wait out a
    // retry ladder against a provider the hourly pipeline already failed on.
    const measured = await measuredLastHour(code, { env, zone, attempts: 1 });
    try {
      const reading = lastHour(code, { measured, zone });
      reading.attribution = ATTRIBUTION;
      return json(reading);
    } catch (e) {
      if (!(e instanceof ProviderlessZone)) throw e;
      // Nothing live. An old reading beats no reading — its `generated_at`
      // says how old, and the caller can judge. 404 is only for a zone that
      // has never had data at all.
      if (cachedDoc) return json(cachedDoc);
      return json({ detail: `No data for ${code}/${zone}.` }, 404);
    }
  }

  // Path-based last-hour lookup (ISO-2 or ISO-3). No .json variant: the bucket
  // matches exact keys, and every key it holds is extensionless.
  const m = path.match(/^\/v1\/last-hour\/(.+)$/);
  if (m) {
    let code;
    try {
      code = resolveCode(decodeURIComponent(m[1]));
    } catch (e) {
      if (e instanceof UnknownCountry) {
        return json({ detail: `Unknown country ${JSON.stringify(m[1])}. See /v1/countries.` }, 404);
      }
      throw e;
    }
    // Prefer the precomputed snapshot (single source of truth).
    if (store) {
      const cached = await store.get(`v1/last-hour/${code}`);
      if (cached) return json(JSON.parse(cached));
    }
    // Fallback: compute on demand (no snapshot available).
    const measured = await measuredLastHour(code, { env });
    const reading = lastHour(code, { measured });
    reading.attribution = ATTRIBUTION;
    return json(reading);
  }

  return json({ detail: "Not found." }, 404);
}
