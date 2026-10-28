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
  function canonical(v, depth = 0) {
    if (Array.isArray(v))
      return "[" + v.map((x) => canonical(x, depth + 1)).join(",") + "]";
    if (v && typeof v === "object")
      return (
        "{" +
        Object.keys(v)
          .sort()
          .filter(
            (k) =>
              !(
                depth <= 1 &&
                [
                  "lastGithubSyncAt",
                  "githubSyncUpdatedAt",
                  "lastJsonExportAt",
                  "exportedAt",
                ].includes(k)
              ),
          )
          .map((k) => JSON.stringify(k) + ":" + canonical(v[k], depth + 1))
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
    if (!sha) return !base?.sha && hasLocal ? "push" : "conflict";
    if (!hasLocal) return "pull";
    if (!base?.sha || !base?.hash) return "conflict";
    if (base.sha === sha) return "push";
    if (base.hash === localHash) return "pull";
    return "conflict";
  }
  function open() {
    if (!dbPromise)
      dbPromise = new Promise((resolve, reject) => {
        const r = indexedDB.open(DB, 1);
        r.onupgradeneeded = () => {
          for (const s of ["snapshots", "meta", "cache"])
            if (!r.result.objectStoreNames.contains(s))
              r.result.createObjectStore(s, { keyPath: "id" });
        };
        r.onsuccess = () => resolve(r.result);
        r.onerror = () => reject(r.error);
        r.onblocked = () =>
          reject(
            Error("Stockage de secours bloqué. Ferme les autres onglets."),
          );
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
  function token() {
    return (
      sessionStorage.getItem(TOKEN) ||
      sessionStorage.getItem("ecosystem-github-token-v1") ||
      sessionStorage.getItem("bureau-genealogique-github-token-v1") ||
      sessionStorage.getItem("scriptoria-github-token-v2") ||
      ""
    );
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
    const controller = new AbortController(),
      timer = setTimeout(() => controller.abort(), 30000);
    try {
      const r = await fetch(url, {
        ...options,
        headers,
        cache: "no-store",
        signal: controller.signal,
        redirect: "error",
      });
      if (r.status === 401) throw Error("Jeton expiré ou invalide (401).");
      if (r.status === 403)
        throw Error(
          "Accès refusé (403) : vérifie Contents et les limites GitHub.",
        );
      if (r.status === 409 || r.status === 422)
        throw Error(
          "Conflit GitHub : aucune nouvelle tentative d’écrasement. Relance la comparaison.",
        );
      return r;
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
    g.dispatchEvent(new StorageEvent("storage", { key }));
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
      await a.flush?.();
      const payload = a.capture ? await a.capture(local) : local;
      await privateRepo(cfg);
      const remote = await read(cfg);
      const remoteDoc =
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
          "Versions différentes sans base commune, ou modifiées sur deux appareils. Les deux copies sont conservées dans Secours JSON. Choisis explicitement Charger GitHub ou Envoyer cet appareil après comparaison.",
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
            "\nLes deux copies seront conservées. " +
            (action === "push"
              ? "Publier cet appareil comme version principale ?"
              : "Charger GitHub sur cet appareil ?"),
        )
      )
        return false;
      let sha = remote.sha,
        final = local;
      if (action === "push") {
        if (remote.doc != null)
          await remoteArchive(cfg, a.id, remote.doc, "avant-remplacement");
        await remoteArchive(cfg, a.id, payload, "cet-appareil");
        if ((await hash(a.get())) !== lh)
          throw Error(
            "La base locale a changé pendant la sauvegarde. Relance la synchronisation.",
          );
        if (a.capture && (await hash(await a.capture(a.get()))) !== ph)
          throw Error("Les fichiers locaux ont changé pendant la sauvegarde.");
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
            "La version distante a changé après l’envoi. Copie de secours conservée ; relance la comparaison.",
          );
      } else if (action === "pull") {
        if ((await hash(a.get())) !== lh)
          throw Error(
            "Modification locale pendant le téléchargement. Rien remplacé.",
          );
        try {
          if (a.applyDocument) await a.applyDocument(clone(remote.doc));
          else await a.apply(clone(remoteDoc));
          await a.flush?.();
          final = clone(a.get());
        } catch (e) {
          try {
            if (a.applyDocument) await a.applyDocument(payload);
            else await a.apply(local);
          } catch {}
          throw Error(
            "Chargement incomplet ; copie de secours conservée : " + e.message,
          );
        }
      }
      const current = await hash(a.get()),
        expected = await hash(final);
      if (current !== expected)
        throw Error(
          "Nouvelle modification locale : synchronisation à confirmer.",
        );
      const at = new Date().toISOString();
      await put("meta", {
        id,
        app: a.id,
        sha,
        hash: a.capture ? await hash(await a.capture(a.get())) : expected,
        lastSuccess: at,
      });
      if (a.key) publish(a.key, a.get());
      await put("cache", {
        id: a.id,
        key: a.key,
        value: clone(a.get()),
        sha,
        at,
      });
      a.success?.(at, sha);
      return { at, sha, action };
    } finally {
      running.delete(a.id);
    }
  }
  async function run(a, mode = "sync", extra = {}) {
    const task = () => perform(a, mode, extra);
    return g.navigator?.locks
      ? g.navigator.locks.request("lenaic-private-sync:" + a.id, task)
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
      '</summary><p>GitHub privé ↔ cet appareil. Aucun transfert automatique avant comparaison. Jeton limité à cette session et au dépôt data.</p><label>Jeton GitHub <input type="password" autocomplete="off" data-sync-token placeholder="Contents : Read and write sur data"></label><button type="button" data-sync-auth>Utiliser pour cette session</button><p><select aria-label="Sens de synchronisation" data-sync-mode><option value="sync">Comparer et synchroniser</option><option value="pull">Charger GitHub (résolution explicite)</option><option value="push">Envoyer cet appareil (résolution explicite)</option></select> <button type="button" data-sync-run>Synchroniser</button> <button type="button" data-sync-export>Exporter la base locale</button> <button type="button" data-sync-recovery>Secours JSON (toutes les copies)</button></p><p><label><input type="checkbox" data-sync-auto> Synchroniser au retour dans l’onglet et chaque minute après une première réussite</label></p><p data-sync-last>Dernière réussite GitHub : aucune sur cet appareil.</p><p role="status" data-sync-status>Pas encore vérifié sur cet appareil.</p>';
    (
      document.querySelector("header") || document.body.firstElementChild
    )?.insertAdjacentElement("afterend", panel);
    const q = (s) => panel.querySelector(s),
      status = q("[data-sync-status]");
    q("[data-sync-auth]").onclick = () => {
      const input = q("[data-sync-token]");
      if (input.value.trim()) sessionStorage.setItem(TOKEN, input.value.trim());
      input.value = "";
      status.textContent =
        "Jeton chargé pour cet onglet. Lance la comparaison.";
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
    const originalRun = q("[data-sync-run]").onclick;
    q("[data-sync-run]").onclick = async () => {
      await originalRun();
      verified = !!(await get(
        "meta",
        a.id + ":" + JSON.stringify(config(a.id)),
      ).catch(() => null));
    };
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

  async function readExisting(name, store, id) {
    return new Promise((resolve, reject) => {
      const r = indexedDB.open(name);
      let created = false;
      r.onupgradeneeded = () => {
        created = true;
        r.transaction.abort();
      };
      r.onerror = () => (created ? resolve(null) : reject(r.error));
      r.onsuccess = () => {
        const db = r.result;
        if (!db.objectStoreNames.contains(store)) {
          db.close();
          resolve(null);
          return;
        }
        const tx = db.transaction(store),
          q = tx.objectStore(store).get(id);
        q.onsuccess = () => {
          db.close();
          try {
            resolve(q.result?.payload ? JSON.parse(q.result.payload) : null);
          } catch (e) {
            reject(e);
          }
        };
        q.onerror = () => {
          db.close();
          reject(q.error);
        };
      };
    });
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
      ["ariane","ariane-local-v2",null,null,null],
      ["scribe","scribe-local-v3",null,null,null],
    ];
    let remoteView = false;
    const panel = document.createElement("details");
    panel.id = "lenaicPrivateSources";
    panel.style.cssText =
      "margin:12px;padding:12px;border:1px solid currentColor;font:14px system-ui";
    panel.innerHTML =
      '<summary>Sources généalogiques privées</summary><p>Lecture seule : aucune sauvegarde des applications ne sera remplacée.</p><label>Jeton GitHub <input type="password" autocomplete="off" data-token></label> <button type="button" data-load>Actualiser depuis GitHub privé</button><p role="status" data-status>Lecture des bases de cet appareil…</p>';
    document.body.prepend(panel);
    const status = panel.querySelector("[data-status]");
    async function local() {
      if (remoteView) return;
      for (const [app, key, db, store, id] of defs) {
        try {
          const d = db ? await readExisting(db, store, id) : JSON.parse(localStorage.getItem(key)||"null"),
            saved = await get("cache", app);
          if (d) publish(key, d);
          else if (saved?.value) publish(key, saved.value);
        } catch (e) {
          status.textContent = "Erreur de lecture locale : " + e.message;
        }
      }
      refresh();
    }
    await local();
    status.textContent =
      "Données de cet appareil ou dernier cache. GitHub non vérifié.";
    panel.querySelector("[data-load]").onclick = async () => {
      const input = panel.querySelector("[data-token]");
      if (input.value.trim()) sessionStorage.setItem(TOKEN, input.value.trim());
      input.value = "";
      const btn = panel.querySelector("[data-load]");
      btn.disabled = true;
      remoteView = true;
      const results = [];
      try {
        await privateRepo(config("arboris"));
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
                      : app === "ariane" ? "cases" : app === "scribe" ? "drafts" : "people"
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
  };
})(window);
