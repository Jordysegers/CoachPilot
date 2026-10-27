// Coachpilot – geometrie van NWB-wegvakken (Nationaal Wegen Bestand, via PDOK OGC API Features).
// De app vraagt alleen de wegvakken op van de borden die in beeld zijn: ?ids=123,456 (max 100).
// Antwoord: { "123": { c: [[lon,lat],...], t: "HR" } }  — t = baansubsoort (bijv. FP = fietspad).
const BASE = "https://api.pdok.nl/rws/nationaal-wegenbestand-wegen/ogc/v1/collections/wegvakken/items";
const UA = "Coachpilot/1.0 (https://coachpilot-steel.vercel.app)";

async function fetchT(url, ms) { const c = new AbortController(); const t = setTimeout(() => c.abort(), ms);
  try { return await fetch(url, { headers: { "User-Agent": UA, Accept: "application/geo+json, application/json" }, signal: c.signal }); }
  finally { clearTimeout(t); } }
function simplify(pts, tol = 0.00003) {
  if (pts.length < 3) return pts; const keep = new Uint8Array(pts.length); keep[0] = keep[pts.length - 1] = 1; const st = [[0, pts.length - 1]];
  while (st.length) { const [a, b] = st.pop(); let md = 0, mi = -1; const [x1, y1] = pts[a], [x2, y2] = pts[b]; const dx = x2 - x1, dy = y2 - y1, L = dx * dx + dy * dy || 1e-18;
    for (let i = a + 1; i < b; i++) { const t = Math.max(0, Math.min(1, ((pts[i][0] - x1) * dx + (pts[i][1] - y1) * dy) / L)); const ex = x1 + t * dx - pts[i][0], ey = y1 + t * dy - pts[i][1]; const d = ex * ex + ey * ey; if (d > md) { md = d; mi = i; } }
    if (mi > 0 && md > tol * tol) { keep[mi] = 1; st.push([a, mi], [mi, b]); } }
  return pts.filter((_, i) => keep[i]);
}
const lines = g => !g ? [] : g.type === "LineString" ? [g.coordinates] : g.type === "MultiLineString" ? g.coordinates : [];

// Zoeken op wvk_id is bij PDOK traag (geen index). Met de positie van het bord zoeken we in een klein vakje
// (ruimtelijke index, snel) en pakken daar het juiste wegvak uit.
async function one(id, lat, lon) {
  const d = 0.0006, url = lat && lon ? BASE + "?f=json&limit=100&bbox=" + [(lon - d).toFixed(6), (lat - d * 0.62).toFixed(6), (lon + d).toFixed(6), (lat + d * 0.62).toFixed(6)].join(",") : BASE + "?f=json&limit=2&wvk_id=" + encodeURIComponent(id);
  const r = await fetchT(url, 9000);
  if (!r.ok) throw new Error("PDOK gaf " + r.status);
  const js = await r.json(); const fs = js.features || [];
  // wvk_id kan in properties of als feature-id staan; geeft PDOK precies één wegvak terug, dan is dat het gevraagde
  const f = fs.find(x => String((x.properties || {}).wvk_id ?? (x.properties || {}).WVK_ID ?? x.id) === String(id)) || (!(lat && lon) && fs.length === 1 ? fs[0] : null);
  if (!f) throw new Error("niet gevonden");
  const p = f.properties || {}; const c = lines(f.geometry).flat();
  return { c: simplify(c.map(q => [Math.round(q[0] * 1e5) / 1e5, Math.round(q[1] * 1e5) / 1e5])), t: p.bst_code || p.bstCode || "", n: p.stt_naam || p.sttNaam || "", r: [p.routeltr, p.routeltr2].filter(Boolean).join(""), w: p.wegbehsrt || "", f: p.frc != null ? +p.frc : null };
}

// Diagnose: ?near=lat,lon → de dichtstbijzijnde borden met hun wegklasse
async function near(q) {
  const [lat, lon] = String(q).split(",").map(Number); const { createClient } = require("@supabase/supabase-js");
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_SECRET_KEY; const c = createClient(process.env.SUPABASE_URL || "https://ediwujxxzpwontltomrv.supabase.co", key, { auth: { persistSession: false } });
  const { data } = await c.from("app_secrets").select("value").eq("name", "ndw_limits").maybeSingle(); const items = (data && data.value && data.value.items) || [];
  const rel = it => it[2] === "h" ? it[3] <= 4.5 : it[2] === "l" ? it[3] <= 15 : it[3] <= 40;
  const list = items.filter(rel).map(it => [Math.hypot((it[0] - lat) * 111, (it[1] - lon) * 68), it]).sort((a, b) => a[0] - b[0]).slice(0, 25);
  const t0 = Date.now(); const out = await Promise.all(list.map(async ([d, it]) => { try { const r = await one(it[5], it[0], it[1]); return { km: +d.toFixed(2), bord: it[2] + " " + it[3], straat: it[4], wegklasse: r.f, beheer: r.w, route: r.r, soort: r.t }; } catch (e) { return { km: +d.toFixed(2), bord: it[2] + " " + it[3], straat: it[4], fout: e.message }; } }));
  return { borden_totaal: items.length, ms: Date.now() - t0, dichtstbij: out };
}
module.exports = async (req, res) => {
  if (req.query && req.query.near) { res.setHeader("Cache-Control", "no-store"); try { return res.status(200).json(await near(req.query.near)); } catch (e) { return res.status(200).json({ fout: e.message }); } }
  // ids als "wvk_id" of "wvk_id:lat:lon"
  const reqs = String((req.query && req.query.ids) || "").split(",").map(s => s.trim().split(":")).filter(a => /^\d{3,12}$/.test(a[0])).slice(0, 100);
  const ids = reqs.map(a => a[0]);
  if (req.query && req.query.debug == "2") { res.setHeader("Cache-Control", "no-store"); try { return res.status(200).json(await one(ids[0])); } catch (e) { return res.status(200).json({ fout: e.message }); } }
  if (req.query && req.query.debug) { res.setHeader("Cache-Control", "no-store");
    try { const r = await fetchT(BASE + "?f=json&limit=1&wvk_id=" + (ids[0] || "1"), 9000); const t = await r.text(); return res.status(200).json({ status: r.status, begin: t.slice(0, 1500) }); }
    catch (e) { return res.status(200).json({ fout: e.message }); } }
  const out = {}, errors = []; let i = 0;
  async function worker() { while (i < reqs.length) { const [id, la, lo] = reqs[i++]; try { out[id] = await one(id, +la || 0, +lo || 0); } catch (e) { out[id] = null; errors.push(id + ": " + e.message); } } }
  await Promise.all(Array.from({ length: 8 }, worker));
  res.setHeader("Cache-Control", errors.length ? "public, s-maxage=600" : "public, s-maxage=2592000, stale-while-revalidate=2592000");
  res.status(200).json({ roads: out, errors: errors.slice(0, 5) });
};
module.exports.config = { maxDuration: 30 };
