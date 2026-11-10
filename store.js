// 자료 계층 — 결과 파일을 받아 기기에 보관한다. (quorum 모바일의 store.js를 따른다)
//
// 결과는 비공개 저장소 holdings-daily-data 의 main 에 있다. 폰은 한 번 넣어 둔 읽기 전용
// 토큰으로 GitHub API 에서 직접 받는다(중간 서버 없음). 받은 파일은 IndexedDB 에 두어
// 통신이 안 될 때도 마지막 결과를 볼 수 있다.
(function (root) {
  'use strict';

  const REPO = 'perseus2133-ai/holdings-daily-data';
  const BRANCH = 'main';
  const API = `https://api.github.com/repos/${REPO}/contents/`;
  const KEY = { token: 'holdings.token' };
  const DB_NAME = 'holdings-daily', DB_STORE = 'files';

  // 개발 PC 에서 `python -m http.server` 로 띄우면 토큰 없이 app_out/ 을 읽는다.
  const DEV = location.protocol === 'http:' && /^(localhost|127\.0\.0\.1)$/.test(location.hostname);

  const ls = {
    get(k, fallback) {
      try {
        const v = localStorage.getItem(k);
        return v == null ? fallback : JSON.parse(v);
      } catch (e) { return fallback; }
    },
    set(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch (e) { /* 저장 불가 */ } },
    del(k) { try { localStorage.removeItem(k); } catch (e) { /* 무시 */ } },
  };

  const token = {
    get: () => ls.get(KEY.token, ''),
    set: (t) => ls.set(KEY.token, String(t || '').trim()),
    clear: () => ls.del(KEY.token),
  };

  // ── IndexedDB ───────────────────────────────────────────────
  function openDb() {
    return new Promise((resolve, reject) => {
      const req = indexedDB.open(DB_NAME, 1);
      req.onupgradeneeded = () => req.result.createObjectStore(DB_STORE);
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
  }
  async function dbGet(name) {
    try {
      const db = await openDb();
      return await new Promise((resolve, reject) => {
        const r = db.transaction(DB_STORE).objectStore(DB_STORE).get(name);
        r.onsuccess = () => resolve(r.result);
        r.onerror = () => reject(r.error);
      });
    } catch (e) { return undefined; }
  }
  async function dbPut(name, value) {
    try {
      const db = await openDb();
      await new Promise((resolve, reject) => {
        const tx = db.transaction(DB_STORE, 'readwrite');
        tx.objectStore(DB_STORE).put(value, name);
        tx.oncomplete = () => resolve();
        tx.onerror = () => reject(tx.error);
      });
    } catch (e) { /* 보관 실패는 화면 표시를 막지 않는다 */ }
  }
  async function dbClear() {
    const db = await openDb();
    return new Promise((resolve, reject) => {
      const tx = db.transaction(DB_STORE, 'readwrite');
      tx.objectStore(DB_STORE).clear();
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
    });
  }

  // ── 네트워크 ────────────────────────────────────────────────
  function fail(kind, status) {
    const e = new Error(kind);
    e.kind = kind;            // auth | notfound | limited | http | network
    e.status = status || 0;
    return e;
  }

  async function fetchFile(name) {
    let res;
    try {
      if (DEV && !token.get()) {
        res = await fetch(`../../app_out/${name}`, { cache: 'no-store' });
      } else {
        res = await fetch(`${API}${name}?ref=${BRANCH}`, {
          cache: 'no-store',
          headers: {
            Accept: 'application/vnd.github.raw+json',
            Authorization: `Bearer ${token.get()}`,
            'X-GitHub-Api-Version': '2022-11-28',
          },
        });
      }
    } catch (e) {
      throw fail('network');
    }
    if (res.status === 401) throw fail('auth', 401);
    // 비공개 저장소는 권한이 없어도 404 를 준다 — 토큰 범위가 틀린 경우가 대부분이다
    if (res.status === 404) throw fail('notfound', 404);
    if (res.status === 403 || res.status === 429) throw fail('limited', res.status);
    if (!res.ok) throw fail('http', res.status);
    return res.json();
  }

  // 기기에 보관된 목록·이력. 없으면 null.
  async function loadCached() {
    const index = await dbGet('index.json');
    const history = await dbGet('history.json');
    return index && history ? { index, history } : null;
  }

  // 목록을 받아 바뀌었으면 이력도 받는다. 반환: {changed, data}
  async function refresh(currentGenerated, force) {
    const index = await fetchFile('index.json');
    if (!force && currentGenerated && index.generated === currentGenerated) {
      return { changed: false, data: null };
    }
    const history = await fetchFile('history.json');
    await dbPut('index.json', index);
    await dbPut('history.json', history);
    return { changed: true, data: { index, history } };
  }

  // 그날 파일. 기기에 있고 목록의 생성 시각과 같으면 받지 않는다.
  async function day(on, generated) {
    const name = `days/${on}.json`;
    const cached = await dbGet(name);
    if (cached && (!generated || cached.generated === generated)) return cached;
    try {
      const fresh = await fetchFile(name);
      await dbPut(name, fresh);
      return fresh;
    } catch (e) {
      if (cached) return cached;      // 오프라인이면 예전 것이라도 보여 준다
      throw e;
    }
  }

  root.Store = {
    REPO, DEV, KEY, ls, token,
    needsToken: () => !token.get() && !DEV,
    loadCached, refresh, day, clearCache: dbClear,
  };
})(self);
