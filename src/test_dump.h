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
// network wait pause lasts N more gametics, so that its unpause names a later gametic
// than a joining client has reached (the race of bugs.md L21). Returns true while
// it should still wait. Always false without the option.
int TestDump_UnpauseDelay( unsigned int now );

// True if -testdump is active.
extern int  testdump_active;

#endif
