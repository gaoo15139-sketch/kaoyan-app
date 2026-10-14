/* 本地持久化层。
 *
 * 浏览器使用 IndexedDB；Node 单元测试使用内存实现。
 * repo.js 只依赖下面这个小接口，因此业务逻辑可以脱离浏览器直接测试。
 */

export const SCHEMA = {
  subjects: { keyPath: 'id', indexes: [['name', 'name', { unique: true }]] },
  chapters: {
    keyPath: 'id',
    indexes: [['subject_id', 'subject_id'], ['parent_id', 'parent_id']]
  },
  material_types: { keyPath: 'id', indexes: [['subject_id', 'subject_id']] },
  tags: { keyPath: 'id', indexes: [['name', 'name', { unique: true }]] },
  sources: { keyPath: 'id', indexes: [['name', 'name', { unique: true }]] },
  materials: {
    keyPath: 'id',
    indexes: [
      ['updated_at', 'updated_at'],
      ['status', 'status'],
      ['processing_status', 'processing_status'],
      ['idempotency_key', 'idempotency_key', { unique: true }]
    ]
  },
  material_raw: { keyPath: 'id', indexes: [['material_id', 'material_id'], ['content_hash', 'content_hash']] },
  ai_analyses: { keyPath: 'id', indexes: [['material_id', 'material_id']] },
  proposals: { keyPath: 'id', indexes: [['material_id', 'material_id'], ['status', 'status']] },
  material_classification: { keyPath: 'material_id', indexes: [['subject_id', 'subject_id']] },
  material_tags: { keyPath: 'id', indexes: [['material_id', 'material_id'], ['tag_id', 'tag_id']] },
  material_reviews: { keyPath: 'id', indexes: [['material_id', 'material_id']] },
  search_index: { keyPath: 'material_id', indexes: [] },
  audit_log: { keyPath: 'id', autoIncrement: true, indexes: [['entity_id', 'entity_id']] },
  settings: { keyPath: 'key', indexes: [] },
  knowledge_nodes: { keyPath: 'id', indexes: [] },
  material_knowledge_links: { keyPath: 'id', indexes: [['material_id', 'material_id']] }
};

export const STORE_NAMES = Object.keys(SCHEMA);

function clone(value) {
  return value === undefined ? undefined : structuredClone(value);
}

/* ------------------------------------------------------------------ 内存实现 */

export function createMemoryDriver() {
  const tables = {};
  STORE_NAMES.forEach(function (name) { tables[name] = new Map(); });
  let autoId = 1;

  function indexValue(record, keyPath) {
    return keyPath.split('.').reduce(function (acc, part) {
      return acc === undefined || acc === null ? undefined : acc[part];
    }, record);
  }

  return {
    kind: 'memory',
    async open() {},
    async get(store, key) { return clone(tables[store].get(key)); },
    async getAll(store) { return Array.from(tables[store].values()).map(clone); },
    async put(store, value) {
      const keyPath = SCHEMA[store].keyPath;
      let record = clone(value);
      if (SCHEMA[store].autoIncrement && record[keyPath] === undefined) record[keyPath] = autoId;
      autoId += 1;
      const key = record[keyPath];
      (SCHEMA[store].indexes || []).forEach(function (index) {
        if (!index[2] || !index[2].unique) return;
        const target = indexValue(record, index[1]);
        if (target === undefined || target === null) return;
        tables[store].forEach(function (existing, existingKey) {
          if (existingKey !== key && indexValue(existing, index[1]) === target) {
            const error = new Error('唯一约束冲突：' + store + '.' + index[0]);
            error.name = 'ConstraintError';
            throw error;
          }
        });
      });
      tables[store].set(key, record);
      return key;
    },
    async putMany(store, values) {
      for (let i = 0; i < values.length; i += 1) await this.put(store, values[i]);
    },
    async delete(store, key) { tables[store].delete(key); },
    async clear(store) { tables[store].clear(); },
    async getByIndex(store, indexName, value) {
      const index = (SCHEMA[store].indexes || []).find(function (item) { return item[0] === indexName; });
      if (!index) return [];
      return Array.from(tables[store].values())
        .filter(function (record) { return indexValue(record, index[1]) === value; })
        .map(clone);
    },
    async replaceAll(dump) {
      STORE_NAMES.forEach(function (name) { tables[name].clear(); });
      for (let i = 0; i < STORE_NAMES.length; i += 1) {
        const name = STORE_NAMES[i];
        const rows = dump[name] || [];
        for (let j = 0; j < rows.length; j += 1) await this.put(name, rows[j]);
      }
    },
    async count(store) { return tables[store].size; }
  };
}

