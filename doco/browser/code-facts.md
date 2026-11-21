# Code facts

What the sources say, checked at this tree (brief 00; Doom Legacy 1.48.18, r1749, plus the changes of this branch). File:line refs are to `src/` as it is now. [`survey.md`](survey.md) (19 Nov 2026) is the source of the claims in §1; where its line numbers are one or two off, that is because this branch added an `#include` near the top of `d_clisrv.c`, `d_main.c` and `g_game.c`.

Contents: §1 the survey's claims, §2 the network driver, §3 start-up, §4 the join, §5 consistency, §6 blocking loops, §7 floats, §8 savegame portability, §9 files, §10 music, §11 the state hash, §12 the wasm build.

## 1. The survey's claims

Verdicts: **confirmed**, **corrected** (with the right facts), **not found**.

| Claim (survey, "Doom Legacy (rank 1)") | Verdict | Facts |
|---|---|---|
| C; Makefile or CMake | confirmed | `src/Makefile`, `CMakeLists.txt`. 99 `.c` files in `src/`, 28 more in `src/sdl`, `src/hardware` and below; 268,443 lines of `.c` and `.h` in all. |
| The software renderer, `r_*.c`, is 26k lines | **corrected** | `r_*.c` are 23,239 lines. The "26k" would be the whole software side with `r_draw*.c` and friends; the hardware directory (`hardware/*.c`, `hardware/r_opengl/*.c`) is 16,427 lines, not 23k. |
| OpenGL is optional (`HWRENDER`) | **corrected** | It is optional in the code, but the upstream Makefile for SDL always defines it (`src/Makefile:920`) and links `-lGL -lGLU`. Without `HWRENDER`, `w_wad.c` and `v_video.c` did not compile (`bugs.md` L13, fixed here), and `sdl/i_video.c` refers to the OpenGL window code with no guard at all (`sdl/i_video.c:409`, `:1020-1060`, `:1118-1134`, `:1366`, `:1420`; L14). The wasm build gets around that with `sdl/i_nohwr.c`. |
| SDL2 via `SDL2=1`; `sdl/i_video.c` has an `SDL_Window` path | confirmed | `src/Makefile:810`; `sdl/i_video.c:858-902` (`SDL_CreateWindow`, `SDL_GetWindowSurface`), SDL 1.2 path at `:918`. The game draws into an 8/16/24/32 bpp software surface and presents it with `SDL_UpdateWindowSurface`. |
| Music goes through SDL_mixer; TiMidity and FluidSynth are optional | confirmed | `sdl/i_sound.c` (`HAVE_MIXER`); `HAVE_TIMIDITY`, `HAVE_FLUIDSYNTH` in `src/Makefile:731-740`; `MIX_INIT_FLUIDSYNTH` at `sdl/i_sound.c:969-998`. The path is §10. |
| Test compile: 100 of 110 files with emsdk 6.0.13 | confirmed, and finished | With the guard below and the three small changes in §12, every source of the build compiles and links (105 of them, without `hardware/*`, `sdl/ogl_sdl.c`, `sdl/hwsym_sdl.c`, `sdl/dosstr.c`). |
| 6 of the failures are files included into others | confirmed | `r_draw.c:753,761,770,779` includes `r_draw8/16/24/32.c`; `p_enemy.c:5576` includes `p_henemy.c`; `p_pspr.c:1643` includes `p_hpspr.c`. They are not compiled on their own. |
| `i_tcp.c` needs IPX off; `i_sound.c` needs SDL_mixer; `v_video.c`, `w_wad.c` need `HWRENDER` | **corrected** | `i_tcp.c`: `USE_IPX` is defined in `doomdef.h:161` and `i_tcp.c` then includes `<linux/ipx.h>`; fixed with an `#undef` for `__EMSCRIPTEN__` next to the ones for Solaris, NetBSD and OpenBSD (`i_tcp.c:~190`). `i_sound.c`: needs `HAVE_MIXER` (`MUS_NONE` and friends are used without it at `sdl/i_sound.c:819-821`); the SDL2_mixer port is seeded. `v_video.c` and `w_wad.c` did **not** need `HWRENDER`: they did not compile without it, which is a bug (L13). |
| `strupr`/`strlwr` prototypes at `doomtype.h:184-185` clash with Emscripten's `compat/string.h` | confirmed | They were at `doomtype.h:184-185` (and `:183-186` with the `#if`). Emscripten declares `char *strupr(char *)` and the sources declare `int strupr(char *)`. Guarded with `!defined(__EMSCRIPTEN__)` (`doomtype.h:183-188`). `sdl/dosstr.c` defines both functions too, so the wasm build leaves it out and uses Emscripten's own. |
| The network driver table is `d_net.c:107-113`: `I_NetGet`, `I_NetSend`, `I_NetCanSend`, `I_NetCloseSocket`, `I_NetFreeNodenum`, `I_NetMakeNode`, `I_NetOpenSocket` | **corrected** | The entry is `I_NetFreeNode`, not `I_NetFreeNodenum` (`d_net.c:111`). Seven pointers, `d_net.c:107-113`. See §2. |
| "About 33 references from `d_net.c`, `d_clisrv.c` and `mserv.c`" | **corrected** | The table functions are used on 37 lines outside `i_tcp.c`: `d_net.c` 26 (12 of them are the table and its two reset blocks, `d_net.c:1797-1802`, `:2013-2018`), `d_clisrv.c` 7 (`:3034`, `:3062`, `:3386`, `:3397`, `:3400`, `:4350`), `mserv.c` 4 (`:526`, `:537`, `:588`, `:614`). The real calls are the nine in §2. Raw sockets are also used directly by `mserv.c:649` (TCP, the master server). |
| `d_net.c` does its own acks and resends | confirmed | `Net_AckTicker` (`d_net.c:702`), retransmission buffers `pak[MAXPACKETLENGTH]` (`d_net.c:258`). Reliable sends are `SP_reliable` (`HSendPacket`). |
| Plan: an `i_vnet.c` fills the table; cap `hardware_MAXPACKETLENGTH` at 1100 | confirmed, and easier | `hardware_MAXPACKETLENGTH` is already 512 (`INETPACKETLENGTH`, `i_net.h:53`) for a server and for a client that connects to an address (`i_tcp.c:1550-1572`); only `connect any` (a LAN) uses 1450 (`i_tcp.c:1580`). So 1100 or less is the existing internet path. See §2. |
| Drop the LAN broadcast search (`CL_Broadcast_AskInfo`, `d_clisrv.c:2929`) | confirmed | Now `d_clisrv.c:2960`. `connect any` and the menu's server search use it (`:3055`, `Command_connect` `:3380`). |
| The server runs inside the game (listen server) or alone with `-dedicated` | confirmed | `d_net.c:1813-1822` (`-dedicated`, `-server`); §3. |
| It gathers `PT_CLIENTCMD`, sends `PT_SERVERTICS`; every node runs `G_Ticker` (`TryRunTics`, `d_clisrv.c:5733`) | confirmed | `TryRunTics` is at `d_clisrv.c:5765`, `PT_CLIENTCMD` handled at `:5410`, `SV_Send_Tics` at `:5015`, `G_Ticker` run at `:5882`. The server does not send tics to itself (the comment at `:5872`). |
| Hot join: `JOININGAME` at `d_clisrv.c:191`; `SV_Send_SaveGame` `:2348`; `CL_Load_Received_Savegame` `:2385`; the client's download loop `:2570-2600` | confirmed | `:192`, `:2349`, `:2386`, `:2570-2620` (the repair path; the join path is in `CL_ConnectToServer`, `:3211-3258`). Steps in §4. |
| The same mechanism repairs desyncs (`cv_netrepair`, `:401-405`) | confirmed | `:402-404`; `cv_SV_netrepair` on the server; the savegame is suggested after the 3rd (Medium) or 3rd and 7th (Aggressive) fault (`consistency_sg_bit`, `:408`). §5. |
| Up to 32 players and 32 nodes | confirmed | `MAXPLAYERS` 32 (`doomdef.h:454`), `MAXNETNODES` 32 (`d_net.h:50`), `BROADCAST_NODE` 32, `MAX_CON_NETNODE` 34 (`d_net.h:52-56`). `cv_maxplayers` (`sv_maxplayers`) defaults to 32 (`d_clisrv.c:3659`). |
| Blocking loops: `D_DoomLoop` (`d_main.c:1034`) is fine; `CL_ConnectToServer` ends at `d_clisrv.c:3313`; the download loop `:2583`; the wipe busy-wait `d_main.c:1003-1017`; a menu busy-wait `m_menu.c:4964` | confirmed, and more | `D_DoomLoop` `d_main.c:1035`, loop `:1086`; `CL_ConnectToServer` loop ends `:3314`; download loop `:2584`; wipe `:1005-1018` (inner `while (!tics)` `:1011`); menu `m_menu.c:4965`. Four more in §6. |
| The scan found no random calls passed together as arguments; gameplay uses no `long` | confirmed | Doom Legacy's `P_SignedRandom` is written as two statements; `grep` finds no function call with two `P_Random()` arguments. `long` is not used in `p_*.c`, `g_game.c`, `b_*.c`, `m_fixed.c` (the savegame code has a few, §8). |
| `-ffast-math` at `src/Makefile:1357` and `CMakeLists.txt:86` | confirmed | Both lines as said. Native: `scripts/build-native.sh` now ends every compile line with `-fno-fast-math` (`scripts/cc-no-fast-math.sh`). CMake: left alone (the project does not use it); the line to change is `CMakeLists.txt:86`. |
| Floats in gameplay: MBF friction `p_enemy.c:993-1052`, pushers `p_spec.c:4268`, `p_user.c:856-912`, `sqrt` in `p_setup.c` and `p_extnodes.c` | confirmed, with more | §7. `m_fixed.c:50-57` (`FixedDiv2`) divides in `double` and is used everywhere. |
| The float intercept code is under `#if 0`; bot aiming runs only on the server | **corrected** | The float `P_InterceptVector` variants are under `#if 0` (`p_maputl.c:240-300`): confirmed. Bot aiming is **not** server-only: `G_Ticker` runs `B_BuildTiccmd` for every bot on every machine (`g_game.c:1758-1764`, "All clients run the bots, identically"), and `b_game.c:742` uses `atan` and `double`. See §7. |
| A hidden host tab paces every player | not checked here (browser) | Brief 04. |
| Saves and config go in IDBFS; data is `DOOM1.WAD` or Freedoom, plus `legacy.wad` from `doomlegacy_1.48.18_common.zip` | confirmed | §9. The game does not start without `legacy.wad` (it shows a launcher error and waits for ESC: `d_main.c:3021`). `common/legacy.wad` is in this repository. |

