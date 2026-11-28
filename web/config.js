// SPDX-License-Identifier: GPL-2.0-or-later
//
// Where the page gets the game data (brief 03). A person hosting the game edits this file, in the
// folder that is served (not in build/wasm/bin, which a rebuild overwrites). Read
// doco/browser/data-hosting.md before changing it.
//
//   url         The IWAD to download: relative to the page, or a full URL. A full URL on another
//               origin needs CORS headers (Access-Control-Allow-Origin) on the server.
//               Only the shareware DOOM1.WAD may be offered for public download (decision D14).
//   name        The file name the game sees (it picks the game by this name: doom1.wad is
//               "Doom shareware"). Not the name on the server.
//   size        Expected size in bytes (0 = not declared). With it the progress bar is right even
//               when the server compresses the response, and a wrong or cut-off file is refused.
//   sha256      Expected SHA-256 as 64 hex digits ('' = not declared). Without declared values the
//               page only checks that the file is an IWAD whose lump directory lies inside it.
//   revalidate  false (the default): once the file is stored in the browser, a reload makes no
//               request for it. true: each load asks the server "has it changed?"
//               (If-None-Match / If-Modified-Since); a 304 answer costs a few hundred bytes. The
//               server must send an ETag or Last-Modified, and on another origin must allow those
//               request headers and expose ETag and Last-Modified.
//
// Changing url, name, size or sha256 makes every browser download the file again on its next
// visit and forget the copy it had of the old url.
//
// ?iwad=<url> in the page address overrides url (name, size and sha256 are then not used: the file
// must be an IWAD, and is named after what it is).
(function () {
  'use strict';

  // Doom shareware 1.9 (id Software; free to distribute unmodified): the default (D14).
  var doom1 = {
    url: 'doom1.wad',
    name: 'doom1.wad',
    size: 4196020,
    sha256: '1d7d43be501e67d927e415e0b8f3e29c3bf33075e859721816f652a526cac771',
    revalidate: false
  };

  // Freedoom 0.13.0, Phase 1 (BSD-3-Clause). To serve it instead, write "data: freedoom1" below.
  var freedoom1 = {
    url: 'freedoom1.wad',
    name: 'freedoom1.wad',
    size: 28795076,
    sha256: '7323bcc168c5a45ff10749b339960e98314740a734c30d4b9f3337001f9e703d',
    revalidate: false
  };

  window.DL_CONFIG_EXAMPLES = { doom1: doom1, freedoom1: freedoom1 };
  window.DL_CONFIG = {
    data: doom1
  };
})();
