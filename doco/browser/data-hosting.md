# Hosting the game data

The browser build does not contain the game. The page (`web/data.js`) downloads one file, the Doom shareware IWAD `DOOM1.WAD` (version 1.9), from a URL you choose, checks it, and keeps it in the visitor's browser. This page says what to put on the server. It is about the data file; the whole deployment (Apache with TLS, the relay, desktop players) is brief 06's.

Only the **shareware** `DOOM1.WAD` is offered for public download (decisions D9 and D14). A person who owns the registered `DOOM.WAD`, `DOOM2.WAD` or another IWAD can pick it in the page ("Use your own copy..."); it stays on their machine and is never uploaded.

## What to serve

One file: the extracted `DOOM1.WAD`, **unmodified**, **4,196,020 bytes, SHA-256 `1d7d43be501e67d927e415e0b8f3e29c3bf33075e859721816f652a526cac771`** (MD5 `f0cefca49926d00903cf57551d901abe`, SHA-1 `5b2e249b9c5133ec987b3ea77596381dc0d6bc1d`: the published values for shareware 1.9, [DoomWiki](https://doomwiki.org/wiki/DOOM1.WAD)). The shareware licence lets it be distributed unmodified and free of charge; the licence text is in the original shareware distribution from id Software (`doom19s.zip`; read the text files in it) and is summarised on DoomWiki's DOOM1.WAD page. It is not quoted here: read it yourself before you publish. Do not repack or patch the file, or the page refuses it.

`scripts/fetch-test-data.sh --only doom1` produces a verified copy as `testdata/doom1.wad`: it downloads `doom1.wad.zip`, checks the zip, takes `DOOM1.WAD` out of it and checks the file against the values above. Copy that file to your server as `doom1.wad` (any name works: the page's `config.js` says which, below).

**Do not serve the zip.** The page does not unpack zips, and the public mirror the script uses (`www.jbserver.com`) sends no CORS headers, so a page on another origin cannot read it anyway. Put the extracted file on a server you control.

Freedoom 0.13.0 (BSD-3-Clause) can be served instead or as well (`freedoom1.wad`, 28,795,076 bytes, SHA-256 `7323bcc168c5a45ff10749b339960e98314740a734c30d4b9f3337001f9e703d`; `freedoom2.wad`, 28,787,748 bytes, `a8772e088847032510d97ba2312406a6998f21cbab44d4ff10696faa9c0ecd4b`). It is 7 times the size of the shareware file.

## Telling the page where it is: `config.js`

`config.js` sits next to `index.html`. Edit the copy in the folder you serve, not the one in `build/wasm/bin` (a rebuild overwrites that one):

```js
window.DL_CONFIG = { data: {
  url: 'doom1.wad',          // relative to the page, or a full URL
  name: 'doom1.wad',         // the file name the game sees
  size: 4196020,             // expected bytes (0: not declared)
  sha256: '1d7d43be501e67d927e415e0b8f3e29c3bf33075e859721816f652a526cac771',   // ('': not declared)
  revalidate: false          // see "Caching"
} };
```

- `url`: the default is next to the page, the same origin, which needs no CORS. A full URL on another origin needs the CORS headers below.
- `name`: **the game chooses the game by the IWAD's file name** (`src/d_main.c`, `game_desc_table`), and then checks that the file holds the key lumps. `doom1.wad` is "Doom shareware". The name here is what the page gives the game, whatever the file is called on the server. A name the game does not know makes it treat the file as "another IWAD" with Doom II rules.
- `size`, `sha256`: what the file must be. Keep them. With them the progress bar is right even when the response is compressed, and a wrong, damaged or cut-off file is refused before it is cached or handed to the game; the message says the size and SHA-256 found against the ones expected. Without them the page only checks that the file is an IWAD whose lump directory (and every lump) lies inside the file.
- `revalidate`: see "Caching".

`config.js` also holds a second entry, `freedoom1`, that is not used (`window.DL_CONFIG_EXAMPLES`). To serve Freedoom Phase 1, put the file on the server and write `data: freedoom1` in the `DL_CONFIG` line.

`?iwad=<url>` on the page address overrides `url`. The declared `name`, `size` and `sha256` are then not used: the file must be an IWAD, and the page names it after what it is (an exact match of the table in `web/iwads.js`, else the key lumps; an IWAD it cannot place keeps its own name). Another origin is allowed if its server sends CORS headers.

**Changing `url`, `name`, `size` or `sha256` makes every visitor download the file again** on their next visit, and the browser forgets its copy from the old URL.

`legacy.wad` (about 960 KB) is part of the build, not game data. It is served next to the page and the page does not cache it itself; the browser's HTTP cache does, by the headers below.

## MIME type

`application/octet-stream`. The page reads the bytes with `fetch`, so the type is not checked; this only keeps a server from guessing `text/plain` and rewriting the file. Apache has no type for `.wad`, so add one (below).

## Compression

`DOOM1.WAD` compresses well. Measured on `doom1.wad` (4,196,020 bytes) with the gzip of this container (GNU gzip 1.12, one core):

| | bytes | of the original | time |
|---|---|---|---|
| gzip -1 | 1,918,497 | 45.7 % | 0.09 s |
| gzip -6 (Apache's `mod_deflate` default) | 1,765,820 | 42.1 % | 0.23 s |
| gzip -9 | 1,756,050 | 41.9 % | 0.65 s |

(Freedoom Phase 1 at gzip -6: 10,366,562 of 28,795,076 bytes, 36 %. Brotli was not measured: it is not installed here.)

So gzip saves **58 %** of the transfer (4.2 MB becomes 1.8 MB), and the extra effort of `-9` buys 0.2 percent. On the fly with `mod_deflate` is enough.

What compression does to the page's progress: with `Content-Encoding`, `Content-Length` (if present) is the compressed size while the browser hands the page the decompressed bytes. The page therefore takes the total from the declared `size` in `config.js`, counts decompressed bytes, and the bar runs from 0 to 100 percent. If no size is declared (an `?iwad=` URL) and the response is encoded, it shows the megabytes so far and an unfilled bar, not a wrong percentage. Both are tested (`tests/web/data.js`, section 5). On a cross-origin server `Content-Encoding` is not readable by the page unless exposed; that case is tested too (the bar never passes 100 percent).

## Caching

The page keeps the file in the visitor's browser (IndexedDB, database `doomlegacy-data`), so the server's HTTP cache headers do not decide whether a returning visitor downloads again. The page asks `fetch` not to use the HTTP cache (`cache: 'no-store'`), so the browser does not keep a second copy. A returning visitor makes **no request for the file at all**, unless:

- `config.js`'s `url`, `name`, `size` or `sha256` changed, or
- the visitor presses "Download again", or
- `revalidate: true` is set. Then each load sends a conditional request (`If-None-Match` from the stored `ETag`, `If-Modified-Since` from `Last-Modified`). A `304` answer costs a few hundred bytes and the stored copy is used; a `200` replaces it; if the server cannot be reached, or answers 5xx, the stored copy is used with a notice.

Before it is trusted, the stored copy is hashed again (about 7 ms for the shareware file), so a damaged entry is dropped and downloaded again.

The page asks the browser to keep the data (`navigator.storage.persist()`, once, after it stored the file). Without it the browser may remove the copy under storage pressure; the page then downloads it again. If the browser has no room for the file the game still starts, with a notice that the data will be downloaded again next time.

If you replace the file on the server and want visitors to get it, change the file's URL (`doom1-v2.wad`) and `config.js`, or turn `revalidate` on. For a file that never changes there is nothing to do.

Still send good cache headers for other clients (a proxy, `curl`): `Cache-Control: public, max-age=86400` and an `ETag` (Apache sends one for static files). For the page's own files (`index.html`, `config.js`, `iwads.js`, `data.js`, `page.js`, `page.css`, `doomlegacy.js`, `doomlegacy.wasm`) use `no-cache`, so that a new build reaches every browser on its next load and the files stay of one build.

## CORS

Needed only when `url` is on a different origin from the page (a different scheme, host or port). The data server must send:

```
Access-Control-Allow-Origin: https://game.example.org      (or *)
```

and, if you set `revalidate: true`, also `Access-Control-Allow-Headers: If-None-Match, If-Modified-Since` (and answer the `OPTIONS` preflight that header causes with a `204` carrying the same headers) and `Access-Control-Expose-Headers: ETag, Last-Modified`, so the page can read the validators. Without `revalidate` there is no preflight.

A browser reports a blocked cross-origin request exactly like a network failure, so the page cannot tell them apart: its message names both and, when the URL is on another origin, adds the CORS hint ("that server must send an Access-Control-Allow-Origin header").

## Example: Apache

Placeholders only: `game.example.org`, `data.example.org`, `/srv/http/games/doom`.

Modules: `mod_mime`, `mod_filter` (for `AddOutputFilterByType` in 2.4), `mod_deflate`, `mod_headers`, and `mod_rewrite` for the preflight (`a2enmod filter deflate headers rewrite`, or `LoadModule` lines on Arch).

```apache
<VirtualHost *:443>
    ServerName game.example.org
    DocumentRoot /srv/http/games/doom
    # index.html, config.js, iwads.js, data.js, page.js, page.css, doomlegacy.js, doomlegacy.wasm,
    # legacy.wad and doom1.wad

    # Only matters when config.js has revalidate: true. mod_deflate rewrites the ETag of a compressed
    # answer to "...-gzip", which no longer matches the ETag the page stored, so Apache answers 200 and
    # sends the whole file on every load. NoChange (2.4.58 and later; allowed here and in the server
    # config, not in <Directory>) keeps the ETag as it is. The caveat: the compressed and the plain
    # answer now share one ETag. On an older Apache leave revalidate off.
    DeflateAlterETag NoChange

    <Directory /srv/http/games/doom>
        Require all granted
        AddType application/octet-stream .wad
        AddType application/wasm .wasm
        AddOutputFilterByType DEFLATE application/octet-stream application/wasm text/html text/css text/javascript application/javascript

        # The page keeps its own copy of the data, so this matters for other clients only.
        <FilesMatch "\.wad$">
            Header set Cache-Control "public, max-age=86400"
        </FilesMatch>
        # The page, its scripts and the wasm change with each deployment and must be of one build.
        <FilesMatch "\.(html|js|css|wasm)$">
            Header set Cache-Control "no-cache"
        </FilesMatch>
    </Directory>
</VirtualHost>
```

**If the IWAD is on another host** (`url: 'https://data.example.org/doom1.wad'` in `config.js`), give that host the same `AddType`, compression and `DeflateAlterETag` lines, and these CORS rules (the data host's virtual host, not the game's):

```apache
<VirtualHost *:443>
    ServerName data.example.org
    DocumentRoot /srv/http/games/data

    <Location "/doom1.wad">
        Header always set Access-Control-Allow-Origin "https://game.example.org"
        Header always set Access-Control-Expose-Headers "ETag, Last-Modified"
        # Only needed with revalidate: true (the conditional headers make the browser send a preflight):
        Header always set Access-Control-Allow-Headers "If-None-Match, If-Modified-Since"
        Header always set Access-Control-Max-Age "86400"
    </Location>
    # Answer the preflight (OPTIONS) with 204 and the headers above. <Location>, not <Files>:
    # the rewrite answers before the file is mapped, and <Files> would not apply.
    RewriteEngine On
    RewriteCond %{REQUEST_METHOD} OPTIONS
    RewriteRule ^/doom1\.wad$ - [R=204,L]
</VirtualHost>
```

**Not checked here:** there is no Apache in the build container, so these two blocks were not run through `apachectl configtest` or `curl`. They are the blocks that jfsw-browser's `data-hosting.md` checked with Apache 2.4.58 (`apache2 -t` said "Syntax OK"; `curl` showed gzip, an `ETag`, a `304` for a conditional request and the CORS headers on both `GET` and the `OPTIONS` preflight), with `.grp` changed to `.wad` and the placeholders changed. Run `apachectl configtest` and the `curl` checks below on your server before you rely on them (the play-test steps in brief 03's Outcome include them).

## Checking it

`curl -sI -H 'Accept-Encoding: gzip' https://game.example.org/doom1.wad` should show `200`, `Content-Type: application/octet-stream`, `Content-Encoding: gzip` and an `ETag`. To check the file you uploaded, download it with `curl -s --compressed -o check.wad https://game.example.org/doom1.wad` and run `sha256sum check.wad`: it must print `1d7d43be501e67d927e415e0b8f3e29c3bf33075e859721816f652a526cac771`, and the file must be 4,196,020 bytes. For the CORS headers: `curl -sI -H 'Origin: https://game.example.org' https://data.example.org/doom1.wad | grep -i access-control`.

## What the page does with the file (for whoever hosts it)

- It downloads with a progress bar, hashes the bytes (`crypto.subtle` SHA-256: 7 ms for this file; a page served over plain `http` from a LAN address has no `crypto.subtle`, and the page falls back to a JavaScript SHA-256: 42 ms), and refuses the file unless it matches `config.js`. A refused file is never cached and the game is not started.
- Every failure is a message on the page that names the file or the URL and offers "Use your own copy..." and "Try again": an HTTP error (404, 403, 500), a blocked or failed request (with the CORS hint), a cut-off download, a wrong file (the size and SHA-256 found against the expected ones), a file that is no IWAD.
- If the browser cannot keep the file (IndexedDB unavailable, as in some private windows; no space), the game starts anyway and says that the data will be downloaded again next time.

## The relay for network games (brief 04)

`web/config.js` has one more entry, `relay`, next to `data`. It is the vnet relay's WebSocket URL: `ws://HOST:PORT/vnet` for a trial, `wss://HOST/vnet` behind TLS in production. The default is `''`: the page offers no network game, and the game refuses `-relay` with a message. Brief 06 writes the deployment (the relay behind Caddy or nginx, the WebTransport port, certificates); until then:

- The page passes `relay` to the game, which asks vnet for `VNET_BACKEND_RELAY_AUTO`: with a `wss://` URL it also tries WebTransport at `https://` + the same host, port and path (3 s), and falls back to the WebSocket. The relay needs `-wt ADDR` with `-wt-cert` and `-wt-key` for that (`ext/vnet/relay/README.md`); the WebSocket endpoint stays up as the fallback. The game logs which one it got (`vnet: transport relay-wt` or `relay-ws`).
- `-origins HOST[:PORT]` on the relay must be the page's host (and port, if not the default).
- Only a test page (`?test=1`) can take a relay, a WebTransport URL (`relay_wt=`), the SHA-256 of a `-dev-cert` certificate (`relay_cert=`) or an impairment (`impair=`) from its address, so that a crafted link cannot send visitors to another relay. There is no menu or lobby yet (brief 05): a game is started with test arguments (`?test=1&args=-server%202`).