## 2. The network driver and `doomcom`

The table (`d_net.c:107-113`) and its callers:

| Pointer | Set by (UDP) | Called by | With |
|---|---|---|---|
| `I_NetOpenSocket` | `I_Init_TCP_Network` → `SOCK_OpenSocket` (`i_tcp.c:1584`) | `CL_Update_ServerList` `d_clisrv.c:3064`, `Command_connect` `:3417`, `SV_SpawnServer` `:4381` | no arguments; opens the UDP socket and fills the other six (`i_tcp.c:1465-1476`) |
| `I_NetGet` | `SOCK_Get` (`i_tcp.c:675`) | `HGetPacket` `d_net.c:1724` | none; fills `doomcom->data`, `doomcom->datalength` and `doomcom->remotenode`; returns 0 or `net_error` |
| `I_NetSend` | `SOCK_Send` (`i_tcp.c:863`) | `HWSend` `d_net.c:1643`; `mserv.c:588` | none; sends `doomcom->datalength` bytes of `doomcom->data` to node `doomcom->remotenode` |
| `I_NetCanSend` | `SOCK_CanSend` (`i_tcp.c:833`) | `d_net.c:1596` | none; may be NULL; true if a send would not block |
| `I_NetMakeNode` | `SOCK_NetMakeNode` (`i_tcp.c:1347`) | `Command_connect` `d_clisrv.c:3431`, the server search `:3092`, `mserv.c:537` | a host name or `host:port` string; returns a node number (255 = failed) |
| `I_NetFreeNode` | `SOCK_FreeNode` (`i_tcp.c:650`) | `d_net.c:974` (`Net_CloseConnection`), `mserv.c:614`, `i_tcp.c:1415` | a node number; node 0 and numbers above `MAXNETNODES` are never freed |
| `I_NetCloseSocket` | `SOCK_CloseSocket` (`i_tcp.c:1309`) | `D_Close_NetGame`-side code at `d_net.c:2010` | none |