/* ------------------------------------------------------------- IndexedDB 实现 */

export function createIdbDriver(dbName) {
  let db = null;

  function run(store, mode, action) {
    return new Promise(function (resolve, reject) {
      const tx = db.transaction(store, mode);
      const request = action(tx.objectStore(store));
      tx.onerror = function () { reject(tx.error); };
      if (request) {
        request.onsuccess = function () { resolve(request.result); };
        request.onerror = function () { reject(request.error); };
      } else {
        tx.oncomplete = function () { resolve(undefined); };
      }
    });
  }

  return {
    kind: 'indexeddb',
    async open() {
      db = await new Promise(function (resolve, reject) {
        const request = indexedDB.open(dbName, 1);
        request.onupgradeneeded = function () {
          const database = request.result;
          STORE_NAMES.forEach(function (name) {
            if (database.objectStoreNames.contains(name)) return;
            const def = SCHEMA[name];
            const objectStore = database.createObjectStore(name, {
              keyPath: def.keyPath,
              autoIncrement: !!def.autoIncrement
            });
            (def.indexes || []).forEach(function (index) {
              objectStore.createIndex(index[0], index[1], index[2] || {});
            });
          });
        };
        request.onsuccess = function () { resolve(request.result); };
        request.onerror = function () { reject(request.error); };
        request.onblocked = function () { reject(new Error('数据库被其它标签页占用，请关闭其它窗口后重试')); };
      });
      return db;
    },
    async get(store, key) { return run(store, 'readonly', function (os) { return os.get(key); }); },
    async getAll(store) { return run(store, 'readonly', function (os) { return os.getAll(); }); },
    async put(store, value) { return run(store, 'readwrite', function (os) { return os.put(value); }); },
    async putMany(store, values) {
      return new Promise(function (resolve, reject) {
        const tx = db.transaction(store, 'readwrite');
        const os = tx.objectStore(store);
        values.forEach(function (value) { os.put(value); });
        tx.oncomplete = function () { resolve(undefined); };
        tx.onerror = function () { reject(tx.error); };
      });
    },
    async delete(store, key) { return run(store, 'readwrite', function (os) { return os.delete(key); }); },
    async clear(store) { return run(store, 'readwrite', function (os) { return os.clear(); }); },
    async getByIndex(store, indexName, value) {
      return run(store, 'readonly', function (os) { return os.index(indexName).getAll(value); });
    },
    async replaceAll(dump) {
      return new Promise(function (resolve, reject) {
        const tx = db.transaction(STORE_NAMES, 'readwrite');
        STORE_NAMES.forEach(function (name) {
          tx.objectStore(name).clear();
        });
        STORE_NAMES.forEach(function (name) {
          const rows = dump[name] || [];
          const os = tx.objectStore(name);
          rows.forEach(function (row) { os.put(row); });
        });
        tx.oncomplete = function () { resolve(undefined); };
        tx.onerror = function () { reject(tx.error); };
      });
    },
    async count(store) { return run(store, 'readonly', function (os) { return os.count(); }); }
  };
}

export async function openDatabase(dbName) {
  const driver = (typeof indexedDB === 'undefined') ? createMemoryDriver() : createIdbDriver(dbName || 'kaoyan-archive');
  await driver.open();
  return driver;
}
