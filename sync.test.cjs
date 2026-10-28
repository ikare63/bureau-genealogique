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
function setup(options = {}) {
  const idb = new IDBFactory(),
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
    confirm: () => options.confirm !== false,
    sessionStorage: {
      getItem: () => (options.noToken ? "" : "unit-test-token"),
    },
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
  assert.equal(decide(null, "a", "", "", true), "push");
  assert.equal(decide(null, "a", "", "", false), "conflict");
  assert.equal(
    decide({ sha: "old", hash: "a" }, "a", "", "", true),
    "conflict",
  );
  assert.equal(
    decide({ sha: "old", hash: "a" }, "b", "a", "old", true),
    "push",
  );
  assert.equal(
    decide({ sha: "old", hash: "a" }, "a", "b", "new", true),
    "pull",
  );
  assert.equal(
    decide({ sha: "old", hash: "a" }, "b", "c", "new", true),
    "conflict",
  );
});
test("empreinte : ordre stable, export ignoré, vraie modification détectée", async () => {
  const { sync } = setup();
  assert.equal(
    await sync.hash({ a: 1, b: 2 }),
    await sync.hash({ b: 2, a: 1 }),
  );
  assert.equal(
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
  assert.equal(saved.length, 1);
  assert.deepEqual(saved[0].local, changed);
  assert.deepEqual(saved[0].remote, original);
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
  assert.equal((await env.sync.run(a)).action, "pull");
  assert.deepEqual(copy(a.get()), original);
  assert.equal(env.calls.filter((x) => x.method === "PUT").length, 0);
  env.files.set("arboris.json", { sha: "updated-on-phone", doc: changed });
  assert.equal((await env.sync.run(a)).action, "pull");
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
  await assert.rejects(env.sync.run(a, "push"), /a changé pendant/);
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
  assert.equal((await rows(env.idb, "snapshots")).length, 1);
});
test("échec du chargement : retour à la copie locale et secours conservé", async () => {
  const a = adapter(changed),
    apply = a.apply;
  a.apply = async (v) => {
    await apply(v);
    if (v.people.length === 1) throw Error("disque plein");
  };
  const env = setup({ remote: original });
  await assert.rejects(env.sync.run(a, "pull"), /Chargement incomplet/);
  assert.deepEqual(copy(a.get()), changed);
  assert.equal((await rows(env.idb, "snapshots")).length, 1);
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
  assert.equal((await env.sync.run(a)).action, "push");
  assert.equal(env.files.get("arboris.json").doc.files[0].blob, files[0].blob);
  assert.deepEqual(env.files.get("arboris.json").doc.data, original);
  env.files.set("arboris.json", {
    sha: "phone-scan",
    doc: { data: changed, files: [file] },
  });
  assert.equal((await env.sync.run(a)).action, "pull");
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
