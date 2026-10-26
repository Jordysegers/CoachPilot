// Coachpilot – pushmeldingen versturen.
// Nodig in Vercel (Settings → Environment Variables): SUPABASE_SERVICE_ROLE_KEY
// De VAPID-sleutels worden automatisch aangemaakt en afgeschermd in Supabase bewaard (tabel app_secrets).
const webpush = require("web-push");
const { createClient } = require("@supabase/supabase-js");

const SUPABASE_URL = process.env.SUPABASE_URL || "https://ediwujxxzpwontltomrv.supabase.co";
const SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_SECRET_KEY;
const CONTACT = process.env.PUSH_CONTACT || "mailto:info@coachpilot.app";

const PREF_OF = { mention: "mention", reply: "reply", rreply: "reply", ncomment: "reply", nreply: "reply", dm: "dm", friendreq: "dm", friendok: "dm" };

function db() {
  if (!SERVICE_KEY) throw Object.assign(new Error("SUPABASE_SERVICE_ROLE_KEY ontbreekt in Vercel"), { status: 500 });
  return createClient(SUPABASE_URL, SERVICE_KEY, { auth: { persistSession: false } });
}

async function vapid(sb) {
  const { data } = await sb.from("app_secrets").select("value").eq("name", "vapid").maybeSingle();
  if (data && data.value && data.value.publicKey) return data.value;
  const keys = webpush.generateVAPIDKeys();
  const { error } = await sb.from("app_secrets").insert({ name: "vapid", value: keys });
  if (error) {
    const again = await sb.from("app_secrets").select("value").eq("name", "vapid").maybeSingle();
    if (again.data && again.data.value) return again.data.value;
    throw error;
  }
  return keys;
}

async function nameOf(sb, uid) {
  const { data } = await sb.from("docs").select("data").eq("path", "profiles/" + uid).maybeSingle();
  return (data && data.data && data.data.name) || "Iemand";
}

function textFor(n, who) {
  const t = n.title ? "“" + n.title + "”" : "";
  return ({
    mention: [who + " noemde je", t || "Tik om te bekijken"],
    reply: ["Nieuwe reactie op je vraag", who + ": " + (t || "")],
    rreply: [who + " antwoordde op je reactie", t],
    ncomment: ["Nieuwe reactie op je nieuwsbericht", who + ": " + (t || "")],
    nreply: [who + " antwoordde op je reactie", t],
    dm: [who, n.title || "Nieuw bericht"],
    friendreq: ["Nieuw vriendschapsverzoek", who + " wil vrienden met je worden"],
    friendok: ["Vriendschap geaccepteerd", who + " heeft je verzoek geaccepteerd"]
  })[n.type] || ["Coachpilot", who + " " + t];
}

function urlFor(n) {
  if (n.newsId) return "/?open=news:" + encodeURIComponent(n.newsId);
  if (n.postId) return "/?open=post:" + encodeURIComponent(n.postId);
  if (n.chatId) return "/?open=chat:" + encodeURIComponent(n.chatId);
  if (n.type === "friendreq") return "/?open=friends:";
  return "/";
}

async function sendTo(sb, keys, subs, payload) {
  webpush.setVapidDetails(CONTACT, keys.publicKey, keys.privateKey);
  let sent = 0;
  for (const row of subs) {
    const sub = row.data && row.data.sub;
    if (!sub || !sub.endpoint) continue;
    try { await webpush.sendNotification(sub, JSON.stringify(payload), { TTL: 3600 * 12 }); sent++; }
    catch (e) { if (e.statusCode === 404 || e.statusCode === 410) await sb.from("docs").delete().eq("path", row.path); }
  }
  return sent;
}

async function readBody(req) {
  if (req.body && typeof req.body === "object") return req.body;
  if (typeof req.body === "string") { try { return JSON.parse(req.body); } catch (e) { return {}; } }
  const chunks = []; for await (const c of req) chunks.push(c);
  try { return JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}"); } catch (e) { return {}; }
}

module.exports = async (req, res) => {
  res.setHeader("Cache-Control", "no-store");
  try {
    const sb = db();
    if (req.method === "GET") {
      const keys = await vapid(sb);
      return res.status(200).json({ publicKey: keys.publicKey });
    }
    if (req.method !== "POST") return res.status(405).json({ error: "Alleen GET of POST" });

    const token = (req.headers.authorization || "").replace(/^Bearer\s+/i, "");
    if (!token) return res.status(401).json({ error: "Niet ingelogd" });
    const { data: u, error: ue } = await sb.auth.getUser(token);
    if (ue || !u || !u.user) return res.status(401).json({ error: "Niet ingelogd" });
    const uid = u.user.id;
    const body = await readBody(req);
    const keys = await vapid(sb);

    // 1) Admin: losse melding of pushknop naar iedereen
    if (body.broadcast) {
      const { data: mod } = await sb.from("moderators").select("user_id").eq("user_id", uid).maybeSingle();
      if (!mod) return res.status(403).json({ error: "Alleen admins kunnen dit versturen" });
      const b = body.broadcast;
      const title = String(b.title || "Coachpilot").slice(0, 80), text = String(b.body || "").slice(0, 200);
      if (!text && !b.title) return res.status(400).json({ error: "Geen tekst" });
      const { data: subs } = await sb.from("docs").select("path,data").eq("coll", "pushsubs");
      const list = (subs || []).filter(r => !(r.data && r.data.prefs && r.data.prefs.admin === false));
      const sent = await sendTo(sb, keys, list, { title, body: text, url: b.url || "/", tag: "admin-" + Date.now() });
      await sb.from("docs").insert({ path: "pushlog/" + Date.now().toString(36), coll: "pushlog", id: Date.now().toString(36), data: { by: uid, title, body: text, url: b.url || "/", sent, at: Date.now() } });
      return res.status(200).json({ sent, total: list.length });
    }

    // 2) Persoonlijke meldingen: alleen voor meldingen die deze gebruiker net zelf heeft aangemaakt
    const ids = (Array.isArray(body.ids) ? body.ids : []).slice(0, 20).map(String);
    if (!ids.length) return res.status(400).json({ error: "Geen meldingen" });
    const { data: rows } = await sb.from("docs").select("path,data,created_at").in("path", ids.map(i => "notifications/" + i));
    const who = await nameOf(sb, uid);
    let sent = 0;
    for (const r of rows || []) {
      const n = r.data || {};
      if (n.from !== uid || n.pushed) continue;
      if (Date.now() - new Date(r.created_at).getTime() > 5 * 60 * 1000) continue;
      const pref = PREF_OF[n.type]; if (!pref) continue;
      const { data: subs } = await sb.from("docs").select("path,data").eq("coll", "pushsubs").eq("data->>user", n.to);
      const list = (subs || []).filter(s => !(s.data && s.data.prefs && s.data.prefs[pref] === false));
      const [title, text] = textFor(n, who);
      sent += await sendTo(sb, keys, list, { title, body: text, url: urlFor(n), tag: n.type + "-" + (n.postId || n.newsId || n.chatId || "") });
      await sb.from("docs").update({ data: { ...n, pushed: true } }).eq("path", r.path);
    }
    return res.status(200).json({ sent });
  } catch (e) {
    return res.status(e.status || 500).json({ error: e.message || "Er ging iets mis" });
  }
};
