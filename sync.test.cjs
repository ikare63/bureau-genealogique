"use strict";
const { test } = require("node:test");
const assert = require("node:assert/strict");
const vm = require("node:vm");
const fs = require("node:fs");
const path = require("node:path");
const { webcrypto } = require("node:crypto");
const { IDBFactory } = require("fake-indexeddb");
const code = fs.readFileSync(path.join(__dirname, "lenaic-sync.js"), "utf8");
const copy = (v) => JSON.parse(JSON.stringify(v));
function storage(initial = {}) {
  const map = new Map(Object.entries(initial));
  return {
    getItem: (k) => map.get(k) ?? null,
    setItem: (k, v) => map.set(k, String(v)),
    removeItem: (k) => map.delete(k),
    key: (i) => [...map.keys()][i] ?? null,
    get length() {
      return map.size;
    },
    dump: () => Object.fromEntries(map),
  };
}
function setup(options = {}) {
  const idb = options.idb || new IDBFactory(),
    calls = [],
    files = new Map(),
    blobs = new Map();
  let seq = 0;
  if (options.remote)
    files.set("arboris.json", { sha: "initial", doc: copy(options.remote) });
  class Reader {
    readAsDataURL(blob) {
      blob
        .arrayBuffer()
        .then((b) => {
          this.result =
            "data:application/json;base64," + Buffer.from(b).toString("base64");
          this.onload();
        })
        .catch((e) => {
          this.error = e;
          this.onerror();
        });
    }
  }
  const context = {
    URL,
    Headers,
    AbortController,
    TextEncoder,
    TextDecoder,
    Uint8Array,
    Blob,
    FileReader: Reader,
    atob,
    console,
    setTimeout,
    clearTimeout,
    indexedDB: idb,
    localStorage: storage(options.localStorage),
    confirm: () => options.confirm !== false,
    sessionStorage: storage(
      options.sessionStorage ||
        (options.noToken
          ? {}
          : {
              "lenaic-private-data-token-v1": "unit-test-token",
              "lenaic-private-data-token-v1:expires": String(
                Date.now() + 3600000,
              ),
            }),
    ),
    StorageEvent: class {
      constructor(type, detail) {
        this.type = type;
        this.detail = detail;
      }
    },
    CustomEvent: class {},
    window: {
      crypto: webcrypto,
      dispatchEvent() {},
      navigator: options.locks
        ? {
            locks: {
              request: async (name, fn) => {
                calls.push({ lock: name });
                return fn();
              },
            },
          }
        : {},
    },
    fetch: async (url, init) => {
      const method = init.method || "GET";
      calls.push({ url, method, headers: init.headers, body: init.body });
      if (options.intercept) {
        const response = await options.intercept(url, init, files, calls);
        if (response) return response;
      }
      const u = new URL(url),
        root = "/repos/ikare63/data";
      if (u.pathname === root)
        return Response.json({ private: options.private !== false });
      if (u.pathname.startsWith(root + "/branches/"))
        return options.badBranch
          ? new Response("", { status: 404 })
          : Response.json({ name: "main" });
      if (u.pathname.startsWith(root + "/git/blobs/")) {
        const value = blobs.get(
          decodeURIComponent(u.pathname.slice((root + "/git/blobs/").length)),
        );
        return value
          ? new Response(JSON.stringify(value))
          : new Response("", { status: 404 });
      }
      const file = u.pathname
        .slice((root + "/contents/").length)
        .split("/")
        .map(decodeURIComponent)
        .join("/");
      if (method === "PUT") {
        const body = JSON.parse(init.body),
          prior = files.get(file);
        if ((prior && body.sha !== prior.sha) || (!prior && body.sha))
          return new Response("", { status: 409 });
        const row = {
          sha: "sha-" + ++seq,
          doc: JSON.parse(Buffer.from(body.content, "base64").toString("utf8")),
        };
        files.set(file, row);
        return Response.json({ content: { sha: row.sha } });
      }
      const row = files.get(file);
      if (!row) return new Response("", { status: 404 });
      blobs.set(row.sha, row.doc);
      return Response.json({
        sha: row.sha,
        type: "file",
        encoding: options.large ? "none" : "base64",
        content: options.large
          ? ""
          : Buffer.from(JSON.stringify(row.doc)).toString("base64"),
      });
    },
  };
  vm.createContext(context);
  vm.runInContext(code, context);
  return { sync: context.window.LenaicSync, idb, calls, files, context };
}
async function rows(idb, store) {
  const db = await new Promise((resolve, reject) => {
    const r = idb.open("lenaic-safe-sync-v1");
    r.onsuccess = () => resolve(r.result);
    r.onerror = () => reject(r.error);
  });
  return new Promise((resolve, reject) => {
    const r = db.transaction(store).objectStore(store).getAll();
    r.onsuccess = () => {
      db.close();
      resolve(r.result);
    };
    r.onerror = () => reject(r.error);
  });
}
function adapter(initial) {
  let value = copy(initial);
  return {
    id: "arboris",
    key: "memoire-famille-data",
    get: () => value,
    valid: (v) => !!v && Array.isArray(v.people) && Array.isArray(v.families),
    has: (v) => v.people.length + v.families.length > 0,
    apply: async (v) => {
      value = v;
    },
    flush: async () => {},
    set: (v) => {
      value = v;
    },
  };
}
const original = { people: [{ id: "1", name: "Élise 🌿" }], families: [] },
  changed = {
    people: [{ id: "1", name: "Élise 🌿" }, { id: "2" }],
    families: [],
  };
