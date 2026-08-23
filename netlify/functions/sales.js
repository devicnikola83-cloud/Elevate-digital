import { getStore } from "@netlify/blobs";
import { getUser } from "@netlify/identity";

/* Alle Verkäufe liegen als EIN JSON-Array unter dem Key "sales".
   Für ein 4-Personen-Team völlig ausreichend (wenig gleichzeitige Schreibzugriffe). */
const KEY = "sales";
const RATE = { website: 0.20, nfc: 0.60, backend: 0.10 };

const json = (data, status = 200) =>
  new Response(JSON.stringify(data), {
    status,
    headers: { "Content-Type": "application/json" },
  });

export default async (req) => {
  // 1) Wer ruft an?  -> aus dem verifizierten Identity-Token, NICHT aus dem Body.
  //    (Diese eine Zeile ist der Wiring-Punkt: gegen die aktuelle
  //     @netlify/identity-Doku prüfen, falls der Build anders erwartet.)
  const user = await getUser(req);
  if (!user) return json({ error: "Nicht angemeldet" }, 401);

  const roles = user.app_metadata?.roles || [];
  const isAdmin = roles.includes("admin");
  const me = {
    id: user.id,
    name: user.user_metadata?.full_name || user.email,
  };

  // 2) Datenspeicher öffnen. "strong" = Bestätigungen sind sofort sichtbar.
  const store = getStore({ name: "elevate", consistency: "strong" });
  const sales = (await store.get(KEY, { type: "json" })) || [];
  const persist = () => store.setJSON(KEY, sales);

  /* ---------- LESEN ---------- */
  if (req.method === "GET") {
    if (isAdmin) return json({ role: "admin", sales });
    // Affiliate: nur eigene Verkäufe + bestätigter Umsatz aller (fürs Leaderboard)
    return json({
      role: "affiliate",
      mine: sales.filter((s) => s.ownerId === me.id),
      board: sales
        .filter((s) => s.status === "confirmed")
        .map((s) => ({ ownerName: s.ownerName, price: s.price })),
    });
  }

  /* ---------- VERKAUF ANLEGEN (Affiliate) ---------- */
  if (req.method === "POST") {
    const b = await req.json();
    if (!b.client || !RATE[b.type] || !(b.price > 0))
      return json({ error: "Ungültige Eingabe" }, 400);

    sales.push({
      id: crypto.randomUUID(),
      ownerId: me.id, // Besitzer IMMER aus dem Token
      ownerName: me.name,
      client: String(b.client).trim(),
      type: b.type,
      price: Math.round(b.price),
      status: "open",
      createdAt: Date.now(),
    });
    await persist();
    return json({ ok: true });
  }

  /* ---------- STATUS ÄNDERN ---------- */
  if (req.method === "PATCH") {
    const { id, status } = await req.json();
    const s = sales.find((x) => x.id === id);
    if (!s) return json({ error: "Nicht gefunden" }, 404);

    if (isAdmin) {
      if (!["open", "done", "confirmed"].includes(status))
        return json({ error: "Ungültiger Status" }, 400);
      s.status = status; // Admin darf alles: abschließen, bestätigen, widerrufen
    } else {
      // Affiliate darf NUR den eigenen Verkauf von "offen" -> "abgeschlossen"
      if (s.ownerId !== me.id || !(s.status === "open" && status === "done"))
        return json({ error: "Nicht erlaubt" }, 403);
      s.status = "done";
    }
    await persist();
    return json({ ok: true });
  }

  /* ---------- LÖSCHEN ---------- */
  if (req.method === "DELETE") {
    const id = new URL(req.url).searchParams.get("id");
    const s = sales.find((x) => x.id === id);
    if (!s) return json({ error: "Nicht gefunden" }, 404);

    // Admin darf alles löschen; Affiliate nur eigene, noch offene Einträge
    if (!isAdmin && !(s.ownerId === me.id && s.status === "open"))
      return json({ error: "Nicht erlaubt" }, 403);

    const next = sales.filter((x) => x.id !== id);
    await store.setJSON(KEY, next);
    return json({ ok: true });
  }

  return json({ error: "Methode nicht erlaubt" }, 405);
};

// Die Function ist danach erreichbar unter  /api/sales
export const config = { path: "/api/sales" };
