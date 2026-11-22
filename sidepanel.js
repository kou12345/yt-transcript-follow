const JA_RE = /[\u3040-\u30ff\u4e00-\u9fff]/;
const ALIGN_COLORS = 6;
const ALIGN_MODES = ['active', 'hover', 'off'];
const ALIGN_LABELS = { active: '対応: 色分け', hover: '対応: ホバー', off: '対応: OFF' };
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

    const color = pairId % ALIGN_COLORS;
    enSpans.push({ start: es, end: ee, pairId, color });
    jaSpans.push({ start: js, end: je, pairId, color });
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
      color: span.color,
    });
  }
  return out;
}

if (typeof document !== 'undefined') {
  const $ = (s) => document.querySelector(s);
  const statusEl = $('#status'), list = $('#list'), followBtn = $('#follow'), grantBtn = $('#grant'), alignBtn = $('#align');
  let vault = null, videoId = null, tabId = null, segments = [], active = -1, follow = true, lastTime = null;
  let hoveredSeg = null, hoveredPair = null, alignMode = 'active';

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

  function clearHover() {
    if (!hoveredSeg) return;
    hoveredSeg.classList.remove('has-hover');
    for (const el of hoveredSeg.querySelectorAll('.tok.match')) el.classList.remove('match');
    hoveredSeg = null;
    hoveredPair = null;
  }

  function setHover(seg, pairId) {
    if (hoveredSeg === seg && hoveredPair === pairId) return;
    clearHover();
    hoveredSeg = seg;
    hoveredPair = pairId;
    seg.classList.add('has-hover');
    for (const el of seg.querySelectorAll(`.tok[data-pair="${pairId}"]`)) el.classList.add('match');
  }

  function setAlignMode(mode) {
    alignMode = ALIGN_MODES.includes(mode) ? mode : 'active';
    document.body.dataset.align = alignMode;
    alignBtn.textContent = ALIGN_LABELS[alignMode];
    if (alignMode === 'off') clearHover();
    try { localStorage.setItem('alignMode', alignMode); } catch {}
  }

  try { setAlignMode(localStorage.getItem('alignMode') || 'active'); } catch { setAlignMode('active'); }

  alignBtn.onclick = () => {
    const next = ALIGN_MODES[(ALIGN_MODES.indexOf(alignMode) + 1) % ALIGN_MODES.length];
    setAlignMode(next);
  };

  list.addEventListener('pointerover', (e) => {
    if (alignMode === 'off') return;
    const tok = e.target.closest?.('.tok');
    if (!tok) return;
    const seg = tok.closest('.seg');
    if (seg) setHover(seg, tok.dataset.pair);
  });
  list.addEventListener('pointerout', (e) => {
    const tok = e.target.closest?.('.tok');
    if (!tok) return;
    const next = e.relatedTarget?.closest?.('.tok');
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

  function appendAlignedText(p, text, spans) {
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
      tok.dataset.color = String(s.color);
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
        if (!line.isJa) p.className = 'en';
        const spans = sliceLineSpans(line.isJa ? jaSpans : enSpans, line.start, line.end);
        appendAlignedText(p, line.text, spans);
        return p;
      }));

      el.onclick = () => {
        chrome.tabs.sendMessage(tabId, { type: 'seek', time: item.time });
        setFollow(true);
      };
      segments.push({ time: item.time, el });
      return el;
    }));
    return alignedCount > 0;
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
    const [file, alignment] = await Promise.all([findNote(vault, id), loadAlignment(vault, id)]);
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
    lastTime = msg.time;
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
}

if (typeof module !== 'undefined') {
  module.exports = { parse, hashSegment, findAllOccurrences, resolvePairSpans, sliceLineSpans };
}
