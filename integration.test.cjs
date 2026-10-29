"use strict";
const assert = require("node:assert/strict"),
  fs = require("node:fs"),
  path = require("node:path");
const { JSDOM, VirtualConsole } = require("jsdom"),
  { IDBFactory } = require("fake-indexeddb"),
  { webcrypto } = require("node:crypto");
const root = path.resolve(__dirname, ".."),
  copy = (v) => JSON.parse(JSON.stringify(v));
const targets = [
  ["bureau-genealogique", "index.html", "arboris"],
  ["bureau-genealogique", "index2.html", "scriptoria"],
  ["bureau-genealogique", "index3.html", "pistoria"],
  ["aide_archive", "Ariane.html", "ariane"],
  ["aide_archive", "Scribe-v3.html", "scribe"],
  ["cap", "index.html", "cap"],
  ["culina", "index.html", "culina"],
  ["3615lenaic", "index.html", "3615"],
];
const docs = {},
  results = [],
  cloud = new Map();
let commit = 0;
function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}
function lsDump(w) {
  return Object.fromEntries(
    Object.keys(w.localStorage).map((k) => [k, w.localStorage.getItem(k)]),
  );
}
async function load(repo, file, { idb = new IDBFactory(), local = {} } = {}) {
  const errors = [],
    logs = [],
    virtual = new VirtualConsole();
  virtual.on("jsdomError", (e) => {
    if (!/Not implemented/.test(e.message)) errors.push(e.message);
  });
  virtual.on("error", (...xs) =>
    logs.push(xs.map((x) => x?.message || String(x)).join(" ")),
  );
  const raw = fs.readFileSync(path.join(root, repo, file), "utf8"),
    dom = new JSDOM(raw.replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, ""), {
      url: "https://ikare63.github.io/" + repo + "/" + file,
      runScripts: "dangerously",
      pretendToBeVisual: true,
      virtualConsole: virtual,
    });
  const w = dom.window;
  class Reader {
    readAsDataURL(blob) {
      blob
        .arrayBuffer()
        .then((b) => {
          this.result =
            "data:" +
            blob.type +
            ";base64," +
            Buffer.from(b).toString("base64");
          this.onload?.();
        })
        .catch((e) => {
          this.error = e;
          this.onerror?.();
        });
    }
  }
  Object.defineProperty(w, "crypto", { value: webcrypto });
  Object.assign(w, {
    indexedDB: idb,
    TextEncoder,
    TextDecoder,
    Headers,
    Blob,
    FileReader: Reader,
    AbortController,
    structuredClone,
    fetch: async (url, init) => {
      const u = String(url);
      if (u === "https://api.github.com/repos/ikare63/data")
        return Response.json({ private: true });
      if (u.includes("/branches/")) return Response.json({ name: "main" });
      if (u.includes("/contents/")) {
        const file = u.split("/contents/")[1].split("?")[0],
          name = file.replace(".json", ""),
          row = cloud.get(file);
        if (init?.method === "PUT") {
          const body = JSON.parse(init.body);
          if (row && body.sha !== row.sha)
            return new Response("", { status: 409 });
          const saved = {
            sha: "commit-" + ++commit,
            doc: JSON.parse(
              Buffer.from(body.content, "base64").toString("utf8"),
            ),
          };
          cloud.set(file, saved);
          return Response.json({ content: { sha: saved.sha } });
        }
        const doc = row?.doc || docs[name];
        if (doc)
          return Response.json({
            sha: row?.sha || "fixture-" + name,
            type: "file",
            encoding: "base64",
            content: Buffer.from(JSON.stringify(doc)).toString("base64"),
          });
      }
      if (repo === "culina" && u.includes("recettes"))
        return Response.json(
          JSON.parse(
            fs.readFileSync(path.join(root, "culina/recettes.json"), "utf8"),
          ),
        );
      return new Response("{}", { status: 404 });
    },
    matchMedia: () => ({
      matches: false,
      addEventListener() {},
      addListener() {},
    }),
    scrollTo() {},
    alert() {},
    confirm: () => false,
    ResizeObserver: class {
      observe() {}
      disconnect() {}
    },
    IntersectionObserver: class {
      observe() {}
      disconnect() {}
    },
  });
  for (const [key, value] of Object.entries(local))
    w.localStorage.setItem(key, value);
  w.HTMLCanvasElement.prototype.getContext = () =>
    new Proxy(
      {
        measureText: (t) => ({ width: String(t).length * 8 }),
        createLinearGradient: () => ({ addColorStop() {} }),
        createRadialGradient: () => ({ addColorStop() {} }),
      },
      { get: (o, k) => o[k] || (() => {}) },
    );
  w.CSS = { escape: (s) => String(s).replace(/[^a-zA-Z0-9_-]/g, "_") };
  const adapters = {};
  for (const m of raw.matchAll(/<script\b([^>]*)>([\s\S]*?)<\/script>/gi)) {
    if (/type=["']application\//i.test(m[1])) continue;
    const src = m[1].match(/src=["']([^"']+)/);
    let text = m[2];
    if (src) {
      const clean = src[1].split("?")[0];
      if (/^https?:/.test(clean)) continue;
      const p = path.resolve(root, repo, clean);
      if (!fs.existsSync(p)) continue;
      text = fs.readFileSync(p, "utf8");
    }
    const el = w.document.createElement("script");
    el.textContent = text;
    w.document.head.appendChild(el);
    if (src && src[1].includes("lenaic-sync.js")) {
      const register = w.LenaicSync.register;
      w.LenaicSync.register = (a) => {
        adapters[a.id] = a;
        return register(a);
      };
    }
  }
  await sleep(200);
  return { dom, w, idb, errors, logs, adapters };
}
(async () => {
  const unhandled = [];
  process.on("unhandledRejection", (e) => unhandled.push(e.stack));
  let failed = false;
  for (const [repo, file, id] of targets) {
    let env, reopened, pc;
    try {
      assert.ok(
        fs.existsSync(path.join(root, repo, file)),
        "Le checkout " +
          repo +
          " doit être présent à côté de bureau-genealogique",
      );
      env = await load(repo, file);
      assert.deepEqual(env.errors, []);
      assert.deepEqual(env.logs, []);
      const a = env.adapters[id];
      assert.ok(a, "adaptateur installé");
      let value = copy(a.get());
      const revision = await a.revision?.();
      if (a.consistent)
        assert.ok(a.consistent(value, revision), "révision initiale cohérente");
      if (id === "arboris")
        value.people.push({
          id: "fixture-person",
          firstNames: "Audit",
          lastName: "Test",
          spouseFamilyIds: [],
        });
      if (id === "scriptoria")
        value.people.push({
          id: "fixture-person",
          firstNames: "Audit",
          lastName: "Test",
        });
      if (id === "scriptoria") value.pages.push({id:"fixture-scan",title:"PDF audit",fileName:"test.pdf",mimeType:"application/pdf"});
      if (id === "pistoria")
        value.comparisons.push({
          id: "fixture-comparison",
          title: "Audit Test",
          summary: "fixture",
        });
      if (id === "ariane")
        value.cases.push({
          id: "fixture-case",
          title: "Audit Test",
          items: [],
          status: "À enquêter",
        });
      if (id === "scribe") {
        value.profile.senderName = "Audit Test";
        value.drafts.push({
          id: "fixture-draft",
          title: "Audit Test",
          status: "waiting",
          sentAt: "2026-10-01",
          fields: {},
        });
      }
      if (id === "cap") value.settings.weight = 63.25;
      if (id === "culina") value.data.prefs.auditCheck = true;
      if (id === "3615") value.storage["3615-palette-v1"] = "amber";
      const doc = a.capture
        ? {
            data: value,
            files: [
              {
                id: "fixture-scan",
                blob: "data:application/pdf;base64,JVBERg==",
                thumbnail: null,
                fileName: "test.pdf",
                mimeType: "application/pdf",
              },
            ],
          }
        : value;
      if (a.applyDocument) await a.applyDocument(doc, revision);
      else await a.apply(value, revision);
      if (a.consistent)
        assert.ok(
          a.consistent(a.get(), await a.revision()),
          "révision après import cohérente",
        );
      function check(v) {
        if (id === "arboris" || id === "scriptoria")
          assert.ok(v.people.some((p) => p.id === "fixture-person"));
        if (id === "pistoria")
          assert.ok(v.comparisons.some((p) => p.id === "fixture-comparison"));
        if (id === "ariane")
          assert.ok(v.cases.some((p) => p.id === "fixture-case"));
        if (id === "scribe") assert.equal(v.profile.senderName, "Audit Test");
        if (id === "cap") assert.equal(v.settings.weight, 63.25);
        if (id === "culina") assert.equal(v.data.prefs.auditCheck, true);
        if (id === "3615") assert.equal(v.storage["3615-palette-v1"], "amber");
      }
      check(a.get());
      env.w.confirm = () => true;
      env.w.LenaicSync.setToken("unit-test-token");
      assert.equal((await env.w.LenaicSync.run(a, "push")).action, "push");
      const cloudRow = cloud.get(id + ".json"),
        bad = copy(cloudRow.doc),
        badState = id === "scriptoria" ? bad.data : bad;
      if (id === "arboris") badState.people = {};
      if (id === "scriptoria") badState.records = {};
      if (id === "pistoria") badState.investigations = {};
      if (id === "ariane") badState.cases = {};
      if (id === "scribe") badState.drafts = {};
      if (id === "cap") badState.settings = [];
      if (id === "culina") badState.data.shopping = {};
      if (id === "3615")
        badState.storage = { "3615-palette-v1": { invalid: true } };
      cloud.set(id + ".json", { sha: "malformed-fixture", doc: bad });
      const beforeMalformed = await a.revision();
      await assert.rejects(
        env.w.LenaicSync.run(a, "pull"),
        /Format distant incompatible/,
      );
      assert.equal(
        env.w.LenaicSync.canonical(await a.revision()),
        env.w.LenaicSync.canonical(beforeMalformed),
      );
      if(id === "scriptoria") {
        const partial=copy(cloudRow.doc);partial.files=[];
        cloud.set(id+".json",{sha:"missing-files-fixture",doc:partial});
        await assert.rejects(env.w.LenaicSync.run(a,"pull"),/Pièce jointe manquante/);
        assert.equal(env.w.LenaicSync.canonical(await a.revision()),env.w.LenaicSync.canonical(beforeMalformed));
      }
      cloud.set(id + ".json", cloudRow);
      pc = await load(repo, file);
      pc.w.confirm = () => true;
      pc.w.LenaicSync.setToken("pc-unit-test-token");
      assert.equal(
        (await pc.w.LenaicSync.run(pc.adapters[id], "pull")).action,
        "pull",
      );
      check(pc.adapters[id].get());
      pc.dom.window.close();
      docs[id] = a.capture ? await a.capture(a.get()) : copy(a.get());
      if (id === "scriptoria") {
        assert.equal(docs[id].files.length, 1);
        assert.equal(
          docs[id].files[0].blob,
          "data:application/pdf;base64,JVBERg==",
        );
      }
      if (id === "3615") {
        env.w.localStorage.setItem(
          "3615-github-token",
          "fixture-should-not-export",
        );
        assert.ok(!Object.hasOwn(a.get().storage, "3615-github-token"));
        env.w.LenaicSync.setToken("unit-test-token");
        await env.w.document.querySelector("[data-load]").onclick();
        assert.match(
          env.w.document.querySelector("#lenaicPrivateSources [data-status]")
            .textContent,
          /arboris vérifié/,
        );
        assert.equal(
          env.w.LenaicSync.view("lenaic-scribe-snapshot-v1").counts.awaiting,
          1,
        );
      }
      const local = lsDump(env.w),
        idb = env.idb;
      env.dom.window.close();
      reopened = await load(repo, file, { idb, local });
      assert.deepEqual(reopened.errors, []);
      assert.deepEqual(reopened.logs, []);
      check(reopened.adapters[id].get());
      assert.equal(reopened.w.LenaicSync.hasToken(), false);
      if (id === "scriptoria")
        assert.equal(
          (await reopened.adapters[id].capture(reopened.adapters[id].get()))
            .files.length,
          1,
        );
      if (id === "3615") {
        const text = reopened.w.document.querySelector(
          "#lenaicPrivateSources [data-status]",
        ).textContent;
        assert.match(text, /cache du/);
        assert.match(text, /non revérifié/);
      }
      // A stale primary revision must reject an actual adapter's import.
      const again = reopened.adapters[id],
        old = await again.revision();
      if (["arboris", "scriptoria", "pistoria"].includes(id)) {
        const spec =
          id === "arboris"
            ? ["arboris-state-v1", "state", "current"]
            : id === "scriptoria"
              ? ["scriptoria-files", "backups", "__scriptoria_primary_state__"]
              : ["pistoria-state-v1", "state", "current"];
        const changed = { ...copy(old), payload: old.payload + " " };
        await reopened.w.LenaicSync.replaceRecord(...spec, old, changed);
        if (again.applyDocument)
          await assert.rejects(
            again.applyDocument(docs[id], old),
            /autre onglet/,
          );
        else
          await assert.rejects(
            again.apply(copy(again.get()), old),
            /autre onglet/,
          );
        assert.equal(
          (await reopened.w.LenaicSync.record(...spec)).payload,
          changed.payload,
        );
      } else {
        const key =
          id === "cap"
            ? "cap-data"
            : id === "culina"
              ? "culina-prefs"
              : id === "ariane"
                ? "ariane-local-v2"
                : id === "scribe"
                  ? "scribe-local-v3"
                  : "3615-palette-v1";
        const newer = reopened.w.localStorage.getItem(key) + " ";
        reopened.w.localStorage.setItem(key, newer);
        await assert.rejects(
          again.apply(copy(again.get()), old),
          /autre onglet/,
        );
        assert.equal(reopened.w.localStorage.getItem(key), newer);
      }
      assert.deepEqual(unhandled, []);
      results.push({
        id,
        start: true,
        import: true,
        reopen: true,
        staleRevisionRejected: true,
        phoneToGitHubToPC: true,
        malformedRemoteRejected: true,
      });
    } catch (e) {
      failed = true;
      results.push({ id, error: e.stack });
    } finally {
      env?.dom.window.close();
      reopened?.dom.window.close();
      pc?.dom.window.close();
    }
  }
  for (const [id, dbName, version, stores, primaryStore, primaryId, file] of [
    [
      "arboris",
      "arboris-state-v1",
      1,
      ["state", "backups"],
      "state",
      "current",
      "index.html",
    ],
    [
      "scriptoria",
      "scriptoria-files",
      2,
      ["files", "backups"],
      "backups",
      "__scriptoria_primary_state__",
      "index2.html",
    ],
    [
      "pistoria",
      "pistoria-state-v1",
      1,
      ["state", "backups"],
      "state",
      "current",
      "index3.html",
    ],
  ]) {
    let env;
    try {
      const idb = new IDBFactory();
      await new Promise((resolve, reject) => {
        const req = idb.open(dbName, version);
        req.onupgradeneeded = () => {
          for (const store of stores)
            req.result.createObjectStore(store, { keyPath: "id" });
        };
        req.onsuccess = () => {
          const db = req.result,
            tx = db.transaction(primaryStore, "readwrite");
          tx.objectStore(primaryStore).put({
            id: primaryId,
            payload: "{corrupt-fixture",
          });
          tx.oncomplete = () => {
            db.close();
            resolve();
          };
          tx.onerror = () => reject(tx.error);
        };
        req.onerror = () => reject(req.error);
      });
      env = await load("bureau-genealogique", file, { idb });
      assert.equal(
        (await env.w.LenaicSync.record(dbName, primaryStore, primaryId))
          .payload,
        "{corrupt-fixture",
      );
      assert.ok(!env.adapters[id]);
      assert.ok(
        env.logs.length > 0,
        "erreur de stockage explicitement signalée",
      );
      results.push({
        id: id + "-corrupt",
        primaryUntouched: true,
        editingBlocked: true,
      });
    } catch (e) {
      failed = true;
      results.push({ id: id + "-corrupt", error: e.stack });
    } finally {
      env?.dom.window.close();
    }
  }
  for (const [file,id,key] of [["Ariane.html","ariane","ariane-local-v2"],["Scribe-v3.html","scribe","scribe-local-v3"]]) {
    let env;try {env=await load("aide_archive",file,{local:{[key]:"{bad-fixture"}});assert.equal(env.w.localStorage.getItem(key),"{bad-fixture");assert.ok(!env.adapters[id]);assert.ok(env.errors.length||env.logs.length);results.push({id:id+"-corrupt",primaryUntouched:true,editingBlocked:true})}catch(e){failed=true;results.push({id:id+"-corrupt",error:e.stack})}finally{env?.dom.window.close()}
  }
  for (const [file,id,key,dbName,version,stores,store,primaryId] of [
    ["index.html","arboris","memoire-famille-data","arboris-state-v1",1,["state","backups"],"state","current"],
    ["index2.html","scriptoria","scriptoria-data","scriptoria-files",2,["files","backups"],"backups","__scriptoria_primary_state__"],
    ["index3.html","pistoria","pistoria_private_v3","pistoria-state-v1",1,["state","backups"],"state","current"]
  ]) {
    let env;try{const idb=new IDBFactory(),state=copy(id==="scriptoria"?docs[id].data:docs[id]),serialized=JSON.stringify(state);const legacy=copy(state);legacy.auditDivergence="different despite same date";const raw=JSON.stringify(legacy);
      await new Promise((resolve,reject)=>{const r=idb.open(dbName,version);r.onupgradeneeded=()=>{for(const name of stores)r.result.createObjectStore(name,{keyPath:"id"})};r.onerror=()=>reject(r.error);r.onsuccess=()=>{const db=r.result,tx=db.transaction(store,"readwrite");tx.objectStore(store).put({id:primaryId,payload:serialized});tx.oncomplete=()=>{db.close();resolve()};tx.onerror=()=>reject(tx.error)}});
      env=await load("bureau-genealogique",file,{idb,local:{[key]:raw}});assert.equal((await env.w.LenaicSync.record(dbName,store,primaryId)).payload,serialized);assert.equal(env.w.localStorage.getItem(key),raw);assert.ok(!env.adapters[id]);results.push({id:id+"-local-divergence",bothCopiesUntouched:true,editingBlocked:true});
    }catch(e){failed=true;results.push({id:id+"-local-divergence",error:e.stack})}finally{env?.dom.window.close()}
  }
  console.log(JSON.stringify(results, null, 2));
  process.exitCode = failed ? 1 : 0;
})();
