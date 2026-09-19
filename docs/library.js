/**
 * Projects, their studies, the studies' files and answers, kept in this browser (IndexedDB) and
 * never sent anywhere. Where the browser allows no storage (some private windows) the same API
 * keeps everything in memory for the visit, and `saved` is false.
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

function dbStore(db, records = db) {
  const on = (name) => (name === "records" ? records : db);
  const run = (name, mode, fn) => done(fn(on(name).transaction(name, mode).objectStore(name)));
  return {
    get: (name, id) => run(name, "readonly", (s) => s.get(id)),
    all: (name, index, value) => run(name, "readonly", (s) => (index ? s.index(index).getAll(value) : s.getAll())),
    put: (name, value) => run(name, "readwrite", (s) => s.put(value)),
    del: (name, id) => run(name, "readwrite", (s) => s.delete(id)),
    /** Many puts and deletes in one transaction: all of them, or none. */
    many: (name, puts, dels = []) =>
      new Promise((resolve, reject) => {
        const tx = on(name).transaction(name, "readwrite");
        const store = tx.objectStore(name);
        for (const v of puts) store.put(v);
        for (const id of dels) store.delete(id);
        tx.oncomplete = () => resolve();
        tx.onerror = tx.onabort = () => reject(tx.error);
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
  };
}

export async function openLibrary() {
  // Browsers only: in Node, an open channel would keep the tests from ending.
  const channel = globalThis.document && typeof BroadcastChannel === "function" ? new BroadcastChannel("jev-reviewer") : null;
  const tell = (kind, id) => channel?.postMessage({ kind, id });
  let store;
  let saved = true;
  try {
    store = dbStore(await openDb(), await openDb("jev-reviewer-screening"));
  } catch {
    store = memoryStore();
    saved = false;
  }
  const id = () => crypto.randomUUID?.() ?? `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
  const byCreated = (list) => list.sort((a, b) => a.created - b.created);
  const lib = {
    saved,
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
