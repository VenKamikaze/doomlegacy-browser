// SPDX-License-Identifier: GPL-2.0-or-later
//
// Test-only per-tic game state hash (-testdump FILE, -teststate FROM [TO]).
//
// With -testdump FILE the game appends one fixed-size record per game tic to
// FILE, flushed at once.  Without it nothing here runs: no behaviour, packet
// or savegame byte changes.  See test_dump.c and doco/browser/code-facts.md.

#ifndef TEST_DUMP_H
#define TEST_DUMP_H

// Read the test options.  Call once, after the command line is known.
void TestDump_Init( void );

// Take the record for the tic that has just been run.
// Call right after G_Ticker and ExtraDataTicker, once gametic is incremented.
void TestDump_Tic( void );

// Test-only -testunpausedelay N (server): after the clients are ready, the server's
// network wait pause lasts N more gametics (it made the race, an unpause for a
// later gametic than a joining client had reached, before the pause went in the tic stream,
// now it only makes the pause last). Returns true while
// it should still wait. Always false without the option.
int TestDump_UnpauseDelay( unsigned int now );

// Test-only: called at the end of B_Level_Start. With -testdump, prints how many of the
// bots' mobj pointers, destinations and path nodes are still set, when there are bots:
// "TEST: bots at level start: N bots, P pointers, D destinations, S path nodes". Memory
// that the old level freed is reused by the new one, so the state hash can take a stale
// pointer for a live mobj; this count cannot.
void TestDump_BotsAtLevelStart( void );

// Test-only -testimpair SPEC: HSendPacket sends through this in place of
// I_NetSend. Without the option it is I_NetSend. Returns what I_NetSend returns.
byte TestImpair_Send( void );
// Print the counts ("TEST: impair: ..."); a no-op without the option.
void TestImpair_Report( void );

// Test-only -testwalk FROM TO: makes the local player's ticcmd walk forward for
// game tics FROM..TO-1. Called by G_BuildTiccmd; nothing without the option.
#include "d_ticcmd.h"
void TestDump_Walk( ticcmd_t * cmd, int which_player );

// True if -testdump is active.
extern int  testdump_active;

#endif
