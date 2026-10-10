# Longbox: DC comics catalog (PWA)

Every DC issue and collected edition from the Grand Comics Database, with:

- **Search** across series, trades, hardcovers, omnibuses, Absolute and Deluxe editions.
- **Book pages**: exactly which issues each book reprints (following reprint chains back to the original issues), format and binding, other editions of the same contents.
- **Collection and wishlist**: marking a book as owned checks off every issue inside it. Partial reprints (backup stories) are tracked separately.
- **Compare**: two lists of books, issues or whole series, or one list against your collection.
- **Run planner**: the fewest books that complete a run, plus what you'll need to get as single issues.
- **Offline**: the app shell is always cached; the catalog (~97 MB) can be saved to the device from "Data and offline use".

No backend: the catalog is a static SQLite file read with HTTP range requests (sql.js-httpvfs); your collection lives in the browser (IndexedDB) and can be exported/imported as JSON.

## Folder layout

```
comics-db/
  raw/            source data (GCD dump extract, catalog.sqlite.gz)
  etl/            data pipeline (Python 3, stdlib only)
  app/            the web app (Vite + React + TypeScript)
  covers/         downloaded cover thumbnails (created by fetch_covers.py)
```

## Run it locally

```bash
cd ~/Documents/comics-db
gunzip -k raw/catalog.sqlite.gz          # once
cd app
npm install
npm run data                              # builds public/db/ from raw/catalog.sqlite
npm run dev                               # http://localhost:5173
```

`npm run build` produces `app/dist/`, a static site you can host anywhere that supports HTTP range requests (Cloudflare Pages, GitHub Pages, Netlify…).

## Refresh the data (monthly)

GCD publishes a new dump at the start of each month (https://www.comics.org/download/, free account).

```bash
cd ~/work-or-any-scratch-folder
unzip ~/Downloads/current.zip                                 # -> YYYY-MM-DD.sql (~4 GB)
E=~/Documents/comics-db/etl
python3 $E/mysql2sqlite.py YYYY-MM-DD.sql gcd.sqlite \
  gcd_publisher,gcd_series,gcd_issue,gcd_story,gcd_reprint,gcd_story_type,gcd_series_publication_type,gcd_series_bond,gcd_series_bond_type,gcd_brand,gcd_brand_group,gcd_indicia_publisher,stddata_country,stddata_language,gcd_story_arc,gcd_story_story_arc
python3 $E/mysql2sqlite.py YYYY-MM-DD.sql credits.sqlite gcd_story_credit,gcd_creator_name_detail,gcd_credit_type,gcd_creator
python3 $E/build_catalog.py gcd.sqlite catalog.sqlite          # contents of each book, editions, formats
python3 $E/add_credits.py credits.sqlite catalog.sqlite        # writers / artists
gzip -kf catalog.sqlite && cp catalog.sqlite* ~/Documents/comics-db/raw/
cd ~/Documents/comics-db/app && npm run data && npm run build
```

Manual fixes go in `etl/overrides.csv` (add or remove issues from a book); they're applied on every build.

## Covers

`etl/fetch_covers.py` downloads one thumbnail per issue/book (Metron for issues, then Open Library and Google Books by ISBN for books) into `covers/<gcd_id>.jpg`. It needs a free Metron account, respects Metron's 20 requests/minute limit and can be stopped and resumed.

```bash
export METRON_USER='...'; export METRON_PASS='...'
python3 ~/Documents/comics-db/etl/fetch_covers.py --limit 200   # try it
python3 ~/Documents/comics-db/etl/fetch_covers.py               # everything (a few hours, ~1.5 GB)
```

The full set is too many files for Cloudflare Pages (20,000 file limit), so host covers in a Cloudflare R2 bucket (10 GB free, no egress fees) with public access, then build the app pointing at it:

```bash
VITE_COVERS_BASE=https://<your-bucket>.r2.dev npm run build
```

Without `VITE_COVERS_BASE` the app draws halftone placeholders.

## Deploy (free)

1. Create a Cloudflare Pages project and upload `app/dist/` (or connect a Git repo with build command `npm run data && npm run build`, output `dist`, root `app`; commit `raw/catalog.sqlite.gz` and add a `gunzip` step).
2. Optional: R2 bucket for covers as above.

## Data licence

Catalog data © Grand Comics Database, CC BY-SA 4.0 (https://www.comics.org). The derived catalog must keep the attribution and the same licence; the app code is yours. Metron data is also CC BY-SA 4.0. Cover images are © DC. Small catalog thumbnails are common practice on sites like GCD and Metron, but whether to publish them is your call.