test("comparaison : égalité, premier conflit, SHA commun, deux appareils, suppression distante", () => {
  const { decide } = setup().sync;
  assert.equal(decide(null, "a", "a", "sha", true), "equal");
  assert.equal(decide(null, "a", "b", "sha", true), "conflict");
  assert.equal(decide(null, "empty", "remote", "sha", false), "conflict");
  assert.equal(decide(null, "a", "", "", true), "conflict");
  assert.equal(decide(null, "a", "", "", false), "conflict");
  assert.equal(
    decide({ sha: "old", hash: "a" }, "a", "", "", true),
    "conflict",
  );
  assert.equal(
    decide({ sha: "old", hash: "a" }, "b", "a", "old", true),
    "conflict",
  );
  assert.equal(
    decide({ sha: "old", hash: "a" }, "a", "b", "new", true),
    "conflict",
  );
  assert.equal(
    decide({ sha: "old", hash: "a" }, "b", "c", "new", true),
    "conflict",
  );
});
test("empreinte : ordre stable et toutes les modifications, y compris export, détectées", async () => {
  const { sync } = setup();
  assert.equal(
    await sync.hash({ a: 1, b: 2 }),
    await sync.hash({ b: 2, a: 1 }),
  );
  assert.notEqual(
    await sync.hash({ people: [], metadata: { lastJsonExportAt: "y" } }),
    await sync.hash({ people: [], metadata: { lastJsonExportAt: "z" } }),
  );
  assert.notEqual(await sync.hash(original), await sync.hash(changed));
});
test("petit JSON UTF-8 et gros JSON : média raw conservé, blob épinglé au SHA", async () => {
  for (const large of [false, true]) {
    const env = setup({ remote: original, large });
    const r = await env.sync.read({
      owner: "ikare63",
      repo: "data",
      branch: "main",
      path: "arboris.json",
    });
    assert.deepEqual(copy(r.doc), original);
    assert.equal(r.sha, "initial");
    if (large) {
      assert.match(env.calls[1].url, /git\/blobs\/initial$/);
      assert.equal(
        env.calls[1].headers.get("Accept"),
        "application/vnd.github.raw+json",
      );
    }
  }
});
test("jeton absent, destination extérieure, erreurs 401/403/409/422 : refus sans fuite", async () => {
  await assert.rejects(
    setup({ noToken: true }).sync.request(
      "https://api.github.com/repos/ikare63/data",
    ),
    /Jeton absent/,
  );
  const env = setup();
  await assert.rejects(
    env.sync.request("https://example.com/"),
    /non autorisée/,
  );
  assert.equal(env.calls.length, 0);
  for (const status of [401, 403, 409, 422]) {
    const env = setup({ intercept: () => new Response("", { status }) });
    await assert.rejects(
      env.sync.request("https://api.github.com/repos/ikare63/data"),
    );
    assert.equal(env.calls.length, 1);
  }
});
test("première divergence : deux copies locales, aucun PUT et aucune application distante", async () => {
  const env = setup({ remote: original }),
    a = adapter(changed);
  await assert.rejects(env.sync.run(a), /Versions différentes/);
  assert.equal(env.calls.filter((x) => x.method === "PUT").length, 0);
  assert.deepEqual(a.get(), changed);
  assert.deepEqual(copy(env.files.get("arboris.json").doc), original);
  const saved = await rows(env.idb, "snapshots");
  assert.equal(saved.length, 2);
  assert.deepEqual(saved[1].local, changed);
  assert.deepEqual(saved[1].remote, original);
});
test("envoi explicite : copies locales et distantes vérifiées AVANT le principal, puis base commune", async () => {
  const env = setup({ remote: original, locks: true }),
    a = adapter(changed);
  const result = await env.sync.run(a, "push");
  assert.equal(result.action, "push");
  const writes = env.calls.filter((x) => x.method === "PUT");
  assert.equal(writes.length, 3);
  assert.match(writes[0].url, /recovery/);
  assert.match(writes[1].url, /recovery/);
  assert.match(writes[2].url, /contents\/arboris.json$/);
  assert.equal(JSON.parse(writes[2].body).sha, "initial");
  assert.deepEqual(copy(env.files.get("arboris.json").doc), changed);
  const meta = await rows(env.idb, "meta");
  assert.equal(meta[0].sha, result.sha);
  assert.ok(meta[0].lastSuccess);
  assert.ok(env.calls.some((x) => x.lock));
  const again = await env.sync.run(a);
  assert.equal(again.action, "equal");
  assert.equal(env.calls.filter((x) => x.method === "PUT").length, 3);
});
test("premier appareil vide : téléchargement avec copie de secours puis mise à jour distante reçue", async () => {
  const env = setup({ remote: original }),
    a = adapter({ people: [], families: [] });
  assert.equal((await env.sync.run(a, "pull")).action, "pull");
  assert.deepEqual(copy(a.get()), original);
  assert.equal(env.calls.filter((x) => x.method === "PUT").length, 0);
  env.files.set("arboris.json", { sha: "updated-on-phone", doc: changed });
  await assert.rejects(env.sync.run(a), /Versions différentes/);
  assert.equal((await env.sync.run(a, "pull")).action, "pull");
  assert.deepEqual(copy(a.get()), changed);
});
test("409 pendant le principal : pas de réessai, copies récupérables, pas de réussite enregistrée", async () => {
  const env = setup({
    remote: original,
    intercept: (url, init) =>
      init.method === "PUT" && url.endsWith("/arboris.json")
        ? new Response("", { status: 409 })
        : null,
  });
  await assert.rejects(
    env.sync.run(adapter(changed), "push"),
    /Conflit GitHub/,
  );
  assert.equal(
    env.calls.filter(
      (x) => x.method === "PUT" && x.url.endsWith("/arboris.json"),
    ).length,
    1,
  );
  assert.deepEqual(copy(env.files.get("arboris.json").doc), original);
  assert.equal((await rows(env.idb, "meta")).length, 0);
  assert.equal(
    [...env.files.keys()].filter((x) => x.startsWith("recovery/")).length,
    2,
  );
});
test("copie distante non vérifiée : arrêt avant remplacement du principal", async () => {
  const env = setup({
    remote: original,
    intercept: (url, init) =>
      init.method !== "PUT" && url.includes("/recovery/")
        ? Response.json({
            sha: "incorrect",
            type: "file",
            encoding: "base64",
            content: Buffer.from("{}").toString("base64"),
          })
        : null,
  });
  await assert.rejects(env.sync.run(adapter(changed), "push"), /non vérifiée/);
  assert.equal(
    env.calls.filter(
      (x) => x.method === "PUT" && x.url.endsWith("/arboris.json"),
    ).length,
    0,
  );
});
test("erreur de stockage local : aucune écriture GitHub", async () => {
  const env = setup({ remote: original });
  env.context.indexedDB = {
    open() {
      const r = {};
      queueMicrotask(() => {
        r.error = new Error("Quota local");
        r.onerror();
      });
      return r;
    },
  };
  await assert.rejects(env.sync.run(adapter(changed), "push"), /Quota local/);
  assert.equal(env.calls.filter((x) => x.method === "PUT").length, 0);
});
test("modification locale pendant les copies : arrêt avant le principal", async () => {
  const a = adapter(changed),
    env = setup({
      remote: original,
      intercept: (url, init) => {
        if (init.method === "PUT" && url.includes("/recovery/"))
          a.set({ ...changed, people: [...changed.people, { id: "3" }] });
        return null;
      },
    });
  await assert.rejects(env.sync.run(a, "push"), /Modification locale pendant/);
  assert.equal(
    env.calls.filter(
      (x) => x.method === "PUT" && x.url.endsWith("/arboris.json"),
    ).length,
    0,
  );
  assert.equal(a.get().people.length, 3);
});
test("dépôt public ou mauvaise branche : aucune sauvegarde envoyée", async () => {
  for (const opts of [
    { private: false, remote: original },
    { badBranch: true },
  ]) {
    const env = setup(opts);
    await assert.rejects(env.sync.run(adapter(changed), "push"));
    assert.equal(env.calls.filter((x) => x.method === "PUT").length, 0);
  }
});
test("annulation de résolution : principal inchangé, copies locales conservées", async () => {
  const env = setup({ remote: original, confirm: false });
  assert.equal(await env.sync.run(adapter(changed), "push"), false);
  assert.equal(env.calls.filter((x) => x.method === "PUT").length, 0);
  assert.equal((await rows(env.idb, "snapshots")).length, 2);
});
test("échec du chargement : aucun rollback aveugle sur une nouvelle modification", async () => {
  const a = adapter(changed);
  let calls = 0;
  a.apply = async () => {
    calls++;
    a.set({ ...changed, people: [{ id: "nouvelle-modification" }] });
    throw Error("transaction annulée");
  };
  const env = setup({ remote: original });
  await assert.rejects(env.sync.run(a, "pull"), /transaction annulée/);
  assert.equal(calls, 1);
  assert.equal(a.get().people[0].id, "nouvelle-modification");
  assert.equal((await rows(env.idb, "meta")).length, 0);
});
test("migration : conservation des chaînes originales même illisibles, déduplication", async () => {
  const env = setup(),
    bundle = {
      legacy: "{illisible",
      primary: { payload: JSON.stringify(original) },
      backup: "original-backup",
    };
  await env.sync.preserveMigration("arboris", bundle);
  await env.sync.preserveMigration("arboris", bundle);
  const saved = await rows(env.idb, "snapshots");
  assert.equal(saved.length, 1);
  assert.deepEqual(saved[0].local, bundle);
});
test("documents complets : modification de fichier seule détectée et envoyée sans perdre le texte", async () => {
  const file = {
    id: "scan",
    blob: "data:application/pdf;base64,YQ==",
    thumbnail: null,
    fileName: "registre.pdf",
    mimeType: "application/pdf",
  };
  const env = setup({ remote: { data: original, files: [file] } }),
    a = adapter(original);
  let files = [file];
  a.capture = async (state) => ({ data: copy(state), files: copy(files) });
  a.extract = (doc) => doc.data || doc;
  a.comparable = (doc) => ({ data: doc.data || doc, files: doc.files || [] });
  a.applyDocument = async (doc) => {
    await a.apply(copy(doc.data || doc));
    files = copy(doc.files || []);
  };
  assert.equal((await env.sync.run(a)).action, "equal");
  files = [{ ...file, blob: "data:application/pdf;base64,Yg==" }];
  await assert.rejects(env.sync.run(a), /Versions différentes/);
  assert.equal((await env.sync.run(a, "push")).action, "push");
  assert.equal(env.files.get("arboris.json").doc.files[0].blob, files[0].blob);
  assert.deepEqual(env.files.get("arboris.json").doc.data, original);
  env.files.set("arboris.json", {
    sha: "phone-scan",
    doc: { data: changed, files: [file] },
  });
  await assert.rejects(env.sync.run(a), /Versions différentes/);
  assert.equal((await env.sync.run(a, "pull")).action, "pull");
  assert.deepEqual(copy(a.get()), changed);
  assert.deepEqual(files, [file]);
});
test("fichiers modifiés pendant l’envoi : le JSON principal reste intact", async () => {
  const a = adapter(changed);
  let version = 0;
  a.capture = async (current) => ({
    data: current,
    files: [{ id: "scan", blob: String(version) }],
  });
  a.extract = (doc) => doc.data || doc;
  a.comparable = (doc) => ({ data: doc.data || doc, files: doc.files || [] });
  const env = setup({
    remote: original,
    intercept: (url, init) => {
      if (init.method === "PUT" && url.includes("cet-appareil")) version++;
      return null;
    },
  });
  await assert.rejects(env.sync.run(a, "push"), /fichiers locaux ont changé/);
  assert.equal(
    env.calls.filter(
      (x) => x.method === "PUT" && x.url.endsWith("/arboris.json"),
    ).length,
    0,
  );
});

