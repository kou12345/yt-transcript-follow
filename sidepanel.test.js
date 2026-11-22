const test = require('node:test');
const assert = require('node:assert/strict');
const { parse, hashSegment, findAllOccurrences, resolvePairSpans, sliceLineSpans } = require('./sidepanel.js');

test('hashSegment matches Python FNV-1a 32-bit hash over UTF-8', () => {
  const ja = '当時ロンドンに拠点を置いていたのは好都合でした。🔥';
  const en = 'Being in London was useful at the time.';
  assert.equal(hashSegment(ja, en), 'beb75719');
});

test('parse unescapes markdown and preserves duplicate timestamps', () => {
  const md = [
    '---',
    'source: https://www.youtube.com/watch?v=test123',
    '---',
    '## Transcript',
    '',
    '### 章見出し',
    '',
    '**0:50**',
    '',
    '彼は［音楽］と主張します。',
    '',
    'He argues \\[music\\].',
    '',
    '**0:50**',
    '',
    '別の文です。',
    '',
    'Another sentence.',
  ].join('\n');

  const items = parse(md);
  assert.equal(items.length, 3);
  assert.deepEqual(items[0], { heading: '章見出し' });
  assert.equal(items[1].label, '0:50');
  assert.equal(items[1].time, 50);
  assert.deepEqual(items[1].lines, ['彼は［音楽］と主張します。', 'He argues [music].']);
  assert.equal(items[2].label, '0:50');
  assert.notEqual(
    hashSegment(items[1].lines[0], items[1].lines[1]),
    hashSegment(items[2].lines[0], items[2].lines[1]),
  );
});

test('findAllOccurrences finds overlapping and repeated occurrences', () => {
  assert.deepEqual(findAllOccurrences('chair in the air', 'air'), [[2, 5], [13, 16]]);
  assert.deepEqual(findAllOccurrences('aaa', 'aa'), [[0, 2], [1, 3]]);
  assert.deepEqual(findAllOccurrences('abc', ''), []);
});

test('resolvePairSpans resolves eo/jo, skips overlaps/invalid pairs, and rotates 6 colors', () => {
  const ja = '超知能は手の届くところにあり、超知能の開発が視野に入っています。x y z';
  const en = 'super intelligence is within reach, developing super intelligence is in sight. x y z';
  const pairs = [
    { en: 'super intelligence', ja: '超知能', eo: 0, jo: 0 },
    { en: 'within reach', ja: '手の届くところにあり' },
    { en: 'reach', ja: '届く' }, // overlaps with "within reach" -> skipped
    { en: 'developing', ja: 'の開発' },
    { en: 'super intelligence', ja: '超知能', eo: 1, jo: 1 },
    { en: 'in sight', ja: '視野に入っています' },
    { en: 'missing', ja: '超知能' }, // missing -> skipped
    { en: 'x', ja: 'x', eo: 99 }, // out of range -> skipped
    { en: 'y', ja: 'y' },
    { en: 'z', ja: 'z' },
  ];

  const { jaSpans, enSpans } = resolvePairSpans(ja, en, pairs);
  assert.equal(enSpans.length, 7);
  assert.equal(jaSpans.length, 7);
  assert.deepEqual(
    enSpans.map((s) => en.slice(s.start, s.end)),
    ['super intelligence', 'within reach', 'developing', 'super intelligence', 'in sight', 'y', 'z'],
  );
  assert.deepEqual(enSpans.map((s) => s.color), [0, 1, 2, 3, 4, 5, 0]);
  assert.deepEqual(
    jaSpans.map((s) => ja.slice(s.start, s.end)),
    ['超知能', '手の届くところにあり', '超知能', 'の開発', '視野に入っています', 'y', 'z'],
  );
});

test('sliceLineSpans maps joined-line spans back to individual paragraph offsets', () => {
  const jaLines = ['最初の文は火山です。', '次の文はボールです。'];
  const enLines = ['First is a volcano.', 'Next is a ball.'];
  const jaText = jaLines.join('\n');
  const enText = enLines.join('\n');
  const { jaSpans, enSpans } = resolvePairSpans(jaText, enText, [
    { en: 'volcano', ja: '火山' },
    { en: 'ball', ja: 'ボール' },
  ]);

  const jaLine0 = sliceLineSpans(jaSpans, 0, jaLines[0].length);
  const jaLine1Start = jaLines[0].length + 1;
  const jaLine1 = sliceLineSpans(jaSpans, jaLine1Start, jaLine1Start + jaLines[1].length);

  assert.equal(jaLines[0].slice(jaLine0[0].start, jaLine0[0].end), '火山');
  assert.equal(jaLines[1].slice(jaLine1[0].start, jaLine1[0].end), 'ボール');

  const enLine1Start = enLines[0].length + 1;
  const enLine1 = sliceLineSpans(enSpans, enLine1Start, enLine1Start + enLines[1].length);
  assert.equal(enLines[1].slice(enLine1[0].start, enLine1[0].end), 'ball');
});
