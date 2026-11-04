# Manual media scripts

The screenshots in `../img/` and the videos in `../video/` are generated from a real QAtlas
instance with Playwright (`@playwright/test` and its Chromium from `web/node_modules`), so they
can be refreshed after UI changes.

| File | Does |
|---|---|
| `lib.mjs` | Shared helpers: browser context (theme, viewport), sign-in, API calls, waits, redaction |
| `screenshots.mjs` | All PNGs: 1440×900 at device scale 1, light theme; plus dark-theme, 390 px mobile (scale 2), and Indonesian-UI shots |
| `videos.mjs` | The walkthroughs (end-to-end demo + three short ones) as raw `.webm` (1280×800) |
| `encode.sh` | `.webm` → MP4 (H.264, CRF 28, faststart), the README GIF (960 px, 10 fps) and the end-to-end poster |

## Run

You need a QAtlas instance seeded with `qatlas seed demo`, a worker, and the demo shop. The
easiest is the demo server on this machine:

```bash
scripts/demo-server.sh start          # http://127.0.0.1:8090, demo shop on :8099

cd web
node ../docs/manual/scripts/screenshots.mjs              # every screenshot
node ../docs/manual/scripts/screenshots.mjs run-dialog   # only shots whose name contains "run-dialog"
RAW_DIR=/tmp/qatlas-manual-raw node ../docs/manual/scripts/videos.mjs
cd ..
RAW_DIR=/tmp/qatlas-manual-raw docs/manual/scripts/encode.sh
```

`QATLAS_URL` points the scripts at another instance (default `http://127.0.0.1:8090`). The
scripts must run from `web/` so `@playwright/test` resolves.

## What they change on the instance

They are not read-only. Expect new runs, plus:

- `screenshots.mjs`: completes one SHOP-F3 manual run for Rina (the seeded SHOP-R3, or a new
  one), creates the invited user Nina Lestari once (later runs regenerate her invite link),
  creates an API token and **revokes it immediately**, and switches Dimas's language to Bahasa
  Indonesia for two shots and back to English.
- `videos.mjs`: creates a new test case each time for walkthrough (a), creates or resets
  "Product page shows the current price" for (b), and completes a SHOP-F3 manual run for (c).

## Redaction

Shots that would show a credential are redacted in the page before the screenshot: the API
token and its prefix become `qat_xxxxxxxx_…`, invite tokens become `xxxx…`, and the instance
origin becomes `https://qatlas.example.com`. Check every new image before committing it, and
never commit a screenshot with a working token.

## Checks before committing

```bash
du -sh docs/manual                    # keep the media under ~40 MB in total
# every image/video link in the manuals points to an existing file
for f in docs/manual/README.md docs/manual/README.id.md README.md; do
  dir=$(dirname "$f")
  grep -oE '\((img|video|docs/manual/(img|video))/[^)]+\)|src="[^"]+"' "$f" \
    | sed -E 's/^\(|\)$//g; s/^src="|"$//g' \
    | while read -r p; do test -f "$dir/$p" || echo "missing in $f: $p"; done
done
```