Before a network game they all point to `Internal_Get`, `Internal_Send` and `Internal_FreeNode` (`d_net.c:125-140`, `:1797-1802`), which report `NE_not_netgame`.

- **Nodes.** A node is a small integer, an index into `net_nodes[]` (`d_net.c`) and into the address table of the driver (`clientaddress[]`, `node_hash[]`, `i_tcp.c`). Node 0 is the local machine (self; "nnode==0 is self, which is always accepted", `d_clisrv.c:4484`). A client's node for the server is `cl_servernode`. `BROADCAST_NODE` (32) is "all"; `MS_PINGNODE` (33) is the master-server ping; both are above the 32 real ones.
- **The packet.** `doomcom_t` (`i_net.h:66-124`) holds `remotenode`, `datalength`, `extratics` and `data[MAXPACKETLENGTH]`; the rest is DOS-only. `netbuffer` points to `doomcom->data` (`d_net.c:1900`). Callers fill `netbuffer` and call `HSendPacket(node, flags, acknum, length)`; `HGetPacket` fills it.
- **Sizes.** `MAXPACKETLENGTH` is 1450 (`i_net.h:52`) and sizes `data[]`. `hardware_MAXPACKETLENGTH` (`d_net.c:104`) is what the driver can carry: 512 on the internet path, 1450 on a LAN (`i_tcp.c:1550-1580`), set by the driver's init. `software_MAXPACKETLENGTH` (`d_clisrv.c:415`) is what the game builds: `hardware_MAXPACKETLENGTH`, or the `-packetsize` value if smaller (`d_net.c:1941-1949`). The tic packets are limited by it (`d_clisrv.c:842`, `:5092-5125`, `:2127`). vnet's 1,100 bytes are therefore enough, and `hardware_MAXPACKETLENGTH = 1100` (or less) in an `i_vnet.c` is all that has to change; nothing in the game needs more than 512.
- **Connections.** Reliable packets and their acks are the game's own, per node (`Net_AckTicker` `d_net.c:702`, `InitNode` `:870`, a ping estimate and a timeout in `net_nodes[]`). A silent node times out (`PT_NODE_TIMEOUT`, `d_clisrv.c:5431`).
- **UDP address handling** is in `i_tcp.c` only (IPv4 `sockaddr_in`, the hash of addresses `NODE_ADDR_HASHING`). The master server (`mserv.c`) uses a TCP socket of its own (`mserv.c:649`) and asks for `I_NetMakeNode` for its UDP ping; `-nomserv`-like behaviour for vnet means not calling `MS_*` (`mserv.c`), which the menu does only when the user opens the internet server list.

## 3. Start-up: `-server`, `-connect`, `-dedicated`

