const $ = (s) => document.querySelector(s);
const statusEl = $('#status'), list = $('#list'), followBtn = $('#follow'), grantBtn = $('#grant');
let vault = null, videoId = null, tabId = null, segments = [], active = -1, follow = true;

// FileSystemDirectoryHandle は IndexedDB に保存できるので、Vault の選択を次回以降も使い回す
const db = new Promise((resolve) => {
  const req = indexedDB.open('transcript-follow', 1);
  req.onupgradeneeded = () => req.result.createObjectStore('kv');
  req.onsuccess = () => resolve(req.result);
});
async function idb(key, value) {
  const store = (await db).transaction('kv', value === undefined ? 'readonly' : 'readwrite').objectStore('kv');
  return new Promise((resolve) => {
    const req = value === undefined ? store.get(key) : store.put(value, key);
    req.onsuccess = () => resolve(req.result);
  });
}

function parse(md) {
  const start = md.indexOf('\n## Transcript');
  const items = [];
  let seg = null;
  for (const raw of md.slice(Math.max(0, start)).split('\n')) {
    const line = raw.trim().replace(/\\([\\`*_{}[\]()#+\-.!|])/g, '$1');
    const ts = line.match(/^\*\*((?:\d+:)?\d+:\d{2})\*\*$/);
    if (ts) {
      seg = { label: ts[1], time: ts[1].split(':').reduce((a, n) => a * 60 + Number(n), 0), lines: [] };
      items.push(seg);
    } else if (line.startsWith('### ')) {
      items.push({ heading: line.slice(4) });
      seg = null;
    } else if (line && seg) {
      seg.lines.push(line);
    }
  }
  return items;
}

async function findNote(dir, id) {
  for await (const entry of dir.values()) {
    if (entry.name.startsWith('.')) continue;
    if (entry.kind === 'directory') {
      const found = await findNote(entry, id);
      if (found) return found;
    } else if (entry.name.endsWith('.md')) {
      const file = await entry.getFile();
      const head = await file.slice(0, 2000).text();
      if (new RegExp(`^source:.*${id}`, 'm').test(head)) return file;
    }
  }
}

function render(items) {
  segments = [];
  active = -1;
  list.replaceChildren(...items.map((item) => {
    if (item.heading) {
      const h = document.createElement('h3');
      h.textContent = item.heading;
      return h;
    }
    const el = document.createElement('div');
    el.className = 'seg';
    const time = document.createElement('span');
    time.className = 'time';
    time.textContent = item.label;
    el.append(time, ...item.lines.map((text) => {
      const p = document.createElement('p');
      p.textContent = text;
      if (!/[぀-ヿ一-鿿]/.test(text)) p.className = 'en';
      return p;
    }));
    el.onclick = () => {
      chrome.tabs.sendMessage(tabId, { type: 'seek', time: item.time });
      setFollow(true);
    };
    segments.push({ time: item.time, el });
    return el;
  }));
}

async function load() {
  list.replaceChildren();
  if (!videoId) return;
  if (!vault) {
    statusEl.textContent = 'Vault を選択してください';
    return;
  }
  const id = videoId;
  statusEl.textContent = 'ノートを検索中…';
  const file = await findNote(vault, id);
  if (id !== videoId) return;
  if (!file) {
    statusEl.textContent = `source が ${id} のノートが見つかりません`;
    return;
  }
  render(parse(await file.text()));
  statusEl.textContent = file.name;
}

function highlight(t) {
  const i = segments.findLastIndex((s) => s.time <= t);
  if (i === active) return;
  segments[active]?.el.classList.remove('active');
  active = i;
  if (i < 0) return;
  segments[i].el.classList.add('active');
  if (follow) segments[i].el.scrollIntoView({ block: 'center', behavior: 'smooth' });
}

// 手でスクロールしたら追従を止め、ボタンで戻せるようにする
function setFollow(on) {
  follow = on;
  followBtn.hidden = on;
  if (on) segments[active]?.el.scrollIntoView({ block: 'center', behavior: 'smooth' });
}
addEventListener('wheel', () => setFollow(false));
followBtn.onclick = () => setFollow(true);

async function useVault(handle) {
  vault = handle;
  grantBtn.hidden = true;
  await idb('vault', handle);
  load();
}

$('#pick').onclick = async () => useVault(await showDirectoryPicker());

grantBtn.onclick = async () => {
  const handle = await idb('vault');
  if (await handle.requestPermission({ mode: 'read' }) === 'granted') useVault(handle);
};

chrome.runtime.onMessage.addListener((msg, sender) => {
  if (msg.type !== 'time') return;
  tabId = sender.tab.id;
  if (msg.videoId !== videoId) {
    videoId = msg.videoId;
    load();
  }
  highlight(msg.time);
});

(async () => {
  const handle = await idb('vault');
  if (!handle) return;
  if (await handle.queryPermission({ mode: 'read' }) === 'granted') return useVault(handle);
  grantBtn.textContent = `「${handle.name}」に再接続`;
  grantBtn.hidden = false;
})();
