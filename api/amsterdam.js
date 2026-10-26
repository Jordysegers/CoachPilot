// Coachpilot – touringcarregels Amsterdam op de kaart.
// - Routes: open data van de gemeente Amsterdam ("Touringcarinfo halteren en parkeren", data.amsterdam.nl):
//   "Route zonder ontheffing voor touringcars" en "Verplichte route met ontheffing voor touringcars".
// - S100 (binnenring): uit OpenStreetMap (Overpass API), wegen met ref S100.
// Alles wordt vereenvoudigd en 24 uur gecachet door Vercel, zodat de kaart licht blijft.
// Amsterdam Datapunt API (dataset "touringcars"): https://api.data.amsterdam.nl/v1/docs/datasets/touringcars.html
const API = "https://api.data.amsterdam.nl/v1/touringcars/";
// Alleen de verplichte route met ontheffing; het grote netwerk van aanbevolen routes maakt de kaart te druk
// De oranje ontheffingsroute (verplichteroutes) tonen we niet meer: die data sluit niet goed aan.
const SRC = {};
// Corridor binnen de S100 die zonder ontheffing gereden mag worden
const CORRIDOR = /^(Weesperstraat|Mr\. Visserplein|Valkenburgerstraat|Kattenburgerstraat|Kattenburgerplein|Kattenburgerkruising)$/;
const OVERPASS = ["https://overpass-api.de/api/interpreter", "https://overpass.kumi.systems/api/interpreter", "https://overpass.private.coffee/api/interpreter", "https://maps.mail.ru/osm/tools/overpass/api/interpreter", "https://overpass.osm.jp/api/interpreter"];
// De S100 verandert vrijwel nooit: na één geslaagde keer bewaren we hem in Supabase (tabel app_secrets) als reserve
const { createClient } = require("@supabase/supabase-js");
const SB_URL = process.env.SUPABASE_URL || "https://ediwujxxzpwontltomrv.supabase.co";
const SB_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_SECRET_KEY;
const sb = () => SB_KEY ? createClient(SB_URL, SB_KEY, { auth: { persistSession: false } }) : null;
async function saveS100(features) { try { const c = sb(); if (c) await c.from("app_secrets").upsert({ name: "osm_s100", value: { at: new Date().toISOString(), features } }); } catch (e) {} }
async function loadS100() { try { const c = sb(); if (!c) return null; const { data } = await c.from("app_secrets").select("value").eq("name", "osm_s100").maybeSingle(); return data && data.value; } catch (e) { return null; } }
const UA = "Coachpilot/1.0 (https://coachpilot-steel.vercel.app)";
// Een API-sleutel van Amsterdam is (straks) verplicht; zet die dan als AMSTERDAM_API_KEY in Vercel.
const amsHeaders = () => { const h = { Accept: "application/geo+json, application/json", "Accept-Crs": "EPSG:4326", "User-Agent": UA }; if (process.env.AMSTERDAM_API_KEY) h["X-Api-Key"] = process.env.AMSTERDAM_API_KEY; return h; };
const BB = "(52.33,4.83,52.40,4.97)";
// Let op: in OpenStreetMap staan de Amsterdamse stadsroutes vaak als kleine letters (s100), daarom hoofdletterongevoelig zoeken
const S100_Q = '[out:json][timeout:20];relation["type"="route"]["ref"~"^s100$",i]' + BB + '->.r;(way(r.r)["highway"];way["highway"]["ref"~"(^|;)s100(;|$)",i]' + BB + ';way["highway"~"^(primary|secondary|tertiary|trunk|unclassified)(_link)?$"]["name"~"^(Weesperstraat|Mr\\\\. Visserplein|Valkenburgerstraat|Kattenburgerstraat|Kattenburgerplein|Kattenburgerkruising)$"]' + BB + ';);out geom;';

// RD (Rijksdriehoek) naar WGS84, benadering van Schreutelkamp & Strang van Hees (nauwkeurig tot ~1 m)
function rd2wgs(x, y) {
  const dX = (x - 155000) * 1e-5, dY = (y - 463000) * 1e-5;
  const lat = 52.15517440 + (3235.65389 * dY - 32.58297 * dX * dX - 0.2475 * dY * dY - 0.84978 * dX * dX * dY - 0.0655 * dY ** 3 - 0.01709 * dX * dX * dY * dY - 0.00738 * dX + 0.0053 * dX ** 4 - 0.00039 * dX * dX * dY ** 3 + 0.00033 * dX ** 4 * dY - 0.00012 * dX * dY) / 3600;
  const lon = 5.38720621 + (5260.52916 * dX + 105.94684 * dX * dY + 2.45656 * dX * dY * dY - 0.81885 * dX ** 3 + 0.05594 * dX * dY ** 3 - 0.05607 * dX ** 3 * dY + 0.01199 * dY - 0.00256 * dX ** 3 * dY * dY + 0.00128 * dX * dY ** 4 + 0.00022 * dY * dY - 0.00022 * dX * dX + 0.00026 * dX ** 5) / 3600;
  return [lon, lat];
}
const fix = c => { const [a, b] = c; if (Math.abs(a) > 1000 || Math.abs(b) > 1000) return rd2wgs(a, b); if (a > 40 && b < 20) return [b, a]; return [a, b]; };

