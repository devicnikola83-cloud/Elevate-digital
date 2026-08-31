import { connectLambda, getStore } from "@netlify/blobs";

/* Alle Verkäufe liegen als EIN JSON-Array unter dem Key "sales". */
const KEY = "sales";
const RATE = { website: 0.20, nfc: 0.60, backend: 0.10 };

const res = (data, statusCode = 200) => ({
  statusCode,
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify(data),
});

export const handler = async (event, context) => {
  // Blobs im Lambda-Modus initialisieren (MUSS vor getStore stehen).
  connectLambda(event);

  // Wer ruft an? -> aus dem verifizierten Identity-Token, NICHT aus dem Body.
  const user = context.clientContext && context.clientContext.user;
  if (!user) return res({ error: "Nicht angemeldet" }, 401);

  const roles = (user.app_metadata && user.app_metadata.roles) || [];
  const isAdmin = roles.includes("admin");
  const me = {
    id: user.sub,
    name: (user.user_metadata && user.user_metadata.full_name) || user.email,
  };

  const store = getStore("elevate");
  const sales = (await store.get(KEY, { type: "json", consistency: "strong" })) || [];
  const persist = () => store.setJSON(KEY, sales);
  const method = event.httpMethod;

  /* ---------- LESEN ---------- */
  if (method === "GET") {
    if (isAdmin) return res({ role: "admin", sales });
    return res({
      role: "affiliate",
      mine: sales.filter((s) => s.ownerId === me.id),
      board: sales
        .filter((s) => s.status === "confirmed")
        .map((s) => ({ ownerName: s.ownerName, price: s.price })),
    });
  }

  /* ---------- VERKAUF ANLEGEN (Affiliate) ---------- */
  if (method === "POST") {
    const b = JSON.parse(event.body || "{}");
    if (!b.client || !RATE[b.type] || !(b.price > 0))
      return res({ error: "Ungültige Eingabe" }, 400);

    sales.push({
      id:
        (globalThis.crypto && globalThis.crypto.randomUUID
          ? globalThis.crypto.randomUUID()
          : String(Date.now()) + Math.random().toString(16).slice(2)),
      ownerId: me.id, // Besitzer IMMER aus dem Token
      ownerName: me.name,
      client: String(b.client).trim(),
      type: b.type,
      price: Math.round(b.price),
      status: "open",
      createdAt: Date.now(),
    });
    await persist();
    return res({ ok: true });
  }

  /* ---------- STATUS ÄNDERN ---------- */
  if (method === "PATCH") {
    const { id, status } = JSON.parse(event.body || "{}");
    const s = sales.find((x) => x.id === id);
    if (!s) return res({ error: "Nicht gefunden" }, 404);

    if (isAdmin) {
      if (!["open", "done", "confirmed"].includes(status))
        return res({ error: "Ungültiger Status" }, 400);
      s.status = status; // Admin darf alles
    } else {
      // Affiliate: nur eigenen Verkauf von "offen" -> "abgeschlossen"
      if (s.ownerId !== me.id || !(s.status === "open" && status === "done"))
        return res({ error: "Nicht erlaubt" }, 403);
      s.status = "done";
    }
    await persist();
    return res({ ok: true });
  }

  /* ---------- LÖSCHEN ---------- */
  if (method === "DELETE") {
    const id = event.queryStringParameters && event.queryStringParameters.id;
    const s = sales.find((x) => x.id === id);
    if (!s) return res({ error: "Nicht gefunden" }, 404);
    if (!isAdmin && !(s.ownerId === me.id && s.status === "open"))
      return res({ error: "Nicht erlaubt" }, 403);
    await store.setJSON(KEY, sales.filter((x) => x.id !== id));
    return res({ ok: true });
  }

  return res({ error: "Methode nicht erlaubt" }, 405);
};
