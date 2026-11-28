# SPDX-License-Identifier: GPL-2.0-or-later
#
# Makefile for the Emscripten (WebAssembly) build of Doom Legacy.
# Run it through scripts/build-wasm.sh, which sets up emsdk and calls
#   make -f scripts/wasm.mk -j4   (after sourcing emsdk_env.sh)
#
# Why not the upstream Makefile (as the native build does): for SDL it always
# defines HWRENDER and links the OpenGL renderer objects and -lGL -lGLU, asks the
# host's sdl2-config for flags, and has no way to leave those out. The wasm build
# is software renderer only (D5), so this lists the sources itself. The list is
# the native build's object list (the compile lines of build-native.sh) without
# hardware/*, sdl/ogl_sdl.c and sdl/hwsym_sdl.c (OpenGL), and without
# sdl/dosstr.c (Emscripten's libc has strupr and strlwr).
# It adds sdl/i_nohwr.c, stubs for the OpenGL symbols that sdl/i_video.c refers to.
#
# Not built in: HAVE_ZLIB (compressed BSP nodes in some maps; the zlib port is not
# in the seeded cache), HAVE_LIBZIP (pk3 files), HAVE_DLOPEN, IPX (i_tcp.c).
# HAVE_MIXER is on because sdl/i_sound.c does not compile without it; the headless
# runs use -nosound -nomusic.
#
# ASYNCIFY (D6, brief 02): the game's loops stay and yield to the page (src/i_web.h,
# src/sdl/i_web.c). NOASYNC=1 builds a copy with the yields compiled out, only to
# measure what ASYNCIFY costs in size (doco/browser/building.md); it cannot run in a page.
#
# The page (web/) and legacy.wad are copied next to the game, so build/wasm/bin is
# the whole site; the game data is not (the page fetches it, see building.md).
#
# No -ffast-math: this file never adds it (upstream's Makefile does).

BUILD    ?= build/wasm
OPTLEV   ?= -O2
CC       := emcc

SRC_MAIN := screen v_video r_draw r_plane r_segs r_sky r_things r_splats \
  r_bsp r_data r_main z_zone p_sight p_mobj p_enemy p_user p_inter p_pspr \
  p_lights p_ceilng p_doors p_plats p_floor p_spec p_switch p_genlin p_telept \
  p_tick p_fab p_info p_setup p_blockmap p_extnodes p_map p_maputl p_heretic \
  p_hsight p_chex umapinfo sb_bar hu_stuff st_lib st_stuff t_array t_func \
  t_oper t_parse t_prepro t_script t_spec t_vari sounds qmus2mid s_sound s_amb \
  mserv b_game b_look b_node b_search g_input g_game f_finale f_wipe wi_stuff \
  am_map md5 m_menu m_misc m_argv m_bbox m_fixed m_swap m_cheat m_random \
  console command p_saveg tables info infoext dstrings dehacked w_wad w_zip \
  d_netcmd d_clisrv d_net d_netfil i_tcp i_vnet d_items d_main test_dump
SRC_SDL  := i_system i_video i_sound i_net filesrch endtxt i_main i_nohwr i_web
SRC_UMI  := doom_umi_api doom_umi_parser doom_umi_lexer doom_umi_keywords

SOURCES := $(addprefix src/,$(addsuffix .c,$(SRC_MAIN))) \
           $(addprefix src/sdl/,$(addsuffix .c,$(SRC_SDL))) \
           $(addprefix src/umapinfo/,$(addsuffix .c,$(SRC_UMI)))
OBJS    := $(patsubst src/%.c,$(BUILD)/objs/%.o,$(SOURCES))

SDLFLAGS := -sUSE_SDL=2 -sUSE_SDL_MIXER=2
# s_sound.c defines a global detect_music_type, which the static SDL2_mixer
# (music.c) defines too; a shared library hides its own on native builds. Renaming
# ours on the command line avoids both a clash and a source change.
DEFS     := -DLINUX -DSDL2 -DSMIF_SDL -DHAVE_MIXER -Ddetect_music_type=dl_detect_music_type
ifeq ($(NOASYNC),1)
DEFS     += -DDL_NO_ASYNCIFY
ASYNCFLAGS :=
else
# 256 KB for the saved call stack (the default 4 KB is too small for the game's depth).
ASYNCFLAGS := -sASYNCIFY -sASYNCIFY_STACK_SIZE=262144
endif
CFLAGS   := -Wall $(OPTLEV) -ffp-contract=off -fno-strict-aliasing $(DEFS) $(SDLFLAGS) -Isrc -Isrc/umapinfo -MMD -MP
# 2 MB of stack (Emscripten's default is 64 KB), memory grows on demand.
LDFLAGS  := $(OPTLEV) $(SDLFLAGS) -sSTACK_SIZE=2097152 -sINITIAL_MEMORY=134217728 \
  -sALLOW_MEMORY_GROWTH=1 -sEXIT_RUNTIME=1 -sFORCE_FILESYSTEM=1 \
  -sMODULARIZE=1 -sEXPORT_NAME=createDoomLegacy -sINVOKE_RUN=0 \
  -sEXPORTED_RUNTIME_METHODS=FS,ENV,callMain,IDBFS -lidbfs.js $(ASYNCFLAGS) $(EXTRA_LDFLAGS)

.DEFAULT_GOAL := all

# Changing NOASYNC or EXTRA_LDFLAGS must rebuild what depends on them: a stamp that changes with them.
FLAGS_STAMP := $(BUILD)/flags.stamp
$(FLAGS_STAMP): FORCE
	@mkdir -p $(dir $@)
	@printf '%s\n' 'NOASYNC=$(NOASYNC) EXTRA_LDFLAGS=$(EXTRA_LDFLAGS)' | cmp -s - $@ || printf '%s\n' 'NOASYNC=$(NOASYNC) EXTRA_LDFLAGS=$(EXTRA_LDFLAGS)' > $@
FORCE:
$(BUILD)/objs/sdl/i_web.o: $(FLAGS_STAMP)

TARGET := $(BUILD)/bin/doomlegacy.js
PAGE   := index.html page.js page.css config.js iwads.js data.js
SITE   := $(addprefix $(BUILD)/bin/,$(PAGE) legacy.wad)

all: $(TARGET) $(SITE)

$(BUILD)/bin/legacy.wad: common/legacy.wad
	@mkdir -p $(dir $@)
	cp $< $@

$(BUILD)/bin/%: web/%
	@mkdir -p $(dir $@)
	cp $< $@

$(TARGET): $(OBJS) scripts/wasm.mk $(FLAGS_STAMP)
	@mkdir -p $(dir $@)
	$(CC) $(OBJS) $(LDFLAGS) -o $@

$(BUILD)/objs/%.o: src/%.c scripts/wasm.mk
	@mkdir -p $(dir $@)
	$(CC) $(CFLAGS) -c $< -o $@

clean:
	rm -rf $(BUILD)

-include $(OBJS:.o=.d)
.PHONY: all clean FORCE
