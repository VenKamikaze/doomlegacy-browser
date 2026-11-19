# doomlegacy-browser

A fork of [Doom Legacy](http://doomlegacy.sourceforge.net/) 1.48.18 (SVN r1749), being ported to the browser (Emscripten/WebAssembly), with its networking replaced by [vnet](https://github.com/VenKamikaze/vnet). It follows the same approach as [jfsw-browser](https://github.com/VenKamikaze/jfsw-browser).

Upstream's own readme is [`README`](README), and its documentation is in [`docs/`](docs/index.html). The port's work briefs and notes are in [`doco/browser/`](doco/browser/README.md).

## Layout

| Path | What |
|---|---|
| `src/`, `Makefile`, `CMakeLists.txt`, `docs/`, `resources/`, `tools/`, `make_options_*`, ... | Upstream SVN trunk r1749, as released in `doomlegacy_1.48.18_source.tar.bz2` (unchanged) |
| `common/legacy.wad` | From `doomlegacy_1.48.18_common.zip`. The game needs it at run time; it is not built from this tree |
| `docs/release-1.48.18/` | The tarball's own top-level files (old readmes, make_options templates) |
| `ext/vnet/` | vnet, a git submodule pinned to `v0.5.0` |
| `scripts/` | Set-up, build, test-data and headless-run scripts for this port (`README.rst` and `release.sh` are upstream's) |
| `doco/browser/` | Briefs, the feasibility survey, building notes and bugs found |

Branches: `claudeai` is the integration branch, `browser/NN-*` are briefs, `fix/*` are upstream-ready fixes from `main`, which holds the pristine extract of the two release archives (`b1daf91`), and `emscripten-ports` holds the Emscripten port archives. See [`doco/browser/README.md`](doco/browser/README.md#git).

## Quick start (native, Linux)

```bash
git clone --recurse-submodules -b claudeai https://github.com/VenKamikaze/doomlegacy-browser
```

```bash
cd doomlegacy-browser && scripts/setup.sh && scripts/build-native.sh && scripts/fetch-test-data.sh
```

See [`doco/browser/building.md`](doco/browser/building.md) for the details, Emscripten set-up and headless runs.

## Licence

GPL v2 or later (see [`LICENSE`](LICENSE) and `docs/LICENSE.txt`). vnet is MIT. The test data (Freedoom, BSD-3-Clause, and the Doom shareware `DOOM1.WAD`) is downloaded by `scripts/fetch-test-data.sh` and never committed.