async function seed(idb, name, version, stores, rowsByStore = {}) {
  const db = await new Promise((resolve, reject) => {
    const r = idb.open(name, version);
    r.onupgradeneeded = () => {
      for (const store of stores)
        r.result.createObjectStore(store, { keyPath: "id" });
    };
    r.onsuccess = () => resolve(r.result);
    r.onerror = () => reject(r.error);
  });
  await new Promise((resolve, reject) => {
    const tx = db.transaction(stores, "readwrite");
    for (const [store, rows] of Object.entries(rowsByStore))
      for (const row of rows) tx.objectStore(store).put(row);
    tx.oncomplete = resolve;
    tx.onerror = () => reject(tx.error);
  });
  db.close();
}
test("première base apparemment vide : ne jamais télécharger implicitement", async () => {
  const env = setup({ remote: original }),
    a = adapter({ people: [], families: [], research: [{ id: "important" }] });
  a.has = () => false;
  await assert.rejects(env.sync.run(a), /Versions différentes/);
  assert.equal(a.get().research.length, 1);
  assert.equal(env.calls.filter((x) => x.method === "PUT").length, 0);
});
test("préparation : la copie de secours précède toute API et aucun flush primaire n’est appelé", async () => {
  const env = setup({ remote: original }),
    a = adapter(changed);
  let flush = 0;
  a.flush = async () => flush++;
  await assert.rejects(env.sync.run(a), /Versions différentes/);
  assert.equal(flush, 0);
  assert.deepEqual((await rows(env.idb, "snapshots"))[0].local, changed);
});
test("autre onglet détecté avant le réseau : conserver la mémoire locale sans écrire le disque", async () => {
  const env = setup({ remote: original }),
    a = adapter(changed);
  a.revision = async () => ({ payload: "newer" });
  a.consistent = () => false;
  await assert.rejects(env.sync.run(a, "push"), /onglet ne correspond/);
  assert.equal(env.calls.length, 0);
  assert.equal((await rows(env.idb, "snapshots")).length, 1);
});
test("modification de révision sur disque pendant le réseau : import arrêté", async () => {
  let revision = 1;
  const env = setup({
      remote: original,
      intercept: (url) => {
        if (url.includes("/contents/")) revision = 2;
        return null;
      },
    }),
    a = adapter(changed);
  a.revision = async () => revision;
  a.apply = async () => assert.fail("aucun import");
  await assert.rejects(env.sync.run(a, "pull"), /autre onglet/);
});
test("IndexedDB : version existante supérieure à 1, payload invalide et base absente", async () => {
  const env = setup();
  await seed(env.idb, "version7", 7, ["state"], {
    state: [{ id: "current", payload: JSON.stringify(original) }],
  });
  assert.deepEqual(
    copy(await env.sync.readExisting("version7", "state", "current")),
    original,
  );
  await seed(env.idb, "broken", 3, ["state"], {
    state: [{ id: "current", payload: "{invalid" }],
  });
  await assert.rejects(env.sync.readExisting("broken", "state", "current"));
  assert.equal(
    await env.sync.readExisting("does-not-exist", "state", "current"),
    null,
  );
  assert.ok(
    !(await env.idb.databases()).some((x) => x.name === "does-not-exist"),
  );
});
test("IndexedDB : comparaison et remplacement dans la même transaction, avec fichiers atomiques", async () => {
  const env = setup(),
    before = { id: "current", payload: JSON.stringify(original) },
    newer = { id: "current", payload: JSON.stringify(changed) };
  await seed(env.idb, "cas", 2, ["state", "files"], {
    state: [before],
    files: [{ id: "scan", value: "original" }],
  });
  await env.sync.replaceRecord(
    "cas",
    "state",
    "current",
    copy(before),
    copy(newer),
    [{ store: "files", row: { id: "scan", value: "changed" } }],
  );
  assert.deepEqual(
    copy(await env.sync.record("cas", "state", "current")),
    newer,
  );
  await assert.rejects(
    env.sync.replaceRecord(
      "cas",
      "state",
      "current",
      before,
      { id: "current", payload: "stale" },
      [{ store: "files", row: { id: "scan", value: "stale" } }],
    ),
    /autre onglet/,
  );
  assert.equal(
    (await env.sync.record("cas", "files", "scan")).value,
    "changed",
  );
});
test("IndexedDB : blocage d’ouverture signalé sans promesse suspendue", async () => {
  const env = setup();
  env.context.indexedDB = {
    open() {
      const r = {};
      queueMicrotask(() => r.onblocked());
      return r;
    },
  };
  await assert.rejects(
    env.sync.readExisting("locked", "state", "current"),
    /bloquée/,
  );
});
test("import localStorage : quota au milieu, retour aux valeurs d’origine", () => {
  const env = setup({ localStorage: { a: "old-a", b: "old-b" } }),
    ls = env.context.localStorage,
    write = ls.setItem;
  ls.setItem = (key, value) => {
    if (key === "b" && value === "new-b") throw Error("QuotaExceeded");
    write(key, value);
  };
  assert.throws(
    () =>
      env.sync.atomicStorage(
        { a: "new-a", b: "new-b" },
        { a: "old-a", b: "old-b" },
      ),
    /interrompu/,
  );
  assert.equal(ls.getItem("a"), "old-a");
  assert.equal(ls.getItem("b"), "old-b");
  assert.equal(ls.getItem("lenaic-sync-localstorage-journal-v1"), null);
});
test("journal interrompu : récupération avant que les applications relisent leurs clés", () => {
  const journal = {
    version: 1,
    before: { a: "old-a", b: "old-b" },
    after: { a: "new-a", b: "new-b" },
  };
  const env = setup({
    localStorage: {
      a: "new-a",
      b: "old-b",
      "lenaic-sync-localstorage-journal-v1": JSON.stringify(journal),
    },
  });
  env.sync.assertStorageReady();
  assert.equal(env.context.localStorage.getItem("a"), "old-a");
  assert.equal(env.context.localStorage.getItem("b"), "old-b");
});
test("journal et écriture extérieure : ne pas restaurer par-dessus la valeur récente", () => {
  const journal = { version: 1, before: { a: "old" }, after: { a: "ours" } };
  const env = setup({
    localStorage: {
      a: "another-tab",
      "lenaic-sync-localstorage-journal-v1": JSON.stringify(journal),
    },
  });
  assert.throws(() => env.sync.assertStorageReady(), /édition suspendue/);
  assert.equal(env.context.localStorage.getItem("a"), "another-tab");
  assert.ok(
    env.context.localStorage.getItem("lenaic-sync-localstorage-journal-v1"),
  );
});
test("fermeture / réouverture : base commune conservée, session vide refuse le réseau, nouveau jeton reprend", async () => {
  const first = setup({ remote: original }),
    a = adapter(original);
  assert.equal((await first.sync.run(a)).action, "equal");
  const reopened = setup({ remote: original, idb: first.idb, noToken: true });
  assert.ok((await rows(first.idb, "meta"))[0].lastSuccess);
  await assert.rejects(reopened.sync.run(adapter(original)), /Jeton absent/);
  assert.equal(reopened.calls.length, 0);
  reopened.sync.setToken("new-unit-test-token");
  assert.equal((await reopened.sync.run(adapter(original))).action, "equal");
  assert.equal(reopened.calls.filter((x) => x.method === "PUT").length, 0);
});
test("session restaurée avec jeton expiré : oubli, pas de réutilisation des anciens jetons", async () => {
  const env = setup({
    sessionStorage: {
      "lenaic-private-data-token-v1": "expired-unit-token",
      "lenaic-private-data-token-v1:expires": String(Date.now() - 10),
      "ecosystem-github-token-v1": "old-unit-token",
    },
  });
  assert.equal(env.sync.hasToken(), false);
  await assert.rejects(
    env.sync.request("https://api.github.com/repos/ikare63/data"),
    /Jeton absent/,
  );
  assert.equal(env.calls.length, 0);
  assert.deepEqual(env.context.sessionStorage.dump(), {});
});
test("anti-fuite : contenu comportant un secret ou clé credential rejeté avant réseau", async () => {
  for (const extra of [
    { token: "credential-string" },
    { note: "ghp_" + "x".repeat(36) },
  ]) {
    const env = setup({ remote: original }),
      a = adapter({ ...changed, ...extra });
    await assert.rejects(env.sync.run(a, "push"), /secret/i);
    assert.equal(env.calls.length, 0);
  }
  const env = setup();
  assert.throws(
    () => env.sync.assertNoSecrets({ nested: { github_token: "secret" } }),
    /secret/,
  );
});
test("gros JSON réel de plus de 1 Mio, UTF-8 : contenu brut intégral récupéré", async () => {
  const remote = {
      people: [{ id: "huge", notes: "é🌿".repeat(300000) }],
      families: [],
    },
    env = setup({ remote, large: true });
  assert.ok(Buffer.byteLength(JSON.stringify(remote)) > 1024 * 1024);
  const result = await env.sync.read({
    owner: "ikare63",
    repo: "data",
    branch: "main",
    path: "arboris.json",
  });
  assert.deepEqual(copy(result.doc), remote);
  assert.match(env.calls.at(-1).url, /git\/blobs\/initial$/);
  assert.equal(
    env.calls.at(-1).headers.get("Accept"),
    "application/vnd.github.raw+json",
  );
});
test("délai réseau : la limite couvre aussi le corps de la réponse", async () => {
  const env = setup({
    intercept: () => ({
      ok: true,
      status: 200,
      text: () => new Promise(() => {}),
    }),
  });
  env.context.setTimeout = (fn, ms) => setTimeout(fn, ms === 30000 ? 5 : ms);
  await assert.rejects(
    env.sync.request("https://api.github.com/repos/ikare63/data"),
    /Délai de lecture/,
  );
});
test("ouverture applicative : stores attendus et blocage signalé", async () => {
  const env = setup(),
    db = await env.sync.openApplicationDB("app", 2, ["state", "files"]);
  assert.equal(db.version, 2);
  assert.ok(db.objectStoreNames.contains("state"));
  db.close();
  const locked = setup();
  locked.context.indexedDB = {
    open() {
      const req = {};
      queueMicrotask(() => req.onblocked());
      return req;
    },
  };
  await assert.rejects(
    locked.sync.openApplicationDB("locked", 2, ["state"]),
    /autre onglet/,
  );
});
test("publication mémoire : aucun faux événement storage avec newValue nul", () => {
  const env = setup(),
    events = [];
  env.context.window.dispatchEvent = (e) => events.push(e);
  env.sync.publish("culina-shopping-v1", [{ id: "fixture" }]);
  assert.equal(events.filter((e) => e.type === "storage").length, 0);
  assert.deepEqual(copy(env.sync.view("culina-shopping-v1")), [
    { id: "fixture" },
  ]);
});
test("réponse perdue après écriture GitHub : aucun marqueur de réussite, comparaison ultérieure sûre", async () => {
  let lost = true;
  const env = setup({
      remote: original,
      intercept: (url, init, files) => {
        if (lost && init.method === "PUT" && url.endsWith("/arboris.json")) {
          const doc = JSON.parse(
            Buffer.from(JSON.parse(init.body).content, "base64").toString(
              "utf8",
            ),
          );
          files.set("arboris.json", {
            sha: "committed-but-response-lost",
            doc,
          });
          lost = false;
          throw Error("réponse réseau perdue");
        }
        return null;
      },
    }),
    a = adapter(changed);
  await assert.rejects(env.sync.run(a, "push"), /réponse réseau perdue/);
  assert.equal((await rows(env.idb, "meta")).length, 0);
  assert.deepEqual(copy(env.files.get("arboris.json").doc), changed);
  assert.equal((await env.sync.run(a)).action, "equal");
});
test("Scribe distant : dériver le récapitulatif de la base publiée, sans réutiliser un snapshot ancien", () => {
  const env = setup();
  env.sync.publish("scribe-local-v3", {
    contacts: [],
    drafts: [
      { id: "1", title: "Test", status: "waiting", sentAt: "2026-10-01" },
    ],
  });
  assert.equal(env.sync.view("lenaic-scribe-snapshot-v1").counts.awaiting, 1);
  env.sync.publish("scribe-local-v3", { contacts: [], drafts: [] });
  assert.equal(env.sync.view("lenaic-scribe-snapshot-v1").counts.awaiting, 0);
});
