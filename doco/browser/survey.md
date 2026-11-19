# Doom source ports on the browser and vnet: feasibility survey (19 Nov 2026)

This survey looks at how easy it would be to port each of four Doom source ports to the browser (Emscripten/WebAssembly), with its networking replaced by vnet, as was done for jfSW and is being done for jfDuke3D.

It is research only. The facts come from reading the sources; nothing was built or run, except a test compile of Doom Legacy with Emscripten.

**Verdict:** port Doom Legacy first. It is the shortest path to what jfSW has. All four ports already support hot joining.

## Ranking (easiest first)

| Rank | Port | Language / size | Renderer / dependencies | Network model and transport | Hot join | Existing wasm work | Main risks | Effort (jfSW was about 10 briefs plus fixes) |
|---|---|---|---|---|---|---|---|---|
| 1 | Doom Legacy 1.48.18 | C, about 274k lines (software renderer 26k; OpenGL 23k, optional) | Software renderer (OpenGL optional); SDL1.2 or SDL2; SDL_mixer | Lockstep, with the server inside the game: the server collects inputs and sends `PT_SERVERTICS`, and every machine simulates. Raw UDP behind a 7-function driver table (`d_net.c:107-113`). | **Yes**: a joining player is sent the savegame (`d_clisrv.c:2348`, `2570-2600`) | None found | `-ffast-math` in both build systems; a few floats in gameplay; about 6 blocking loops; a hidden host tab slows everyone; one maintainer, on SVN | **7–9** |
| 2 | Odamex | C++17, about 246k lines plus libraries | Software only; SDL2, SDL2_mixer, libADLMIDI, protobuf, curl, FLTK, C++ exceptions | Client/server (the server decides). All UDP is in `common/i_net.cpp`, called from 19 places in 7 files. | **Yes** (`SV_ConnectClient`, `sv_main.cpp:1754`; `SV_JoinPlayer`, `:3338`) | None found | No server inside the client, so a browser host needs `odasrv` in a Web Worker; packets of up to 8192 bytes need splitting to fit vnet's 1100; heavy C++ dependencies | **9–11** |
| 3 | Zandronum 3.3-alpha | C++, 568k lines plus 123k lines of bundled libraries | Old fixed-function OpenGL or software; **SDL1.2 only**; **FMOD Ex only** for sound; OpenSSL required | Client/server, UDP in `network.cpp` (about 32 call sites in 10 files); 1024-byte packets by default, which fits vnet; LAN broadcast, master and auth servers | **Yes** (`joinqueue.cpp`) | None found | New sound backend; SDL2 port; blocking ZDoom main loop with a SIGALRM timer; server only as a separate process; licence not GPL-compatible (BUILD and id terms, non-commercial) | **16–20** |
| 4 | Doomsday Engine 3.0-dev | C++17, about 870k lines | OpenGL 3.3 / GLES3 only, no software renderer; the_Foundation (threads), glbinding, assimp | Client/server over **TCP**; UDP is used only for LAN discovery | **Yes** (`doc/readme/features.ame:56`) | None found | vnet has no TCP; needs pthreads and the COOP/COEP headers; dedicated server only; very large; 3 commits in 6 months | **25+** |

### Why this order

