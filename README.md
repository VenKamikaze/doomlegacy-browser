# emscripten-ports

Orphan branch. Library archives that Emscripten 6.0.13 would otherwise download
from GitHub, which some networks (the cloud container) block with HTTP 403.
`scripts/setup-emsdk.sh --with-ports` (on `claudeai` and the feature branches)
fetches this branch, checks each archive's SHA-512 against `tools/ports/<name>.py`
in the pinned emsdk (`d7b4130`), and seeds Emscripten's cache with it.

| File | Port | URL Emscripten fetches |
|---|---|---|
| release-2.32.10.zip | sdl2 | https://github.com/libsdl-org/SDL/archive/release-2.32.10.zip |
| libogg-1.3.5.zip | ogg | https://github.com/xiph/ogg/releases/download/v1.3.5/libogg-1.3.5.zip |
| libvorbis-1.3.7.zip | vorbis | https://github.com/xiph/vorbis/releases/download/v1.3.7/libvorbis-1.3.7.zip |
| release-2.8.0.zip | sdl2_mixer | https://github.com/libsdl-org/SDL_mixer/archive/release-2.8.0.zip |

`SHA512SUMS` lists every archive; each value equals the `HASH` in the pinned
emsdk's port file.

Where they came from (19 Nov 2026):

- sdl2, ogg, vorbis: copied from jfsw-browser's `emscripten-ports` branch
  (`a8ec8bc`), which pins the same emsdk.
- sdl2_mixer: the GitHub archive URL is blocked here, so the zip was rebuilt
  from the tag with git, which reproduces GitHub's archive byte for byte when
  run in GitHub's time zone:

      git fetch --depth 1 https://github.com/libsdl-org/SDL_mixer.git refs/tags/release-2.8.0:refs/tags/release-2.8.0
      TZ=America/Los_Angeles git archive --format=zip --prefix=SDL_mixer-release-2.8.0/ -o release-2.8.0.zip release-2.8.0

  (git 2.43.0; tag commit `40cd9d8`). Its SHA-512 equals the port's `HASH`.

Library archives only; never game data. If the emsdk pin changes, refresh them.
Never force-push this branch.