// Douglas-Peucker in graden (tolerantie ~4 m)
function simplify(pts, tol = 0.00004) {
  if (pts.length < 3) return pts;
  const keep = new Uint8Array(pts.length); keep[0] = keep[pts.length - 1] = 1; const st = [[0, pts.length - 1]];
  while (st.length) { const [a, b] = st.pop(); let md = 0, mi = -1; const [x1, y1] = pts[a], [x2, y2] = pts[b]; const dx = x2 - x1, dy = y2 - y1, L = dx * dx + dy * dy || 1e-18;
    for (let i = a + 1; i < b; i++) { const t = Math.max(0, Math.min(1, ((pts[i][0] - x1) * dx + (pts[i][1] - y1) * dy) / L)); const ex = x1 + t * dx - pts[i][0], ey = y1 + t * dy - pts[i][1]; const d = ex * ex + ey * ey; if (d > md) { md = d; mi = i; } }
    if (mi > 0 && md > tol * tol) { keep[mi] = 1; st.push([a, mi], [mi, b]); } }
  return pts.filter((_, i) => keep[i]);
}
const round = p => [Math.round(p[0] * 1e5) / 1e5, Math.round(p[1] * 1e5) / 1e5];
const line = pts => simplify(pts.map(fix)).map(round);

function wkt(s) {
  const m = String(s).trim().match(/^(MULTI)?LINESTRING\s*\((.*)\)$/i); if (!m) return [];
  const body = m[1] ? m[2].replace(/^\(|\)$/g, "").split(/\)\s*,\s*\(/) : [m[2]];
  return body.map(part => part.split(",").map(t => t.trim().split(/\s+/).map(Number)));
}
// Haal lijnen uit GeoJSON, een lijst met objecten met geometry/WKT, of een ander genest formaat
function linesOf(js) {
  const out = [];
  const fromGeom = g => { if (!g) return; if (typeof g === "string") { wkt(g).forEach(l => out.push(l)); return; }
    if (g.type === "LineString") out.push(g.coordinates); else if (g.type === "MultiLineString") g.coordinates.forEach(l => out.push(l));
    else if (g.type === "GeometryCollection") (g.geometries || []).forEach(fromGeom); };
  const items = Array.isArray(js) ? js : js.features || js.results || js.data || js.items || [];
  items.forEach(it => { if (!it) return; if (it.geometry) return fromGeom(it.geometry);
    const k = Object.keys(it).find(k => /^(wkt|geom|geometrie|wkt_lng_lat|geometry_wkt)/i.test(k)); if (k) fromGeom(it[k]); });
  return out.map(line).filter(l => l.length > 1);
}
async function fetchT(url, opt = {}, ms = 9000) { const c = new AbortController(); const t = setTimeout(() => c.abort(), ms);
  try { return await fetch(url, { ...opt, signal: c.signal }); } catch (e) { throw new Error(url.split("/")[2] + (e.name === "AbortError" ? " reageerde niet op tijd" : ": " + e.message)); } finally { clearTimeout(t); } }
async function getJson(url, opt, ms) { const r = await fetchT(url, opt, ms); if (!r.ok) throw new Error(url.split("/")[2] + " gaf " + r.status); return r.json(); }
// Alle pagina's ophalen (DSO-API geeft een "next"-link mee)
async function getAll(url) { let feats = [], next = url, n = 0;
  while (next && n++ < 20) { const js = await getJson(next, { headers: amsHeaders() }); const f = js.features || (js._embedded && Object.values(js._embedded)[0]) || (Array.isArray(js) ? js : []); feats = feats.concat(f);
    const l = js._links && js._links.next; next = (l && (l.href || l)) || (Array.isArray(js.links) && (js.links.find(x => x.rel === "next") || {}).href) || null; if (typeof next !== "string") next = null; }
  return feats; }
