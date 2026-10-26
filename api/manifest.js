// Coachpilot – app-manifest met het app-icoon dat een admin in de app heeft gekozen.
const SUPABASE_URL = process.env.SUPABASE_URL || "https://ediwujxxzpwontltomrv.supabase.co";
const ANON = process.env.SUPABASE_ANON_KEY || "sb_publishable_O6-jb04hxvuowhwYJ8-KBQ_gvseRbXq";
module.exports = async (req, res) => {
  let icon = null, color = "#3D5AFE";
  try {
    const r = await fetch(SUPABASE_URL + "/rest/v1/docs?select=path,data&path=in.(settings/appicon,settings/theme)", { headers: { apikey: ANON, Authorization: "Bearer " + ANON } });
    const rows = await r.json();
    for (const row of rows || []) {
      if (row.path === "settings/appicon") icon = row.data;
      if (row.path === "settings/theme" && row.data && row.data.accent) color = row.data.accent;
    }
  } catch (e) {}
  const icons = icon && icon.i512 ? [
    { src: icon.i192 || icon.i512, sizes: "192x192", type: "image/png", purpose: "any" },
    { src: icon.i512, sizes: "512x512", type: "image/png", purpose: "any" },
    { src: icon.i512, sizes: "512x512", type: "image/png", purpose: "maskable" }
  ] : [
    { src: "/icon-192.png", sizes: "192x192", type: "image/png", purpose: "any" },
    { src: "/icon-512.png", sizes: "512x512", type: "image/png", purpose: "any" }
  ];
  res.setHeader("Content-Type", "application/manifest+json");
  res.setHeader("Cache-Control", "public, max-age=300");
  res.status(200).send(JSON.stringify({
    name: "Coachpilot", short_name: "Coachpilot", description: "De app voor touringcarchauffeurs: busparkings, community en nieuws.",
    start_url: "/", scope: "/", display: "standalone", background_color: "#ECEFF5", theme_color: color, lang: "nl", icons
  }));
};
