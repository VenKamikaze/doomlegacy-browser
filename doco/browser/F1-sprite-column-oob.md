# F1: Sprites crash the 24/32 bpp column drawer on 64-bit builds (L1)

## Goal

Stop the segfault that every x86_64 build hits the first time the player's weapon sprite is drawn ([`bugs.md`](bugs.md) L1). The fix follows the upstream-fix pattern in [`README.md`](README.md#git): it can go upstream unchanged, and an integration branch adds the regression test.

## The bug

- `R_DrawColumn_24` and `R_DrawColumn_32` declare `unsigned int heightmask = dc_texheight - 1;` (`src/r_draw24.c:42`, `src/r_draw32.c:42`).
- Sprites are drawn with `dc_texheight = 0`, meaning "no wrap" (`src/r_things.c:1437`, `:2973`), so `heightmask` is `0xFFFFFFFF` and the power-of-two path runs.
- At the top of a sprite column, `frac` can be slightly negative (`frac = -6` was seen, with `count = 7`). `(frac >> FRACBITS) & heightmask` then promotes to `unsigned int` and gives 4294967295, not −1.
  - On a 64-bit build, `dc_source[4294967295]` is 4 GB past the column: segfault.
  - On a 32-bit build, the pointer arithmetic wraps to `dc_source[-1]`, so nothing shows. Upstream's default build is 32-bit (`ARCH=-march=i686`).
- `R_DrawColumn_8` declares the mask `int` (`src/r_draw8.c:144`). Every other column drawer (translucent, translated, shade, alpha, fog) indexes `dc_source[frac >> FRACBITS]` without a mask. All of them read `dc_source[-1]` in the same situation.
- `dc_source` is `(byte *)column + 3` (`src/r_things.c:1349`). Byte −1 is the post's unused pad byte, inside the patch.

## In scope

- `fix/sprite-column-oob`, from `main`: make the mask `int` in both functions. Nothing else.
- `browser/F1-sprite-column-oob`, from `claudeai`: merge the fix with `--no-ff`, add `tests/sprite-column-oob.sh`, and update the docs.

## Out of scope

- The `dc_source[-1]` pad-byte read itself, which all builds and all other drawers share; changing it would change what is drawn.
- The other sanitizer findings (`bugs.md` L8-L10).

## Acceptance criteria

1. The fix branch changes only the two declarations.
2. After the fix, `-warp 1 1` keeps running, and every demo of `freedoom1.wad`, `freedoom2.wad` and `doom1.wad` plays to its end with status 0, on x86_64.
3. `tests/sprite-column-oob.sh` passes on the fixed build and fails on the unfixed one.

## Outcome

Status: **done** (merged into `claudeai` with `--no-ff`, 19 Nov 2026).

**What landed**

- `fix/sprite-column-oob` (`cada39d`, from `main` `b1daf91`): `unsigned int heightmask` becomes `int heightmask` in `R_DrawColumn_24` and `R_DrawColumn_32`, with a short comment. It is two lines, in upstream's style, and the commit message is written for upstream. For an SVN patch, use `git format-patch --relative=doomlegacy_1.48.18/svn1749 -1 cada39d`; the paths are then trunk-relative.
- `browser/F1-sprite-column-oob`: `--no-ff` merge of the fix (`a70222a`). Git followed the rename into `src/` without conflicts. The branch also adds `tests/sprite-column-oob.sh` and these docs.

**Upstream check: not done.** The SourceForge SVN repository could not be read from the cloud container (the tree page shows no source, and the raw fetch was refused). To check whether a newer upstream revision has the fix, run on a machine with Subversion:

```bash
svn cat svn://svn.code.sf.net/p/doomlegacy/code/legacy_one/trunk/src/r_draw32.c | sed -n '/R_DrawColumn_32 (void)/,+3p'
```

The repository path is a guess: the HTTPS form of it returned 404 from here, and the project's SourceForge "Code" page shows the real checkout URL. If upstream already has `int heightmask` there, the fix is to move to that revision instead.