// Alle servers tegelijk proberen; de eerste die antwoordt wint
async function overpass() {
  try { return await Promise.any(OVERPASS.map(u => getJson(u + "?data=" + encodeURIComponent(S100_Q), { headers: { "User-Agent": UA, Accept: "*/*" } }, 25000))); }
  catch (e) { throw new Error((e.errors || [e]).map(x => x.message).join(" / ")); } }

// Gaten dichten: OpenStreetMap knipt wegen op in stukken (pleinen, tunnels, kruisingen) die soms een andere naam hebben.
// Voor elk los eindpunt zoeken we het dichtstbijzijnde punt op een ander stuk van dezelfde soort en trekken een korte verbindingslijn.
function fillGaps(features, kind, maxM) {
  const segs = features.filter(f => f.properties.kind === kind).map(f => f.geometry.coordinates); const add = [];
  const m = (a, b) => { const k = Math.cos(a[1] * Math.PI / 180); return Math.hypot((a[0] - b[0]) * k, a[1] - b[1]) * 111320; };
  segs.forEach((s, i) => [s[0], s[s.length - 1]].forEach(end => {
    let best = null, bd = Infinity, connected = false;
    segs.forEach((t, j) => { if (j === i) return; t.forEach(p => { const d = m(end, p); if (d < 8) connected = true; if (d < bd) { bd = d; best = p; } }); });
    if (!connected && best && bd <= maxM) add.push({ type: "Feature", properties: { kind, gap: true }, geometry: { type: "LineString", coordinates: [end, best] } });
  }));
  return features.concat(add);
}
module.exports = async (req, res) => {
  const out = { type: "FeatureCollection", fetchedAt: new Date().toISOString(), source: "Gemeente Amsterdam (open data) en OpenStreetMap", errors: [], features: [] };
  try {
    if (req.query && req.query.raw) {
      res.setHeader("Cache-Control", "no-store"); const r = await fetchT(SRC.vrij, { headers: amsHeaders() }); const t = await r.text();
      return res.status(200).json({ status: r.status, key: !!process.env.AMSTERDAM_API_KEY, begin: t.slice(0, 1500) });
    }
    const jobs = Object.entries(SRC).map(async ([kind, url]) => { try { linesOf(await getAll(url)).forEach(c => out.features.push({ type: "Feature", properties: { kind }, geometry: { type: "LineString", coordinates: c } })); } catch (e) { out.errors.push(kind + ": " + e.message); } });
    jobs.push((async () => { let osm = [];
      // Snel: een recente reservekopie (< 30 dagen) direct gebruiken, zonder de trage kaartservers te vragen
      const cached = await loadS100();
      if (cached && cached.features && Date.now() - Date.parse(cached.at) < 30 * 864e5 && !(req.query && req.query.fresh)) { cached.features.forEach(f => out.features.push(f)); return; }
      try {
        const js = await overpass();
        osm = (js.elements || []).filter(e => e.type === "way" && e.geometry).map(w => ({ type: "Feature", properties: { kind: CORRIDOR.test((w.tags || {}).name || "") && !/s100/i.test((w.tags || {}).ref || "") ? "corridor" : "s100" }, geometry: { type: "LineString", coordinates: simplify(w.geometry.map(p => [p.lon, p.lat])).map(round) } }));
        if (osm.some(f => f.properties.kind === "s100")) await saveS100(osm); else throw new Error("geen S100 gevonden in OpenStreetMap");
      } catch (e) {
        const c = cached;
        if (c && c.features) { osm = c.features; out.errors.push("s100 uit reserve van " + c.at + " (" + e.message + ")"); } else out.errors.push("s100: " + e.message);
      }
      osm.forEach(f => out.features.push(f)); })());
    await Promise.all(jobs);
    out.features = fillGaps(fillGaps(out.features, "corridor", 450), "s100", 300);
    if (req.query && req.query.debug) { const n = {}; out.features.forEach(f => n[f.properties.kind] = (n[f.properties.kind] || 0) + 1); res.setHeader("Cache-Control", "no-store"); return res.status(200).json({ aantallen: n, fouten: out.errors, sleutel: !!process.env.AMSTERDAM_API_KEY }); }
    if (!out.features.length) throw new Error(out.errors.join("; ") || "geen gegevens");
    res.setHeader("Cache-Control", "public, s-maxage=86400, stale-while-revalidate=604800");
    res.setHeader("Content-Type", "application/json");
    res.status(200).send(JSON.stringify(out));
  } catch (e) {
    res.setHeader("Cache-Control", "public, s-maxage=300");
    res.status(502).json({ error: "Touringcarregels Amsterdam konden niet worden opgehaald: " + (e.message || e) });
  }
};

module.exports.config = { maxDuration: 60 };
