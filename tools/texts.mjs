// Builds texts.json, the app's extra training texts, from tools/texts-source.json.
// A text with `from` is a passage of one of our EPUBs, copied word for word: it runs from the
// paragraph starting with `from.start` up to (not including) the one starting with `from.until`,
// whose first words become the excerpt's continueAt (left out with "continue": false, for a
// passage from the middle of a book). Other texts give their paragraphs directly.
// Run after `npm run build`, so the EPUBs are current: npm run texts
import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { strFromU8, unzipSync } from 'fflate';

import { findLookAlikes, vocabulary } from './lookalikes.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const catalog = JSON.parse(readFileSync(join(ROOT, 'catalog.json'), 'utf8'));
const source = JSON.parse(readFileSync(join(ROOT, 'tools', 'texts-source.json'), 'utf8'));

const decode = (s) =>
  s
    .replace(/&nbsp;|&#160;/g, ' ')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(Number(n)))
    .replace(/&#x([0-9a-f]+);/gi, (_, n) => String.fromCodePoint(parseInt(n, 16)))
    .replace(/&amp;/g, '&');

/** Every paragraph and heading of a book, in reading order. */
function bookParagraphs(id) {
  const files = unzipSync(readFileSync(join(ROOT, 'books', `${id}.epub`)));
  const paragraphs = [];
  for (const name of Object.keys(files).filter((k) => /\.x?html?$/.test(k)).sort()) {
    const html = strFromU8(files[name]).replace(/<head[\s\S]*?<\/head>/, '');
    for (const m of html.matchAll(/<(p|h[1-6])\b[^>]*>([\s\S]*?)<\/\1>/g)) {
      const text = decode(m[2].replace(/<br\s*\/?>/g, ' ').replace(/<[^>]+>/g, '')).replace(/\s+/g, ' ').trim();
      if (text) paragraphs.push(text);
    }
  }
  return paragraphs;
}

function passage(text) {
  const { book: id, start, until } = text.from;
  const book = catalog.books.find((b) => b.id === id);
  if (!book) throw new Error(`${text.id}: ${id} is not in the catalog`);
  const all = bookParagraphs(id);
  const first = all.findIndex((p) => p.startsWith(start));
  if (first < 0) throw new Error(`${text.id}: no paragraph starts with "${start}"`);
  const end = all.findIndex((p, i) => i > first && p.startsWith(until));
  if (end < 0) throw new Error(`${text.id}: no paragraph after the start begins with "${until}"`);
  const author = catalog.authors.find((a) => a.id === book.authorId);
  return {
    // Scene breaks ("* * *") are not text to read.
    paragraphs: all.slice(first, end).filter((p) => /[\p{L}\p{N}]/u.test(p)),
    excerpt: {
      catalogId: id,
      book: book.title,
      author: author?.name ?? '',
      ...(book.sahafTranslation ? { sahafTranslation: true } : {}),
      // A passage from the middle of a book leaves it to be read from the start.
      ...(text.from.continue === false ? {} : { continueAt: until }),
    },
  };
}

const texts = source.texts.map(({ from, ...text }) => {
  if (text.questions?.length !== 4) throw new Error(`${text.id}: needs four questions`);
  const words = (paragraphs) => paragraphs.join(' ').split(/\s+/).length;
  if (!from) return text;
  const { paragraphs, excerpt } = passage({ ...text, from });
  console.log(`${text.id}: ${paragraphs.length} paragraphs, ${words(paragraphs)} words`);
  return { ...text, paragraphs, excerpt };
});

// Attention Test words: a target and real words that look like it, per language. The ones
// written in the source come first; real look-alikes found in our books are added after them.
const wordSets = {};
for (const [language, sets] of Object.entries(source.wordSets ?? {})) {
  const seen = new Set();
  const vocab = vocabulary(language);
  wordSets[language] = sets.map(({ word, similar = [] }) => {
    if (!/^\p{Ll}{2,20}$/u.test(word) || seen.has(word)) throw new Error(`wordSets.${language}: bad or repeated word "${word}"`);
    seen.add(word);
    const bad = similar.find((w) => !/^\p{Ll}{2,20}$/u.test(w) || w === word);
    if (bad !== undefined) throw new Error(`wordSets.${language}.${word}: bad similar word "${bad}"`);
    return { word, similar: [...new Set([...similar, ...findLookAlikes(word, language, vocab)])] };
  });
}

writeFileSync(join(ROOT, 'texts.json'), `${JSON.stringify({ version: 1, texts, wordSets }, null, 1)}\n`);
console.log(`texts.json: ${texts.length} texts, ${Object.entries(wordSets).map(([l, s]) => `${s.length} ${l} word sets`).join(', ')}`);
