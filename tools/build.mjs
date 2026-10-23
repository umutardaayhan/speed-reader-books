// Builds the books and catalog.json from tools/sources.json.
//
//   node tools/build.mjs            build every book that is not in books/ yet, then the catalog
//   node tools/build.mjs --force    rebuild every book
//
// Wikisource books are made into EPUBs from each page's plain text; Project Gutenberg books are
// their own EPUB files (with the Project Gutenberg license inside), downloaded and then kept small:
// illustrations are taken out (the cover stays), and so is a Gutenberg note in the contents.
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

async function wikisourceApi(params) {
  const query = new URLSearchParams({ format: 'json', redirects: '1', ...params });
  const response = await fetch(`https://tr.wikisource.org/w/api.php?${query}`, { headers: { 'User-Agent': UA } });
  return response.json();
}

const wordsIn = (paragraphs) => paragraphs.join(' ').split(/\s+/).filter(Boolean).length;

/**
 * Plain text of a Wikisource page, as paragraphs (section headings left out). The plain-text
 * extract misses text that pages proofread from scans take from the scan's pages, and on some
 * pages it stops after a line or two, so when it is shorter than the rendered page, the rendered
 * page is used instead.
 */
async function wikisourceParagraphs(title) {
  const json = await wikisourceApi({ action: 'query', prop: 'extracts', explaintext: '1', titles: title.normalize('NFC') });
  const extract = (Object.values(json.query.pages)[0].extract ?? '')
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line && !/^=+.*=+$/.test(line));
  const parsed = await wikisourceApi({ action: 'parse', prop: 'text', disableeditsection: '1', page: title.normalize('NFC') });
  const rendered = parsed.parse ? htmlParagraphs(parsed.parse.text['*']) : [];
  const paragraphs = (wordsIn(extract) >= 0.9 * wordsIn(rendered) ? extract : rendered)
    .map((p) => p.replace(/\s*Sayfa başı\W*$/u, '').trim()) // the link back to the top of the page
    .filter(Boolean);
  if (paragraphs.length === 0) throw new Error(`No text for "${title}"`);
  return paragraphs;
}

const ENTITIES = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ' };

/** The text of a rendered Wikisource page as paragraphs, without its header, page numbers and license box. */
function htmlParagraphs(html) {
  let h = html;
  const scans = h.indexOf('class="prp-pages-output"');
  if (scans >= 0) h = h.slice(h.indexOf('>', scans) + 1);
  // The header box ends with the hidden ws-data block; the text starts after it.
  const data = h.indexOf('id="ws-data"');
  if (data >= 0) h = h.slice(h.indexOf('</div>', data) + 6);
  // The text ends at the source and license box, or at the parser's report.
  const ends = [h.indexOf('<b>Kaynak:</b>'), h.indexOf('class="licenseContainer'), h.indexOf('<!--')].filter((i) => i >= 0);
  if (ends.length) {
    const end = Math.min(...ends);
    const table = h.lastIndexOf('<table', end);
    const cut = table < 0 || h.slice(table, end).includes('</table>') ? h.lastIndexOf('<', end) : table;
    h = h.slice(0, cut);
  }
  h = h
    .replace(/<span><span class="pagenum[^"]*"[^>]*><\/span><\/span>/g, '')
    .replace(/<figure[\s\S]*?<\/figure>/g, '')
    .replace(/<style[\s\S]*?<\/style>/g, '')
    .replace(/<sup[^>]*class="reference"[\s\S]*?<\/sup>/g, '')
    .replace(/<ol class="references"[\s\S]*?<\/ol>/g, '')
    .replace(/\n/g, ' ')
    .replace(/<br\s*\/?>|<\/?(p|div|center|li|h\d|dd|dt|tr|table|blockquote|ul|ol|dl)\b[^>]*>/gi, '\u0000')
    .replace(/<[^>]+>/g, '')
    .replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(Number(n)))
    .replace(/&#x([0-9a-f]+);/gi, (_, n) => String.fromCodePoint(parseInt(n, 16)))
    .replace(/&([a-z]+);/gi, (m, n) => ENTITIES[n.toLowerCase()] ?? m)
    .replace(/­/g, ''); // soft hyphens from the scans
  return h
    .split('\u0000')
    .map((p) => p.replace(/\s+/g, ' ').trim())
    .filter(Boolean);
}

