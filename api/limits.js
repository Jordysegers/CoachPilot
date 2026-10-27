// Coachpilot – doorrijhoogtes en maximale gewichten uit de open verkeersborden-data van het NDW.
// Bron: NDW Verkeersborden API (https://docs.ndw.nu/en/data-uitwisseling/interface-beschrijvingen/verkeersborden-api/).
// RVV C19 = maximale hoogte, C21 = maximaal totaalgewicht. We maken er een compacte lijst van [lat, lon, waarde]
// en bewaren een reservekopie in Supabase (tabel app_secrets), omdat het ophalen bij het NDW traag kan zijn.
const { createClient } = require("@supabase/supabase-js");
const SB_URL = process.env.SUPABASE_URL || "https://ediwujxxzpwontltomrv.supabase.co";
const SB_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_SECRET_KEY;
const sb = () => SB_KEY ? createClient(SB_URL, SB_KEY, { auth: { persistSession: false } }) : null;
const UA = "Coachpilot/1.0 (https://coachpilot-steel.vercel.app)";
const BASES = ["https://data.ndw.nu/api/rest/static-road-data/traffic-signs/v4/current-state", "https://data.ndw.nu/api/rest/static-road-data/traffic-signs/v1/current-state"];
const KINDS = { C19: "h", C21: "t" };

async function fetchT(url, ms) { const c = new AbortController(); const t = setTimeout(() => c.abort(), ms);
  try { return await fetch(url, { headers: { "User-Agent": UA, Accept: "application/json", "Accept-Encoding": "gzip" }, signal: c.signal }); }
  catch (e) { throw new Error(e.name === "AbortError" ? "NDW reageerde niet op tijd" : e.message); } finally { clearTimeout(t); } }

const get = (o, paths) => { for (const p of paths) { let v = o; for (const k of p.split(".")) v = v == null ? v : v[k]; if (v != null && v !== "") return v; } return null; };
// Waarde van het bord: "3,5 m" / "3.5" / "12t"
function valueOf(s, kind) {
  const cands = [get(s, ["blackCode", "black_code", "value", "details.blackCode"]), ...(get(s, ["textSigns", "text_signs"]) || []).map(t => typeof t === "string" ? t : (t && (t.text || t.value)) || "")].filter(Boolean).map(String);
  for (const c of cands) { const m = c.replace(",", ".").match(/(\d{1,2}(?:\.\d{1,2})?)/); if (m) { const v = parseFloat(m[1]); if (kind === "h" && v >= 1.5 && v <= 6) return v; if (kind === "t" && v >= 1 && v <= 80) return v; } }
  return null;
}
async function fetchKind(code) {
  let lastErr;
  for (const base of BASES) for (const param of ["rvvCode", "rvv-code"]) {
    try {
      const r = await fetchT(base + "?" + param + "=" + code, 40000); if (!r.ok) throw new Error("NDW gaf " + r.status);
      const js = await r.json(); const list = Array.isArray(js) ? js : js.items || js.features || js.data || [];
      if (!list.length) throw new Error("geen borden");
      const codeOf = s => String(get(s, ["rvvCode", "rvv_code", "properties.rvvCode"]) || "");
      const ok = list.filter(s => codeOf(s).toUpperCase().startsWith(code));
      if (ok.length < list.length * 0.8) throw new Error("filter werkte niet");
      return ok;
    } catch (e) { lastErr = e; }
  }
  throw lastErr;
}

module.exports = async (req, res) => {
  const errors = []; let out = null;
  const c = sb(); let cached = null;
  try { if (c) { const { data } = await c.from("app_secrets").select("value").eq("name", "ndw_limits").maybeSingle(); cached = data && data.value; } } catch (e) {}
  const fresh = cached && cached.items && Date.now() - Date.parse(cached.at) < 14 * 864e5 && !(req.query && req.query.fresh);
  if (fresh) out = cached;
  else {
    const items = [];
    for (const [code, kind] of Object.entries(KINDS)) {
      try {
        const list = await fetchKind(code); const seen = new Set();
        list.forEach(s => {
          const lat = +get(s, ["location.wgs84.latitude", "location.lat", "latitude", "lat"]), lon = +get(s, ["location.wgs84.longitude", "location.lon", "location.lng", "longitude", "lon"]);
          const v = valueOf(s, kind); if (!lat || !lon || v == null) return;
          const k = kind + lat.toFixed(4) + lon.toFixed(4) + v; if (seen.has(k)) return; seen.add(k);
          items.push([Math.round(lat * 1e5) / 1e5, Math.round(lon * 1e5) / 1e5, kind, v]);
        });
      } catch (e) { errors.push(code + ": " + e.message); }
    }
    if (items.length) { out = { at: new Date().toISOString(), items }; try { if (c) await c.from("app_secrets").upsert({ name: "ndw_limits", value: out }); } catch (e) {} }
    else if (cached && cached.items) { out = cached; errors.push("reservekopie gebruikt"); }
  }
  if (req.query && req.query.debug) { res.setHeader("Cache-Control", "no-store"); return res.status(200).json({ aantal: out ? out.items.length : 0, hoogtes: out ? out.items.filter(i => i[2] === "h").length : 0, gewichten: out ? out.items.filter(i => i[2] === "t").length : 0, bijgewerkt: out && out.at, fouten: errors, voorbeeld: out ? out.items.slice(0, 5) : [] }); }
  if (!out) { res.setHeader("Cache-Control", "public, s-maxage=300"); return res.status(502).json({ error: "Doorrijhoogtes konden niet worden opgehaald: " + errors.join("; ") }); }
  res.setHeader("Cache-Control", "public, s-maxage=86400, stale-while-revalidate=604800");
  res.setHeader("Content-Type", "application/json");
  res.status(200).send(JSON.stringify({ source: "NDW verkeersborden (C19 hoogte, C21 gewicht)", at: out.at, items: out.items, errors }));
};
module.exports.config = { maxDuration: 60 };
