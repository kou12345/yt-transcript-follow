const test = require('node:test');
const assert = require('node:assert/strict');
const {
  parse,
  hashSegment,
  normalizeKey,
  parseKnownWords,
  serializeKnownWords,
  findAllOccurrences,
  resolvePairSpans,
  sliceLineSpans,
} = require('./sidepanel.js');

test('hashSegment matches Python FNV-1a 32-bit hash over UTF-8', () => {
  const ja = '当時ロンドンに拠点を置いていたのは好都合でした。🔥';
  const en = 'Being in London was useful at the time.';
  assert.equal(hashSegment(ja, en), 'beb75719');
});

test('normalizeKey prefers lemma and falls back to lowercased en', () => {
  assert.equal(normalizeKey({ en: 'Launched', lemma: 'launch' }), 'launch');
  assert.equal(normalizeKey({ en: 'Take Advantage Of' }), 'take advantage of');
  assert.equal(normalizeKey({ en: 'worries', lemma: '  Worry ' }), 'worry');
});

test('parseKnownWords and serializeKnownWords round-trip and normalize', () => {
  const raw = serializeKnownWords(new Set(['worry', 'compete', 'despite']));
  assert.deepEqual([...parseKnownWords(raw)], ['compete', 'despite', 'worry']);
  assert.deepEqual([...parseKnownWords('["Launch", " launch ", ""]')], ['launch']);
  assert.equal(parseKnownWords('not json'), null);
  assert.equal(parseKnownWords('{}'), null);
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

test('resolvePairSpans resolves eo/jo, attaches lemma key and en text, and skips overlaps/invalid pairs', () => {
  const ja = '超知能は手の届くところにあり、超知能の開発が視野に入っています。';
  const en = 'super intelligence is within reach, developing super intelligence is in sight.';
  const pairs = [
    { en: 'super intelligence', ja: '超知能', eo: 0, jo: 0 },
    { en: 'within reach', ja: '手の届くところにあり' },
    { en: 'reach', ja: '届く' }, // overlaps with "within reach" -> skipped
    { en: 'developing', ja: 'の開発', lemma: 'develop' },
    { en: 'super intelligence', ja: '超知能', eo: 1, jo: 1 },
    { en: 'in sight', ja: '視野に入っています' },
    { en: 'missing', ja: '超知能' }, // missing -> skipped
    { en: 'within reach', ja: '手の届くところにあり', eo: 99 }, // out of range -> skipped
  ];

  const { jaSpans, enSpans } = resolvePairSpans(ja, en, pairs);
  assert.equal(enSpans.length, 5);
  assert.equal(jaSpans.length, 5);
  assert.deepEqual(
    enSpans.map((s) => en.slice(s.start, s.end)),
    ['super intelligence', 'within reach', 'developing', 'super intelligence', 'in sight'],
  );
  assert.deepEqual(
    jaSpans.map((s) => ({ ja: ja.slice(s.start, s.end), en: s.en, key: s.key })),
    [
      { ja: '超知能', en: 'super intelligence', key: 'super intelligence' },
      { ja: '手の届くところにあり', en: 'within reach', key: 'within reach' },
      { ja: '超知能', en: 'super intelligence', key: 'super intelligence' },
      { ja: 'の開発', en: 'developing', key: 'develop' },
      { ja: '視野に入っています', en: 'in sight', key: 'in sight' },
    ],
  );
});

test('sliceLineSpans maps joined-line spans back to individual paragraph offsets', () => {
  const jaLines = ['最初の文は火山です。', '次の文は反発します。'];
  const enLines = ['First is a volcano.', 'Next it repels.'];
  const jaText = jaLines.join('\n');
  const enText = enLines.join('\n');
  const { jaSpans, enSpans } = resolvePairSpans(jaText, enText, [
    { en: 'volcano', ja: '火山' },
    { en: 'repels', ja: '反発', lemma: 'repel' },
  ]);

  const jaLine0 = sliceLineSpans(jaSpans, 0, jaLines[0].length);
  const jaLine1Start = jaLines[0].length + 1;
  const jaLine1 = sliceLineSpans(jaSpans, jaLine1Start, jaLine1Start + jaLines[1].length);

  assert.equal(jaLines[0].slice(jaLine0[0].start, jaLine0[0].end), '火山');
  assert.equal(jaLine0[0].en, 'volcano');
  assert.equal(jaLines[1].slice(jaLine1[0].start, jaLine1[0].end), '反発');
  assert.equal(jaLine1[0].key, 'repel');

  const enLine1Start = enLines[0].length + 1;
  const enLine1 = sliceLineSpans(enSpans, enLine1Start, enLine1Start + enLines[1].length);
  assert.equal(enLines[1].slice(enLine1[0].start, enLine1[0].end), 'repels');
});
