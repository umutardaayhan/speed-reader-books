// Real words that look like a given word, found in the vocabulary of our own books: the
// Attention Test's meaningful look-alikes (mektep -> matkap, horse -> house).
// node tools/lookalikes.mjs tr kalem mektep ...   prints what it finds for each word
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { strFromU8, unzipSync } from 'fflate';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

const ALPHABET = { tr: /^[a-zçğıöşüâîû]+$/, en: /^[a-z]+$/ };
const VOWELS = { tr: /[aeıioöuüâîû]/g, en: /[aeiouy]/g };
/** Words seen fewer times are left out, so typos and rare forms do not show up. */
const MIN_COUNT = { tr: 2, en: 15 };
/** Common in our books but not words of the language: French and German passages, dialect spellings. */
const EXCLUDE = {
  tr: new Set(),
  en: new Set(['des', 'dis', 'dat', 'dey', 'dah', 'dem', 'les', 'une', 'und', 'der', 'die', 'das', 'ein', 'que', 'qui', 'pas', 'mon', 'est', 'sur', 'avec', 'mais', 'nicht', 'sich', 'ich', 'wid', 'git', 'ole', 'warn']),
};
/** At most this many found words per target, and at most this many that only add or drop an ending. */
const MAX_FOUND = 8;
const MAX_ENDINGS = 2;

const lower = (s, language) => s.toLocaleLowerCase(language === 'tr' ? 'tr-TR' : 'en-US');

/** Every word of the books in `language` that appears in lower case (so names are left out), with its count. */
export function vocabulary(language) {
  const catalog = JSON.parse(readFileSync(join(ROOT, 'catalog.json'), 'utf8'));
  const counts = new Map();
  for (const book of catalog.books.filter((b) => b.language === language)) {
    const files = unzipSync(readFileSync(join(ROOT, 'books', `${book.id}.epub`)));
    for (const name of Object.keys(files).filter((k) => /\.x?html?$/.test(k))) {
      const text = strFromU8(files[name]).replace(/<head[\s\S]*?<\/head>/, '').replace(/<[^>]+>/g, ' ').replace(/&[a-z#0-9]+;/gi, ' ');
      for (const word of text.match(/\p{L}+/gu) ?? []) {
        if (word.length < 3 || word !== lower(word, language) || !ALPHABET[language].test(word)) continue;
        counts.set(word, (counts.get(word) ?? 0) + 1);
      }
    }
  }
  return new Map([...counts].filter(([w, n]) => n >= MIN_COUNT[language] && !EXCLUDE[language].has(w)));
}

/** Damerau–Levenshtein distance (adjacent swaps count as one change). */
function distance(a, b) {
  const x = [...a];
  const y = [...b];
  const d = Array.from({ length: x.length + 1 }, (_, i) => [i, ...Array(y.length).fill(0)]);
  for (let j = 1; j <= y.length; j++) d[0][j] = j;
  for (let i = 1; i <= x.length; i++) {
    for (let j = 1; j <= y.length; j++) {
      const cost = x[i - 1] === y[j - 1] ? 0 : 1;
      d[i][j] = Math.min(d[i - 1][j] + 1, d[i][j - 1] + 1, d[i - 1][j - 1] + cost);
      if (i > 1 && j > 1 && x[i - 1] === y[j - 2] && x[i - 2] === y[j - 1]) d[i][j] = Math.min(d[i][j], d[i - 2][j - 2] + 1);
    }
  }
  return d[x.length][y.length];
}

/**
 * Up to MAX_FOUND words of `vocab` that look like `word`, closest and most common first:
 * - spelled nearly the same: one change, or two in a word of five letters or more that keeps its
 *   first and last letter (one of them is enough from six letters on);
 * - or built on the same frame: same first and last letter, about the same length, and three or
 *   more consonants in nearly the same order, only the vowels differing (mektep -> matkap).
 */
export function findLookAlikes(word, language, vocab) {
  const letters = [...word];
  const skeleton = (w) => w.replace(VOWELS[language], '');
  const frame = skeleton(word);
  const vowels = (w) => (w.match(VOWELS[language]) ?? []).length;
  const found = [];
  for (const [candidate, count] of vocab) {
    if (candidate === word) continue;
    const other = [...candidate];
    if (Math.abs(other.length - letters.length) > 1) continue;
    const d = distance(word, candidate);
    const sameFirst = other[0] === letters[0];
    const sameLast = other.at(-1) === letters.at(-1);
    // Two changes still look alike only when the word keeps its ends (one of them, if it is long).
    const near =
      d <= 1 ||
      (d === 2 && letters.length >= 5 && ((sameFirst && sameLast) || (letters.length >= 6 && (sameFirst || sameLast))));
    const sameFrame =
      letters.length >= 4 &&
      sameFirst &&
      sameLast &&
      frame.length >= 3 &&
      distance(frame, skeleton(candidate)) <= 1 &&
      Math.abs(vowels(candidate) - vowels(word)) <= 1;
    if (near || sameFrame) found.push({ candidate, d, count, ending: candidate.startsWith(word) || word.startsWith(candidate) });
  }
  found.sort((a, b) => a.d - b.d || b.count - a.count);
  const out = [];
  let endings = 0;
  for (const f of found) {
    if (out.length >= MAX_FOUND) break;
    if (f.ending && endings >= MAX_ENDINGS) continue;
    if (f.ending) endings++;
    out.push(f.candidate);
  }
  return out;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const [language, ...words] = process.argv.slice(2);
  const vocab = vocabulary(language);
  console.log(`${vocab.size} words in the ${language} vocabulary`);
  for (const word of words) console.log(`${word}: ${findLookAlikes(word, language, vocab).join(' ')}`);
}