**Tests** (x86_64, gcc 13.3, Ubuntu 24.04, `SDL_VIDEODRIVER=dummy`)

- `tests/sprite-column-oob.sh`, 10 s of `-warp 1 1` per IWAD, in the default mode and with `-bpp 24`:
  - fixed build: 6 passed, 0 failed;
  - unfixed build: 0 passed, 6 failed, every case `exit 139` (segfault).
- `--full` adds DEMO1 of each IWAD played to the end.
- All 11 demos played to the end on the fixed build with status 0, with no errors in the logs. Times were 63-206 s, which matches each demo's length at 35 tics/s:

  | IWAD | Demos (time to finish) |
  |---|---|
  | `freedoom1.wad` | demo1 206 s, demo2 205 s, demo3 175 s, demo4 92 s |
  | `freedoom2.wad` | demo1 78 s, demo2 158 s, demo3 82 s, demo4 136 s |
  | `doom1.wad` | demo1 152 s, demo2 114 s, demo3 63 s |

- **Which drawer the test reaches:** under the dummy driver, the default mode, `-bpp 8` and `-bpp 24` all draw with `R_DrawColumn_32` (checked with gdb on the unfixed build), and `-bpp 15/16/32` choose a mode that never reached the crash. So `R_DrawColumn_24` is fixed by the same one-line change, but no test reaches it.
- **Sanitizers:** a debug build with `-fsanitize=address,undefined` (`scripts/build-native.sh --build build/asan -- DEBUG=1 "CC_EXPLICIT_CMD=gcc -fsanitize=address,undefined -fno-omit-frame-pointer"`) played `d1demo3` and `fd2demo1`.
  - Both runs were stopped by an unrelated `global-buffer-overflow` in `R_RenderSegLoop`, now `bugs.md` L8.
  - The UBSan reports are L9 and L10.
  - ASan cannot see the `dc_source[-1]` pad-byte read: lumps live inside Doom Legacy's own zone heap.

**For later briefs**

- The 16 bpp drawer masks sprites with `& 127` (`src/r_draw16.c:96`), as vanilla Doom did. It reads a different byte from the 8/24/32 bpp drawers on the same frame (`bugs.md` L11). This is cosmetic.
- An ASan build with `-fsanitize-recover=address` and `ASAN_OPTIONS=halt_on_error=0` would list every memory error in one run. That belongs with the baseline brief, before the native-against-wasm comparison.

### Review

An independent read-only reviewer gave the verdict **merge**, with no blocking findings. Its findings, which I re-checked against the code:

- **The fix is correct in both paths.** Sprites always take the power-of-two path (`0 & -1 = 0`), and the index there is now a signed −1. The odd-height path only tests `heightmask` and never indexes with it.
- **No other drawer has the unsigned mask.**
  - `R_DrawColumn_8` and the 8 bpp translucent drawers use `int` (`r_draw8.c:144`, `:677`, `:815`). The sky drawers and the 16 bpp drawer use int constants.
  - The span drawers mask with small positive masks.
  - The x86 assembly (`tmap.s`) builds only for 32-bit.
  - The drawers chosen at run time (`screen.c:307-442`) are all covered.
- **`dc_source[-1]` is the post's leading pad byte**, the same byte a 32-bit build reads (`r_defs.h:979-992`). Posts that Doom Legacy builds itself set it to 0 (`r_data.c:381`, `:1309`).
- **Rendering changes only where `dc_texheight <= 0`:** sprites, coronas and splats (`r_segs.c:841`). Walls and sky are unchanged.
- **Two bugs already in the code, recorded rather than fixed here:**
  - `R_DrawColumn_24`'s odd-height path lacks Boom's negative-`frac` wrap (`bugs.md` L12, 24 bpp only).
  - The 16 bpp `& 127` read can go past a short post (L11, refined).
  - Neither crashes or stops play, so under the bugs policy neither gets a brief.
- **Nit:** the trailing comment on the declaration is a little long. It is kept.
