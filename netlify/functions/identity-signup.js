/* Läuft AUTOMATISCH, sobald jemand seinen Account bestätigt.
   Vergibt die Rolle: du = admin, alle anderen = affiliate.
   Dateiname "identity-signup" ist der Auslöser — nicht umbenennen. */

export const handler = async (event) => {
  const { user } = JSON.parse(event.body || "{}");

  // >>> HIER deine eigene E-Mail eintragen (kleingeschrieben) <<<
  const ADMINS = ["nikola@deine-domain.de"];

  const email = (user.email || "").toLowerCase();
  const roles = ADMINS.includes(email) ? ["admin"] : ["affiliate"];

  return {
    statusCode: 200,
    body: JSON.stringify({ app_metadata: { roles } }),
  };
};
