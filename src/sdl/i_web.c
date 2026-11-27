// SPDX-License-Identifier: GPL-2.0-or-later
//
// The Emscripten (browser) build: giving control back to the page (brief 02).
// Only built by scripts/wasm.mk; see i_web.h.
//
// Two ways to wait:
//   normal   the page's pace. A frame waits for requestAnimationFrame (100 ms at
//            most: a hidden tab gets no frames), so the game runs in step with the
//            display and the page stays responsive. This is what users get.
//   fast     test only (the page's ?test=1&fast=1, Module.dlFast): a yield is a
//            message to the page itself, and it happens only when 20 ms (default,
//            Module.dlFastMs) have passed since the last one. The tests play
//            -timedemo as fast as the CPU allows, as they did before ASYNCIFY.
//
// The yields change when the page gets control back and nothing else: the game's
// clock is still I_GetTime (SDL_GetTicks) and TryRunTics still runs the tics that
// are due, so the simulation is the same as natively.

#ifdef __EMSCRIPTEN__

#include <emscripten.h>
#include <SDL.h>
#include "i_web.h"

#ifdef DL_NO_ASYNCIFY
// A build for measuring the size of ASYNCIFY only (scripts/wasm.mk NOASYNC=1): no
// yields, so it cannot run in a page.
void I_Web_Init( void ) { SDL_SetHint( SDL_HINT_EMSCRIPTEN_ASYNCIFY, "0" ); }
void I_Web_Frame( void ) {}
void I_Web_Poll( void ) {}
void I_Web_PassEnd( void ) {}
void I_Web_Idle( void ) {}
void I_Web_Sleep( unsigned int ms ) { SDL_Delay( ms ); }
#else

static int     web_fast;           // test pacing
static double  web_fast_ms = 20.0;
static double  web_poll_ms = 8.0;  // yield from the event pump after this long without one
static double  last_yield;         // emscripten_get_now() when the game last got control back
static unsigned long  yield_count;
static unsigned long  passend_seen;

EM_JS(int, dl_fast_flag, (void), { return Module.dlFast ? 1 : 0; });
EM_JS(double, dl_fast_ms, (void), { return Module.dlFastMs > 0 ? Module.dlFastMs : 20; });
EM_JS(void, dl_log_frame, (void), { if (Module.dlFrameLog) { Module.dlFrameLog.push(performance.now()); } });

// The yields. With Module.dlYields (a test hook) each one records [the game gave control away, the page
// resumed it, the game was running again]: the last minus the middle is what rewinding the saved stack
// cost, and the next first minus this last is the game's own work between yields.

// A frame: resumes in the next display frame (or after 100 ms).
EM_ASYNC_JS(void, dl_wait_frame, (void), {
  var t0 = performance.now();
  await new Promise(function (resolve) {
    var timer = 0, done = false;
    var go = function () { if (!done) { done = true; clearTimeout(timer); resolve(); } };
    requestAnimationFrame(go);
    timer = setTimeout(go, 100);
  });
  if (Module.dlYields && Module.dlYields.length < 200000) { Module.dlYields.push([t0, performance.now(), 0]); }
});

// A turn for the page: resumes as soon as the browser has run what is waiting.
EM_ASYNC_JS(void, dl_yield_now, (void), {
  var t0 = performance.now();
  await new Promise(function (resolve) {
    var ch = Module.dlChannel || (Module.dlChannel = new MessageChannel());
    ch.port1.onmessage = function () { resolve(); };
    ch.port2.postMessage(0);
  });
  if (Module.dlYields && Module.dlYields.length < 200000) { Module.dlYields.push([t0, performance.now(), 0]); }
});

EM_ASYNC_JS(void, dl_sleep, (int ms), {
  var t0 = performance.now();
  await new Promise(function (resolve) { setTimeout(resolve, ms); });
  if (Module.dlYields && Module.dlYields.length < 200000) { Module.dlYields.push([t0, performance.now(), 0]); }
});

// The game is running again.
EM_JS(void, dl_back, (void), {
  var y = Module.dlYields;
  if (y && y.length) { y[y.length - 1][2] = performance.now(); }
});

void I_Web_Init( void )
{
    // SDL's own yields: SDL_Delay and the buffer swap sleep (emscripten_sleep(0)) when
    // ASYNCIFY is on. Off: the yields are ours, at the places above.
    SDL_SetHint( SDL_HINT_EMSCRIPTEN_ASYNCIFY, "0" );
    web_fast = dl_fast_flag();
    web_fast_ms = dl_fast_ms();
    last_yield = emscripten_get_now();
}

static void web_yield_now( void )
{
    yield_count++;
    dl_yield_now();
    dl_back();
    last_yield = emscripten_get_now();
}

static void web_wait_frame( void )
{
    yield_count++;
    dl_wait_frame();
    dl_back();
    last_yield = emscripten_get_now();
}

void I_Web_Frame( void )
{
    dl_log_frame();
    if( web_fast )
    {
        if( emscripten_get_now() - last_yield >= web_fast_ms )
            web_yield_now();
    }
    else
        web_wait_frame();
}

void I_Web_Poll( void )
{
    if( emscripten_get_now() - last_yield >= (web_fast ? web_fast_ms : web_poll_ms) )
        web_yield_now();
}

void I_Web_PassEnd( void )
{
    if( web_fast )
    {
        if( emscripten_get_now() - last_yield >= web_fast_ms )
            web_yield_now();
        return;
    }
    // A pass that drew has waited for its frame in I_Web_Frame. One that did not
    // (no new tic yet) waits here, so the game does not spin.
    if( yield_count == passend_seen )
        web_wait_frame();
    passend_seen = yield_count;
}

void I_Web_Idle( void )
{
    yield_count++;
    dl_sleep( 1 );
    dl_back();
    last_yield = emscripten_get_now();
}

void I_Web_Sleep( unsigned int ms )
{
    yield_count++;
    dl_sleep( (int)ms );
    dl_back();
    last_yield = emscripten_get_now();
}

#endif
#endif