**Doom Legacy (1)**
- It has the same shape as jfSW. The host's game runs the server, so whoever creates the room is the server.
- The network seam is just `I_NetGet`, `I_NetSend`, `I_NetCanSend`, `I_NetMakeNode`, `I_NetOpenSocket`, `I_NetCloseSocket` and `I_NetFreeNodenum`, over node indices. `d_net.c` already does its own acks and resends.
- Hot join and desync repair (`cv_netrepair`) are already built in.
- **Test compile:** 100 of 110 files compile under Emscripten with no source changes beyond one prototype fix. Of the 10 that don't, 6 are files included into other files. The other 4 need build settings: IPX off, SDL_mixer, or `HWRENDER`.
- **Determinism:** the scan found no random calls passed together as arguments (the pattern behind Duke's D15), and gameplay code doesn't use `long`. The work is to drop `-ffast-math`, then check the floats in MBF friction and pushers with a per-tic state dump.
- **Data:** `DOOM1.WAD` or Freedoom, plus `legacy.wad` from the separate common zip.

**Odamex (2)**
- It has the cleanest UDP file and an active GPL project that takes GitHub pull requests.
- Client/server means there is no determinism work, and a hidden tab only lags its own player.
- It costs about two briefs more than Doom Legacy, for three reasons:
  - the server has to run as wasm in a Web Worker, or as a native server per room;
  - large packets have to be split to fit vnet;
  - protobuf, curl and FLTK have to be ported or stubbed out.

**Zandronum (3)**
- It has hot join and a UDP layer that fits vnet.
- But:
  - FMOD Ex has no wasm build;
  - it is SDL1-only and needs OpenSSL;
  - its main loop blocks;
  - its licence restricts use.
- The GitHub mirror's last commit is 2026-06-06. The official repository on Heptapod was unreachable, so the two couldn't be compared.

**Doomsday Engine (4)**
- Its multiplayer runs over TCP, so it would need a reliable stream built on vnet.
- It also needs threads, has an OpenGL-only renderer, and is by far the largest codebase.

## Recommendation

**Port Doom Legacy first.** It is the quickest route to the jfSW result: room codes, a host running in the browser, and native players in the same rooms. Brief 00 should:
- make a native and a wasm build without `-ffast-math`;
- compare a per-tic state hash between native and wasm;
- add a hot-join test;
- check whether the SVN maintainer accepts patches.

**Choose Odamex instead** if long-term upkeep, getting changes accepted upstream, and play over lossy or WebSocket connections matter more. It is the better product; Doom Legacy is the cheaper port.

## Other ports worth a look (not investigated; approval needed first)

- **Chocolate Doom, via `cloudflare/doom-wasm`:** a working Emscripten port already exists. Its WebSocket network module (`net_websockets.c`) plugs into Chocolate Doom's own network-module interface, and the host runs the server inside the game. It is lockstep and has **no hot join**.
- **Crispy Doom:** it shares Chocolate Doom's network layer, so doom-wasm's work should carry over. It has **no hot join** either.
- **GZDoom / UZDoom:** browser builds have been reported (Rosebud). It is lockstep peer-to-peer, with a heavy renderer.

## Port details

### Sources used

| Port | Where from | Version |
|---|---|---|
| Doom Legacy | SourceForge tarball (the redirect worked); sha256 `80f502afb4b7c6a87e5c291cf8b145e4e0c01bf0dde9a79c64a1306890a3eb19` | 1.48.18 = SVN r1749, released 2025-04-23 |
| Odamex | github `odamex/odamex` | `25a3898` (2026-11-18) |
| Doomsday Engine | github `skyjake/Doomsday-Engine` | `d45eb7f` (2026-11-02) |
| Zandronum | github `torrsamaho/zandronum` | 3.3-alpha, `bdd0f7b` (2026-06-06) |

Notes on the sources:
- **Doom Legacy:** the tarball's `srcdir` is a broken symlink to the packager's home directory; the real source is in `svn1749/`.
- **Odamex:** submodules were not cloned.
- **Zandronum:** the GitHub repository looks like a mirror converted from Mercurial (author names read "Trillster ext:(%22)", and there are ZDoom-era branches). It has 1 commit in the last 6 months. The official Heptapod repository (zandronum-stable) was unreachable (503 / connection reset).

### Doom Legacy (rank 1)

**Build**
- C; Makefile or CMake.
- The software renderer (`r_*.c`, 26k lines) is the one to keep. OpenGL in `hardware/` (23k lines) is optional (`HWRENDER`).
- SDL2 via `SDL2=1`; `sdl/i_video.c` has an `SDL_Window` path.
- Music goes through SDL_mixer; TiMidity and FluidSynth are optional.

**Test compile** (emsdk 6.0.13, `-sUSE_SDL=2 -DSDL2 -DSMIF_SDL -DLINUX`)
- 100 of 110 files compile.
- 6 of the failures are files included into others: `r_draw8/16/24/32` into `r_draw.c`, `p_henemy` into `p_enemy.c`, and `p_hpspr` into `p_pspr.c`.
- The other 4 need build settings:
  - `i_tcp.c` needs IPX off;
  - `i_sound.c` needs SDL_mixer;
  - `v_video.c` and `w_wad.c` need `HWRENDER`.
- One shim is needed: the `strupr`/`strlwr` prototypes at `doomtype.h:184-185` clash with Emscripten's `compat/string.h`. It is a one-line fix.

**Network**
- `d_net.c:107-113` is a table of function pointers: `I_NetGet`, `I_NetSend`, `I_NetCanSend`, `I_NetCloseSocket`, `I_NetFreeNodenum`, `I_NetMakeNode` and `I_NetOpenSocket`. Data goes through `doomcom` (`i_net.h`), addressed by node index.
- All raw sockets are in `i_tcp.c`, with about 33 references from `d_net.c`, `d_clisrv.c` and `mserv.c`.
- `d_net.c` does its own acks and resends.
- Plan:
  - write an `i_vnet.c` that fills the table;
  - cap `hardware_MAXPACKETLENGTH` at 1100 bytes or less;
  - drop the LAN broadcast search (`CL_Broadcast_AskInfo`, `d_clisrv.c:2929`), the TCP master server (`mserv.c`) and IPX.

**Netcode model**
- The server runs inside the game, as a listen server, or separately with `-dedicated`.
- It gathers `PT_CLIENTCMD`, sends `PT_SERVERTICS`, and every node runs `G_Ticker` (`TryRunTics`, `d_clisrv.c:5733`).
- That makes it star-shaped lockstep, like jfSW's master/slave mode, and the room creator is the server.

**Hot join: yes**
- `JOININGAME` is defined at `d_clisrv.c:191`.
- The server sends the savegame (`SV_Send_SaveGame`, `:2348`), the client loads it (`CL_Load_Received_Savegame`, `:2385`), and the client's download loop is at `:2570-2600`.
- The same mechanism repairs desyncs (`cv_netrepair`, `:401-405`).
- Up to 32 players and 32 nodes.

**Blocking loops**
- `D_DoomLoop` (`d_main.c:1034`) does one frame per pass, which is fine.
- These loops block, and each needs an ASYNCIFY yield:
  - `CL_ConnectToServer`, a do/while ending at `d_clisrv.c:3313`;
  - the savegame download loop at `:2583`;
  - the screen-wipe busy-wait at `d_main.c:1003-1017`;
  - a menu busy-wait at `m_menu.c:4964`.

**Determinism**
- The scan found no random calls passed together as arguments (Doom Legacy uses `P_SignedRandom`), and gameplay code doesn't use `long`.
- `-ffast-math` is set in `src/Makefile:1357` and `CMakeLists.txt:86`, and must be removed.
- Floats in gameplay:
  - MBF friction, `p_enemy.c:993-1052`;
  - pushers, `p_spec.c:4268`;
  - `p_user.c:856-912`;
  - `sqrt` in `p_setup.c` and `p_extnodes.c`.
- The float intercept code is under `#if 0`, and bot aiming runs only on the server.
- Verify with a per-tic state hash like jfSW's `-testdump`.

**Browser**
- A hidden host tab paces every player, as jfSW's master did, so it needs the same wake / MessageChannel work.
- Saves and config go in IDBFS.
- Data: `DOOM1.WAD` or Freedoom, plus `legacy.wad` from `doomlegacy_1.48.18_common.zip`.

**Licence and project health**
- GPLv2 or later.
- One maintainer (WDJ); SVN; the previous release was 1.48.16, in November 2024.

### Odamex (rank 2)

**Build**
- C++17, CMake; software renderer only.
- SDL2 video and input (`client/sdl/i_video_sdl20.cpp`, `i_input_sdl20.cpp`).
- There is a Nintendo Switch port.

**Dependencies**

| Dependency | What it would take |
|---|---|
| SDL2, SDL2_mixer, zlib, libpng | Emscripten ports exist |
| libADLMIDI | should compile |
| protobuf | needs `protoc` on the build machine |
| curl (`otransfer.cpp`) | stub it out, or use `emscripten_fetch` |
| FLTK boot window (`gui_boot.cpp`), portmidi, miniupnp, cpptrace | turn off |

Also:
- `odamex.wad` is built by a Python script (`wad/odawad.py`).
- C++ exceptions are used (`CRecoverableError`, `client/src/d_main.cpp:357`), so the build needs `-fexceptions`.

**Network**
- All sockets are in `common/i_net.cpp`, with `select` in `NetWaitOrTimeout`.
- `netadr_t` is an IPv4 address and a port; the default port is 10666.
- Call sites:
  - client: `cl_main` 6, `cl_game` 3;
  - server: `sv_main` 3, `sv_rproto` 3, `sv_sqp` 2, `sv_master` 1, `sv_sqpold` 1.
- The master server and the launcher query protocol would be stubbed out.
- `MAX_UDP_PACKET` is 8192 (`i_net.h:29`), and `sv_rproto.cpp:151-253` packs both buffers into one send. Packets would need splitting inside the vnet shim, or the buffers capped.

**Netcode**
- Client/server; the server decides.
- Hot join: yes (`SV_ConnectClient`, `sv_main.cpp:1754`; `SV_JoinPlayer`, `:3338`).
- There is no server inside the client: `odasrv` is a separate program. A browser host would need either:
  - `odasrv` built as wasm in a Web Worker, with its own vnet context, creating the room; or
  - a native `odasrv` per room on the relay machine.

**Main loop**
- `D_RunTics` (`common/d_main.cpp`) does one pass with schedulers, which suits `emscripten_set_main_loop`.
- Its only sleep is at `common/d_main.cpp:1570`.

**Determinism:** not a concern, because it is client/server. The scan found nothing.

**Licence and project health**
- GPLv2 or later.
- About 640 commits from 13 authors in the last 6 months, with GitHub pull requests: the most upstream-friendly of the four.

### Zandronum (rank 3)

**Build**
- C++; `src/` is 568k lines (OpenGL 76k), plus about 123k lines of bundled libraries.
- Python is needed at build time.

**Blockers**
- SDL1.2 only (`src/CMakeLists.txt:261`).
- FMOD Ex is the only sound backend (`sound/fmodsound.cpp`), so it needs a new one, or `NO_SOUND`.
- OpenSSL is required (`CMakeLists:684`).
- Also uses sqlite, GeoIP and Opus/rnnoise; the x86 assembly is optional.
- The OpenGL renderer is old fixed-function, so build with `NO_GL` and use the software renderer.

**Network**
- Client/server, with UDP in `network.cpp` and about 32 call sites in 10 files.
- `sv_maxpacketsize` defaults to 1024 (`sv_main.cpp:375`), which fits vnet.
- It also uses a LAN broadcast socket (`network.cpp:391`) and master and auth servers.
- Hot join: yes (`joinqueue.cpp`).
- The server is a separate process; `-host` turns sound off (`sound/i_sound.cpp:256`).

**Main loop**
- `d_main.cpp:1285` is a `for(;;)` loop with `I_WaitForTic` (`d_net.cpp:1746`).
- It uses a SIGALRM/`setitimer` timer (`sdl/i_system.cpp:286`).

**Determinism:** the scan found 3 places with random calls passed together as arguments (`p_mobj.cpp:4101`; `thingdef_codeptr.cpp:3240` and `:3669`). They matter little in a client/server game.

**Licence**
- Zandronum's own code is BSD/Sleepycat-style.
- It also includes `docs/BUILDLIC.TXT` (non-commercial, Internet-only terms) and `docs/doomlic.txt`.
- The result is not GPL-compatible. MIT-licensed vnet is fine with it.

### Doomsday Engine (rank 4)

**Build**
- C++17, about 870k lines.
- Uses the_Foundation (`libs/core/CMakeLists.txt:8`) and threads (`socket.cpp:342`).
- OpenGL 3.3, GLES3 or GLES2 only (`libs/gui/CMakeLists.txt:10-58`); no software renderer.
- Also glbinding, assimp and FluidSynth.

**Network**
- TCP (`doc/server/manpage.ame:55`; `socket.cpp`, `listensocket.cpp`).
- UDP is used only for the LAN beacon, on ports 13209-13224.
- Dedicated server only.
- Hot join: yes (`features.ame:56`), but the docs link to a list of known multiplayer problems.

**Licence and project health**
- GPLv3, with LGPLv3 libraries.
- 3 commits in the last 6 months.

## What couldn't be checked

- GitHub's API and issue search were blocked (403), so the search for existing wasm work covered only the source trees and web search, not issues or fork lists.
- Zandronum's Heptapod repository and zandronum.com returned 503 or reset the connection.
- Doom Legacy's SVN log couldn't be parsed.
- Nothing was fully built:
  - only Doom Legacy got a test compile;
  - submodules weren't fetched;
  - downloading Emscripten's `sdl2_mixer` port returned 403 here.
- Line counts come from `wc -l` (cloc wasn't available).
- The scan for random calls passed together as arguments is a heuristic.
- Effort figures are estimates.

Downloaded sources are in `/home/user/doom-survey/<name>/src`.