`D_Startup_NetGame` (`d_net.c:1784-1990`, called from `D_DoomMain` at `d_main.c:3456`) decides the mode; it ends by calling `D_Init_ClientServer` (`d_net.c:1983`) for the node tables:
- `server = true; netgame = false` by default.
- `-dedicated`: `server = true; netgame = true;` `cv_wait_players = 0` (`d_net.c:1813-1820`). No local player (`G_Ticker` skips player ticcmds when `dedicated`: `g_game.c:1758`).
- `-server [N]` (`:1822-1850`): `server`, `netgame`, `N` = number of player nodes to wait for (the local machine counts), default 1; `0` means "start after the wait timeout and allow others in". `N` is stored in `cv_wait_players` (`:1855`).
- `-connect [ADDR]` (`:1854`): `server = false`; `netgame` is set later by the `connect` command that `I_Init_TCP_Network` queues (`i_tcp.c:1555-1572`: `connect "ADDR"`, or `connect any` with no address). Combined with `-server` or `-dedicated` it is ignored with a message (`:1858-1862`).
- `-udpport P` is the server's port (default 5029) and `-clientport P` the client's own (`i_tcp.c:1519-1536`), so a server and a client can share a machine.
- The rest of `D_Startup_NetGame`: `I_Init_TCP_Network` (`:1894`), the packet size options (`-extratic`, `-bandwidth`, `-packetsize`, `:1902-1949`).
- After the WADs: `D_DoomMain` queues `map "E1M1"` (or the `-warp` map) for a server (`d_main.c:3546-3555`), which `SV_SpawnServer` (`d_clisrv.c:4367`) turns into the game. The server's own player joins through the same path as a client (node 0): "Every player goes through here to connect to game, including a single player on the server" (`d_clisrv.c:3122`, in `CL_ConnectToServer`).
- **The wait.** `D_WaitPlayer_Setup` (`d_clisrv.c:2798`) sets `wait_netplayer = cv_wait_players` (server) or 99 (client) and `wait_tics = cv_wait_timeout * TICRATE`, with `gamestate = GS_WAITINGPLAYERS`. `D_WaitPlayer_Ticker` (`:2825`) counts player nodes and returns true when enough have come or the timeout is reached; `TryRunTics` does not run `G_Ticker` until then (`:5813-5831`). The `s` key on the wait screen starts at once (`D_WaitPlayer_Response`, `:2894`).
- **Commands** such as `addbot` can be queued on the command line as `+addbot` (`M_PushSpecialParameters`, `m_argv.c`); they run at the first `COM_BufExecute` in `D_DoomLoop` (`d_main.c:1081`), after `map` was queued, so the bots join the first level.

## 4. The join, step by step (`JOININGAME`)

Client side `CL_ConnectToServer` (`d_clisrv.c:3110-3381`, a blocking loop on `cl_mode`):
1. `CLM_searching`: sends `PT_ASKINFO` every 2 s (`CL_Send_AskInfo`, `:2944`) to `cl_servernode` (the address given) or broadcasts (`connect any`); the server answers `PT_SERVERINFO` (`SV_Send_ServerInfo`, `:1368`).
2. `CLM_server_files`: checks the files the server needs (`CL_CheckFiles`; WADs and `legacy.wad` must match by name and MD5, `d_netfil.c`); `CLM_download_req` / `CLM_download_files` fetch missing add-on files (not the IWAD).
3. `CLM_askjoin` (`:3235`): `CL_Prepare_download_savegame("$$$.sav")` (a file in the working directory; `tmpsave`, `:2411`), then `CL_Send_Join` (`:1334`) sends `PT_CLIENTJOIN` (version, `NETWORK_VERSION`, flags `NF_download_savegame`, `NF_big_endian`, `NF_drone`, the number of players).

Server side `client_join_handler` (`d_clisrv.c:4467`):
4. Refuses on a version or `NETWORK_VERSION` mismatch (`:4474`), `sv_allownewplayers 0`, or `cv_maxplayers` (`:4485-4502`).
5. If the server is in `GS_LEVEL` and both sides allow it (`cv_download_savegame`, `cv_SV_download_savegame`, both default 1), the command is `CTRL_download_savegame`; otherwise `CTRL_wait_game_start` (the player waits for the next level). A big-endian/little-endian mismatch forces the wait (`:4510-4531`). **Nothing compares pointer sizes** (§8).
6. `SV_AddNode`, then `SV_Send_ServerConfig` (`:1407`): `PT_SERVERCFG` with the game's settings, the gametic, the players and their positions, and the command.
7. For `CTRL_download_savegame`: node state `NOS_join_savegame`, `SV_Send_SaveGame` (`:2379`): `SV_network_wait_timer(90)` (the game is **paused** for the download, 90 s at most), then `P_Savegame_Write_header` and `P_Savegame_Save_game` into a buffer and `SV_SendData(to_node, "SAVEGAME", ...)` (`d_netfil.c`), which sends it as file fragments (`PT_FILEFRAGMENT`) on the ordinary reliable channel. The client's player is then added to `join_waiting` (`SV_Add_Join_Waiting`, `:4243`).

Client again:
8. `server_cfg_handler` (`:4675`) sets `maketic = gametic = cl_need_tic = servercfg.gametic` and `cl_mode = CLM_download_savegame` (`:3264`).
9. **What the client shows while it downloads:** a text box "Download Savegame" (`:3269-3273`), drawn once a tic, with a file progress bar from `Filetx_Ticker`; Q or ESC aborts. The server's other players see the game paused (the `NETWAIT` pause).
10. When `netfile_download` ends, `CL_Load_Received_Savegame` (`:2416`): `P_Savegame_Readfile("$$$.sav")`, `P_Savegame_Read_header`, `P_Savegame_Load_game` (the level is **rebuilt from the WAD** and the thinkers, mobjs, sectors and players are overwritten from the savegame), deletes the file, stores `consistency[gametic]`, `cl_mode = CLM_download_done`.
11. The client sends `PT_CLIENTREADY` (`:3285`), sets `gamestate = GS_LEVEL`, `cl_mode = CLM_connected`, and the loop ends (`:3345`). `network_state = NETS_active`, `consoleplayer` and `displayplayer` are set (`:3353-3357`).
12. The server on `PT_CLIENTREADY` (`:5543`) finishes the join: `SV_Send_AddPlayer`, the player's mobj spawns (`XD_ADDPLAYER` net command), the wait timer is released, and ticks flow to the new node.

