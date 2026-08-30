import { connectLambda, getStore } from "@netlify/blobs";

/* Geteilte Lead-Liste: alle sehen alle Leads. Liegt als JSON-Array unter "leads". */
const KEY = "leads";
const STATUSES = ["neu", "interessiert", "nicht_interessiert", "termin", "verkauft"];
const WEBSITE = ["unbekannt", "interessiert", "vielleicht", "nicht_interessiert"];

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
  const leads = (await store.get(KEY, { type: "json" })) || [];
  const persist = () => store.setJSON(KEY, leads);
  const method = event.httpMethod;

  /* ---------- LESEN: alle Leads ---------- */
  if (method === "GET") {
    return res({ role: isAdmin ? "admin" : "affiliate", myId: me.id, leads });
  }

  /* ---------- UNTERNEHMEN AUSWÄHLEN (neuer Lead) ---------- */
  if (method === "POST") {
    const b = JSON.parse(event.body || "{}");
    if (!b.placeId || !b.name) return res({ error: "Ungültige Daten" }, 400);

    if (leads.find((l) => l.placeId === b.placeId))
      return res({ ok: true, duplicate: true }); // schon in der Liste

    leads.push({
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
      createdBy: me,
      createdAt: Date.now(),
      updatedAt: Date.now(),
    });
    await persist();
    return res({ ok: true });
  }

  /* ---------- VERWALTEN: Status / Website / Reservierung ---------- */
  if (method === "PATCH") {
    const b = JSON.parse(event.body || "{}");
    const l = leads.find((x) => x.id === b.id);
    if (!l) return res({ error: "Nicht gefunden" }, 404);

    if (b.status !== undefined) {
      if (!STATUSES.includes(b.status)) return res({ error: "Status ungültig" }, 400);
      l.status = b.status;
    }
    if (b.website !== undefined) {
      if (!WEBSITE.includes(b.website)) return res({ error: "Wert ungültig" }, 400);
      l.website = b.website;
    }
    if (b.reserve === true) {
      // Reservieren: nur wenn frei (oder eigene / Admin)
      if (l.reservedBy && l.reservedBy.id !== me.id && !isAdmin)
        return res({ error: "Bereits von " + l.reservedBy.name + " reserviert" }, 403);
      l.reservedBy = me;
    }
    if (b.reserve === false) {
      // Freigeben: nur eigene Reservierung (oder Admin)
      if (l.reservedBy && l.reservedBy.id !== me.id && !isAdmin)
        return res({ error: "Nicht erlaubt" }, 403);
      l.reservedBy = null;
    }
    l.updatedAt = Date.now();
    await persist();
    return res({ ok: true });
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
