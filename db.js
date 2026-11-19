// IndexedDB 저장소: ideas, clusters, meta(key-value)
const DB_NAME = 'idea-map';
const DB_VER = 2;
let dbp = null;

function open() {
  if (dbp) return dbp;
  dbp = new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VER);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains('ideas')) db.createObjectStore('ideas', { keyPath: 'id' });
      if (!db.objectStoreNames.contains('clusters')) db.createObjectStore('clusters', { keyPath: 'id' });
      if (!db.objectStoreNames.contains('meta')) db.createObjectStore('meta');
      if (!db.objectStoreNames.contains('asks')) db.createObjectStore('asks', { keyPath: 'id' });
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
  return dbp;
}

function wrap(req) {
  return new Promise((resolve, reject) => {
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

async function store(name, mode = 'readonly') {
  const db = await open();
  return db.transaction(name, mode).objectStore(name);
}

export const all = async (name) => wrap((await store(name)).getAll());
export const get = async (name, key) => wrap((await store(name)).get(key));
export const put = async (name, val) => wrap((await store(name, 'readwrite')).put(val));
export const del = async (name, key) => wrap((await store(name, 'readwrite')).delete(key));
export const clear = async (name) => wrap((await store(name, 'readwrite')).clear());

export const getMeta = async (key, fallback = null) => {
  const db = await open();
  const v = await wrap(db.transaction('meta').objectStore('meta').get(key));
  return v === undefined ? fallback : v;
};
export const setMeta = async (key, val) => {
  const db = await open();
  return wrap(db.transaction('meta', 'readwrite').objectStore('meta').put(val, key));
};

export const uid = () => Date.now().toString(36) + Math.random().toString(36).slice(2, 6);

// 아이디어 삭제 시 다른 아이디어들의 연결에서도 제거
export async function deleteIdea(id) {
  await del('ideas', id);
  const ideas = await all('ideas');
  for (const it of ideas) {
    if (it.links?.includes(id)) {
      it.links = it.links.filter((x) => x !== id);
      await put('ideas', it);
    }
  }
  await pruneClusters();
}

// 비어 있는 묶음 정리
export async function pruneClusters() {
  const ideas = await all('ideas');
  const used = new Set(ideas.map((i) => i.clusterId).filter(Boolean));
  for (const c of await all('clusters')) if (!used.has(c.id)) await del('clusters', c.id);
}

export async function exportAll() {
  return {
    app: 'idea-map',
    version: 1,
    exportedAt: new Date().toISOString(),
    ideas: await all('ideas'),
    clusters: await all('clusters'),
    asks: await all('asks'),
  };
}

// 같은 id는 덮어쓰고 나머지는 합침
export async function importAll(data) {
  if (!data || !Array.isArray(data.ideas)) throw new Error('bad file');
  for (const c of data.clusters || []) if (c?.id) await put('clusters', c);
  for (const a of data.asks || []) if (a?.id && a.q) await put('asks', a);
  for (const i of data.ideas) {
    if (!i?.id || typeof i.text !== 'string') continue;
    await put('ideas', {
      links: [],
      status: i.keyword ? 'done' : 'pending',
      ...i,
    });
  }
  return data.ideas.length;
}
