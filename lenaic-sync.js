/* Shared private GitHub sync. No credentials or personal data in this file. */
(function (g) {
  "use strict";
  const DB = "lenaic-safe-sync-v1",
    TOKEN = "lenaic-private-data-token-v1";
  const cache = {},
    running = new Set(),
    adapters = new Map(),
    checkpointHashes = new Map();
  let dbPromise;
  const clone = (v) => JSON.parse(JSON.stringify(v));
  function canonical(v) {
    if (Array.isArray(v)) return "[" + v.map(canonical).join(",") + "]";
    if (v && typeof v === "object")
      return (
        "{" +
        Object.keys(v)
          .sort()
          .map((k) => JSON.stringify(k) + ":" + canonical(v[k]))
          .join(",") +
        "}"
      );
    return JSON.stringify(v);
  }
  async function hash(v) {
    return Array.from(
      new Uint8Array(
        await g.crypto.subtle.digest(
          "SHA-256",
          new TextEncoder().encode(canonical(v)),
        ),
      ),
    )
      .map((x) => x.toString(16).padStart(2, "0"))
      .join("");
  }
  function decide(base, localHash, remoteHash, sha, hasLocal, mode = "sync") {
    if (remoteHash === localHash) return "equal";
    if (mode === "pull") {
      if (!sha) throw Error("Aucun fichier distant à charger.");
      return "pull";
    }
    if (mode === "push") return "push";
    // Comparison never mutates either primary, even with a common baseline.
    return "conflict";
  }
  function open() {
    if (!dbPromise)
      dbPromise = new Promise((resolve, reject) => {
        const r = indexedDB.open(DB, 1);
        let done = false;
        const fail = (e) => {
          if (done) return;
          done = true;
          clearTimeout(timer);
          dbPromise = null;
          reject(e);
        };
        const timer = setTimeout(
          () =>
            fail(
              Error(
                "Ouverture du secours IndexedDB bloquée. Ferme les autres onglets.",
              ),
            ),
          5000,
        );
        r.onupgradeneeded = () => {
          for (const name of ["snapshots", "meta", "cache"])
            if (!r.result.objectStoreNames.contains(name))
              r.result.createObjectStore(name, { keyPath: "id" });
        };
        r.onblocked = () =>
          fail(Error("Secours IndexedDB bloqué par un autre onglet."));
        r.onerror = () =>
          fail(r.error || Error("Secours IndexedDB inaccessible."));
        r.onsuccess = () => {
          if (done) {
            r.result.close();
            return;
          }
          done = true;
          clearTimeout(timer);
          const db = r.result;
          db.onversionchange = () => {
            db.close();
            dbPromise = null;
          };
          resolve(db);
        };
      });
    return dbPromise;
  }
  async function put(store, row) {
    const db = await open();
    return new Promise((resolve, reject) => {
      const tx = db.transaction(store, "readwrite");
      tx.objectStore(store).put(row);
      tx.oncomplete = () => resolve(row);
      tx.onerror = () => reject(tx.error);
      tx.onabort = () => reject(tx.error || Error("Sauvegarde locale annulée"));
    });
  }
  async function get(store, id) {
    const db = await open();
    return new Promise((resolve, reject) => {
      const r = db.transaction(store).objectStore(store).get(id);
      r.onsuccess = () => resolve(r.result);
      r.onerror = () => reject(r.error);
    });
  }
  async function all(store) {
    const db = await open();
    return new Promise((resolve, reject) => {
      const r = db.transaction(store).objectStore(store).getAll();
      r.onsuccess = () => resolve(r.result);
      r.onerror = () => reject(r.error);
    });
  }
  async function archive(app, local, remote) {
    const id = app + "-" + Date.now() + "-" + g.crypto.randomUUID();
    await put("snapshots", {
      id,
      app,
      createdAt: new Date().toISOString(),
      local: clone(local),
      remote: remote == null ? null : clone(remote),
    });
    return id;
  }
  const TOKEN_EXPIRY = TOKEN + ":expires",
    TOKEN_TTL = 60 * 60 * 1000;
  const LEGACY_TOKENS = [
    "ecosystem-github-token-v1",
    "bureau-genealogique-github-token-v1",
    "scriptoria-github-token-v2",
  ];
  function forgetToken() {
    sessionStorage.removeItem(TOKEN);
    sessionStorage.removeItem(TOKEN_EXPIRY);
    for (const key of LEGACY_TOKENS) sessionStorage.removeItem(key);
  }
  function setToken(value) {
    forgetToken();
    const t = String(value || "").trim();
    if (t) {
      sessionStorage.setItem(TOKEN, t);
      sessionStorage.setItem(TOKEN_EXPIRY, String(Date.now() + TOKEN_TTL));
    }
  }
  function token() {
    const expires = Number(sessionStorage.getItem(TOKEN_EXPIRY));
    if (!expires || expires <= Date.now()) {
      forgetToken();
      return "";
    }
    return sessionStorage.getItem(TOKEN) || "";
  }
  function assertNoSecrets(value) {
    const secret =
      /(?:github_pat_[A-Za-z0-9_]{30,}|gh[pousr]_[A-Za-z0-9]{30,}|Bearer\s+[A-Za-z0-9_.-]{20,})/;
    const visit = (v) => {
      if (typeof v === "string") {
        if (secret.test(v))
          throw Error(
            "Secret détecté dans les données : aucun envoi autorisé.",
          );
        return;
      }
      if (v && typeof v === "object")
        for (const [k, x] of Object.entries(v)) {
          if (
            /^(?:.*[_-])?(?:password|token|secret|authorization|credential|api[_-]?key|access[_-]?token|refresh[_-]?token)$/i.test(
              k,
            ) &&
            typeof x === "string" &&
            x
          )
            throw Error("Champ de secret détecté : aucun envoi autorisé.");
          visit(x);
        }
    };
    visit(value);
  }
  function config(app, extra = {}) {
    const cfg = {
      owner: "ikare63",
      repo: "data",
      branch: "main",
      path: app + ".json",
      ...extra,
    };
    if (
      cfg.owner !== "ikare63" ||
      cfg.repo !== "data" ||
      !cfg.branch ||
      !cfg.path ||
      cfg.path !== app + ".json"
    )
      throw Error(
        "Destination non autorisée : utilise le dépôt privé ikare63/data.",
      );
    return cfg;
  }
  function endpoint(cfg, path = cfg.path) {
    return (
      "https://api.github.com/repos/" +
      encodeURIComponent(cfg.owner) +
      "/" +
      encodeURIComponent(cfg.repo) +
      "/contents/" +
      path.split("/").map(encodeURIComponent).join("/")
    );
  }
  async function request(url, options = {}) {
    const target = new URL(url);
    if (
      target.origin !== "https://api.github.com" ||
      target.username ||
      target.password ||
      !/^\/repos\/ikare63\/data(?:\/|$)/.test(target.pathname)
    )
      throw Error("Destination API non autorisée.");
    const t = token();
    if (!t)
      throw Error(
        "Jeton absent : saisis le jeton privé dans Synchronisation sécurisée.",
      );
    const headers = new Headers(options.headers || {});
    if (!headers.has("Accept"))
      headers.set("Accept", "application/vnd.github+json");
    headers.set("Authorization", "Bearer " + t);
    headers.set("X-GitHub-Api-Version", "2022-11-28");
    const controller = new AbortController();
    let timer;
    try {
      return await Promise.race([
        (async () => {
          const r = await fetch(url, {
            ...options,
            headers,
            cache: "no-store",
            signal: controller.signal,
            redirect: "error",
          });
          if (r.status === 401) throw Error("Jeton expiré ou invalide (401).");
          if (r.status === 403)
            throw Error("Accès refusé (403) : Contents ou limite GitHub.");
          if (r.status === 409 || r.status === 422)
            throw Error("Conflit GitHub : aucun réessai d’écrasement.");
          const body = await r.text();
          return {
            ok: r.ok,
            status: r.status,
            json: async () => JSON.parse(body),
            text: async () => body,
          };
        })(),
        new Promise((_, reject) => {
          timer = setTimeout(() => {
            controller.abort();
            reject(Error("Délai de lecture GitHub dépassé (30 s)."));
          }, 30000);
        }),
      ]);
    } finally {
      clearTimeout(timer);
    }
  }

  async function privateRepo(cfg) {
    const r = await request(
      "https://api.github.com/repos/" +
        encodeURIComponent(cfg.owner) +
        "/" +
        encodeURIComponent(cfg.repo),
    );
    if (!r.ok)
      throw Error(
        "Dépôt privé inaccessible (" +
          r.status +
          "). Vérifie le dépôt sélectionné dans le jeton.",
      );
    const info = await r.json();
    if (info.private !== true)
      throw Error("Arrêt : le dépôt de sauvegarde doit être privé.");
    return info;
  }
  function decode(s) {
    return new TextDecoder().decode(
      Uint8Array.from(atob(s.replace(/\s/g, "")), (c) => c.charCodeAt(0)),
    );
  }
  async function encode(text) {
    return new Promise((resolve, reject) => {
      const r = new FileReader();
      r.onload = () => resolve(String(r.result).split(",")[1]);
      r.onerror = () => reject(r.error);
      r.readAsDataURL(
        new Blob([text], { type: "application/json;charset=utf-8" }),
      );
    });
  }
  async function read(cfg) {
    const r = await request(
      endpoint(cfg) + "?ref=" + encodeURIComponent(cfg.branch),
      { headers: { Accept: "application/vnd.github.object+json" } },
    );
    if (r.status === 404) {
      const branch = await request(
        "https://api.github.com/repos/" +
          encodeURIComponent(cfg.owner) +
          "/" +
          encodeURIComponent(cfg.repo) +
          "/branches/" +
          encodeURIComponent(cfg.branch),
      );
      if (!branch.ok) throw Error("Branche inaccessible : " + cfg.branch);
      return { sha: "", doc: null };
    }
    if (!r.ok) throw Error("Lecture GitHub impossible (" + r.status + ").");
    const info = await r.json();
    if (!info.sha || info.type !== "file")
      throw Error("Chemin GitHub invalide.");
    let text;
    if (info.content && info.encoding === "base64") text = decode(info.content);
    else {
      const raw = await request(
        "https://api.github.com/repos/" +
          encodeURIComponent(cfg.owner) +
          "/" +
          encodeURIComponent(cfg.repo) +
          "/git/blobs/" +
          encodeURIComponent(info.sha),
        { headers: { Accept: "application/vnd.github.raw+json" } },
      );
      if (!raw.ok)
        throw Error("Lecture du contenu impossible (" + raw.status + ").");
      text = await raw.text();
    }
    let doc;
    try {
      doc = JSON.parse(text);
    } catch {
      throw Error("JSON distant illisible : aucune écriture autorisée.");
    }
    return { sha: info.sha, doc };
  }
  async function write(cfg, doc, sha, path = cfg.path) {
    assertNoSecrets(doc);
    if (new Blob([JSON.stringify(doc, null, 2)]).size > 90 * 1024 * 1024)
      throw Error("JSON supérieur à 90 Mio : envoi arrêté avant remplacement.");
    const body = {
      message: "Sauvegarde sécurisée " + path,
      content: await encode(JSON.stringify(doc, null, 2)),
      branch: cfg.branch,
    };
    if (sha) body.sha = sha;
    const r = await request(endpoint(cfg, path), {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    if (!r.ok) throw Error("Écriture GitHub impossible (" + r.status + ").");
    const out = await r.json();
    if (!out.content?.sha)
      throw Error("GitHub n’a pas confirmé la sauvegarde.");
    return out.content.sha;
  }
  async function remoteArchive(cfg, app, doc, label) {
    const path =
      "recovery/" +
      app +
      "/" +
      Date.now() +
      "-" +
      g.crypto.randomUUID() +
      "-" +
      label +
      ".json";
    const sha = await write(cfg, doc, "", path);
    const check = await read({ ...cfg, path });
    if (check.sha !== sha || (await hash(check.doc)) !== (await hash(doc)))
      throw Error("Copie de récupération distante non vérifiée. Arrêt.");
    return path;
  }
  function publish(key, value) {
    cache[key] = clone(value);
    if (key === "scribe-local-v3" && Array.isArray(value?.drafts)) {
      const contacts = new Map(
          (Array.isArray(value.contacts) ? value.contacts : [])
            .filter(Boolean)
            .map((c) => [c.id, c]),
        ),
        drafts = value.drafts.filter(Boolean),
        counts = {
          draft: 0,
          sent: 0,
          waiting: 0,
          received: 0,
          closed: 0,
          awaiting: 0,
        };
      for (const d of drafts) {
        if (Object.hasOwn(counts, d.status)) counts[d.status]++;
        if (d.status === "sent" || d.status === "waiting") counts.awaiting++;
      }
      const summary = (d) => ({
        id: d.id,
        title: d.title || "Requête",
        contact: contacts.get(d.contactId)?.name || "Archives",
        status: d.status,
        sentAt: d.sentAt || null,
        updatedAt: d.updatedAt || null,
        ageDays: Math.max(
          0,
          Math.floor(
            (Date.now() -
              (Date.parse(d.sentAt || d.updatedAt || d.createdAt) ||
                Date.now())) /
              86400000,
          ),
        ),
      });
      cache["lenaic-scribe-snapshot-v1"] = {
        version: 1,
        source: "scribe",
        generatedAt: new Date().toISOString(),
        counts,
        pending: drafts
          .filter((d) => d.status === "sent" || d.status === "waiting")
          .map(summary),
        received: drafts.filter((d) => d.status === "received").map(summary),
      };
    }

    g.dispatchEvent(new CustomEvent("lenaicsyncchange", { detail: { key } }));
  }
  function download(name, value) {
    const url = URL.createObjectURL(
        new Blob([JSON.stringify(value, null, 2)], {
          type: "application/json",
        }),
      ),
      a = document.createElement("a");
    a.href = url;
    a.download = name;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }
  function summary(v) {
    if (!v) return "absente";
    return (
      Object.entries(v)
        .filter(([, x]) => Array.isArray(x))
        .map(([k, x]) => k + ": " + x.length)
        .join(" · ") || "base disponible"
    );
  }
  async function perform(a, mode = "sync", extra = {}) {
    if (running.has(a.id))
      throw Error("Une synchronisation est déjà en cours.");
    running.add(a.id);
    try {
      const cfg = config(a.id, extra),
        id = a.id + ":" + JSON.stringify(cfg),
        local = clone(a.get());
      if (!a.valid(local)) throw Error("Base locale invalide.");
      const payload = a.capture ? await a.capture(local) : local;
      // Must commit a recoverable copy before any network or local replacement.
      await archive(a.id, payload, null);
      const revision = a.revision ? await a.revision() : null;
      if (a.consistent && !a.consistent(local, revision))
        throw Error(
          "Cet onglet ne correspond pas au stockage local. Copie conservée ; recharge et compare avant de synchroniser.",
        );
      assertNoSecrets(payload);
      await privateRepo(cfg);
      const remote = await read(cfg),
        remoteDoc =
          remote.doc == null
            ? null
            : a.extract
              ? a.extract(remote.doc)
              : remote.doc;
      if (remote.sha && !a.valid(remoteDoc))
        throw Error("Format distant incompatible. Aucune donnée remplacée.");
      const lh = await hash(local),
        ph = await hash(payload),
        rh =
          remoteDoc == null
            ? ""
            : await hash(a.comparable ? a.comparable(remote.doc) : remoteDoc),
        base = await get("meta", id);
      const action = decide(base, ph, rh, remote.sha, a.has(local), mode);
      if (action !== "equal") await archive(a.id, payload, remote.doc);
      if (action === "conflict")
        throw Error(
          "Versions différentes sans base commune, ou modifiées sur deux appareils. Les deux copies sont conservées dans Secours JSON. Aucun remplacement automatique. Choisis explicitement Charger GitHub ou Envoyer cet appareil uniquement après sauvegardes externes et restauration vérifiées.",
        );
      if (
        mode !== "sync" &&
        action !== "equal" &&
        !confirm(
          "Résolution explicite — " +
            a.id +
            "\nCet appareil : " +
            summary(local) +
            "\nGitHub : " +
            summary(remoteDoc) +
            "\nConfirme uniquement après deux copies externes vérifiées et un essai de restauration réussi. Les deux versions sont conservées. " +
            (action === "push"
              ? "Publier cet appareil comme version principale ?"
              : "Charger GitHub sur cet appareil ?"),
        )
      )
        return false;
      async function unchanged() {
        if ((await hash(a.get())) !== lh)
          throw Error(
            "Modification locale pendant la synchronisation. Rien remplacé.",
          );
        if (a.capture && (await hash(await a.capture(a.get()))) !== ph)
          throw Error("Les fichiers locaux ont changé pendant la sauvegarde.");
        if (a.revision && canonical(await a.revision()) !== canonical(revision))
          throw Error(
            "Un autre onglet a modifié le stockage local. Rien remplacé.",
          );
      }
      await unchanged();
      let sha = remote.sha,
        expectedState = local,
        baselineHash = ph;
      if (action === "push") {
        if (remote.doc != null)
          await remoteArchive(cfg, a.id, remote.doc, "avant-remplacement");
        await remoteArchive(cfg, a.id, payload, "cet-appareil");
        await unchanged();
        sha = await write(cfg, payload, remote.sha);
        const check = await read(cfg);
        if (
          check.sha !== sha ||
          (await hash(
            a.comparable
              ? a.comparable(check.doc)
              : a.extract
                ? a.extract(check.doc)
                : check.doc,
          )) !== ph
        )
          throw Error(
            "Version distante modifiée après envoi. Secours conservés ; relance la comparaison.",
          );
        await unchanged();
      } else if (action === "pull") {
        // Check the remote again before committing a downloaded version.
        const check = await read(cfg);
        if (check.sha !== sha)
          throw Error(
            "GitHub a changé pendant le téléchargement. Rien remplacé.",
          );
        await unchanged();
        const applied = a.applyDocument
          ? await a.applyDocument(clone(remote.doc), revision)
          : await a.apply(clone(remoteDoc), revision);
        expectedState =
          applied === undefined ? clone(remoteDoc) : clone(applied);
        baselineHash = rh;
      }
      if ((await hash(a.get())) !== (await hash(expectedState)))
        throw Error("Nouvelle modification locale : réussite non enregistrée.");
      const at = new Date().toISOString();
      // Cache failure cannot leave a success marker for an operation reported as failed.
      await put("cache", {
        id: a.id,
        key: a.key,
        value: clone(a.get()),
        sha,
        at,
      });
      await put("meta", {
        id,
        app: a.id,
        sha,
        hash: baselineHash,
        lastSuccess: at,
      });
      if (a.key) publish(a.key, a.get());
      a.success?.(at, sha);
      return { at, sha, action };
    } finally {
      running.delete(a.id);
    }
  }
  async function run(a, mode = "sync", extra = {}) {
    const task = () => perform(a, mode, extra);
    // All apps share a branch: serialize their commits, not just one application.
    return g.navigator?.locks
      ? g.navigator.locks.request("lenaic-private-sync:ikare63/data", task)
      : task();
  }

  async function checkpoint(id) {
    const a = adapters.get(id);
    if (!a) return;
    const local = clone(a.get()),
      value = a.capture ? await a.capture(local) : local,
      h = await hash(value);
    if (checkpointHashes.get(id) === h) return;
    await archive(id, value, null);
    checkpointHashes.set(id, h);
    if (a.key) publish(a.key, local);
  }
  async function preserveMigration(app, bundle) {
    const id = "migration:" + app,
      h = await hash(bundle),
      old = await get("meta", id);
    if (old?.hash === h) return;
    await archive(app, bundle, null);
    await put("meta", { id, app, hash: h });
  }
  function localChange(id) {
    checkpoint(id)
      .then(() => {
        const status = document.querySelector(
          "#lenaicSafeSync [data-sync-status]",
        );
        if (status && !running.has(id))
          status.textContent =
            "Copie locale de secours conservée ; comparaison GitHub à effectuer.";
      })
      .catch((e) => {
        const status = document.querySelector(
          "#lenaicSafeSync [data-sync-status]",
        );
        if (status)
          status.textContent =
            "Échec de la copie locale de secours : " + e.message;
      });
  }
  function register(a) {
    if (!document.body) {
      document.addEventListener("DOMContentLoaded", () => register(a), {
        once: true,
      });
      return;
    }
    adapters.set(a.id, a);
    let panel = document.getElementById("lenaicSafeSync");
    if (panel) return;
    panel = document.createElement("details");
    panel.id = "lenaicSafeSync";
    panel.style.cssText =
      "margin:12px;padding:12px;border:1px solid currentColor;border-radius:10px;font:14px system-ui;position:relative;z-index:10";
    panel.innerHTML =
      "<summary>Synchronisation sécurisée · " +
      a.id +
      '</summary><p>GitHub privé ↔ cet appareil. Aucun transfert automatique avant comparaison. Jeton limité à cet onglet, au dépôt data et à 60 minutes. Après fermeture : ressaisir le jeton et refaire une comparaison ; aucun travail en arrière-plan.</p><label>Jeton GitHub <input type="password" autocomplete="off" data-sync-token placeholder="Contents : Read and write sur data"></label><button type="button" data-sync-auth>Utiliser pour cette session</button> <button type="button" data-sync-forget>Oublier le jeton</button><p><select aria-label="Sens de synchronisation" data-sync-mode><option value="sync">Comparer sans remplacer</option><option value="pull">Charger GitHub (résolution explicite)</option><option value="push">Envoyer cet appareil (résolution explicite)</option></select> <button type="button" data-sync-run>Synchroniser</button> <button type="button" data-sync-export>Exporter la base locale</button> <button type="button" data-sync-recovery>Secours JSON (toutes les copies)</button></p><p><label><input type="checkbox" data-sync-auto> Comparer au retour dans l’onglet et chaque minute (aucun remplacement automatique)</label></p><p data-sync-last>Dernière réussite GitHub : aucune sur cet appareil.</p><p role="status" data-sync-status>Pas encore vérifié sur cet appareil.</p>';
    (
      document.querySelector("header") || document.body.firstElementChild
    )?.insertAdjacentElement("afterend", panel);
    const q = (s) => panel.querySelector(s),
      status = q("[data-sync-status]");
    q("[data-sync-auth]").onclick = () => {
      const input = q("[data-sync-token]");
      if (input.value.trim()) setToken(input.value.trim());
      input.value = "";
      status.textContent =
        "Jeton chargé pour 60 minutes au maximum. Lance la comparaison.";
    };
    q("[data-sync-forget]").onclick = () => {
      forgetToken();
      status.textContent = "Jeton oublié. Une nouvelle saisie sera nécessaire.";
    };
    q("[data-sync-export]").onclick = async () => {
      try {
        const value = a.capture ? await a.capture(a.get()) : a.get();
        download(a.id + "-local-" + Date.now() + ".json", value);
      } catch (e) {
        status.textContent = "Export impossible : " + e.message;
      }
    };
    q("[data-sync-recovery]").onclick = async () => {
      try {
        download(a.id + "-recuperation-" + Date.now() + ".json", {
          app: a.id,
          current: a.capture ? await a.capture(a.get()) : a.get(),
          snapshots: (await all("snapshots")).filter((x) => x.app === a.id),
          meta: (await all("meta")).filter((x) => x.app === a.id),
        });
      } catch (e) {
        status.textContent = "Erreur : " + e.message;
      }
    };
    q("[data-sync-run]").onclick = async () => {
      const btn = q("[data-sync-run]");
      btn.disabled = true;
      status.textContent = "Comparaison et copies de sécurité…";
      try {
        const result = await run(a, q("[data-sync-mode]").value);
        verified = !!result;
        if (result)
          q("[data-sync-last]").textContent =
            "Dernière réussite GitHub : " +
            new Date(result.at).toLocaleString("fr-FR");
        status.textContent = result
          ? "Dernière synchronisation vérifiée : " +
            new Date(result.at).toLocaleString("fr-FR") +
            " · " +
            result.action
          : "Annulé : aucune version principale remplacée.";
      } catch (e) {
        verified = false;
        q("[data-sync-auto]").checked = false;
        status.textContent = "Erreur : " + e.message;
      } finally {
        btn.disabled = false;
      }
    };
    get("meta", a.id + ":" + JSON.stringify(config(a.id)))
      .then((m) => {
        if (m?.lastSuccess)
          q("[data-sync-last]").textContent =
            "Dernière réussite : " +
            new Date(m.lastSuccess).toLocaleString("fr-FR") +
            " · comparaison nécessaire.";
      })
      .catch((e) => {
        status.textContent = "Stockage de secours indisponible : " + e.message;
      });
    let verified = false;
    async function automatic() {
      await checkpoint(a.id).catch((e) => {
        status.textContent = "Secours local : " + e.message;
      });
      if (
        !q("[data-sync-auto]").checked ||
        !verified ||
        running.has(a.id) ||
        document.hidden
      )
        return;
      try {
        const result = await run(a);
        q("[data-sync-last]").textContent =
          "Dernière réussite GitHub : " +
          new Date(result.at).toLocaleString("fr-FR");
        status.textContent =
          "Dernière synchronisation vérifiée : " +
          new Date(result.at).toLocaleString("fr-FR");
      } catch (e) {
        q("[data-sync-auto]").checked = false;
        status.textContent = "Automatique suspendu : " + e.message;
      }
    }
    setInterval(automatic, 60000);
    g.addEventListener("focus", automatic);
    document.addEventListener("visibilitychange", () => {
      if (document.hidden) localChange(a.id);
    });
    localChange(a.id);
  }

  const appDatabases = new Map();
  function openApplicationDB(name, version, stores) {
    if (appDatabases.has(name)) return appDatabases.get(name);
    const pending = new Promise((resolve, reject) => {
      const req = indexedDB.open(name, version);
      let done = false;
      const fail = (e) => {
        if (done) return;
        done = true;
        clearTimeout(timer);
        appDatabases.delete(name);
        reject(e);
      };
      const timer = setTimeout(
        () => fail(Error("Initialisation IndexedDB bloquée : " + name)),
        5000,
      );
      req.onblocked = () =>
        fail(Error("IndexedDB occupée par un autre onglet : " + name));
      req.onerror = () => fail(req.error || Error("IndexedDB inaccessible."));
      req.onupgradeneeded = () => {
        for (const store of stores)
          if (!req.result.objectStoreNames.contains(store))
            req.result.createObjectStore(store, { keyPath: "id" });
      };
      req.onsuccess = () => {
        const db = req.result;
        if (done) {
          db.close();
          return;
        }
        if (stores.some((store) => !db.objectStoreNames.contains(store))) {
          db.close();
          fail(Error("Structure IndexedDB incomplète : " + name));
          return;
        }
        done = true;
        clearTimeout(timer);
        db.addEventListener("versionchange", () => {
          db.close();
          appDatabases.delete(name);
        });
        resolve(db);
      };
    });
    appDatabases.set(name, pending);
    pending.catch(() => appDatabases.delete(name));
    return pending;
  }
  async function existingDB(name) {
    return new Promise((resolve, reject) => {
      const r = indexedDB.open(name);
      let done = false,
        created = false;
      const fail = (e) => {
        if (done) return;
        done = true;
        clearTimeout(timer);
        reject(e);
      };
      const timer = setTimeout(
        () => fail(Error("Lecture IndexedDB bloquée : " + name)),
        5000,
      );
      r.onupgradeneeded = () => {
        created = true;
        r.transaction.abort();
      };
      r.onblocked = () =>
        fail(Error("IndexedDB bloquée par un autre onglet : " + name));
      r.onerror = () => {
        if (done) return;
        if (created) {
          done = true;
          clearTimeout(timer);
          resolve(null);
        } else fail(r.error);
      };
      r.onsuccess = () => {
        if (done) {
          r.result.close();
          return;
        }
        done = true;
        clearTimeout(timer);
        r.result.onversionchange = () => r.result.close();
        resolve(r.result);
      };
    });
  }
  async function record(name, store, id) {
    const db = await existingDB(name);
    if (!db) return null;
    return new Promise((resolve, reject) => {
      if (!db.objectStoreNames.contains(store)) {
        db.close();
        reject(Error("Store IndexedDB absent : " + store));
        return;
      }
      const tx = db.transaction(store),
        r = tx.objectStore(store).get(id);
      let row;
      r.onsuccess = () => {
        row = r.result || null;
      };
      tx.oncomplete = () => {
        db.close();
        resolve(row);
      };
      tx.onabort = tx.onerror = () => {
        db.close();
        reject(tx.error || Error("Lecture IndexedDB interrompue"));
      };
    });
  }
  async function replaceRecord(name, store, id, expected, next, extras = []) {
    const db = await existingDB(name);
    if (!db) throw Error("Base locale absente.");
    return new Promise((resolve, reject) => {
      const stores = [...new Set([store, ...extras.map((x) => x.store)])];
      let conflict = false;
      const tx = db.transaction(stores, "readwrite"),
        target = tx.objectStore(store),
        r = target.get(id);
      r.onsuccess = () => {
        if (canonical(r.result || null) !== canonical(expected)) {
          conflict = true;
          tx.abort();
          return;
        }
        for (const e of extras) tx.objectStore(e.store).put(e.row);
        target.put(next);
      };
      tx.oncomplete = () => {
        db.close();
        resolve(true);
      };
      tx.onabort = tx.onerror = () => {
        db.close();
        reject(
          Error(
            conflict
              ? "Stockage modifié par un autre onglet : import annulé."
              : "Transaction IndexedDB annulée.",
          ),
        );
      };
    });
  }
  async function readExisting(name, store, id) {
    const row = await record(name, store, id);
    if (!row) return null;
    if (typeof row.payload !== "string")
      throw Error("Payload IndexedDB invalide.");
    return JSON.parse(row.payload);
  }
  const JOURNAL = "lenaic-sync-localstorage-journal-v1";
  let storageRecoveryError = null;
  function rawStorage(keys) {
    return Object.fromEntries(keys.map((k) => [k, localStorage.getItem(k)]));
  }
  function restoreJournal(journal) {
    let failed = false;
    for (const [key, before] of Object.entries(journal.before)) {
      const current = localStorage.getItem(key);
      if (current === before) continue;
      if (current !== journal.after[key]) {
        failed = true;
        continue;
      }
      try {
        if (before === null) localStorage.removeItem(key);
        else localStorage.setItem(key, before);
      } catch {
        failed = true;
      }
    }
    if (failed)
      throw Error(
        "Récupération locale incomplète : édition suspendue, secours conservés.",
      );
    localStorage.removeItem(JOURNAL);
  }
  function assertStorageReady() {
    if (storageRecoveryError) throw storageRecoveryError;
  }
  function atomicStorage(changes, expected) {
    assertStorageReady();
    if (localStorage.getItem(JOURNAL))
      throw Error("Une récupération locale est en attente.");
    const keys = Object.keys(changes),
      before = rawStorage(keys);
    if (
      expected &&
      canonical(rawStorage(Object.keys(expected))) !== canonical(expected)
    )
      throw Error("Stockage local modifié par un autre onglet.");
    // One native setItem is atomic and needs no quota-expensive journal.
    if (keys.length === 1) {
      const key = keys[0];
      if (changes[key] === null) localStorage.removeItem(key);
      else localStorage.setItem(key, changes[key]);
      return;
    }
    const journal = { version: 1, before, after: changes };
    localStorage.setItem(JOURNAL, JSON.stringify(journal));
    try {
      for (const [key, value] of Object.entries(changes)) {
        if (localStorage.getItem(key) !== before[key])
          throw Error("Écriture locale concurrente.");
        if (value === null) localStorage.removeItem(key);
        else localStorage.setItem(key, value);
      }
      localStorage.removeItem(JOURNAL);
    } catch (e) {
      try {
        restoreJournal(journal);
      } catch (recovery) {
        storageRecoveryError = recovery;
      }
      throw Error(
        "Import local interrompu ; secours conservés. " +
          (storageRecoveryError ? storageRecoveryError.message : e.message),
      );
    }
  }
  try {
    const journal = localStorage.getItem(JOURNAL);
    if (journal) restoreJournal(JSON.parse(journal));
  } catch (e) {
    storageRecoveryError = e;
  }

  async function dashboard(refresh) {
    const defs = [
      [
        "arboris",
        "memoire-famille-data",
        "arboris-state-v1",
        "state",
        "current",
      ],
      [
        "scriptoria",
        "scriptoria-data",
        "scriptoria-files",
        "backups",
        "__scriptoria_primary_state__",
      ],
      [
        "pistoria",
        "pistoria_private_v3",
        "pistoria-state-v1",
        "state",
        "current",
      ],
      ["ariane", "ariane-local-v2", null, null, null],
      ["scribe", "scribe-local-v3", null, null, null],
    ];
    let remoteView = !!(await get("meta", "dashboard-source").catch(() => null))
      ?.remote;
    const panel = document.createElement("details");
    panel.id = "lenaicPrivateSources";
    panel.style.cssText =
      "margin:12px;padding:12px;border:1px solid currentColor;font:14px system-ui";
    panel.innerHTML =
      '<summary>Sources généalogiques privées</summary><p>Lecture seule : aucune sauvegarde des applications ne sera remplacée.</p><label>Jeton GitHub <input type="password" autocomplete="off" data-token></label> <button type="button" data-load>Actualiser depuis GitHub privé</button> <button type="button" data-local>Afficher les bases de cet appareil</button><p role="status" data-status>Lecture des bases de cet appareil…</p>';
    document.body.prepend(panel);
    const status = panel.querySelector("[data-status]");
    async function local() {
      const errors = [];
      for (const [app, key, db, store, id] of defs) {
        try {
          const d = db
              ? await readExisting(db, store, id)
              : JSON.parse(localStorage.getItem(key) || "null"),
            saved = await get("cache", app);
          if (remoteView && saved?.value) {
            publish(key, saved.value);
            errors.push(app + " : cache du " + saved.at + ", non revérifié");
          } else if (d) publish(key, d);
          else if (saved?.value) {
            publish(key, saved.value);
            errors.push(app + " : cache non revérifié");
          }
        } catch (e) {
          errors.push(app + " : erreur de lecture locale — " + e.message);
        }
      }
      refresh();
      status.textContent =
        "GitHub non vérifié. " +
        (errors.length
          ? errors.join(" ; ")
          : "Bases de cet appareil disponibles.");
    }
    await local();
    panel.querySelector("[data-local]").onclick = async () => {
      remoteView = false;
      await put("meta", { id: "dashboard-source", remote: false });
      await local();
    };
    panel.querySelector("[data-load]").onclick = async () => {
      const input = panel.querySelector("[data-token]");
      if (input.value.trim()) setToken(input.value.trim());
      input.value = "";
      const btn = panel.querySelector("[data-load]");
      btn.disabled = true;
      const results = [];
      try {
        await privateRepo(config("arboris"));
        remoteView = true;
        await put("meta", { id: "dashboard-source", remote: true });
        for (const [app, key] of defs) {
          try {
            const cfg = config(app),
              r = await read(cfg),
              d =
                app === "scriptoria"
                  ? r.doc?.scriptoria || r.doc?.data || r.doc
                  : r.doc;
            if (
              !d ||
              !Array.isArray(
                d[
                  app === "pistoria"
                    ? "investigations"
                    : app === "scriptoria"
                      ? "records"
                      : app === "ariane"
                        ? "cases"
                        : app === "scribe"
                          ? "drafts"
                          : "people"
                ],
              )
            )
              throw Error("format invalide ou fichier absent");
            await put("cache", {
              id: app,
              key,
              value: d,
              sha: r.sha,
              at: new Date().toISOString(),
            });
            publish(key, d);
            results.push(app + " vérifié");
          } catch (e) {
            results.push(app + " : " + e.message);
          }
        }
        refresh();
        status.textContent =
          new Date().toLocaleString("fr-FR") + " · " + results.join(" ; ");
      } catch (e) {
        status.textContent = "Erreur : " + e.message;
      } finally {
        btn.disabled = false;
      }
    };
    g.addEventListener("focus", () => {
      if (remoteView && token() && !panel.querySelector("[data-load]").disabled)
        panel.querySelector("[data-load]").onclick();
      else
        local().catch((e) => {
          status.textContent = e.message;
        });
    });
  }
  g.LenaicSync = {
    canonical,
    decide,
    hash,
    run,
    register,
    dashboard,
    request,
    read,
    archive,
    localChange,
    preserveMigration,
    view: (key) => cache[key],
    publish,
    openApplicationDB,
    setToken,
    forgetToken,
    hasToken: () => !!token(),
    assertNoSecrets,
    record,
    replaceRecord,
    rawStorage,
    atomicStorage,
    assertStorageReady,
    readExisting,
  };
})(window);
