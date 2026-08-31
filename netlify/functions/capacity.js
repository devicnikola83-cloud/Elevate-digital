import { connectLambda, getStore } from "@netlify/blobs";

/* Kapazität: Website-Verkauf pausieren, NFC-Nachschub-Hinweis, Tags pro Person.
   Liegt als EIN JSON-Objekt unter "capacity". */
const KEY = "capacity";
const DEFAULT = { websitePaused: false, websiteNote: "", nfcNote: "", tags: {} };

const res = (data, statusCode = 200) => ({
  statusCode,
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify(data),
});

export const handler = async (event, context) => {
  connectLambda(event);

  const user = context.clientContext && context.clientContext.user;
  if (!user) return res({ error: "Nicht angemeldet" }, 401);

  const roles = (user.app_metadata && user.app_metadata.roles) || [];
  const isAdmin = roles.includes("admin");
  const me = {
    id: user.sub,
    name: (user.user_metadata && user.user_metadata.full_name) || user.email,
  };

  const store = getStore("elevate");
  const data = (await store.get(KEY, { type: "json", consistency: "strong" })) || { ...DEFAULT };
  if (!data.tags) data.tags = {};
  const persist = () => store.setJSON(KEY, data);
  const method = event.httpMethod;

  /* ---------- LESEN ---------- */
  if (method === "GET") {
    if (!isAdmin) {
      const t = data.tags[me.id] || { given: 0, left: 0, needMore: false };
      t.name = me.name;
      data.tags[me.id] = t;
      await persist();
    }
    return res({ role: isAdmin ? "admin" : "affiliate", myId: me.id, data });
  }

  /* ---------- ÄNDERN ---------- */
  if (method === "PATCH") {
    const b = JSON.parse(event.body || "{}");

    if (isAdmin) {
      if (b.type === "website") {
        data.websitePaused = !!b.paused;
        if (b.note !== undefined) data.websiteNote = String(b.note).slice(0, 200);
      } else if (b.type === "nfc") {
        data.nfcNote = String(b.note || "").slice(0, 200);
      } else if (b.type === "given") {
        const t = data.tags[b.userId] || { given: 0, left: 0, needMore: false, name: b.name || "" };
        t.given = Math.max(0, parseInt(b.given, 10) || 0);
        if (b.name) t.name = b.name;
        data.tags[b.userId] = t;
      } else return res({ error: "Unbekannt" }, 400);
    } else {
      if (b.type !== "mytags") return res({ error: "Nicht erlaubt" }, 403);
      const t = data.tags[me.id] || { given: 0, left: 0, needMore: false };
      t.name = me.name;
      if (b.left !== undefined) t.left = Math.max(0, parseInt(b.left, 10) || 0);
      if (b.needMore !== undefined) t.needMore = !!b.needMore;
      data.tags[me.id] = t;
    }
    await persist();
    return res({ ok: true, data });
  }

  return res({ error: "Methode nicht erlaubt" }, 405);
};