The client's tic counter is the server's at the time of the savegame; `-testdump` files of the two machines therefore agree from the client's first record (§11).

## 5. Consistency (`Consistency()`, `d_clisrv.c:5646`)

- After every tic (`:5895`) each machine computes a 16-bit sum: the x of every player's mobj plus `P_Rand_GetIndex()` (`:5646-5663`). Position and the P_Random index only; no health, no sectors.
- A client sends the value for a past tic in every `PT_CLIENTCMD` (`:4912`); the server compares it with its own for that tic (`:4981`).
- On a mismatch, `SV_consistency_fault` (`:4802`) counts faults per node. With `sv_netrepair` 2 (the default, "Medium"): the 1st fault repairs the one player's position (`SV_Send_player_repair(.., 2, ..)`), later ones all players, the 3rd suggests a savegame download (`RQ_SUG_SAVEGAME`, the client's loop at `:2600-2650`), and the 5th (`consistency_limit_fatal`, `:407`) kicks the node (`XD_KICK`, `KICK_MSG_CON_FAIL`). Level 3 ("Aggressive"): savegame at the 3rd and 7th, kick at the 8th. Level 0: kick at the 1st.
- No fault is counted during `GS_INTERMISSION` (`:4809`).
- The messages are "Consistency failure tic N: node ..." (with `-v`) or "Consistency failure ( server=%X client=%X ), msg tic N, Kick node N" (`:4820-4834`), and "Client repair: gametic ..." and "... P_random index ..." from the repair (`:2591`, `random_state_checkset`, `:1719-1770`). `tests/net/test-hot-join.sh` fails on any of them.
- The repair also copies the server's `P_Random`, `B_Random` and `E_Random` states (`get_random_state`, `:1701`); `E_Random` (`m_random.c:247-285`) is the "extended" generator for bot names and skills (`b_game.c:268-271`, `:1674-1677`).
- What the check does **not** see: anything not in a player's x or the random index. The state hash (§11) is a much stronger check, and is test-only.

## 6. Blocking loops

Loops that wait for something while the caller does not return. Every one needs a yield (or a rewrite) in the browser (D6).

| Where | What it waits for | Notes |
|---|---|---|
| `D_DoomLoop`, `d_main.c:1035`, `while (1)` at `:1086` | never returns | One pass is `I_StartFrame`, `TryRunTics`, `D_Display`, `I_UpdateSound`... With `SDL_VIDEODRIVER=dummy` and no vsync there is no wait: 100% CPU (`bugs.md` L7). `I_Sleep(10)` is only under `SAVECPU_EXPERIMENTAL` (`:1094-1097`). |
| Screen wipe, `d_main.c:1005-1018` | the clock, up to 2 s | `do { do { tics = now - wipestart } while (!tics) ... } while (!wipe_done && I_GetTime() < y)`: a busy-wait, and it runs the whole game's drawing but not `TryRunTics`. |
| `CL_ConnectToServer`, `d_clisrv.c:3110-3345` | the server's answers, the files, the savegame | Polls `Net_Packet_Handler`, `I_GetKey`, `CON_Drawer`, `I_FinishUpdate`; no sleep. Also used by the server for its own player. |
| Savegame download for a repair, `d_clisrv.c:2614-2650` | `netfile_download` | Same shape, `Net_Packet_Handler` and `Net_AckTicker`. |
| `Net_Wait_AllAckReceived`, `d_net.c:852-868` (`D_CloseConnection`, `:2002`) | the acks, 5 s | Contains `while(ct == I_GetTime()) {}` (a spin on the clock). Runs at game exit and on `Command_ExitGame`. |
| Quit sound, `m_menu.c:4947-4966` | `I_GetTime`, 2 s | `while (dlyd_time > I_GetTime());`, only when not a netgame and sound is on. |
| Fatal error at start-up, `d_main.c:3021-3033` (`LAUNCHER`) | the key ESC | After a missing IWAD or `legacy.wad` the game shows the console and loops until ESC, then the launcher menu (`M_LaunchMenu`, `m_menu.c:~7157`, another `do { ... } while (menuactive)`). A headless run never leaves it: run-wasm.js has a timeout for this. |
| `I_Quit`/`D_Quit_Save` on an error, `d_main.c:3695` | `I_Sleep(3000)` | 3 s freeze before `exit`; `I_Error` calls it (`sdl/i_system.c:1587-1603`). |
| Level setup, `p_setup.c:2238`, `:2515` | `I_Sleep(100)`; `I_Sleep(4000)` after a bad level | `SDL_Delay`. |
| `sdl/i_video.c:1082`, `:1397` | `SDL_Delay(2000)`, `SDL_Delay(4000)` | Marked "[WDJ] DEBUG"; on mode-set failure paths. |

Menus (`M_Drawer`, `M_Responder`) and the console are driven from `D_DoomLoop`, not blocking; the launcher aside, nothing else loops on a key.

## 7. Floats and libm

