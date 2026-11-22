const JA_RE = /[\u3040-\u30ff\u4e00-\u9fff]/;
const ALIGN_MODES = ['ruby', 'active', 'off'];
const ALIGN_LABELS = { ruby: 'ルビ: 常時', active: 'ルビ: 再生中', off: 'ルビ: OFF' };
const textEncoder = new TextEncoder();

// Python 側 (generate_alignments.py) と同一の FNV-1a 32bit ハッシュ
function hashSegment(ja, en) {
  let h = 0x811c9dc5;
  for (const b of textEncoder.encode(`${ja}\n${en}`)) {
    h ^= b;
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h.toString(16).padStart(8, '0');
}

function normalizeKey(pair) {
  const raw = typeof pair?.lemma === 'string' && pair.lemma.trim() ? pair.lemma : pair?.en || '';
  return raw.trim().toLowerCase();
}

function parseKnownWords(raw) {
  try {
    const data = JSON.parse(raw);
    const list = Array.isArray(data) ? data : Array.isArray(data?.words) ? data.words : null;
    if (!list) return null;
    const out = new Set();
    for (const item of list) {
      if (typeof item === 'string' && item.trim()) out.add(item.trim().toLowerCase());
    }
    return out;
  } catch {
    return null;
  }
}

function serializeKnownWords(words) {
  return `${JSON.stringify({ version: 1, words: [...words].sort() }, null, 2)}\n`;
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

function findAllOccurrences(text, sub) {
  if (!sub) return [];
  const out = [];
  let start = 0;
  while (true) {
    const idx = text.indexOf(sub, start);
    if (idx < 0) break;
    out.push([idx, idx + sub.length]);
    start = idx + 1;
  }
  return out;
}

function overlaps(start, end, used) {
  return used.some((u) => !(end <= u.start || start >= u.end));
}

function resolvePairSpans(jaText, enText, pairs) {
  const jaSpans = [];
  const enSpans = [];
  if (!Array.isArray(pairs) || !pairs.length) return { jaSpans, enSpans };

  let pairId = 0;
  for (const pair of pairs) {
    if (!pair || typeof pair.en !== 'string' || typeof pair.ja !== 'string') continue;
    const enOccs = findAllOccurrences(enText, pair.en);
    const jaOccs = findAllOccurrences(jaText, pair.ja);
    const enIdx = Number.isInteger(pair.eo) ? pair.eo : 0;
    const jaIdx = Number.isInteger(pair.jo) ? pair.jo : 0;
    if (enIdx < 0 || enIdx >= enOccs.length || jaIdx < 0 || jaIdx >= jaOccs.length) continue;

    const [es, ee] = enOccs[enIdx];
    const [js, je] = jaOccs[jaIdx];
    if (overlaps(es, ee, enSpans) || overlaps(js, je, jaSpans)) continue;

    const key = normalizeKey(pair);
    enSpans.push({ start: es, end: ee, pairId, key, en: pair.en });
    jaSpans.push({ start: js, end: je, pairId, key, en: pair.en });
    pairId++;
  }

  enSpans.sort((a, b) => a.start - b.start);
  jaSpans.sort((a, b) => a.start - b.start);
  return { jaSpans, enSpans };
}

function sliceLineSpans(spans, lineStart, lineEnd) {
  const out = [];
  for (const span of spans) {
    if (span.end <= lineStart) continue;
    if (span.start >= lineEnd) break;
    out.push({
      start: Math.max(span.start, lineStart) - lineStart,
      end: Math.min(span.end, lineEnd) - lineStart,
      pairId: span.pairId,
      key: span.key,
      en: span.en,
    });
  }
  return out;
}

if (typeof document !== 'undefined') {
  const $ = (s) => document.querySelector(s);
  const statusEl = $('#status'), list = $('#list'), followBtn = $('#follow'), grantBtn = $('#grant');
  const alignBtn = $('#align'), knownBtn = $('#known-btn'), knownPanel = $('#known-panel');
  const knownList = $('#known-list'), knownClear = $('#known-clear');
  const toastEl = $('#toast'), toastMsg = $('#toast-msg'), undoBtn = $('#undo');

  let vault = null, videoId = null, tabId = null, segments = [], active = -1, follow = true, lastTime = null;
  let hoveredSeg = null, hoveredPair = null, alignMode = 'ruby';
  let knownWords = new Set(), lastMarked = null, toastTimer = null, writeChain = Promise.resolve();

  // FileSystemDirectoryHandle と既知語フォールバックは IndexedDB に保存する
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

  function clearHover() {
    if (!hoveredSeg) return;
    for (const el of hoveredSeg.querySelectorAll('.match')) el.classList.remove('match');
    hoveredSeg = null;
    hoveredPair = null;
  }

  function setHover(seg, pairId) {
    if (hoveredSeg === seg && hoveredPair === pairId) return;
    clearHover();
    hoveredSeg = seg;
    hoveredPair = pairId;
    for (const el of seg.querySelectorAll(`[data-pair="${pairId}"]`)) {
      if (!el.classList.contains('known')) el.classList.add('match');
    }
  }

  function setAlignMode(mode) {
    alignMode = ALIGN_MODES.includes(mode) ? mode : 'ruby';
    document.body.dataset.align = alignMode;
    alignBtn.textContent = ALIGN_LABELS[alignMode];
    if (alignMode === 'off') clearHover();
    try { localStorage.setItem('alignMode', alignMode); } catch {}
  }

  try { setAlignMode(localStorage.getItem('alignMode') || 'ruby'); } catch { setAlignMode('ruby'); }

  alignBtn.onclick = () => {
    const next = ALIGN_MODES[(ALIGN_MODES.indexOf(alignMode) + 1) % ALIGN_MODES.length];
    setAlignMode(next);
  };

  function syncKnownDom() {
    for (const el of list.querySelectorAll('.vocab, .tok')) {
      el.classList.toggle('known', knownWords.has(el.dataset.key));
    }
    for (const p of list.querySelectorAll('.seg p:not(.en)')) {
      p.classList.toggle('has-ruby', Boolean(p.querySelector('ruby.vocab:not(.known)')));
    }
  }

  function renderKnownPanel() {
    const words = [...knownWords].sort();
    knownBtn.hidden = words.length === 0;
    knownBtn.textContent = `既知(${words.length})`;
    if (words.length === 0) {
      knownPanel.hidden = true;
      knownList.replaceChildren();
      return;
    }
    knownList.replaceChildren(...words.map((w) => {
      const chip = document.createElement('button');
      chip.className = 'chip';
      chip.type = 'button';
      chip.textContent = `${w} ×`;
      chip.title = `「${w}」のルビを再表示`;
      chip.onclick = () => unmarkKnown(w);
      return chip;
    }));
  }

  async function loadKnownFromVault(dir) {
    try {
      const alignDir = await dir.getDirectoryHandle('.yt-transcript-follow');
      const fileHandle = await alignDir.getFileHandle('known-words.json');
      return parseKnownWords(await (await fileHandle.getFile()).text());
    } catch {
      return null;
    }
  }

  async function ensureWritePermission(dir) {
    if (!dir) return false;
    if (await dir.queryPermission({ mode: 'readwrite' }) === 'granted') return true;
    try {
      return (await dir.requestPermission({ mode: 'readwrite' })) === 'granted';
    } catch {
      return false;
    }
  }

  function enqueueVaultKnownWrite(dir, payload) {
    const run = async () => {
      const alignDir = await dir.getDirectoryHandle('.yt-transcript-follow', { create: true });
      const fileHandle = await alignDir.getFileHandle('known-words.json', { create: true });
      const writable = await fileHandle.createWritable();
      await writable.write(payload);
      await writable.close();
      return true;
    };
    const next = writeChain.then(run, run);
    writeChain = next.catch(() => false);
    return next.catch(() => false);
  }

  async function persistKnown() {
    renderKnownPanel();
    const sorted = [...knownWords].sort();
    const payload = serializeKnownWords(knownWords);
    const writable = await ensureWritePermission(vault);
    await idb('knownWords', sorted);
    if (!writable) return false;
    return enqueueVaultKnownWrite(vault, payload);
  }

  function showToast(key, savedToVault) {
    lastMarked = key;
    toastMsg.textContent = savedToVault
      ? `「${key}」を覚えた登録`
      : `「${key}」を覚えた登録（ブラウザのみ）`;
    toastEl.hidden = false;
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => { toastEl.hidden = true; }, 5000);
  }

  async function markKnown(key) {
    if (!key || knownWords.has(key)) return;
    knownWords.add(key);
    clearHover();
    syncKnownDom();
    const savedToVault = await persistKnown();
    showToast(key, savedToVault);
  }

  async function unmarkKnown(key) {
    if (!knownWords.delete(key)) return;
    syncKnownDom();
    await persistKnown();
  }

  knownBtn.onclick = () => { knownPanel.hidden = !knownPanel.hidden; };
  knownClear.onclick = async () => {
    knownWords.clear();
    toastEl.hidden = true;
    syncKnownDom();
    await persistKnown();
  };
  undoBtn.onclick = () => {
    if (lastMarked) unmarkKnown(lastMarked);
    lastMarked = null;
    toastEl.hidden = true;
  };

  list.addEventListener('pointerover', (e) => {
    if (alignMode === 'off') return;
    const hit = e.target.closest?.('.vocab, .tok');
    if (!hit || hit.classList.contains('known')) return;
    const seg = hit.closest('.seg');
    if (seg) setHover(seg, hit.dataset.pair);
  });
  list.addEventListener('pointerout', (e) => {
    const hit = e.target.closest?.('.vocab, .tok');
    if (!hit) return;
    const next = e.relatedTarget?.closest?.('.vocab, .tok');
    if (next && next.closest('.seg') === hoveredSeg && next.dataset.pair === hoveredPair) return;
    clearHover();
  });
  list.addEventListener('pointerleave', clearHover);

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

  async function loadAlignment(dir, id) {
    try {
      const alignDir = await dir.getDirectoryHandle('.yt-transcript-follow');
      const fileHandle = await alignDir.getFileHandle(`${id}.json`);
      const data = JSON.parse(await (await fileHandle.getFile()).text());
      return data?.segments && typeof data.segments === 'object' ? data : null;
    } catch {
      return null;
    }
  }

  function appendJaRuby(p, text, spans) {
    if (!spans.length) {
      p.textContent = text;
      return;
    }
    let cursor = 0;
    let visibleRuby = false;
    for (const s of spans) {
      if (s.start > cursor) p.append(text.slice(cursor, s.start));
      const jaSpanText = text.slice(s.start, s.end);
      const ruby = document.createElement('ruby');
      ruby.className = jaSpanText.length <= 10 ? 'vocab nowrap' : 'vocab';
      ruby.dataset.pair = String(s.pairId);
      ruby.dataset.key = s.key;
      const isKnown = knownWords.has(s.key);
      if (isKnown) ruby.classList.add('known');
      else visibleRuby = true;
      ruby.append(jaSpanText);
      const rt = document.createElement('rt');
      rt.textContent = s.en;
      rt.title = `クリックで「${s.key}」を覚えた登録（Vault に保存・以降の動画でも非表示）`;
      ruby.append(rt);
      p.append(ruby);
      cursor = s.end;
    }
    if (cursor < text.length) p.append(text.slice(cursor));
    if (visibleRuby) p.classList.add('has-ruby');
  }

  function appendEnTokens(p, text, spans) {
    if (!spans.length) {
      p.textContent = text;
      return;
    }
    let cursor = 0;
    for (const s of spans) {
      if (s.start > cursor) p.append(text.slice(cursor, s.start));
      const tok = document.createElement('span');
      tok.className = 'tok';
      tok.dataset.pair = String(s.pairId);
      tok.dataset.key = s.key;
      if (knownWords.has(s.key)) tok.classList.add('known');
      tok.textContent = text.slice(s.start, s.end);
      p.append(tok);
      cursor = s.end;
    }
    if (cursor < text.length) p.append(text.slice(cursor));
  }

  function render(items, alignment) {
    clearHover();
    segments = [];
    active = -1;
    let alignedCount = 0;
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

      let jaOffset = 0, enOffset = 0;
      const lineEntries = item.lines.map((text) => {
        const isJa = JA_RE.test(text);
        if (isJa) {
          const start = jaOffset;
          jaOffset += text.length + 1;
          return { text, isJa, start, end: start + text.length };
        }
        const start = enOffset;
        enOffset += text.length + 1;
        return { text, isJa, start, end: start + text.length };
      });

      const jaLines = lineEntries.filter((l) => l.isJa).map((l) => l.text);
      const enLines = lineEntries.filter((l) => !l.isJa).map((l) => l.text);
      let jaSpans = [], enSpans = [];
      if (alignment && jaLines.length && enLines.length) {
        const jaText = jaLines.join('\n');
        const enText = enLines.join('\n');
        const segAlign = alignment.segments[hashSegment(jaText, enText)];
        if (segAlign?.pairs?.length) {
          ({ jaSpans, enSpans } = resolvePairSpans(jaText, enText, segAlign.pairs));
          if (jaSpans.length) alignedCount++;
        }
      }

      el.append(time, ...lineEntries.map((line) => {
        const p = document.createElement('p');
        if (line.isJa) {
          appendJaRuby(p, line.text, sliceLineSpans(jaSpans, line.start, line.end));
        } else {
          p.className = 'en';
          appendEnTokens(p, line.text, sliceLineSpans(enSpans, line.start, line.end));
        }
        return p;
      }));

      el.onclick = (e) => {
        const rt = e.target.closest?.('rt');
        const hit = e.target.closest?.('.vocab, .tok');
        if (rt || (e.shiftKey && hit)) {
          if (hit && !hit.classList.contains('known')) markKnown(hit.dataset.key);
          return;
        }
        chrome.tabs.sendMessage(tabId, { type: 'seek', time: item.time });
        setFollow(true);
      };
      segments.push({ time: item.time, el });
      return el;
    }));
    return alignedCount > 0;
  }

  async function syncKnownFromVault(dir) {
    const vaultKnown = await loadKnownFromVault(dir);
    if (vaultKnown) {
      knownWords = vaultKnown;
      renderKnownPanel();
      await idb('knownWords', [...knownWords].sort());
    } else if (knownWords.size > 0 && await dir.queryPermission({ mode: 'readwrite' }) === 'granted') {
      await enqueueVaultKnownWrite(dir, serializeKnownWords(knownWords));
    }
  }

  async function load() {
    list.replaceChildren();
    alignBtn.hidden = true;
    clearHover();
    if (!videoId) return;
    if (!vault) {
      statusEl.textContent = 'Vault を選択してください';
      return;
    }
    const id = videoId;
    statusEl.textContent = 'ノートを検索中…';
    const [file, alignment] = await Promise.all([
      findNote(vault, id),
      loadAlignment(vault, id),
      syncKnownFromVault(vault),
    ]);
    if (id !== videoId) return;
    if (!file) {
      statusEl.textContent = `source が ${id} のノートが見つかりません`;
      return;
    }
    const hasAligned = render(parse(await file.text()), alignment);
    alignBtn.hidden = !hasAligned;
    statusEl.textContent = file.name;
    if (lastTime != null) highlight(lastTime);
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
    await syncKnownFromVault(handle);
    load();
  }

  $('#pick').onclick = async () => useVault(await showDirectoryPicker({ mode: 'readwrite' }));

  grantBtn.onclick = async () => {
    const handle = await idb('vault');
    if (await handle.requestPermission({ mode: 'readwrite' }) === 'granted') useVault(handle);
    else if (await handle.requestPermission({ mode: 'read' }) === 'granted') useVault(handle);
  };

  chrome.runtime.onMessage.addListener((msg, sender) => {
    if (msg.type !== 'time') return;
    tabId = sender.tab.id;
    lastTime = msg.time;
    if (msg.videoId !== videoId) {
      videoId = msg.videoId;
      load();
    }
    highlight(msg.time);
  });

  (async () => {
    const [savedKnown, handle] = await Promise.all([idb('knownWords'), idb('vault')]);
    if (Array.isArray(savedKnown)) knownWords = new Set(savedKnown);
    renderKnownPanel();
    if (!handle) return;
    if (
      await handle.queryPermission({ mode: 'readwrite' }) === 'granted' ||
      await handle.queryPermission({ mode: 'read' }) === 'granted'
    ) {
      return useVault(handle);
    }
    grantBtn.textContent = `「${handle.name}」に再接続`;
    grantBtn.hidden = false;
  })();
}

if (typeof module !== 'undefined') {
  module.exports = {
    parse,
    hashSegment,
    normalizeKey,
    parseKnownWords,
    serializeKnownWords,
    findAllOccurrences,
    resolvePairSpans,
    sliceLineSpans,
  };
}
