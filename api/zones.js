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

module.exports = async (req, res) => {
  try {
    const r = await fetch(SRC, { headers: { Accept: "application/geo+json, application/json" } });
    if (!r.ok) throw new Error("NDW antwoordde met " + r.status);
    const raw = await r.json();
    if (req.query && req.query.raw) {
      res.setHeader("Cache-Control", "no-store");
      const f0 = (raw.features || [])[0];
      return res.status(200).json({ keys: Object.keys(raw), count: (raw.features || []).length, firstProperties: f0 && f0.properties, geometryType: f0 && f0.geometry && f0.geometry.type });
    }
    const feats = (raw.features || (Array.isArray(raw) ? raw : [])).filter(f => f && f.geometry).map(normalize);
    const anyVehicleInfo = feats.some(f => f.properties.vehicles.length);
    const out = { type: "FeatureCollection", source: "NDW – Nationaal Dataportaal Wegverkeer (CC-0)", fetchedAt: new Date().toISOString(), busFiltered: anyVehicleInfo,
      features: anyVehicleInfo ? feats.filter(f => f.properties.busKnown || f.properties.mentionsBus || f.properties.zone === "zero" || !f.properties.vehicles.length) : feats };
    res.setHeader("Cache-Control", "public, s-maxage=21600, stale-while-revalidate=86400");
    res.setHeader("Content-Type", "application/json");
    res.status(200).send(JSON.stringify(out));
  } catch (e) {
    res.setHeader("Cache-Control", "public, s-maxage=300");
    res.status(502).json({ error: "Milieuzones konden niet worden opgehaald: " + (e.message || e) });
  }
};