Reachable from `G_Ticker` (every machine, every tic):
- **`FixedDiv2`** (`m_fixed.c:42-57`): `double c = a / b * FRACUNIT` and a cast; used by `P_InterceptVector`, sight and aim checks, teleports, damage, `r_*`, `t_func.c`, `v_video.c` (about 60 call sites). In IEEE double arithmetic with no `-ffast-math` the result is the same on every machine (x86_64 SSE2 and wasm). With `-ffast-math` the compiler may rewrite `a / b * c` as `a * (c / b)` or use reciprocals; the comparison in §11 shows whether it did.
- **MBF friction** (`p_enemy.c:993-1052`, `P_Move` when monsters have friction): `float` arithmetic on `momf`, `mdiffm`, `mf_ratio`; `speed = (int)(speed * mf_ratio)`. Not reached by the 11 demos (compatibility mode).
- **Pushers** (`p_spec.c:4268-4275`, `T_Pusher` with a source): `float` products of `(1<<23)`, `(1<<FRACBITS)` and the magnitude. Not reached by the demos.
- **`p_user.c:856-912`**: camera (chase view) distance with `float` and `sqrt`; changes the view, not the game.
- **Bot aiming**, `b_game.c:742`: `atan` of a `double` ratio, `FIXED_TO_INT((int)(... * ANG180 / M_PI))`, in `B_AimWeapon`/`B_BuildTiccmd`, which `G_Ticker` runs for every bot on every machine. The result goes into the bot's `cmd.aiming`, which `P_MovePlayer` uses. `atan` is libm: the wasm one is Emscripten's (musl), the native one glibc's. A bot that aims differently by one unit is a desync. **Not reached by the 11 demos, and not by the hot-join test unless the bots shoot** (they do, in a level with monsters). `b_game.c:305-320` also has `rand()` (bot names/colours, `cv_bot_gen == 4` only, outside `G_Ticker`).
- `sqrt`: `p_setup.c:387` (line lengths at level load, `P_SetupLevel`), `p_extnodes.c:154` (extended nodes): level load, same on all machines for IEEE `sqrt`.
- Level load: `b_node.c:42-45`, `:621-623` (bot node grid: `float`, `ceil`); the grid is built at level start on every machine.
- Not simulation: `d_net.c:1628` (`rand()` to drop packets, `-droprate`-style test code), `t_func.c:317` (FraggleScript `rand()`), `r_*` and `am_map.c` (drawing), the `CONS_Printf` of times.

Which of these the demos reach: `FixedDiv2` (all of them) and nothing else from the list. A bounded run that reaches the others would need a Legacy-format demo (version >= 128) recorded with friction or pusher sectors and bots; `G_Ticker` does record bot ticcmds in `demorecording` (`g_game.c:1776`), so a native `-record` with `+addbot` on a MAP with a pusher or a friction sector (Freedoom has none in the first levels) would do, for brief 02 or 04.

## 8. Savegame portability (the hot-join payload)

**Not portable between a 64-bit native build and wasm32.** The savegame code writes some structures as raw memory, and their sizes differ.

- The header records `sizeof(int)` and `sizeof(boolean)` and the loader checks them (`p_saveg.c:3909-3910`, `:3998-4000`): both 4 on both builds. It does not record the size of a pointer or the endian of the data beyond `NF_big_endian` in the join.
- **Sector effects** (ceilings, doors, floors, platforms, lights, elevators, scrollers, pushers) are written with `WRITE_SECTOR_THINKER(th, type, field)`: the raw bytes from `offsetof(type, field)` to `sizeof(*th)` (`p_saveg.c:1801-1840`, uses at `:2180-2340`, reads at `:2680-2900`). The thinker header and the `sector_t *` are skipped, but the fields after them are copied as the compiler laid them out, up to the end of the struct, **including the structure's tail padding**, which depends on the alignment of the whole struct (8 on x86_64 because of the pointers, 4 on wasm32). `ceiling_t` also has a pointer (`list`) that is inside the written range for some of them.
- Measured with `gcc -m64` against `emcc` (`wasm32`), bytes written per record:

  | Type | x86_64 | wasm32 |
  |---|---|---|
  | `ceiling_t` | 40 | 36 |
  | `vldoor_t` | 32 | 28 |
  | `floormove_t` | 32 | 28 |
  | `plat_t` | 40 | 40 |
  | `lightflash_t`, `strobe_t` | 16 | 16 |
  | `glow_t`, `fireflicker_t` | 8 | 8 |
  | `lightfader_t` | 8 | 4 |
  | `elevator_t` | 24 | 20 |

  (`sizeof(void *)` 8/4, `sizeof(thinker_t)` 40/20, `sizeof(mobj_t)` 312/224, `sizeof(player_t)` 496/436.) A native server's savegame therefore has the wrong number of bytes for a wasm client at the first door, ceiling, floor or lift thinker: the rest of the stream is read shifted. **A browser joining a native host with a level in progress would corrupt its game, or fail to load.** A browser host and browser clients are fine (same layout); two native 64-bit machines are fine. Brief 04 needs a fix; see `bugs.md` L19.
- Mobjs, players and sectors are written field by field with `WRITE32`/`WRITEU32` etc. (`p_saveg.c`, the `WRITE_MobjPointerID` and `WRITE_SECTOR_PTR` macros at `:1464-1474`): pointers become indices, so those parts are portable. `inventory_t` (2 bytes) and `memcpy` of bytes are the same on both. `mobj_t` itself is not copied raw.
- Endianness: everything is written in the machine's own byte order (`LE_SWAP*` only on big-endian machines reading), and the join refuses a big-endian/little-endian pair (`d_clisrv.c:4486-4496`). x86_64 and wasm are both little-endian.
- `long`: used for sizes in a few `CheckSaveGame(sizeof(long))` comments and the FraggleScript parts (`p_saveg.c:3325`); not in the data of the first levels.

## 9. Files: WAD search and config

