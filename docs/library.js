/**
 * Projects, their studies, the studies' files and answers, kept in this browser (IndexedDB) and
 * never sent anywhere. Where the browser allows no storage (some private windows) the same API
 * keeps everything in memory for the visit, and `saved` is false (`recordsSaved` says the same of
 * the screening's records alone).
 *
 * Other tabs of the site hear of every change (`onChange`), so a study open in two tabs is not
 * saved over with an older copy.
 *
 *   project: {id, name, created, questions?: [{id, query}], questionsName?, backedUp?}
 *   study:   {id, projectId, name, created, updated, letters, asked, current?, source?, ref?,
 *             docs: [{key, name, kind, fileId, fp}], items: [{id, query, result}]}
 *            (ref: the reference a study was imported from: {title, authors, year, journal, doi, pmid})
 *   file:    {id, studyId, name, bytes}
 *   record:  {id, projectId, n, from, title, authors, year, journal, ..., abstract, jev?, decided?}
 *            (a search result being screened by title and abstract; see screen.js)
 *
 * Records live in a database of their own, so adding them needed no upgrade of the first one
 * (an upgrade waits for every other open tab of the site to close).
 */
const STORES = ["projects", "studies", "files", "records"];

function openDb(name = "jev-reviewer") {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(name, 1);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (name !== "jev-reviewer") return void db.createObjectStore("records", { keyPath: "id" }).createIndex("projectId", "projectId");
      db.createObjectStore("projects", { keyPath: "id" });
      db.createObjectStore("studies", { keyPath: "id" }).createIndex("projectId", "projectId");
      db.createObjectStore("files", { keyPath: "id" }).createIndex("studyId", "studyId");
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
    req.onblocked = () => reject(new Error("storage blocked"));
  });
}

const done = (req) =>
  new Promise((resolve, reject) => {
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });

// A value with some of its fields changed; a field given as undefined is removed
const merged = (value, fields) => {
  const out = { ...value, ...fields };
  for (const k of Object.keys(fields)) if (fields[k] === undefined) delete out[k];
  return out;
};

function dbStore(db) {
  const run = (name, mode, fn) => done(fn(db.transaction(name, mode).objectStore(name)));
  const write = (name, fn) =>
    new Promise((resolve, reject) => {
      const tx = db.transaction(name, "readwrite");
      fn(tx.objectStore(name));
      tx.oncomplete = () => resolve();
      tx.onerror = tx.onabort = () => reject(tx.error);
    });
  return {
    get: (name, id) => run(name, "readonly", (s) => s.get(id)),
    all: (name, index, value) => run(name, "readonly", (s) => (index ? s.index(index).getAll(value) : s.getAll())),
    put: (name, value) => run(name, "readwrite", (s) => s.put(value)),
    del: (name, id) => run(name, "readwrite", (s) => s.delete(id)),
    /** Many puts and deletes in one transaction: all of them, or none. */
    many: (name, puts, dels = []) =>
      write(name, (store) => {
        for (const v of puts) store.put(v);
        for (const id of dels) store.delete(id);
      }),
    /** Fields changed in values already kept ([{id, ...fields}]), each read and written in the same transaction; gone ones are left gone. */
    patch: (name, patches) =>
      write(name, (store) => {
        for (const { id, ...fields } of patches) {
          const req = store.get(id);
          req.onsuccess = () => req.result && store.put(merged(req.result, fields));
        }
      }),
  };
}

function memoryStore() {
  const maps = Object.fromEntries(STORES.map((s) => [s, new Map()]));
  return {
    get: async (name, id) => maps[name].get(id),
    all: async (name, index, value) => [...maps[name].values()].filter((v) => !index || v[index] === value),
    put: async (name, value) => void maps[name].set(value.id, value),
    del: async (name, id) => void maps[name].delete(id),
    many: async (name, puts, dels = []) => {
      for (const v of puts) maps[name].set(v.id, v);
      for (const id of dels) maps[name].delete(id);
    },
    patch: async (name, patches) => {
      for (const { id, ...fields } of patches) if (maps[name].has(id)) maps[name].set(id, merged(maps[name].get(id), fields));
    },
  };
}

