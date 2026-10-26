// Coachpilot – milieuzones en zero-emissiezones uit de open data van het NDW (Nationaal Dataportaal Wegverkeer).
// Bron: https://data.ndw.nu/api/rest/static-road-data/emission-zones/v1/map (CC-0). Het NDW werkt dit dagelijks bij;
// deze functie wordt 6 uur gecachet door Vercel, zodat de kaart altijd actueel is zonder de bron te overbelasten.
const SRC = "https://data.ndw.nu/api/rest/static-road-data/emission-zones/v1/map";

const first = (o, keys) => { for (const k of keys) { if (o && o[k] != null && o[k] !== "") return o[k]; } return null; };

// Zoek in een willekeurig genest object naar regels voor voertuigtypes (bus) en euroklassen
function scanRules(obj) {
  const out = []; const seen = new Set();
  (function walk(v, depth) {
    if (!v || depth > 8 || typeof v !== "object") return;
    if (seen.has(v)) return; seen.add(v);
    if (Array.isArray(v)) { v.forEach(x => walk(x, depth + 1)); return; }
    const vt = first(v, ["vehicleType", "voertuigType", "voertuigtype", "vehicleCategory", "category", "type"]);
    const cl = first(v, ["classification", "emissionClassification", "euroClass", "euroklasse", "emissionClass", "minimumEuroClass"]);
    if (vt && typeof vt === "string" && cl && typeof cl === "string") out.push({ vehicle: vt.toUpperCase(), cls: cl.toUpperCase() });
    Object.values(v).forEach(x => walk(x, depth + 1));
  })(obj, 0);
  return out;
}

function normalize(f) {
  const p = f.properties || {};
  const flat = JSON.stringify(p).toUpperCase();
  const name = first(p, ["name", "naam", "zoneName", "zoneNaam", "title", "description", "displayName"]) || "Milieuzone";
  const town = first(p, ["municipality", "gemeente", "municipalityName", "city", "plaats"]);
  const ze = /ZERO|NUL[_ -]?EMISSIE|ZERO_EMISSION|UITSTOOTVRIJ/.test(flat);
  const rules = scanRules(p);
  const busRules = rules.filter(r => /BUS|COACH|AUTOBUS/.test(r.vehicle));
  const mentionsBus = /\bBUS\b|AUTOBUS|COACH|\"BUS/.test(flat);
  const vehicles = [...new Set(rules.map(r => r.vehicle))];
  const from = first(p, ["validFrom", "startDate", "geldigVanaf", "start", "validityStart", "effectiveFrom"]);
  const until = first(p, ["validTo", "endDate", "geldigTot", "end", "validityEnd"]);
  const url = first(p, ["url", "informationUrl", "informatieUrl", "website", "link", "moreInfoUrl"]);
  const status = first(p, ["status", "state"]);
  return {
    type: "Feature",
    geometry: f.geometry,
    properties: {
      id: String(first(p, ["id", "zoneId", "identifier", "regulationId"]) || first(f, ["id"]) || name),
      name: String(name), town: town ? String(town) : null, zone: ze ? "zero" : "low",
      bus: busRules.length ? busRules.map(r => r.cls) : null, busKnown: busRules.length > 0, mentionsBus, vehicles,
      from: from ? String(from) : null, until: until ? String(until) : null, url: url ? String(url) : null, status: status ? String(status) : null
    }
  };
}

// Milieuzones die volgens milieuzones.nl gelden voor autobussen (touringcar en OV): "paarse" zones, diesel minimaal Euro 6.
// Bron: https://www.milieuzones.nl/autobussen. Zero-emissiezones in Nederland gelden (nog) niet voor bussen, alleen voor bestel- en vrachtauto's.
const BUS_TOWNS = [/\bAMSTERDAM\b/, /\bARNHEM\b/, /DEN HAAG|'?S-GRAVENHAGE/, /\bEINDHOVEN\b/, /\bRIJSWIJK\b/, /\bUTRECHT\b/];
const BUS_TOKEN = /\bBUS\b|BUSSEN|AUTOBUS|COACH|TOURINGCAR|"M2"|"M3"|\bM2\b|\bM3\b/;

function decide(f) {
  const p = f.properties, flat = (JSON.stringify(f._raw || {}) + " " + p.name + " " + (p.town || "")).toUpperCase();
  if (p.until && new Date(p.until) < new Date()) return "verlopen";
  if (/GEEN MILIEUZONE MEER|VERVALLEN|INGETROKKEN/.test(flat)) return "vervallen";
  const explicit = p.busKnown || BUS_TOKEN.test(flat);
  if (explicit) return "bus";
  if (p.zone === "zero") return "geen bus (zero-emissie voor bestel/vracht)";
  const label = (p.name + " " + (p.town || "")).toUpperCase();
  if (BUS_TOWNS.some(r => r.test(label))) return "bus-lijst";
  return "geen bus";
}

module.exports = async (req, res) => {
  try {
    const r = await fetch(SRC, { headers: { Accept: "application/geo+json, application/json" } });
    if (!r.ok) throw new Error("NDW antwoordde met " + r.status);
    const raw = await r.json();
    const list = (raw.features || (Array.isArray(raw) ? raw : [])).filter(f => f && f.geometry);
    if (req.query && req.query.raw) {
      res.setHeader("Cache-Control", "no-store");
      return res.status(200).json({ keys: Object.keys(raw), count: list.length, firstProperties: list.slice(0, 3).map(f => f.properties) });
    }
    const feats = list.map(f => { const n = normalize(f); n._raw = f.properties; n._why = decide(n); return n; });
    if (req.query && req.query.debug) {
      res.setHeader("Cache-Control", "no-store");
      return res.status(200).json(feats.map(f => ({ name: f.properties.name, town: f.properties.town, zone: f.properties.zone, from: f.properties.from, until: f.properties.until, besluit: f._why })));
    }
    const seen = new Set();
    const keep = feats.filter(f => (f._why === "bus" || f._why === "bus-lijst")).filter(f => { const k = JSON.stringify(f.geometry).slice(0, 400); if (seen.has(k)) return false; seen.add(k); return true; })
      .map(f => { const o = { type: "Feature", geometry: f.geometry, properties: { ...f.properties } };
        if (f._why === "bus-lijst" && !o.properties.bus) { o.properties.bus = ["EURO6"]; o.properties.busKnown = true; o.properties.purple = true; }
        return o; });
    const out = { type: "FeatureCollection", source: "NDW – Nationaal Dataportaal Wegverkeer (CC-0); busregels volgens milieuzones.nl", fetchedAt: new Date().toISOString(), features: keep };
    res.setHeader("Cache-Control", "public, s-maxage=21600, stale-while-revalidate=86400");
    res.setHeader("Content-Type", "application/json");
    res.status(200).send(JSON.stringify(out));
  } catch (e) {
    res.setHeader("Cache-Control", "public, s-maxage=300");
    res.status(502).json({ error: "Milieuzones konden niet worden opgehaald: " + (e.message || e) });
  }
};
