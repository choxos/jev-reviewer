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
 */
const STORES = ["projects", "studies", "files"];

function openDb() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open("jev-reviewer", 1);
    req.onupgradeneeded = () => {
      const db = req.result;
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

function dbStore(db) {
  const run = (name, mode, fn) => done(fn(db.transaction(name, mode).objectStore(name)));
  return {
    get: (name, id) => run(name, "readonly", (s) => s.get(id)),
    all: (name, index, value) => run(name, "readonly", (s) => (index ? s.index(index).getAll(value) : s.getAll())),
    put: (name, value) => run(name, "readwrite", (s) => s.put(value)),
    del: (name, id) => run(name, "readwrite", (s) => s.delete(id)),
  };
}

function memoryStore() {
  const maps = Object.fromEntries(STORES.map((s) => [s, new Map()]));
  return {
    get: async (name, id) => maps[name].get(id),
    all: async (name, index, value) => [...maps[name].values()].filter((v) => !index || v[index] === value),
    put: async (name, value) => void maps[name].set(value.id, value),
    del: async (name, id) => void maps[name].delete(id),
  };
}

export async function openLibrary() {
  // Browsers only: in Node, an open channel would keep the tests from ending.
  const channel = globalThis.document && typeof BroadcastChannel === "function" ? new BroadcastChannel("jev-reviewer") : null;
  const tell = (kind, id) => channel?.postMessage({ kind, id });
  let store;
  let saved = true;
  try {
    store = dbStore(await openDb());
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
    /** Called with {kind, id} when another tab changes a project or a study. */
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
      await store.del("projects", projectId);
      tell("projects", projectId);
    },
  };
  return lib;
}
