// SPDX-License-Identifier: GPL-2.0-or-later
//
// The IWADs this page knows by name: the file name the game expects, the size and the SHA-256.
// tests/web/iwad-table.js checks this table against scripts/fetch-test-data.sh, so the two cannot drift.
// A file in the table is named after it when it is picked or downloaded without a declared name; any
// other IWAD is accepted too (data.js: "your own copy") and the game decides which game it is.
window.DL_IWADS = [
  { file: 'doom1.wad', game: 'Doom shareware 1.9', size: 4196020,
    sha256: '1d7d43be501e67d927e415e0b8f3e29c3bf33075e859721816f652a526cac771' },
  { file: 'freedoom1.wad', game: 'Freedoom: Phase 1 0.13.0', size: 28795076,
    sha256: '7323bcc168c5a45ff10749b339960e98314740a734c30d4b9f3337001f9e703d' },
  { file: 'freedoom2.wad', game: 'Freedoom: Phase 2 0.13.0', size: 28787748,
    sha256: 'a8772e088847032510d97ba2312406a6998f21cbab44d4ff10696faa9c0ecd4b' }
];