/**
 * The chapters of one Wikisource page. A page is a page title, or an object with:
 *   fixes     [from, to] pairs for transcription errors ("\n\n" in `to` starts a new paragraph)
 *   chapters  [{ title, from }]: the page split where a paragraph starts with `from`; the text
 *             before the first one (a title page) is left out, and a first paragraph that is
 *             only the chapter's title is dropped, since the chapter gets its own heading
 */
async function wikisourceChapters(page) {
  const { page: title, fixes = [], chapters } = typeof page === 'string' ? { page } : page;
  let paragraphs = await wikisourceParagraphs(title);
  if (fixes.length) {
    let text = paragraphs.join('\n\n');
    for (const [from, to] of fixes) {
      if (!text.includes(from)) throw new Error(`${title}: fix not found: ${from}`);
      text = text.replace(from, to);
    }
    paragraphs = text.split('\n\n');
  }
  if (!chapters) return [{ title: title.replace(/\s*\((hikâye|Ömer Seyfettin)\)$/, ''), paragraphs }];
  const starts = chapters.map((c) => {
    const i = paragraphs.findIndex((p) => p.startsWith(c.from));
    if (i < 0) throw new Error(`${title}: chapter start not found: ${c.from}`);
    return i;
  });
  return chapters.map((c, n) => {
    const body = paragraphs.slice(starts[n], starts[n + 1] ?? paragraphs.length);
    const isHeading = body[0].toLocaleLowerCase('tr-TR') === c.title.toLocaleLowerCase('tr-TR');
    return { title: c.title, paragraphs: isHeading ? body.slice(1) : body };
  });
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
    chapters.push(...(await wikisourceChapters(page)));
    await wait(500);
  }
  const links = book.pages
    .map((p) => (typeof p === 'string' ? p : p.page))
    .map((p) => `https://tr.wikisource.org/wiki/${encodeURIComponent(p.replace(/ /g, '_'))}`);
  // Named "Kaynaklar", so the app skips it as back matter.
  chapters.push({
    title: 'Kaynaklar',
    paragraphs: [
      author.died
        ? `${author.name} ${author.died} yılında öldü; eserleri, yazarın ölümünden 70 yıl sonra Türkiye'de kamu malı olmuştur.`
        : `${author.name} antik çağda yaşadı; eserleri kamu malıdır.`,
      ...(book.translator
        ? [`Türkçesi ${book.translator}; çevirmen ${book.translatorDied} yılında öldü, çevirisi de ölümünden 70 yıl sonra kamu malı olmuştur.`]
        : []),
      "Bu kitaptaki metinler Vikikaynak'tan (tr.wikisource.org) alınmıştır. Vikikaynak sayfaları Creative Commons Atıf-AynıLisanslaPaylaş 4.0 lisansıyla paylaşılır.",
      ...links,
    ],
  });
  return makeEpub({ id: book.id, title: book.title, author: author.name, language: book.language, chapters });
}

/** The text files of a Sahaf translation: translations/<book id>/<story file>. */
const storyPaths = (book) => book.stories.map((story) => join(ROOT, 'translations', book.id, story.file));

/**
 * A book the bookshop translated itself, from its text files: one story each, its title on the
 * first line, paragraphs separated by blank lines. It opens with a translator's note saying it
 * may have mistakes (titled so that the app suggests skipping it) and ends with the originals.
 */
