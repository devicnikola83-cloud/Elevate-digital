import { connectLambda, getStore } from "@netlify/blobs";

/* Jeder Lead ist ein EIGENER Datensatz unter dem Schlüssel "lead:<id>".
   Dadurch überschreiben sich gleichzeitige Änderungen NICHT mehr
   (kein Lesen-Ändern-Zurückschreiben eines großen Arrays). */
const PREFIX = "lead:";
const OLD_KEY = "leads";
const STATUSES = ["neu", "interessiert", "nicht_interessiert", "termin", "verkauft"];
const WEBSITE = ["unbekannt", "interessiert", "vielleicht", "nicht_interessiert"];
const RESERVE_DAYS = 3;
const RESERVE_MS = RESERVE_DAYS * 24 * 60 * 60 * 1000;
const MAX_RES = 3;

const res = (data, statusCode = 200) => ({
  statusCode,
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify(data),
});
const isActiveRes = (l) =>
  l.reservedBy && l.reservedAt && (Date.now() - l.reservedAt) < RESERVE_MS;
const newId = () =>
  (globalThis.crypto && globalThis.crypto.randomUUID)
    ? globalThis.crypto.randomUUID()
    : String(Date.now()) + Math.random().toString(16).slice(2);

async function listLeads(store) {
  const { blobs } = await store.list({ prefix: PREFIX, consistency: "strong" });
  const arr = await Promise.all(blobs.map((b) => store.get(b.key, { type: "json", consistency: "strong" })));
  return arr.filter(Boolean);
}

/* Einmalige Migration: alter Sammel-Datensatz -> Einzel-Datensätze */
async function migrateIfNeeded(store) {
  let old = null;
  try { old = await store.get(OLD_KEY, { type: "json", consistency: "strong" }); } catch (e) {}
  if (Array.isArray(old) && old.length) {
    await Promise.all(old.map((l) => (l && l.id ? store.setJSON(PREFIX + l.id, l) : null)));
  }
  if (old !== null && old !== undefined) {
    try { await store.delete(OLD_KEY); } catch (e) {}
  }
}

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
  const method = event.httpMethod;

  /* ---------- LESEN ---------- */
  if (method === "GET") {
    await migrateIfNeeded(store);
    const leads = await listLeads(store);
    return res({
      role: isAdmin ? "admin" : "affiliate",
      myId: me.id,
      reserveDays: RESERVE_DAYS,
      maxRes: MAX_RES,
      leads,
    });
  }

  /* ---------- NEUER LEAD ---------- */
  if (method === "POST") {
    const b = JSON.parse(event.body || "{}");
    if (!b.placeId || !b.name) return res({ error: "Ungültige Daten" }, 400);
    const lead = {
      id: newId(),
      placeId: b.placeId,
      name: String(b.name).slice(0, 200),
      address: b.address ? String(b.address).slice(0, 300) : "",
      phone: b.phone ? String(b.phone).slice(0, 60) : "",
      lat: b.lat, lng: b.lng,
      status: "neu",
      website: "unbekannt",
      reservedBy: null,
      reservedAt: null,
      createdBy: me,
      createdAt: Date.now(),
      updatedAt: Date.now(),
    };
    await store.setJSON(PREFIX + lead.id, lead);
    return res({ ok: true, lead });
  }

  /* ---------- ÄNDERN (nur Ersteller/Admin) ---------- */
  if (method === "PATCH") {
    const b = JSON.parse(event.body || "{}");
    const l = await store.get(PREFIX + b.id, { type: "json", consistency: "strong" });
    if (!l) return res({ error: "Nicht gefunden" }, 404);
    if (!isAdmin && l.createdBy.id !== me.id)
      return res({ error: "Nur der Ersteller darf diesen Lead ändern" }, 403);

    if (b.status !== undefined) {
      if (!STATUSES.includes(b.status)) return res({ error: "Status ungültig" }, 400);
      l.status = b.status;
    }
    if (b.website !== undefined) {
      if (!WEBSITE.includes(b.website)) return res({ error: "Wert ungültig" }, 400);
      l.website = b.website;
    }
    if (b.reserve === true) {
      const all = await listLeads(store);
      const active = all.filter(
        (x) => x.id !== l.id && x.reservedBy && x.reservedBy.id === me.id && isActiveRes(x)
      ).length;
      if (active >= MAX_RES)
        return res({ error: "Maximal " + MAX_RES + " Reservierungen gleichzeitig" }, 403);
      l.reservedBy = me;
      l.reservedAt = Date.now();
    }
    if (b.reserve === false) {
      l.reservedBy = null;
      l.reservedAt = null;
    }
    l.updatedAt = Date.now();
    await store.setJSON(PREFIX + l.id, l);
    return res({ ok: true, lead: l });
  }

  /* ---------- LÖSCHEN (idempotent) ---------- */
  if (method === "DELETE") {
    let id = event.queryStringParameters && event.queryStringParameters.id;
    if (!id && event.body) { try { id = JSON.parse(event.body).id; } catch (e) {} }
    if (!id) return res({ error: "Keine ID" }, 400);
    const l = await store.get(PREFIX + id, { type: "json", consistency: "strong" });
    if (l && !isAdmin && l.createdBy.id !== me.id)
      return res({ error: "Nur der Ersteller darf löschen" }, 403);
    await store.delete(PREFIX + id);
    return res({ ok: true });
  }

  return res({ error: "Methode nicht erlaubt" }, 405);
};
