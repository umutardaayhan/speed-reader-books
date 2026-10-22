// Builds the books and catalog.json from tools/sources.json.
//
//   node tools/build.mjs            build every book that is not in books/ yet, then the catalog
//   node tools/build.mjs --force    rebuild every book
//
// Wikisource books are made into EPUBs from each page's plain text; Project Gutenberg books are
// their own EPUB files, downloaded as they are (with the Project Gutenberg license inside).
import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { strFromU8, strToU8, unzipSync, zipSync } from 'fflate';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const UA = 'SpeedReaderCatalogBuilder/1.0 (https://github.com/umutardaayhan/speed-reader-books)';
const force = process.argv.includes('--force');
const sources = JSON.parse(readFileSync(join(ROOT, 'tools', 'sources.json'), 'utf8'));
const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const escapeXml = (s) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

/** Plain text of a Wikisource page, as paragraphs (section headings left out). */
async function wikisourceParagraphs(title) {
  const params = new URLSearchParams({
    format: 'json',
    action: 'query',
    prop: 'extracts',
    explaintext: '1',
    redirects: '1',
    titles: title.normalize('NFC'),
  });
  const response = await fetch(`https://tr.wikisource.org/w/api.php?${params}`, { headers: { 'User-Agent': UA } });
  const json = await response.json();
  const page = Object.values(json.query.pages)[0];
  if (!page.extract) throw new Error(`No text for "${title}"`);
  return page.extract
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line && !/^=+.*=+$/.test(line));
}

function xhtml(title, paragraphs) {
  return `<?xml version="1.0" encoding="utf-8"?>
<!DOCTYPE html>
<html xmlns="http://www.w3.org/1999/xhtml" xml:lang="tr" lang="tr">
<head><meta charset="utf-8"/><title>${escapeXml(title)}</title></head>
<body>
<h1>${escapeXml(title)}</h1>
${paragraphs.map((p) => `<p>${escapeXml(p)}</p>`).join('\n')}
</body>
</html>`;
}

/** An EPUB 3 of chapters (title + paragraphs), with a table of contents. */
function makeEpub({ id, title, author, language, chapters }) {
  const files = {
    mimetype: strToU8('application/epub+zip'),
    'META-INF/container.xml': strToU8(
      '<?xml version="1.0"?><container version="1.0" xmlns="urn:oasis:names:tc:opendocument:xmlns:container"><rootfiles><rootfile full-path="OEBPS/content.opf" media-type="application/oebps-package+xml"/></rootfiles></container>',
    ),
  };
  const items = chapters.map((c, i) => ({ id: `c${i + 1}`, href: `c${i + 1}.xhtml`, ...c }));
  for (const item of items) files[`OEBPS/${item.href}`] = strToU8(xhtml(item.title, item.paragraphs));
  files['OEBPS/nav.xhtml'] = strToU8(`<?xml version="1.0" encoding="utf-8"?>
<!DOCTYPE html>
<html xmlns="http://www.w3.org/1999/xhtml" xmlns:epub="http://www.idpf.org/2007/ops">
<head><meta charset="utf-8"/><title>${escapeXml(title)}</title></head>
<body><nav epub:type="toc"><ol>
${items.map((i) => `<li><a href="${i.href}">${escapeXml(i.title)}</a></li>`).join('\n')}
</ol></nav></body></html>`);
  files['OEBPS/content.opf'] = strToU8(`<?xml version="1.0" encoding="utf-8"?>
<package xmlns="http://www.idpf.org/2007/opf" version="3.0" unique-identifier="book-id">
<metadata xmlns:dc="http://purl.org/dc/elements/1.1/">
<dc:identifier id="book-id">urn:speed-reader-books:${id}</dc:identifier>
<dc:title>${escapeXml(title)}</dc:title>
<dc:creator>${escapeXml(author)}</dc:creator>
<dc:language>${language}</dc:language>
<meta property="dcterms:modified">${new Date().toISOString().replace(/\.\d+Z$/, 'Z')}</meta>
</metadata>
<manifest>
<item id="nav" href="nav.xhtml" media-type="application/xhtml+xml" properties="nav"/>
${items.map((i) => `<item id="${i.id}" href="${i.href}" media-type="application/xhtml+xml"/>`).join('\n')}
</manifest>
<spine>${items.map((i) => `<itemref idref="${i.id}"/>`).join('')}</spine>
</package>`);
  // The mimetype entry must come first and stay uncompressed.
  return zipSync(files, { level: 9, mtime: new Date('2026-01-01') });
}

