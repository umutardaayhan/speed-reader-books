# Speed Reader Books

Public-domain books and the catalog for the bookstore (Kitapçı) of Aesthetic Speed Reader. The app downloads `catalog.json` through the jsDelivr CDN and fetches a book only when a reader asks for it:

- catalog: `https://cdn.jsdelivr.net/gh/umutardaayhan/speed-reader-books@main/catalog.json`
- books: `books/<id>.epub`, resolved against the catalog's address

## What is here

| Book | Author | Language | Source |
|---|---|---|---|
| Kaşağı ve Diğer Hikâyeler (14 stories) | Ömer Seyfettin (1884–1920) | Turkish | Vikikaynak |
| Bomba ve Diğer Hikâyeler (15 stories) | Ömer Seyfettin | Turkish | Vikikaynak |
| Crime and Punishment, tr. Constance Garnett | Fyodor Dostoyevsky (1821–1881) | English | Project Gutenberg #2554 |
| Notes from the Underground, tr. Constance Garnett | Fyodor Dostoyevsky | English | Project Gutenberg #600 |
| Anna Karenina, tr. Constance Garnett | Leo Tolstoy (1828–1910) | English | Project Gutenberg #1399 |

## Why these are free to share

- A work is in the public domain in Turkey 70 years after its author's death (Law No. 5846), so authors who died in 1955 or earlier. Translations are separate works: a translation is free only when its translator also died more than 70 years ago. Constance Garnett died in 1946.
- Turkish texts come from Vikikaynak (tr.wikisource.org). Each Turkish book ends with a "Kaynaklar" chapter naming its pages; Vikikaynak pages are shared under CC BY-SA 4.0.
- English texts are Project Gutenberg's own EPUB files, unchanged, with the Project Gutenberg License inside. They are public domain in the US, and their authors and translators died more than 70 years ago.

Before adding a book, check both the author's and (for a translation) the translator's year of death. Leave a book out when in doubt.

## Adding books

1. Add the author (if new) and the book to `tools/sources.json`:
   - Vikikaynak: `"source": "wikisource"` and `"pages"`, the page titles to include as chapters.
   - Project Gutenberg: `"source": "gutenberg"` and `"gutenberg"`, the ebook number; add `"translator"` for a translation.
2. Run:

   ```bash
   npm install
   npm run build
   ```

   Books already in `books/` are kept; `node tools/build.mjs --force` rebuilds all of them. The script writes `catalog.json` with each book's size and word count.
3. Commit and push. jsDelivr caches `@main` for up to a day; to see a change at once, open `https://purge.jsdelivr.net/gh/umutardaayhan/speed-reader-books@main/catalog.json`.

The app checks every catalog entry and leaves out any with a missing field, an unknown author or a link that is not http(s). Catalog format: see `src/engine/catalog.ts` in the app.
