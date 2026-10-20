import type express from "express";
import { config } from "./config.js";
import { activate, activeCookies, listFixtures, loadFixtures, release, saveFixtures, setAccountBroadcast } from "./fixtures.js";
import { deleteSecret, listSecrets, setSecret } from "./secrets.js";

/**
 * Routes for the lab account switcher (fixtures.ts) and its Keychain
 * secrets (secrets.ts). Editing secrets or fixtures, and anything that
 * returns session cookies, needs the Crux window's Origin, as the login
 * import does (index.ts fromUi): other local programs send none.
 */
export function registerLabAccounts(app: express.Express, broadcast: (msg: unknown) => void) {
  setAccountBroadcast(broadcast);
  const uiOnly = (req: express.Request, res: express.Response) => {
    if (req.headers.origin) return true;
    res.status(403).json({ error: "Only the Crux window can do this" });
    return false;
  };
  const fail = (res: express.Response, err: unknown) =>
    res.status((err as { status?: number }).status ?? 400).json({ error: (err as Error).message, lock: (err as { lock?: unknown }).lock });

  app.get("/api/secrets", async (_req, res) => {
    try {
      // Names only (plus whether each is set); values never leave the Keychain here.
      res.json(await listSecrets(loadFixtures().flatMap((f) => Object.values(f.env))));
    } catch (err) {
      fail(res, err);
    }
  });
  app.put("/api/secrets/:name", async (req, res) => {
    if (!uiOnly(req, res)) return;
    try {
      await setSecret(req.params.name, req.body?.value);
      res.json({ ok: true });
    } catch (err) {
      fail(res, err);
    }
  });
  app.delete("/api/secrets/:name", async (req, res) => {
    if (!uiOnly(req, res)) return;
    try {
      await deleteSecret(req.params.name);
      res.json({ ok: true });
    } catch (err) {
      fail(res, err);
    }
  });

  app.get("/api/fixtures", (_req, res) => res.json(listFixtures()));
  app.put("/api/fixtures", (req, res) => {
    if (!uiOnly(req, res)) return;
    try {
      saveFixtures(req.body?.fixtures ?? req.body);
      res.json(listFixtures());
    } catch (err) {
      fail(res, err);
    }
  });
  app.post("/api/fixtures/:id/activate", async (req, res) => {
    const ws = String(req.body?.ws ?? "");
    const repo = config.repos[ws];
    if (!repo) return void res.status(404).json({ error: `Unknown workspace "${ws}"` });
    try {
      const round = typeof req.body?.round === "string" && req.body.round.trim() ? req.body.round.trim() : null;
      const { cookies, ...rest } = await activate(req.params.id, { ws, round, cwd: repo.path });
      // Session cookies go to the Crux window only (it logs its browser in).
      res.json(req.headers.origin ? { ...rest, cookies } : rest);
    } catch (err) {
      fail(res, err);
    }
  });
  app.post("/api/fixtures/:id/release", (req, res) => {
    res.json({ ok: release(req.params.id) });
  });
  // After `account:refreshed` the window re-imports the new session.
  app.get("/api/fixtures/active/:ws/cookies", (req, res) => {
    if (!uiOnly(req, res)) return;
    const cookies = activeCookies(req.params.ws);
    if (!cookies) return void res.status(404).json({ error: "No fixture active in this workspace" });
    res.json({ cookies });
  });
}