async function buildWikisource(book, author) {
  const chapters = [];
  for (const page of book.pages) {
    const paragraphs = await wikisourceParagraphs(page);
    chapters.push({ title: page.replace(/\s*\((hikâye|Ömer Seyfettin)\)$/, ''), paragraphs });
    await wait(500);
  }
  const links = book.pages.map((p) => `https://tr.wikisource.org/wiki/${encodeURIComponent(p.replace(/ /g, '_'))}`);
  // Named "Kaynaklar", so the app skips it as back matter.
  chapters.push({
    title: 'Kaynaklar',
    paragraphs: [
      `${author.name} ${author.died} yılında öldü; eserleri, yazarın ölümünden 70 yıl sonra Türkiye'de kamu malı olmuştur.`,
      "Bu kitaptaki metinler Vikikaynak'tan (tr.wikisource.org) alınmıştır. Vikikaynak sayfaları Creative Commons Atıf-AynıLisanslaPaylaş 4.0 lisansıyla paylaşılır.",
      ...links,
    ],
  });
  return makeEpub({ id: book.id, title: book.title, author: author.name, language: book.language, chapters });
}

async function buildGutenberg(book) {
  const url = `https://www.gutenberg.org/ebooks/${book.gutenberg}.epub3.images`;
  const response = await fetch(url, { headers: { 'User-Agent': UA } });
  if (!response.ok) throw new Error(`${url}: HTTP ${response.status}`);
  return new Uint8Array(await response.arrayBuffer());
}

/** Words of an EPUB's text documents, counted like the app does (whitespace-separated). */
function countWords(epub) {
  const files = unzipSync(epub, { filter: (f) => /\.(x?html?)$/i.test(f.name) && !/nav\.xhtml$/i.test(f.name) });
  let words = 0;
  for (const data of Object.values(files)) {
    const text = strFromU8(data)
      .replace(/<head[\s\S]*?<\/head>/i, ' ')
      .replace(/<[^>]+>/g, ' ')
      .replace(/&[a-z#0-9]+;/gi, ' ');
    words += text.split(/\s+/).filter(Boolean).length;
  }
  return words;
}

mkdirSync(join(ROOT, 'books'), { recursive: true });
const authors = new Map(sources.authors.map((a) => [a.id, a]));
const entries = [];
for (const book of sources.books) {
  const author = authors.get(book.authorId);
  if (!author) throw new Error(`${book.id}: unknown author ${book.authorId}`);
  const file = `books/${book.id}.epub`;
  const path = join(ROOT, file);
  if (force || !existsSync(path)) {
    console.log(`building ${book.id}…`);
    const epub = book.source === 'wikisource' ? await buildWikisource(book, author) : await buildGutenberg(book);
    writeFileSync(path, epub);
    await wait(1000);
  }
  const epub = new Uint8Array(readFileSync(path));
  const isWikisource = book.source === 'wikisource';
  entries.push({
    id: book.id,
    title: book.title,
    authorId: book.authorId,
    language: book.language,
    ...(book.year ? { year: book.year } : {}),
    ...(book.translator ? { translator: book.translator } : {}),
    words: countWords(epub),
    bytes: statSync(path).size,
    file,
    about: book.about,
    ...(book.blurb ? { blurb: book.blurb } : {}),
    source: isWikisource ? 'Vikikaynak (tr.wikisource.org)' : `Project Gutenberg #${book.gutenberg}`,
    license: isWikisource
      ? `Kamu malı (yazar ${author.died} yılında öldü); Vikikaynak metni CC BY-SA 4.0`
      : 'Public domain (author and translator died more than 70 years ago); Project Gutenberg License',
  });
}

const catalog = {
  version: 1,
  updated: new Date().toISOString().slice(0, 10),
  authors: sources.authors,
  books: entries,
};
writeFileSync(join(ROOT, 'catalog.json'), `${JSON.stringify(catalog, null, 2)}\n`);
console.log(`catalog.json: ${catalog.authors.length} authors, ${catalog.books.length} books`);
for (const b of entries) console.log(`  ${b.id}: ${b.words} words, ${Math.round(b.bytes / 1024)} KB`);
