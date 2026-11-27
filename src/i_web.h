// SPDX-License-Identifier: GPL-2.0-or-later
//
// The Emscripten (browser) build: giving control back to the page.
//
// The game's loops wait for the clock, the network or a key and never return, so
// in a browser they would freeze the page. The build uses ASYNCIFY: these calls
// suspend the game and let the page run, then carry on where the game was.
// Everywhere else they compile to nothing. The implementation is sdl/i_web.c.
//
// doco/browser/code-facts.md section 6 lists the loops and where each yields.

#ifndef I_WEB_H
#define I_WEB_H

#ifdef __EMSCRIPTEN__

void I_Web_Init( void );        // before SDL_Init: SDL's own yields off, reads the page's switches
void I_Web_Frame( void );       // a frame was presented: wait for the next display frame
void I_Web_Poll( void );        // from the event pump: yield if the game has not for a few ms
void I_Web_PassEnd( void );     // end of a pass of D_DoomLoop: wait for a frame unless one was just waited for
void I_Web_Idle( void );        // inside a loop that waits for the clock: let the page run for a moment
void I_Web_Sleep( unsigned int ms );  // I_Sleep
void I_Web_MouseGrab( int on ); // the game wants the mouse (a level is playing): the page locks the pointer and sends the motion

#else

#define I_Web_Init()      ((void)0)
#define I_Web_Frame()     ((void)0)
#define I_Web_Poll()      ((void)0)
#define I_Web_PassEnd()   ((void)0)
#define I_Web_Idle()      ((void)0)
#define I_Web_MouseGrab(on) ((void)0)

#endif

#endif
