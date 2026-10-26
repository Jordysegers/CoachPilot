// Coachpilot – touringcarregels Amsterdam op de kaart.
// - Routes: open data van de gemeente Amsterdam ("Touringcarinfo halteren en parkeren", data.amsterdam.nl):
//   "Route zonder ontheffing voor touringcars" en "Verplichte route met ontheffing voor touringcars".
// - S100 (binnenring): uit OpenStreetMap (Overpass API), wegen met ref S100.
// Alles wordt vereenvoudigd en 24 uur gecachet door Vercel, zodat de kaart licht blijft.
const SRC = {
  vrij: "https://e85bcf2124fb4437b1bc6eb75dfc3abf.objectstore.eu/dcatd/bb070fe2638f4fe8b4a5abac0fa450e0",
  ontheffing: "https://e85bcf2124fb4437b1bc6eb75dfc3abf.objectstore.eu/dcatd/f118360818664180a66fe1f75204ccd2"
};
const OVERPASS = "https://overpass-api.de/api/interpreter";
const S100_Q = '[out:json][timeout:25];area["name"="Amsterdam"]["admin_level"="8"]->.a;(way(area.a)["highway"]["ref"~"(^|;)S100(;|$)"];relation(area.a)["type"="route"]["ref"="S100"];)->.r;(.r;way(r.r););way._["highway"];out geom;';

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
async function getJson(url, opt) { const r = await fetch(url, opt); if (!r.ok) throw new Error(url.split("/")[2] + " gaf " + r.status); return r.json(); }

module.exports = async (req, res) => {
  const out = { type: "FeatureCollection", fetchedAt: new Date().toISOString(), source: "Gemeente Amsterdam (open data) en OpenStreetMap", errors: [], features: [] };
  try {
    if (req.query && req.query.raw) {
      const js = await getJson(SRC.vrij); const it = (Array.isArray(js) ? js : js.features || [])[0];
      res.setHeader("Cache-Control", "no-store");
      return res.status(200).json({ isArray: Array.isArray(js), keys: Array.isArray(js) ? null : Object.keys(js), first: it ? JSON.stringify(it).slice(0, 1200) : null });
    }
    const jobs = Object.entries(SRC).map(async ([kind, url]) => { try { linesOf(await getJson(url)).forEach(c => out.features.push({ type: "Feature", properties: { kind }, geometry: { type: "LineString", coordinates: c } })); } catch (e) { out.errors.push(kind + ": " + e.message); } });
    jobs.push((async () => { try {
      const js = await getJson(OVERPASS, { method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded" }, body: "data=" + encodeURIComponent(S100_Q) });
      (js.elements || []).filter(e => e.type === "way" && e.geometry).forEach(w => out.features.push({ type: "Feature", properties: { kind: "s100" }, geometry: { type: "LineString", coordinates: simplify(w.geometry.map(p => [p.lon, p.lat])).map(round) } }));
    } catch (e) { out.errors.push("s100: " + e.message); } })());
    await Promise.all(jobs);
    if (!out.features.length) throw new Error(out.errors.join("; ") || "geen gegevens");
    res.setHeader("Cache-Control", "public, s-maxage=86400, stale-while-revalidate=604800");
    res.setHeader("Content-Type", "application/json");
    res.status(200).send(JSON.stringify(out));
  } catch (e) {
    res.setHeader("Cache-Control", "public, s-maxage=300");
    res.status(502).json({ error: "Touringcarregels Amsterdam konden niet worden opgehaald: " + (e.message || e) });
  }
};
