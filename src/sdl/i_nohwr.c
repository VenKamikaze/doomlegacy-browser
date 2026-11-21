// SPDX-License-Identifier: GPL-2.0-or-later
//
// Stubs for a build without the OpenGL renderer (the Emscripten build,
// scripts/wasm.mk).
//
// sdl/i_video.c refers to the OpenGL window code (sdl/ogl_sdl.c) and to the
// hardware renderer's function table (sdl/hwsym_sdl.c, hardware/*) without
// guarding them with HWRENDER. This file defines just those symbols, so that the
// software renderer links without the OpenGL objects. Selecting the OpenGL
// renderer then fails, as it does when no OpenGL is available: the mode
// switch returns false and the game stays in software mode.

#include "doomincl.h"
#include "ogl_sdl.h"
#include "hwsym_sdl.h"
#include "hardware/hw_drv.h"

byte  ogl_active = 0;

struct hwdriver_s  hwdriver;

boolean OglSdl_SetMode( int w, int h, byte req_fullscreen )
{
    (void) w;  (void) h;  (void) req_fullscreen;
    return false;
}

void OglSdl_FinishUpdate( void )
{
}

void OglSdl_Shutdown( void )
{
}

void * hwSym( const char * funcName )
{
    (void) funcName;
    return NULL;
}