/** The records in a store of their own, everything else in the main one. */
const byStore = (main, records) => Object.fromEntries(["get", "all", "put", "del", "many", "patch"].map((k) => [k, (name, ...args) => (name === "records" ? records : main)[k](name, ...args)]));

export async function openLibrary() {
  // Browsers only: in Node, an open channel would keep the tests from ending.
  const channel = globalThis.document && typeof BroadcastChannel === "function" ? new BroadcastChannel("jev-reviewer") : null;
  const tell = (kind, id) => channel?.postMessage({ kind, id });
  let store;
  let saved = true;
  let recordsSaved = true;
  try {
    const main = dbStore(await openDb());
    // When only the screening's database will not open, projects and studies are still kept; the
    // records last the visit
    const records = await openDb("jev-reviewer-screening").then(dbStore, () => ((recordsSaved = false), memoryStore()));
    store = byStore(main, records);
  } catch {
    store = memoryStore();
    saved = recordsSaved = false;
  }
  const id = () => crypto.randomUUID?.() ?? `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
  const byCreated = (list) => list.sort((a, b) => a.created - b.created);
  const lib = {
    saved,
    recordsSaved,
    projects: async () => byCreated(await store.all("projects")),
    studies: async (projectId) => byCreated(await store.all("studies", "projectId", projectId)),
    allStudies: () => store.all("studies"),
    project: (projectId) => store.get("projects", projectId),
    study: (studyId) => store.get("studies", studyId),
    file: (fileId) => store.get("files", fileId),
    async save(kind, record) {
      await store.put(kind, record);
      tell(kind, record.id);
    },
    /** A project's search results being screened, in the order they came in. */
    records: async (projectId) => (await store.all("records", "projectId", projectId)).sort((a, b) => a.n - b.n),
    /** Saves records (new or changed), and deletes those with the ids in `gone`, together. */
    async saveRecords(projectId, records, gone = []) {
      await store.many("records", records, gone);
      tell("records", projectId);
    },
    /**
     * Changes some fields of records already kept ([{id, ...fields}], a field given as undefined
     * removed), each read and written at once: what another tab saved in their other fields stays.
     */
    async patchRecords(projectId, patches) {
      await store.patch("records", patches);
      tell("records", projectId);
    },
    /** Called with {kind, id} when another tab changes a project, a study, or a project's records. */
    onChange: (fn) => channel && (channel.onmessage = (ev) => fn(ev.data)),

    async createProject(name) {
      navigator.storage?.persist?.().catch(() => {}); // ask the browser not to clear projects when space runs low
      const project = { id: id(), name, created: Date.now() };
      await store.put("projects", project);
      tell("projects", project.id);
      return project;
    },
    async createStudy(projectId, name, extra = {}) {
      const study = { id: id(), projectId, name, created: Date.now(), updated: Date.now(), letters: 0, asked: 0, docs: [], items: [], ...extra };
      await store.put("studies", study);
      tell("studies", study.id);
      return study;
    },
    async addFile(studyId, name, bytes) {
      const file = { id: id(), studyId, name, bytes };
      await store.put("files", file);
      return file.id;
    },
    deleteFile: (fileId) => store.del("files", fileId),
    async deleteStudy(studyId) {
      for (const f of await store.all("files", "studyId", studyId)) await store.del("files", f.id);
      await store.del("studies", studyId);
      tell("studies", studyId);
    },
    async deleteProject(projectId) {
      for (const s of await store.all("studies", "projectId", projectId)) await lib.deleteStudy(s.id);
      await store.many("records", [], (await store.all("records", "projectId", projectId)).map((r) => r.id));
      await store.del("projects", projectId);
      tell("projects", projectId);
    },
  };
  return lib;
}