- **IWAD and `legacy.wad`** (`d_main.c:1836-1900`, `Search_doomwaddir`): `legacy.wad` is looked for next to the executable (`progdir`), then `LEGACYWADDIR`, then the WAD directory list; the list `doomwaddir[]` (`d_main.c:554-561`) is filled from `$DOOMWADDIR`, the working directory, the program directory, `$HOME/...` and a long list of system directories (the log of a run prints all 20). `-iwad FILE` names the IWAD; `-file` adds PWADs, `-deh` DeHackEd files (`d_main.c:2881-2905`). A missing `legacy.wad` or IWAD: the launcher error loop (§6).
- **Home directory** (`d_main.c:2599-2690`): `-home DIR`, else `$HOME`, else `~`; the game keeps its files in `DIR/.doomlegacy/` (`legacyhome`, `d_main.c:487`): `config.cfg`, `log.txt`, `savegames` as `DIR/.doomlegacy/<name>/` subdirectories, screenshots, and `autoexec.cfg` (looked for first there, then in the working directory: `d_main.c:1047-1060`). `-config FILE` names another config (`d_main.c:3071`).
- **Savegames** are written under `legacyhome` (the menu lists directories: `m_menu.c:4070-4140`, with `ftw` replaced by `dirent` under Emscripten); the join's `$$$.sav` goes to the **working directory** (`d_clisrv.c:2381`).
- For the browser (brief 03): `-home /somewhere` pointing into IDBFS covers config, saves and the log; the IWAD, `legacy.wad` and `-file` data can be in MEMFS or IDBFS at any path given with `-iwad` and `-file`; the working directory must be writable for `$$$.sav`.

## 10. The music path (for M1)