function buildSahaf(book, author) {
  const stories = storyPaths(book).map((path) => {
    const [title, ...paragraphs] = readFileSync(path, 'utf8').replace(/\r/g, '').trim().split(/\n\s*\n/);
    return { title: title.trim(), paragraphs: paragraphs.map((p) => p.replace(/\s+/g, ' ').trim()).filter(Boolean) };
  });
  const chapters = [
    {
      title: 'Çevirmenin notu',
      paragraphs: [
        'Bu bir sahaf çevirisidir, yanlışlıklar olabilir.',
        `Bu kitaptaki öyküler, Sahaf için yapay zekâ yardımıyla özgün dillerinden (${book.translatedFrom}) Türkçeye çevrildi; yayımlanmış bir çevirmenin elinden çıkmadı. Anlamı kaymış, eksik ya da yanlış çevrilmiş yerler olabilir.`,
        'Özgün metinler kamu malıdır; nereden alındıkları kitabın sonundaki Kaynaklar bölümünde yazılıdır. Bu çeviri de serbestçe paylaşılabilir.',
      ],
    },
    ...stories,
    {
      // Named "Kaynaklar", so the app skips it as back matter.
      title: 'Kaynaklar',
      paragraphs: [
        `${author.name} ${author.died} yılında öldü; eserleri, yazarın ölümünden 70 yıl sonra kamu malı olmuştur.`,
        `Öyküler şu özgün metinlerden çevrildi (${book.translatedFrom}):`,
        ...book.stories.map((story, i) => `${stories[i].title}: ${story.original}, ${story.url}`),
      ],
    },
  ];
  return makeEpub({ id: book.id, title: book.title, author: author.name, language: book.language, chapters });
}

async function buildGutenberg(book) {
  const url = `https://www.gutenberg.org/ebooks/${book.gutenberg}.epub3.images`;
  const response = await fetch(url, { headers: { 'User-Agent': UA } });
  if (!response.ok) throw new Error(`${url}: HTTP ${response.status}`);
  return new Uint8Array(await response.arrayBuffer());
}

/**
 * The EPUB without its illustrations, keeping only the cover image. Illustrated Gutenberg books
 * can be tens of megabytes, too much to download on a phone (and over GitHub's 100 MB a file),
 * and a speed reader shows no pictures. Images go from the zip and the OPF manifest, and the tags
 * that showed them go from the pages. Returns the same bytes when there is nothing to take out.
 */
function slimEpub(epub) {
  const files = unzipSync(epub);
  const container = strFromU8(files['META-INF/container.xml'] ?? new Uint8Array());
  const opfPath = /full-path="([^"]+)"/.exec(container)?.[1];
  if (!opfPath || !files[opfPath]) return epub;
  const opfDir = opfPath.includes('/') ? opfPath.slice(0, opfPath.lastIndexOf('/') + 1) : '';
  let opf = strFromU8(files[opfPath]);
  const attr = (tag, name) => new RegExp(`\\s${name}="([^"]*)"`).exec(tag)?.[1];

  const coverMeta = /<meta[^>]*name="cover"[^>]*>/.exec(opf)?.[0];
  const coverItemId = coverMeta ? attr(coverMeta, 'content') : undefined;
  const removed = new Set();
  opf = opf.replace(/<item\s[^>]*\/>/g, (tag) => {
    const type = attr(tag, 'media-type') ?? '';
    const isCover = attr(tag, 'id') === coverItemId || /cover-image/.test(attr(tag, 'properties') ?? '');
    if (!type.startsWith('image/') || isCover) return tag;
    removed.add(decodeURIComponent(opfDir + attr(tag, 'href')));
    return '';
  });
  if (removed.size === 0) return epub;

  const out = {};
  for (const [name, data] of Object.entries(files)) {
    if (removed.has(name)) continue;
    if (name === opfPath) {
      out[name] = strToU8(opf);
    } else if (/\.x?html?$/i.test(name)) {
      const dir = name.includes('/') ? name.slice(0, name.lastIndexOf('/') + 1) : '';
      const gone = (src) => {
        const parts = [];
        for (const p of (dir + decodeURIComponent(src.split('#')[0])).split('/')) {
          if (p === '..') parts.pop();
          else if (p !== '.') parts.push(p);
        }
        return removed.has(parts.join('/'));
      };
      out[name] = strToU8(
        strFromU8(data)
          .replace(/<img\s[^>]*>/gi, (tag) => (gone(attr(tag, 'src') ?? '') ? '' : tag))
          .replace(/<image\s[^>]*>/gi, (tag) => (gone(attr(tag, 'xlink:href') ?? attr(tag, 'href') ?? '') ? '' : tag)),
      );
    } else {
      out[name] = data;
    }
  }
  return rezip(out);
}

