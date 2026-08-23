/* Läuft AUTOMATISCH, sobald jemand seinen Account bestätigt.
   Vergibt die Rolle: du = admin, alle anderen = affiliate.
   Der Dateiname "identity-signup" ist der Auslöser — nicht umbenennen. */

export default async (req) => {
  const { user } = await req.json();

  // >>> HIER deine eigene E-Mail eintragen (kleingeschrieben) <<<
  const ADMINS = ["devicnikola83@gmail.com"];

  const email = (user.email || "").toLowerCase();
  const roles = ADMINS.includes(email) ? ["admin"] : ["affiliate"];

  return new Response(JSON.stringify({ app_metadata: { roles } }), {
    headers: { "Content-Type": "application/json" },
  });
};
