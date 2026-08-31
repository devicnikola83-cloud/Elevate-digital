import { connectLambda, getStore } from "@netlify/blobs";

/* Geteilte Lead-Liste: alle sehen alle Leads. Liegt als JSON-Array unter "leads".
   Reservierungs-Fairness: max. MAX_RES aktive Reservierungen pro Person,
   jede Reservierung läuft nach RESERVE_DAYS automatisch ab. */
const KEY = "leads";
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
  const leads = (await store.get(KEY, { type: "json" })) || [];
  const persist = () => store.setJSON(KEY, leads);
  const method = event.httpMethod;

  /* ---------- LESEN: abgelaufene Reservierungen automatisch freigeben ---------- */
  if (method === "GET") {
    let changed = false;
    for (const l of leads) {
      if (l.reservedBy && !isActiveRes(l)) {
        l.reservedBy = null;
        l.reservedAt = null;
        changed = true;
      }
    }
    if (changed) await persist();
    return res({
      role: isAdmin ? "admin" : "affiliate",
      myId: me.id,
      reserveDays: RESERVE_DAYS,
      maxRes: MAX_RES,
      leads,
    });
  }

  /* ---------- UNTERNEHMEN AUSWÄHLEN (neuer Lead) ---------- */
  if (method === "POST") {
    const b = JSON.parse(event.body || "{}");
    if (!b.placeId || !b.name) return res({ error: "Ungültige Daten" }, 400);

    const lead = {
      id:
        (globalThis.crypto && globalThis.crypto.randomUUID
          ? globalThis.crypto.randomUUID()
          : String(Date.now()) + Math.random().toString(16).slice(2)),
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
    leads.push(lead);
    await persist();
    return res({ ok: true, lead });
  }

  /* ---------- VERWALTEN: nur der Ersteller (oder Admin) ---------- */
  if (method === "PATCH") {
    const b = JSON.parse(event.body || "{}");
    const l = leads.find((x) => x.id === b.id);
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
      // Fairness: max. MAX_RES aktive Reservierungen pro Person
      const active = leads.filter(
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
    await persist();
    return res({ ok: true, lead: l });
  }

  /* ---------- LÖSCHEN ---------- */
  if (method === "DELETE") {
    const id = event.queryStringParameters && event.queryStringParameters.id;
    const l = leads.find((x) => x.id === id);
    if (!l) return res({ error: "Nicht gefunden" }, 404);
    if (!isAdmin && l.createdBy.id !== me.id)
      return res({ error: "Nicht erlaubt" }, 403);
    await store.setJSON(KEY, leads.filter((x) => x.id !== id));
    return res({ ok: true });
  }

  return res({ error: "Methode nicht erlaubt" }, 405);
};