- `S_ChangeMusic` / `S_StartMusic` (`s_sound.c:1581-1750`) find the lump (`D_<name>` for Doom), call `detect_music_type` (`:1581`; MUS, MIDI, Ogg, ... from the lump's first bytes) and then `I_RegisterSong(type, data, length)` (`:1727`), `I_PlaySong(handle, looping)` (`:1729`); stop is `I_StopSong`, `I_UnRegisterSong` (`:1749-1750`); pause and resume `I_PauseSong`, `I_ResumeSong` (`:1320`, `:1334`); volume `I_SetMusicVolume` (`:1504`). The interface is `i_sound.h:112-146`.
- `sdl/i_sound.c`: `I_RegisterSong` (`:831`) converts a MUS lump to MIDI in memory with `qmus2mid` (`:850-853`, `qmus2mid.c`, `MIDI_BUFFER_SIZE`), wraps the buffer in `SDL_RWFromConstMem` and loads it with `Mix_LoadMUSType_RW` (`:883-898`); `I_PlaySong` (`:754`) calls `Mix_PlayMusic`. The handle is always 0 and only one song can be registered at a time (`:841-845`). So the seam for an OPL player is these functions: `I_RegisterSong` gets the **raw lump** (MUS or MIDI) and its type, so an OPL player can take the MUS data directly and skip `qmus2mid`.
- SDL_mixer initialisation and the music-type flags (`EN_port_music = ADM_MUS | ADM_MIDI` at `:960`, `Mix_Init` formats at `:969-998`).
- The wasm build here links SDL2_mixer (it has to, for `sdl/i_sound.c` to compile) and plays nothing (`-nosound -nomusic`); `scripts/wasm.mk` renames the game's `detect_music_type` (`-Ddetect_music_type=dl_detect_music_type`) because the static SDL2_mixer has a global with that name.

## 11. The state hash (`-testdump`)

`src/test_dump.c`. Test-only; nothing changes without it (`TestDump_Tic` is one test of a flag; no packet, savegame or game behaviour changes).

- **Options.** `-testdump FILE` writes one 28-byte record per game tic: `tic`, `total`, `random`, `players`, `mobjs`, `world`, `specials`, seven little-endian 32-bit words, flushed at once. `-teststate FROM [TO]` also writes `FILE.state`, the same state as text, one line per object, for the tics FROM..TO. Under `-timedemo`, `-testdump` makes the game quit with status 0 at the end of the demo (`g_game.c:~4598`, `G_CheckDemoStatus`); `-playdemo` already did.
- **The point.** `TestDump_Tic()` is called in `TryRunTics` (`d_clisrv.c:5885`) right after `G_Ticker` and `ExtraDataTicker` and `gametic++`, so every machine takes the record for tic N after tic N-1 ran, whatever drew. The record's tic is `gametic` after the increment. A client that joined by savegame starts at the join tic.
- **What is in it.**
  - `random`: the `P_Random` index, the `B_Random` index, and the two words of `E_Random` (`m_random.c`). Not `M_Random` (menus, status bar, wipes, sound pitch), `A_Random` (ambience, coronas) or `N_Random` (blood, smoke trails): none touches the simulation (checked with `grep`: `M_Random` only in `f_wipe.c`, `wi_stuff.c`, `s_sound.c`, `st_stuff.c`, `sb_bar.c`; `A_Random` in `r_things.c` and `s_amb.c`; `N_Random` in `p_fab.c` and `p_mobj.c` for blood and smoke, where Legacy mode makes `P_Random` calls instead).
  - `players`: for every player in the game: state, mobj, position, momentum, angle, view height, bob, health, armour, the ammo, weapons, current and pending weapon, powers, cards, cheats, frags, counters, the weapon sprites, and more (`test_dump.c:hash_players`).
  - `mobjs`: every live mobj in thinker-list order: type, position, momentum, floor/ceiling z, size, angle, sprite, frame, flags, health, tics, state number, target, tracer and the other mobj pointers **as indices in that order**, movement fields, friction.
  - `world`: every sector (heights, pictures, light, special, tag, offsets, stair lock), every line (special, tag, flags without `ML_MAPPED`), every side (offsets, textures).
  - `specials`: every non-mobj thinker (ceilings, doors, floors, platforms, lights, elevators) with the sector index and its fields, the switch timers, and the number of thinkers.
  - `total`: the five hashes, `leveltime`, `gamemap`, `gameepisode`, `gamestate`, `paused`.
  - Only walked when `gamestate == GS_LEVEL`; in other states the three world words are 0.
- **What is deliberately not in it:** `ML_MAPPED` (set by the renderer for the automap: `r_segs.c:2750`; its first version of the hash showed it as a drawing dependence at tic 2, and it was removed), `paused` (an input to the next tic that a joining client's savegame load sets earlier than the server's record), the view bobbing (`viewz`, `bob`, `bob_momx/y`, the weapon sprite's `sx`/`sy`: not in a savegame, `bugs.md` L25), pointers, the `T_Scroll`, `T_Friction` and `T_Pusher` structs (their changes show in the sides and sectors), the fields that the makers of a sector effect leave unset: `vldoor_t.topwait`, `.topcountdown` unless the door is waiting; `ceiling_t`/`floormove_t` `new_*` and `old_*` fields; `plat_t.count` unless waiting, `.oldstatus` unless stopped. **Those fields are read from `Z_Malloc` memory the zone does not clear**: two machines hold different garbage there, and the game never reads it (`bugs.md` L16). Found by a build whose `Z_Malloc` filled blocks with 0xA5 (a throwaway patch, not committed): native against that build gave identical files on all 11 demos once these were out and L15 was fixed. That check found L15, which the first native-against-wasm run had found too: the shareware `DEMO1` at tic 4898, the start of E1M5.
- **Not in it** (not reachable from the demos or not cheap): the boss-brain target list, the item respawn queue, the body queue, FraggleScript state, `Anim`s and the `button_t` textures beyond the timers, the heads-up and status bar state.
- **Draw and pacing independence** (acceptance 4): `tests/draw-independence.sh` plays one demo per IWAD with `-timedemo`, with `-timedemo -nodraw` and with `-playdemo` (real time) and compares the files. The renderer writes one thing the hash had to exclude (`ML_MAPPED`, above). `M_Random` is the other thing a drawing frame calls; it is not in the hash and not in the simulation.
- **Hot join** (`tests/net/test-hot-join.sh`): the join of §4 gives the same hashes on both machines from the first tic after the savegame load, once `bugs.md` L21 (the client's pause state: its level time ran one tic ahead), L22 (`dropoffz` was not saved) and the view bobbing (L25, left out of the hash) are dealt with. `TestDump_Tic` is also called when the client has loaded the savegame (`d_clisrv.c`, after `gamestate = GS_LEVEL`), so the first record is the loaded state at the server's gametic and it equals the server's record for that tic in the file: players, mobjs, sectors and thinkers all survive the savegame. Measured: 1,442 identical records over 40 s of play (tics 361 to 1802), the client joining after 10 s; 1,089 identical from tic 1 for two players started together. What does not survive: a bot's state (L23, the first tic after the join already differs and the client is kicked after a few seconds), and a slow client (L29, ASan builds: about 50 tics of agreement, then the players and mobjs part).
- What the client sees while it downloads: the text box "Download Savegame" (§4), and the other players see the game paused for the length of the download (`SV_network_wait_timer(90)`); on loopback the pause is about a second.

## 12. The wasm build

- `scripts/build-wasm.sh` → `scripts/wasm.mk` (not the upstream Makefile; see the comment there) → `build/wasm/bin/doomlegacy.{js,wasm}`; `-O2`, no `-ffast-math`; `emcc` with `-sUSE_SDL=2 -sUSE_SDL_MIXER=2`; `-sMODULARIZE=1 -sEXPORT_NAME=createDoomLegacy -sEXIT_RUNTIME=1 -sINVOKE_RUN=0`, exports `FS`, `ENV`, `callMain`; 2 MB stack, 128 MB initial memory (grows).
- Source changes, all `#ifdef __EMSCRIPTEN__` except the two bug fixes: `doomtype.h:183-188` (`strupr`/`strlwr`), `i_tcp.c:~190` (no IPX), `m_menu.c:4070-4075` (no `ftw`: the `dirent` code is used). New files: `sdl/i_nohwr.c` (OpenGL stubs), `test_dump.c/.h`.
- Not built in: `HAVE_ZLIB` (compressed BSP nodes: some maps), `HAVE_LIBZIP` (pk3), `HAVE_DLOPEN`, IPX, OpenGL. The Freedoom and Doom shareware maps do not need them.
- The runner (`tests/tools/run-wasm.js`) loads the page in headless Chromium: the SDL2 port's only video driver is the one for a web page (`SDL_VIDEODRIVER=dummy` is "not available"), so under plain Node `SDL_Init` fails at `emscripten_get_screen_size` (`screen` is not defined), then on gamepads. The audio driver `dummy` is available (`ENV.SDL_AUDIODRIVER`, set in `preRun`).
- The game runs inside one `callMain` call on the page's main thread, blocking, until `I_Quit`. That is fine for a test (nothing needs the page to respond) and wrong for a user: brief 02 adds the yields of §6.
- Speed: a timed demo takes 2.5 to 3 times as long in wasm (Chromium, software canvas) as natively; both are 6 to 10 times faster than real time.