/** Zips EPUB files; the mimetype file must come first and be stored uncompressed. */
function rezip(files) {
  const { mimetype, ...rest } = files;
  return zipSync({ ...(mimetype ? { mimetype: [mimetype, { level: 0 }] } : {}), ...rest }, { level: 9 });
}

/**
 * The EPUB without Gutenberg's "There are several editions of this ebook..." entry in its table
 * of contents. Pointing at the first text file, it would become that chapter's title, and the app
 * would take the chapter (sometimes half the book) for Gutenberg's notice and skip it.
 */
function dropEditionsNote(epub) {
  const files = unzipSync(epub);
  let changed = false;
  for (const name of Object.keys(files)) {
    if (!/\.(ncx|x?html?)$/i.test(name)) continue;
    const text = strFromU8(files[name]);
    if (!text.includes('There are several editions of this ebook')) continue;
    const tidy = text
      .replace(/<li\b[^>]*>\s*<a\b[^>]*>\s*There are several editions of this ebook[^<]*<\/a>\s*<\/li>/g, '')
      .replace(/<navPoint\b[^>]*>\s*<navLabel>\s*<text>\s*There are several editions of this ebook[^<]*<\/text>\s*<\/navLabel>\s*<content\b[^>]*\/>\s*<\/navPoint>/g, '');
    if (tidy !== text) {
      files[name] = strToU8(tidy);
      changed = true;
    }
  }
  return changed ? rezip(files) : epub;
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
  // A translation is rebuilt whenever one of its files is newer than the book, so corrections
  // to it go out with the next build.
  const edited =
    book.source === 'sahaf' &&
    existsSync(path) &&
    storyPaths(book).some((story) => statSync(story).mtimeMs > statSync(path).mtimeMs);
  if (force || edited || !existsSync(path)) {
    console.log(`building ${book.id}…`);
    if (book.source === 'sahaf') {
      writeFileSync(path, buildSahaf(book, author));
    } else {
      writeFileSync(path, book.source === 'wikisource' ? await buildWikisource(book, author) : await buildGutenberg(book));
      await wait(1000);
    }
  }
  if (book.source === 'gutenberg') {
    const original = new Uint8Array(readFileSync(path));
    const slim = dropEditionsNote(slimEpub(original));
    if (slim !== original) writeFileSync(path, slim);
  }
  const epub = new Uint8Array(readFileSync(path));
  const origin = {
    wikisource: {
      source: 'Vikikaynak (tr.wikisource.org)',
      license: `Kamu malı (${book.translator ? `çevirmen ${book.translatorDied}` : `yazar ${author.died}`} yılında öldü); Vikikaynak metni CC BY-SA 4.0`,
    },
    gutenberg: {
      source: `Project Gutenberg #${book.gutenberg}`,
      license: 'Public domain (author and translator died more than 70 years ago); Project Gutenberg License',
    },
    sahaf: {
      source: `Sahaf çevirisi (${book.translatedFrom} özgün metinden, yapay zekâ yardımıyla)`,
      license: `Özgün metin kamu malı (yazar ${author.died} yılında öldü); çeviri serbestçe paylaşılabilir (CC0)`,
    },
  }[book.source];
  entries.push({
    id: book.id,
    title: book.title,
    authorId: book.authorId,
    language: book.language,
    ...(book.year ? { year: book.year } : {}),
    ...(book.source === 'sahaf' ? { translator: 'Sahaf', sahafTranslation: true } : {}),
    ...(book.translator ? { translator: book.translator } : {}),
    words: countWords(epub),
    bytes: statSync(path).size,
    file,
    about: book.about,
    ...(book.blurb ? { blurb: book.blurb } : {}),
    ...origin,
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
