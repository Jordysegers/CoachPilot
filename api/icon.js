// Coachpilot – geeft het huidige app-icoon terug (voor meldingen), of het standaardicoon.
const SUPABASE_URL = process.env.SUPABASE_URL || "https://ediwujxxzpwontltomrv.supabase.co";
const ANON = process.env.SUPABASE_ANON_KEY || "sb_publishable_O6-jb04hxvuowhwYJ8-KBQ_gvseRbXq";
module.exports = async (req, res) => {
  const s = Number((req.query && req.query.s) || 192);
  let url = s > 200 ? "/icon-512.png" : "/icon-192.png";
  try {
    const r = await fetch(SUPABASE_URL + "/rest/v1/docs?select=data&path=eq.settings/appicon", { headers: { apikey: ANON, Authorization: "Bearer " + ANON } });
    const rows = await r.json();
    const d = rows && rows[0] && rows[0].data;
    if (d && d.i512) url = s > 200 ? d.i512 : (d.i192 || d.i512);
  } catch (e) {}
  res.setHeader("Cache-Control", "public, max-age=300");
  res.writeHead(302, { Location: url }); res.end();
};
