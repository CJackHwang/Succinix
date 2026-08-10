// IndexedDB 封装（O4）：原生 API + 轻量 promise 包装（不新增依赖）。每个持久化上下文
// 持有独立 dbPromise（多实例共享会互相污染重试状态）。

export function makeIdb(dbName: string, storeName: string) {
  let dbPromise: Promise<IDBDatabase> | null = null;

  function getDB(): Promise<IDBDatabase> {
    if (!dbPromise) {
      dbPromise = new Promise<IDBDatabase>((resolve, reject) => {
        const req = indexedDB.open(dbName, 1);
        req.onupgradeneeded = () => {
          if (!req.result.objectStoreNames.contains(storeName)) req.result.createObjectStore(storeName);
        };
        req.onsuccess = () => resolve(req.result);
        req.onerror = () => {
          dbPromise = null; // 失败后允许下次调用重试打开
          reject(req.error ?? new Error('indexeddb open failed'));
        };
      });
    }
    return dbPromise;
  }

  // 通用事务封装：fn 里发起一个请求，事务提交时 resolve 该请求的结果。
  function idbReq<T>(mode: IDBTransactionMode, fn: (store: IDBObjectStore) => IDBRequest<T>): Promise<T> {
    return getDB().then(
      (db) =>
        new Promise<T>((resolve, reject) => {
          const txn = db.transaction(storeName, mode);
          const req = fn(txn.objectStore(storeName));
          txn.oncomplete = () => resolve(req.result);
          txn.onerror = () => reject(txn.error ?? new Error('indexeddb transaction error'));
          txn.onabort = () => reject(txn.error ?? new Error('indexeddb transaction aborted'));
        })
    );
  }

  return { getDB, idbReq };
}
