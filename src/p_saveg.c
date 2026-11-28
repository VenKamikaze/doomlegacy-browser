// Emacs style mode select   -*- C++ -*-
//-----------------------------------------------------------------------------
//
// $Id: p_saveg.c 1736 2025-03-14 08:15:57Z wesleyjohnson $
//
// Copyright (C) 1993-1996 by id Software, Inc.
// Copyright (C) 1998-2017 by DooM Legacy Team.
//
// This program is free software; you can redistribute it and/or
// modify it under the terms of the GNU General Public License
// as published by the Free Software Foundation; either version 2
// of the License, or (at your option) any later version.
//
// This program is distributed in the hope that it will be useful,
// but WITHOUT ANY WARRANTY; without even the implied warranty of
// MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.  See the
// GNU General Public License for more details.
//
//
// $Log: p_saveg.c,v $
// Revision 1.29  2004/07/27 08:19:37  exl
// New fmod, fs functions, bugfix or 2, patrol nodes
//
// Revision 1.28  2004/04/20 00:34:26  andyp
// Linux compilation fixes and string cleanups
//
// Revision 1.27  2003/08/11 13:50:01  hurdler
// go final + translucent HUD + fix spawn in net game
//
// Revision 1.26  2003/07/21 11:33:57  hurdler
//
// Revision 1.25  2003/05/04 07:22:55  sburke
// Overlooked a LONG() swap when restoring the door->line of a door thinker.
//
// Revision 1.24  2003/05/04 02:36:18  sburke
// Make thorough use of READSHORT, READLONG macros to avoid endian, alignment faults.
//
// Revision 1.23  2002/09/09 20:41:53  uid22974
// Fix a bug with save/load game and FS
//
// Revision 1.22  2002/06/23 17:38:21  ssntails
// Fix for savegames with 3dfloors!
//
// Revision 1.21  2002/01/21 23:14:28  judgecutor
// Frag's Weapon Falling fixes
//
// Revision 1.20  2001/06/16 08:07:55  bpereira
// Revision 1.19  2001/06/10 21:16:01  bpereira
// Revision 1.18  2001/03/03 06:17:33  bpereira
// Revision 1.17  2001/02/24 13:35:20  bpereira
// Revision 1.16  2001/02/10 12:27:14  bpereira
//
// Revision 1.15  2001/01/25 22:15:43  bpereira
// added heretic support
//
// Revision 1.14  2000/11/11 13:59:45  bpereira
// Revision 1.13  2000/11/04 16:23:43  bpereira
//
// Revision 1.12  2000/11/02 17:50:08  stroggonmeth
// Big 3Dfloors & FraggleScript commit!!
//
// Revision 1.11  2000/09/28 20:57:16  bpereira
// Revision 1.10  2000/08/31 14:30:56  bpereira
// Revision 1.9  2000/07/01 09:23:49  bpereira
// Revision 1.8  2000/04/16 18:38:07  bpereira
// Revision 1.7  2000/04/15 22:12:57  stroggonmeth
//
// Revision 1.6  2000/04/11 19:07:24  stroggonmeth
// Finished my logs, fixed a crashing bug.
//
// Revision 1.5  2000/04/04 00:32:47  stroggonmeth
// Initial Boom compatability plus few misc changes all around.
//
// Revision 1.4  2000/02/27 16:30:28  hurdler
// dead player bug fix + add allowmlook <yes|no>
//
// Revision 1.3  2000/02/27 00:42:10  hurdler
// Revision 1.2  2000/02/26 00:28:42  hurdler
// Mostly bug fix (see borislog.txt 23-2-2000, 24-2-2000)
//
//
// DESCRIPTION:
//      Archiving: SaveGame I/O.
//
//-----------------------------------------------------------------------------

#include <stdint.h>
#include <stddef.h>
  // offsetof

#include "doomincl.h"
#include "p_local.h"
#include "p_tick.h"
  // think
#include "p_setup.h"
#include "g_game.h"
#include "r_data.h"
#include "r_state.h"
#include "z_zone.h"
#include "w_wad.h"
#include "byteptr.h"
#include "t_array.h"
#include "t_vari.h"
#include "t_script.h"
#include "t_func.h"
#include "m_random.h"
#include "d_items.h"
  // NUMWEAPONS, NUMAMMO, NUMPOWERS
#include "m_argv.h"
  // to save command line
#include "m_misc.h"
  // FIL_Filename_of
#include "b_game.h"
  // B_Destroy_Bot
#include "b_node.h"
  // botNodeArray, oksector
#include "b_search.h"
  // the bot's path

#include "p_saveg.h"

// Compile-time savegame version, 149
#define DL_VERSION  ((DL_VER_MAJ * 100) + DL_VER_MIN)
// Need to read and write savegame version 149, for 1.48.16, due to MBF21 and VARY,
// and translate of dropped_ammo_count.
#if (DL_VERSION == 148) && defined( MOBJ_HAS_FLAGS3 ) || defined (MONSTER_VARY)
# define  FORCE_SAVEGAME_149   149
#undef DL_VERSION
#define DL_VERSION  149
#endif

#define MIN_READSAVE_VERSION  144
#define MAX_READSAVE_VERSION  DL_VERSION
// Portable savegames only: the version after F4, which saves every player's walking bob
// (bob_momx, bob_momy: bugs.md L25, L53). A portable 149 savegame (F2, F3) has no bob and
// still loads from a file, with the bob 0; a joining client refuses it, as the game it
// would start differs from the server's.
#define SG_BOB_VERSION  150

// The portable layout of the sector effects.  Savegame versions 144 to 149
// write them as raw memory, which differs between a 64-bit and a 32-bit
// build (see the sector effects below).  A savegame written with the
// portable layout has the version number SG_PORTABLE_BASE + the version of
// the rest of the format (149).  The base is far above any version number
// upstream is going to use, so the two cannot meet.  sg_version has the
// version without the base, and sg_portable says which layout it is.
#define SG_PORTABLE_BASE  10000


// Enable code for reading VERSION 144 format light thinkers.
#define READ_LF_VER_144    1
// Read old savegame flag positions
#define READ_FLAGS144      147
// Enable code for reading VERSION 144 format plat thinkers.
// The lowest savegame version where the new plat format was written.
#define READ_PLAT144    147

// Needed 1.48.16.
#define WRITE_DIFF2    148
#define READ_DIFF2     148

// Need to read and write savegame version 149, for 1.48.16, due to MBF21 and VARY.
#ifdef FORCE_SAVEGAME_149
#  undef  READ_DIFF2
#  define READ_DIFF2    149
#  undef  WRITE_DIFF2
#  define WRITE_DIFF2    149
#endif

byte * save_p;
boolean  save_game_abort = 0;
int  sg_version = 0;
boolean  sg_portable = 0;  // sector effects in the portable layout
static boolean  sg_net_load = 0;  // the savegame being read came by the network (a join)

// =======================================================================
//          Save Buffer Support
// =======================================================================

// Save game is inherently variable length, this is worst case wild guess.
// added 8-3-98 increase savegame size from 0x2c000 (180kb) to 512*1024
//#define SAVEGAMESIZE    (512*1024)
// [WDJ] This was exceeded by longdays.wad, ( 486K+ to 806K ).

// [WDJ] Variable savebuffer size
#define SAVEBUF_SIZE    (128*1024)
#define SAVEBUF_SIZEINC (128*1024)
#define SAVEBUF_HEADERSIZE   (64 + (80*5) + 1024 + 256)
#define SAVEBUF_FREE_TRIGGER  (64*1024)
//#define SAVEBUF_OVERFLOW_LENGTH  0xFF000000

//#define SAVEBUF_REPORT_BUFINC
// [WDJ] Uncomment the following to see how close to overrunning the buffer.
//#define SAVEBUF_REPORT_MIN_FREE 1
#ifdef SAVEBUF_REPORT_MIN_FREE
// [WDJ] Largest max_write, HGH2.wad, 12643 for Thinkers.
int savebuf_min_free;
int savebuf_max_write;
byte  current_sync, max_write_sync;
byte * savebuf_prev_write;
#endif


size_t savebuffer_size = 0;
byte * savebuffer = NULL;
const char * savefile = NULL;
ExtFIL_t  extfile;


const byte sg_padded = 0;  // Savegames are no longer padded for any platform.

#ifdef SGI
// [WDJ] File padding no longer works because SG_Writebuf and SG_Readbuf
// move the buffer content up and down, and it is not fixed at any alignment.

// SGI savegame is now like normal savegames, without padding.
// If any write causes a problem, fix it at WRITEU16, WRITEU32, etc.,
// which encapsulate the byte buffer reads and writes.
// It appears that the current inline functions will suffice, but an
// actual test on an SGI machine will be needed.
#endif


// Allocate malloc an appropriately sized buffer
// Header-only, or data sized buffer (large).
byte *  P_Alloc_savebuffer( boolean large_size )
{
    savebuffer_size = (large_size)? SAVEBUF_SIZE : SAVEBUF_HEADERSIZE;
   
    save_p = savebuffer = (byte *)malloc(savebuffer_size);
    if( ! savebuffer)
    {
        I_SoftError(" Cannot allocate memory for savegame\n");
        return NULL;
    }
    extfile.buffer = savebuffer;
    extfile.bufcnt = 0;
#ifdef SAVEBUF_REPORT_MIN_FREE
    savebuf_min_free = savebuffer_size;
    savebuf_max_write = 0;
    savebuf_prev_write = savebuffer;
#endif
    return savebuffer;
}

// return SAVEBUF_OVERFLOW_LENGTH if overrun the buffer
// CLANG: size_t is unsigned
size_t  P_Savegame_length( void )
{
    size_t length = save_p - savebuffer;
    if (length > savebuffer_size)
    {
        I_SoftError ("Savegame buffer overrun, need %i\n", length);
        return SAVEBUF_OVERFLOW_LENGTH;
    }
#ifdef SAVEBUF_REPORT_MIN_FREE
    if( (savebuffer_size - length) < savebuf_min_free )
        savebuf_min_free = savebuffer_size - length;
    if( (save_p - savebuf_prev_write) > savebuf_max_write )
    {
        savebuf_max_write = (save_p - savebuf_prev_write);
        max_write_sync = current_sync;
    }
#endif
    return length;
}


// Setup savegame file write
int  P_Savegame_Writefile( const char * filename )
{
    if( P_Alloc_savebuffer( 1 ) == NULL )  // large savebuffer
       return -1;

    savefile = filename;
    return FIL_ExtFile_Open( &extfile, filename, 1 );  // Write file
}

// Setup savegame file read
int  P_Savegame_Readfile( const char * filename )
{
    if( P_Alloc_savebuffer( 1 ) == NULL )  // large savebuffer
       return -1;

    savefile = filename;
    return FIL_ExtFile_Open( &extfile, filename, 0 );  // Read file
}

// Close savegame file, and return error indication <0
// Only call if opened with P_Savegame_Readfile or Writefile.
int  P_Savegame_Closefile( boolean writeflag )
{
    int errflag = 0;
#ifdef SAVEBUF_REPORT_MIN_FREE
    GenPrintf(EMSG_info, "Report savebuffer min free: %i, buffer used: %i\n", savebuf_min_free, (savebuffer_size-savebuf_min_free));
    if( writeflag )
        GenPrintf(EMSG_info, "                 max write: %i, sync=%i\n", savebuf_max_write, max_write_sync);
#endif
    if( savebuffer )
    {
        size_t length = P_Savegame_length();
        if( length >= SAVEBUF_OVERFLOW_LENGTH )
        {
            errflag = -13;  // overrun buffer
        }
        else if( writeflag )
        {
            errflag = FIL_ExtWriteFile( &extfile, length );
        }
        FIL_ExtFile_Close( &extfile );
        free(savebuffer);
        savebuffer = NULL;
    }
    savefile = NULL;
    if( save_game_abort )
        errflag = -14;
    return errflag;
}

// In case of error
void  P_Savegame_Error_Closefile( void )
{
    if( savebuffer )
    {
        FIL_ExtFile_Close( &extfile );
        free(savebuffer);
        savebuffer = NULL;
    }
    savefile = NULL;
}

// write out buffer or expand it
static
void SG_Writebuf( void )
{
    size_t length = P_Savegame_length();
#ifdef SAVEBUF_REPORT_MIN_FREE
    savebuf_prev_write = save_p;
#endif
    // do nothing until within trigger of overflow
    if( (length + SAVEBUF_FREE_TRIGGER) < savebuffer_size )
        goto done;
    
    if( ! savefile )
    {
        // No savefile, buffer only
        // increase the buffer size
        size_t newsize = savebuffer_size + SAVEBUF_SIZEINC;
        if( newsize >= SAVEBUF_OVERFLOW_LENGTH )
           goto done;

        void * newbuf = realloc( savebuffer, newsize);
        if( newbuf == NULL )
        {
            I_SoftError ("Savegame buffer realloc fail at %i bytes.\n", newsize);
            // will fail when buffer gets overrun, which might not happen
            goto done;
        }
        savebuffer = newbuf;
        savebuffer_size = newsize;
        // [WDJ] Enable the following to see buffer increases
#ifdef SAVEBUF_REPORT_BUFFINC
#ifdef __MINGW32__
        // MinGW does not understand %z
        GenPrintf(EMSG_info, "Savegame buffer realloc of %u bytes.\n", (int)newsize);
#else
        GenPrintf(EMSG_info, "Savegame buffer realloc of %zu bytes.\n", newsize);
#endif
#endif
        goto done;
    }

    // flush the buffer
    if( length >= SAVEBUF_OVERFLOW_LENGTH )
        length = savebuffer_size;

    if( FIL_ExtWriteFile( &extfile, length ) < 0 )
    {
         I_SoftError ("Savegame buffer write fail: %i\n", extfile.stat_error);
         save_game_abort = 1;
    }
    save_p = savebuffer;  // ready for more
done:   
    return;
}

// read in buffer
static
void SG_Readbuf( void )
{
    size_t len1 = P_Savegame_length();  // used
   
    if( len1 >= SAVEBUF_OVERFLOW_LENGTH )
    {   // buffer overrun
        save_game_abort = 1;
        goto done;
    }
    if( ! savefile )
        goto done;  // No savefile, buffer only

    // check for done reading
    if( extfile.stat_error < STAT_OPEN )  // ERR or EOF
        goto done;
    // still have data to read
    
    if( extfile.bufcnt > len1 )  // existing data in buffer
    {
        // do not load more until little is left
        if( (extfile.bufcnt - len1) >= SAVEBUF_FREE_TRIGGER )
            goto done;

        extfile.bufcnt -= len1;  // data still in buffer
        memmove( savebuffer, save_p, extfile.bufcnt ); // shuffle data down
    }
    else
    {   // really empty (like first time)
        len1 = savebuffer_size;
        extfile.bufcnt = 0;
    }
    save_p = savebuffer;  // ready read ptr

    // refill the buffer
    if( FIL_ExtReadFile( &extfile, len1 ) < 0 )
    {
         I_SoftError ("Savegame buffer read fail: %i\n", extfile.stat_error);
         save_game_abort = 1;
    }
done:   
    return;
}

// =======================================================================
//          SYNC Support
// =======================================================================

// [WDJ] Sync byte with section identifier, so sections can be conditional
// Do not alter the values of these. They must have the same value over
// all save game versions they were used in.
typedef enum {
  // do not use 0, 1, 2, 254, 255
  SYNC_net = 3,
  SYNC_misc,
  SYNC_players,
  SYNC_world,
  SYNC_thinkers,
  SYNC_specials,	// 8
  // optionals that game may use
  SYNC_fragglescript = 70,
  SYNC_extra_mapthing,
  SYNC_bots,
  // optional controls that may vary per game
  SYNC_gamma = 200,
  SYNC_slowdoor,
  // optional sections added by this port; far from the values upstream hands out next
  SYNC_soundtarget = 240,
  SYNC_botstate,   // the rest of the bots' state, after the bots section
  // sync
  SYNC_end = 252,
  SYNC_sync = 253
} save_game_section_e;

static
void SG_SaveSync( save_game_section_e sgs )
{
#ifdef SAVEBUF_REPORT_MIN_FREE
    current_sync = sgs;
#endif
    WRITEBYTE( save_p, SYNC_sync );	// validity check
    WRITEBYTE( save_p, sgs );	// section id
    SG_Writebuf();
}

// required or conditional section
static
boolean SG_ReadSync( save_game_section_e sgs, boolean cond )
{
   if( save_game_abort )   return 0;	// all sync reads repeat the abort
   SG_Readbuf();
   if( READBYTE( save_p ) != SYNC_sync )  goto invalid;
   if( READBYTE( save_p ) != sgs )
   {
      if( ! cond )  goto invalid;
      save_p -= 2;	// backup for re-reading the sync
      return 0;		// not the wanted sync
   }
   return 1;
   
 invalid:
   I_SoftError( "LoadGame: Invalid sync\n" );
   save_game_abort = 1;
   return 0;
}

// =======================================================================
//          String Support
// =======================================================================

// write null term string
static
void SG_write_string( const char * sp )
{
#if 1
    strcpy((char *)save_p, sp);
    save_p += strlen(sp) + 1;
#else   
    int i=0;
    do {
        WRITECHAR(save_p, sp[i]);
    } while (sp[i++]);	// until null
#endif   
}

#if 0
// unused
// return string allocated using Z_Strdup, PU_LEVEL
static
char * SG_read_string( void )
{
    char * spdest;
    // Use strnlen (GNU) if you have it, otherwise have to use strlen
    // Do not define strnlen as strlen somewhere else, because that hides the
    // vulnerability.
#ifdef __USE_GNU
    // better protection against buffer overrun
    int len = strnlen( (char*)save_p, 258 ) + 1;	// incl term 0
#else   
    int len = strlen( (char*)save_p ) + 1;	// incl term 0
#endif
    // Protect against unterm string in file
    if( len > 256 )  return NULL;  // error
    spdest = Z_Strdup((char *)save_p, PU_LEVEL, NULL);
//    spdest = Z_Malloc( len, PU_LEVEL, 0 );
//    strcpy( spdest, save_p );
    save_p += len;
    return spdest;
}
#endif

#if 0
// unused
// write fixed length string
static
void SG_write_nstring( const char * sp, int field_length )
{
#if 1
    strncpy((char *)save_p, sp, field_length);  // padded with nulls
    save_p += field_length;
#else   
    int i;
    for( i=0; i<field_length; i++ ) {
        if( sp[i] == 0 ) break;	// end of string
        WRITECHAR(save_p, sp[i]);
    }
    for( ; i<field_length; i++ ) {
        WRITECHAR(save_p, 0 );  // padding
    }
#endif   
}
#endif

#if 0
// unused
// return string allocated using Z_Strdup, PU_LEVEL
static
char * SG_read_nstring( int field_length )
{
    char * spdest = Z_Malloc( field_length, PU_LEVEL, NULL );
    strncpy( spdest, (char *)save_p, field_length );
    save_p += field_length;
    return spdest;
}
#endif


// =======================================================================
//          Save sections
// =======================================================================

//int num_thinkers;       // number of thinkers in level being archived

static byte bots_detected = 0;

// For savegame before Ver 1.49
typedef enum
{
    // weapons   = 0x01ff,
    BACKPACK = 0x0200,
    ORIGNWEAP = 0x0400,
    AUTOAIM = 0x0800,
    ATTACKDWN = 0x1000,
    USEDWN = 0x2000,
    JMPDWN = 0x4000,
    DIDSECRET = 0x8000,
} player_saveflags;

// 32 bit flags
typedef enum
{
    // powers      = 0x00ff
    PD_REFIRE    = 0x0100,
    PD_KILLCOUNT = 0x0200,
    PD_ITEMCOUNT = 0x0400,
    PD_SECRETCOUNT = 0x0800,
    PD_DAMAGECOUNT = 0x1000,
    PD_BONUSCOUNT  = 0x2000,
    PD_CHICKENTICS = 0x4000,
    PD_CHICKENPECK = 0x8000,
    PD_FLAMECOUNT  = 0x10000,
    PD_FLYHEIGHT   = 0x20000,
    PD_TIRED       = 0x40000,
    PD_FLAGS149    = 0x80000,

    PD_EXPANSION   = 0x80000000L,  // Reserved
} player_diff;

//
// P_ArchivePlayers
//
static
void P_ArchivePlayers(void)
{
    int i, j;
    int flags;
    uint32_t diff;
    player_t * ply;

    for (i = 0; i < MAXPLAYERS; i++)
    {
        if (!playeringame[i])
            continue;

        ply = &players[i];

        if( ply->bot )  bots_detected = 1;

        flags = 0;
        diff = 0;
        for (j = 0; j < NUMPOWERS; j++)
            if (ply->powers[j])
                diff |= 1 << j;
        if (ply->refire)
            diff |= PD_REFIRE;
        if (ply->killcount)
            diff |= PD_KILLCOUNT;
        if (ply->itemcount)
            diff |= PD_ITEMCOUNT;
        if (ply->secretcount)
            diff |= PD_SECRETCOUNT;
        if (ply->damagecount)
            diff |= PD_DAMAGECOUNT;
        if (ply->bonuscount)
            diff |= PD_BONUSCOUNT;
        if (ply->chickenTics)
            diff |= PD_CHICKENTICS;
        if (ply->chickenPeck)
            diff |= PD_CHICKENPECK;
        if (ply->flamecount)
            diff |= PD_FLAMECOUNT;
        if (ply->flyheight)
            diff |= PD_FLYHEIGHT;
        if (ply->tired || ply->drown)
            diff |= PD_TIRED;
	if (ply->GB_flags || ply->GF_flags)
            diff |= PD_FLAGS149;

        WRITEU32(save_p, diff);

        WRITEANGLE(save_p, ply->aiming);
        WRITEU16(save_p, ply->health);
        WRITEU16(save_p, ply->armorpoints);
        WRITEBYTE(save_p, ply->armortype);

        for (j = 0; j < NUMPOWERS; j++)
        {
            if (diff & (1 << j))
                WRITE32(save_p, ply->powers[j]);
        }
        WRITEBYTE(save_p, ply->cards);
        WRITEBYTE(save_p, ply->readyweapon);
        WRITEBYTE(save_p, ply->pendingweapon);
        WRITEBYTE(save_p, ply->playerstate);

        WRITEU16(save_p, ply->addfrags);
        for (j = 0; j < MAXPLAYERS; j++)
        {
            if (playeringame[j])	// [WDJ] was [i] which was useless
                WRITEU16(save_p, ply->frags[j]);
        }

        for (j = 0; j < NUMWEAPONS; j++)
        {
            WRITEBYTE(save_p, ply->favoritweapon[j]);
            if (ply->weaponowned[j])
                flags |= 1 << j;
        }
        for (j = 0; j < NUMAMMO; j++)
        {
            WRITEU16(save_p, ply->ammo[j]);
            WRITEU16(save_p, ply->maxammo[j]);
        }

        if (diff & PD_REFIRE)
            WRITE32(save_p, ply->refire);
        if (diff & PD_KILLCOUNT)
            WRITE32(save_p, ply->killcount);
        if (diff & PD_ITEMCOUNT)
            WRITE32(save_p, ply->itemcount);
        if (diff & PD_SECRETCOUNT)
            WRITE32(save_p, ply->secretcount);
        if (diff & PD_DAMAGECOUNT)
            WRITE32(save_p, ply->damagecount);
        if (diff & PD_BONUSCOUNT)
            WRITE32(save_p, ply->bonuscount);
        if (diff & PD_CHICKENTICS)
            WRITE32(save_p, ply->chickenTics);
        if (diff & PD_CHICKENPECK)
            WRITE32(save_p, ply->chickenPeck);
        if (diff & PD_FLAMECOUNT)
            WRITE32(save_p, ply->flamecount);
        if (diff & PD_FLYHEIGHT)
            WRITE32(save_p, ply->flyheight);
        if (diff & PD_TIRED)  // Ver 1.49
        {   // Ver 1.48.16
            WRITEU16(save_p, ply->tired);
            WRITEU16(save_p, ply->drown);
        }

        WRITEBYTE(save_p, ply->skincolor);

        for (j = 0; j < NUMPSPRITES; j++)
        {
            pspdef_t * psp = & ply->psprites[j];
            if (psp->state)
                WRITEU16(save_p, (psp->state - states) + 1);
            else
                WRITEU16(save_p, 0);
            WRITE32(save_p, psp->tics);
            WRITEFIXED(save_p, psp->sx);
            WRITEFIXED(save_p, psp->sy);
        }
        WRITEU16(save_p, flags);

        if (diff & PD_FLAGS149)
	{
            // [MB] 2024-12-26: Added for 1.49 savegame format
            WRITEBYTE(save_p, ply->GB_flags);
            WRITEU16(save_p, ply->GF_flags);
	}

        if (EN_inventory)
        {
            WRITEBYTE(save_p, ply->inventorySlotNum);
            for (j = 0; j < ply->inventorySlotNum; j++)
            {
                WRITEBYTE(save_p, ply->inventory[j].type);
                WRITEBYTE(save_p, ply->inventory[j].count);
            }
        }

        // Portable layout: the view height is not always the default, after a fall.
        WRITEFIXED(save_p, ply->viewheight);
        WRITEFIXED(save_p, ply->deltaviewheight);
        // The walking bob decides when a player's mobj leaves its running frames
        // (P_PlayerMobjThinker, "stop player walking sprite"): a joiner that starts it at 0
        // stops a running player's frame at once (bugs.md L25, L53). Since SG_BOB_VERSION.
        WRITEFIXED(save_p, ply->bob_momx);
        WRITEFIXED(save_p, ply->bob_momy);

        SG_Writebuf();
    }
}

//
// P_UnArchivePlayers
//
static
void P_UnArchivePlayers(void)
{
    int i, j;
    int flags;
    uint32_t diff;
    player_t * ply;
       

    for (i = 0; i < MAXPLAYERS; i++)
    {
        SG_Readbuf();

        ply = &players[i];
        
        if( ply->bot )  B_Destroy_Bot( ply );
       
        memset( ply, 0, sizeof(player_t));

        if (!playeringame[i])
            continue;

        diff = READU32(save_p);

        ply->aiming = READANGLE(save_p);
        ply->health = READU16(save_p);
        ply->armorpoints = READU16(save_p);
        ply->armortype = READBYTE(save_p);

        for (j = 0; j < NUMPOWERS; j++)
        {
            if (diff & (1 << j))
                ply->powers[j] = READ32(save_p);
        }

        ply->cards = READBYTE(save_p);
        ply->readyweapon = READBYTE(save_p);
        ply->pendingweapon = READBYTE(save_p);
        ply->playerstate = READBYTE(save_p);

        ply->addfrags = READU16(save_p);
        for (j = 0; j < MAXPLAYERS; j++)
        {
            if (playeringame[j])	// [WDJ] was [i] which was useless
                ply->frags[j] = READU16(save_p);
        }

        for (j = 0; j < NUMWEAPONS; j++)
            ply->favoritweapon[j] = READBYTE(save_p);
        for (j = 0; j < NUMAMMO; j++)
        {
            ply->ammo[j] = READU16(save_p);
            ply->maxammo[j] = READU16(save_p);
        }
        if (diff & PD_REFIRE)
            ply->refire = READ32(save_p);
        if (diff & PD_KILLCOUNT)
            ply->killcount = READ32(save_p);
        if (diff & PD_ITEMCOUNT)
            ply->itemcount = READ32(save_p);
        if (diff & PD_SECRETCOUNT)
            ply->secretcount = READ32(save_p);
        if (diff & PD_DAMAGECOUNT)
            ply->damagecount = READ32(save_p);
        if (diff & PD_BONUSCOUNT)
            ply->bonuscount = READ32(save_p);
        if (diff & PD_CHICKENTICS)
            ply->chickenTics = READ32(save_p);
        if (diff & PD_CHICKENPECK)
            ply->chickenPeck = READ32(save_p);
        if (diff & PD_FLAMECOUNT)
            ply->flamecount = READ32(save_p);
        if (diff & PD_FLYHEIGHT)
            ply->flyheight = READ32(save_p);
        if (diff & PD_TIRED)  // Ver 1.49
        {   // Ver 1.48.16
            ply->tired = READU16(save_p);
            ply->drown = READU16(save_p);
        }

        ply->skincolor = READBYTE(save_p);

        for (j = 0; j < NUMPSPRITES; j++)
        {
            pspdef_t * psp = & ply->psprites[j];
            flags = READU16(save_p);
            if (flags)
                psp->state = &states[flags - 1];

            psp->tics = READ32(save_p);
            psp->sx = READFIXED(save_p);
            psp->sy = READFIXED(save_p);
        }

        flags = READU16(save_p);

        if( sg_version >= 149 )
        {   // Ver 1.48.16
	    if( diff & PD_FLAGS149 )
	    {
                ply->GB_flags = READBYTE(save_p);
                ply->GF_flags = READU16(save_p);
	    }
        }
        else
        {
            // Before Ver 1.49 savegame
            byte gb = 0;
            uint16_t gf = 0;
            if(flags & BACKPACK)  gf |= GF_backpack;
            if(flags & ORIGNWEAP) gf |= GF_original_weapon;
            if(flags & AUTOAIM)   gf |= GF_autoaim;
            if(flags & DIDSECRET) gf |= GF_didsecret;
            if(flags & ATTACKDWN) gb |= GB_attackdown;
            if(flags & USEDWN)    gb |= GB_usedown;
            if(flags & JMPDWN)    gb |= GB_jumpdown;  // spirit used 2 bit, in boolean field
            ply->GB_flags = gb;
            ply->GF_flags = gf;
        }
	
        if (EN_inventory)
        {
            ply->inventorySlotNum = READBYTE(save_p);
            for (j = 0; j < ply->inventorySlotNum; j++)
            {
                ply->inventory[j].type = READBYTE(save_p);
                ply->inventory[j].count = READBYTE(save_p);
            }
        }

        for (j = 0; j < NUMWEAPONS; j++)
            ply->weaponowned[j] = (flags & (1 << j)) != 0;

        if( sg_portable )
        {
            ply->viewheight = READFIXED(save_p);
            ply->deltaviewheight = READFIXED(save_p);
            if( sg_version >= SG_BOB_VERSION )
            {
                ply->bob_momx = READFIXED(save_p);
                ply->bob_momy = READFIXED(save_p);
            }
            else
            {
                // an older savegame does not have it: the bob starts at 0, as it did
                ply->bob_momx = 0;
                ply->bob_momy = 0;
            }
        }
        else
            ply->viewheight = cv_viewheight.value << FRACBITS;
        if (EN_heretic)
        {
            if (ply->powers[pw_weaponlevel2])
                ply->weaponinfo = wpnlev2info;
            else
                ply->weaponinfo = wpnlev1info;
        }
        else
            ply->weaponinfo = doomweaponinfo;

    }
}

#define SD_FLOORHT     0x01
#define SD_CEILHT      0x02
#define SD_FLOORPIC    0x04
#define SD_CEILPIC     0x08
#define SD_LIGHT       0x10
#define SD_SPECIAL     0x20
#define SD_DIFF2       0x40

//SoM: 4/10/2000: Fix sector related savegame bugs
// diff2 flags
#define SD_FXOFFS     0x01
#define SD_FYOFFS     0x02
#define SD_CXOFFS     0x04
#define SD_CYOFFS     0x08
#define SD_STAIRLOCK  0x10
#define SD_PREVSEC    0x20
#define SD_NEXTSEC    0x40

#define LD_FLAG     0x01
#define LD_SPECIAL  0x02
//#define LD_TAG      0x04
#define LD_S1TEXOFF 0x08
#define LD_S1TOPTEX 0x10
#define LD_S1BOTTEX 0x20
#define LD_S1MIDTEX 0x40
#define LD_DIFF2    0x80

// diff2 flags
#define LD_S2TEXOFF 0x01
#define LD_S2TOPTEX 0x02
#define LD_S2BOTTEX 0x04
#define LD_S2MIDTEX 0x08

//
// P_ArchiveWorld
//
static
void P_ArchiveWorld(void)
{
    int statsec = 0, statline = 0;
    line_t *li;
    side_t *si;
    byte *put;	// local copy of save_p, apparently for no reason
      // [WDJ] using a local var instead of global costs 800 bytes in obj
      // but saves 64 bytes in executable.
//#define put save_p

    // reload the map just to see difference
    mapsector_t *ms;
    mapsidedef_t *msd;
    maplinedef_t *mld;
    sector_t *ss;
    byte diff;
    byte diff2;

    // [WDJ] protect lump during this function
    ms = W_CacheLumpNum(level_lumpnum + ML_SECTORS, PU_IN_USE);	// mapsectors temp
    // [WDJ] Fix endian as compare temp to internal.
    // 
    ss = sectors;
    put = save_p;

    uint32_t i;
    for (i = 0; i < numsectors; i++, ss++, ms++)
    {
        // Save only how the sector differs from the wad.
        diff = 0;
        diff2 = 0;
        if (ss->floorheight != LE_SWAP16(ms->floorheight) << FRACBITS)
            diff |= SD_FLOORHT;
        if (ss->ceilingheight != LE_SWAP16(ms->ceilingheight) << FRACBITS)
            diff |= SD_CEILHT;
        //
        //  flats
        //
        // P_AddLevelFlat should not add but just return the number
        if (ss->floorpic != P_AddLevelFlat(ms->floorpic))  // check changed id
            diff |= SD_FLOORPIC;
        if (ss->ceilingpic != P_AddLevelFlat(ms->ceilingpic))  // check changed id
            diff |= SD_CEILPIC;

        if (ss->lightlevel != LE_SWAP16(ms->lightlevel))
            diff |= SD_LIGHT;
        if (ss->special != LE_SWAP16(ms->special))
            diff |= SD_SPECIAL;

        if (ss->floor_xoffs != 0)
            diff2 |= SD_FXOFFS;
        if (ss->floor_yoffs != 0)
            diff2 |= SD_FYOFFS;
        if (ss->ceiling_xoffs != 0)
            diff2 |= SD_CXOFFS;
        if (ss->ceiling_yoffs != 0)
            diff2 |= SD_CYOFFS;
        if (ss->stairlock < 0)
            diff2 |= SD_STAIRLOCK;
        if (ss->nextsec != -1)
            diff2 |= SD_NEXTSEC;
        if (ss->prevsec != -1)
            diff2 |= SD_PREVSEC;
        if (diff2)
            diff |= SD_DIFF2;

        if (diff)
        {
            statsec++;

            WRITE16(put, i);
            WRITEBYTE(put, diff);
            if (diff & SD_DIFF2)
                WRITEBYTE(put, diff2);
            if (diff & SD_FLOORHT)
                WRITEFIXED(put, ss->floorheight);
            if (diff & SD_CEILHT)
                WRITEFIXED(put, ss->ceilingheight);
            if (diff & SD_FLOORPIC)
            {
                memcpy(put, levelflats[ss->floorpic].name, 8);
                put += 8;
            }
            if (diff & SD_CEILPIC)
            {
                memcpy(put, levelflats[ss->ceilingpic].name, 8);
                put += 8;
            }
            if (diff & SD_LIGHT)
                WRITE16(put, (short) ss->lightlevel);
            if (diff & SD_SPECIAL)
                WRITE16(put, (short) ss->special);

            if (diff2 & SD_FXOFFS)
                WRITEFIXED(put, ss->floor_xoffs);
            if (diff2 & SD_FYOFFS)
                WRITEFIXED(put, ss->floor_yoffs);
            if (diff2 & SD_CXOFFS)
                WRITEFIXED(put, ss->ceiling_xoffs);
            if (diff2 & SD_CYOFFS)
                WRITEFIXED(put, ss->ceiling_yoffs);
            if (diff2 & SD_STAIRLOCK)
                WRITE32(put, ss->stairlock);
            if (diff2 & SD_NEXTSEC)
                WRITE32(put, ss->nextsec);
            if (diff2 & SD_PREVSEC)
                WRITE32(put, ss->prevsec);
        }
        save_p = put;
        SG_Writebuf();  // flush buffer upto save_p
        put = save_p;
    }
    WRITEU16(put, 0xffff);  // mark end of world sector section

    mld = W_CacheLumpNum(level_lumpnum + ML_LINEDEFS, PU_IN_USE); // linedefs temp
    msd = W_CacheLumpNum(level_lumpnum + ML_SIDEDEFS, PU_IN_USE); // sidedefs temp
    // [WDJ] Fix endian as compare temp to internal.
    li = lines;
    // do lines
    for (i = 0; i < numlines; i++, mld++, li++)
    {
        diff = 0;
        diff2 = 0;

        // we don't care of map in deathmatch !
        if( (( deathmatch )? (li->flags & ~ML_MAPPED) : li->flags) != LE_SWAP16(mld->flags) )
            diff |= LD_FLAG;
        if (li->special != LE_SWAP16(mld->special))
            diff |= LD_SPECIAL;

        if (li->sidenum[0] != NULL_INDEX)
        {
            mapsidedef_t * msd0 = &msd[li->sidenum[0]];
            si = &sides[li->sidenum[0]];
            if (si->textureoffset != LE_SWAP16(msd0->textureoffset) << FRACBITS)
                diff |= LD_S1TEXOFF;
            //SoM: 4/1/2000: Some textures are colormaps. Don't worry about invalid textures.
            if (R_CheckTextureNumForName(msd0->toptexture) != -1)
                if (si->toptexture != R_TextureNumForName(msd0->toptexture))
                    diff |= LD_S1TOPTEX;
            if (R_CheckTextureNumForName(msd0->bottomtexture) != -1)
                if (si->bottomtexture != R_TextureNumForName(msd0->bottomtexture))
                    diff |= LD_S1BOTTEX;
            if (R_CheckTextureNumForName(msd0->midtexture) != -1)
                if (si->midtexture != R_TextureNumForName(msd0->midtexture))
                    diff |= LD_S1MIDTEX;
        }
        if (li->sidenum[1] != NULL_INDEX)
        {
            mapsidedef_t * msd1 = &msd[li->sidenum[1]];
            si = &sides[li->sidenum[1]];
            if (si->textureoffset != LE_SWAP16(msd1->textureoffset) << FRACBITS)
                diff2 |= LD_S2TEXOFF;
            if (R_CheckTextureNumForName(msd1->toptexture) != -1)
                if (si->toptexture != R_TextureNumForName(msd1->toptexture))
                    diff2 |= LD_S2TOPTEX;
            if (R_CheckTextureNumForName(msd1->bottomtexture) != -1)
                if (si->bottomtexture != R_TextureNumForName(msd1->bottomtexture))
                    diff2 |= LD_S2BOTTEX;
            if (R_CheckTextureNumForName(msd1->midtexture) != -1)
                if (si->midtexture != R_TextureNumForName(msd1->midtexture))
                    diff2 |= LD_S2MIDTEX;
            if (diff2)
                diff |= LD_DIFF2;

        }

        if (diff)
        {
            statline++;
            WRITE16(put, (short) i);
            WRITEBYTE(put, diff);
            if (diff & LD_DIFF2)
                WRITEBYTE(put, diff2);
            if (diff & LD_FLAG)
                WRITE16(put, li->flags);
            if (diff & LD_SPECIAL)
                WRITE16(put, li->special);

            si = &sides[li->sidenum[0]];
            if (diff & LD_S1TEXOFF)
                WRITEFIXED(put, si->textureoffset);
            if (diff & LD_S1TOPTEX)
                WRITE16(put, si->toptexture);
            if (diff & LD_S1BOTTEX)
                WRITE16(put, si->bottomtexture);
            if (diff & LD_S1MIDTEX)
                WRITE16(put, si->midtexture);

            si = &sides[li->sidenum[1]];
            if (diff2 & LD_S2TEXOFF)
                WRITEFIXED(put, si->textureoffset);
            if (diff2 & LD_S2TOPTEX)
                WRITE16(put, si->toptexture);
            if (diff2 & LD_S2BOTTEX)
                WRITE16(put, si->bottomtexture);
            if (diff2 & LD_S2MIDTEX)
                WRITE16(put, si->midtexture);
        }
        save_p = put;
        SG_Writebuf();  // flush buffer upto save_p
        put = save_p;
    }
    WRITEU16(put, 0xffff);  // mark end of world linedef section

    //debug_Printf("sector saved %d/%d, line saved %d/%d\n",statsec,numsectors,statline,numlines);
    save_p = put;
    Z_ChangeTags_To( PU_IN_USE, PU_CACHE ); // now can free
}

//
// P_UnArchiveWorld
//
static
void P_UnArchiveWorld(void)
{
    uint32_t i;
    line_t * li;
    side_t * si;
    sector_t * secp;
    byte * get;
      // [WDJ] using a local var instead of global costs 736 bytes in obj
      // but saves 32 bytes in executable.
//#define get save_p
    byte diff, diff2;

    get = save_p;

    while (1)
    {
        save_p = get;
        SG_Readbuf();  // Read more from file to save_p
        get = save_p;

        i = (uint16_t) READU16(get);

        if (i == 0xffff) // end of world sector section
            break;

        if( i >= numsectors )  goto bad_sec_id_err;
        secp = & sectors[i];

        diff = READBYTE(get);
        if (diff & SD_DIFF2)
            diff2 = READBYTE(get);
        else
            diff2 = 0;
       
        if (diff & SD_FLOORHT)
            secp->floorheight = READFIXED(get);
        if (diff & SD_CEILHT)
            secp->ceilingheight = READFIXED(get);
        if (diff & SD_FLOORPIC)
        {
            secp->floorpic = P_AddLevelFlat((char *)get);  // find id
            get += 8;
        }
        if (diff & SD_CEILPIC)
        {
            secp->ceilingpic = P_AddLevelFlat((char *)get);  // find id
            get += 8;
        }
        if (diff & SD_LIGHT)
            secp->lightlevel = READ16(get);
        if (diff & SD_SPECIAL)
        {
            // OK to update, savegame linedef changes are not read yet,
            // but linedef changes do not affect sectors that are already setup.
            P_Update_Special_Sector( secp, READ16(get) );
        }

        if (diff2 & SD_FXOFFS)
            secp->floor_xoffs = READFIXED(get);
        if (diff2 & SD_FYOFFS)
            secp->floor_yoffs = READFIXED(get);
        if (diff2 & SD_CXOFFS)
            secp->ceiling_xoffs = READFIXED(get);
        if (diff2 & SD_CYOFFS)
            secp->ceiling_yoffs = READFIXED(get);
        if (diff2 & SD_STAIRLOCK)
            secp->stairlock = READ32(get);
        else
            secp->stairlock = 0;
        if (diff2 & SD_NEXTSEC)
            secp->nextsec = READ32(get);
        else
            secp->nextsec = -1;
        if (diff2 & SD_PREVSEC)
            secp->prevsec = READ32(get);
        else
            secp->prevsec = -1;
    }

    while (1)
    {
        save_p = get;
        SG_Readbuf();  // Read more from file to save_p
        get = save_p;

        i = READU16(get);

        if (i == 0xffff)  // end of world linedef section
            break;

        if( i >= numlines )  goto bad_line_id_err;
        li = &lines[i];
       
        diff = READBYTE(get);

        if (diff & LD_DIFF2)
            diff2 = READBYTE(get);
        else
            diff2 = 0;
        if (diff & LD_FLAG)
            li->flags = READ16(get);
        if (diff & LD_SPECIAL)
            li->special = READ16(get);

        si = &sides[li->sidenum[0]];
        if (diff & LD_S1TEXOFF)
            si->textureoffset = READFIXED(get);
        if (diff & LD_S1TOPTEX)
            si->toptexture = READ16(get);
        if (diff & LD_S1BOTTEX)
            si->bottomtexture = READ16(get);
        if (diff & LD_S1MIDTEX)
            si->midtexture = READ16(get);

        si = &sides[li->sidenum[1]];
        if (diff2 & LD_S2TEXOFF)
            si->textureoffset = READFIXED(get);
        if (diff2 & LD_S2TOPTEX)
            si->toptexture = READ16(get);
        if (diff2 & LD_S2BOTTEX)
            si->bottomtexture = READ16(get);
        if (diff2 & LD_S2MIDTEX)
            si->midtexture = READ16(get);
    }

    save_p = get;
    return;

bad_sec_id_err:
    I_SoftError("LoadGame: Bad sector ID.\n");
    goto failed;

bad_line_id_err:
    I_SoftError("LoadGame: Bad linedef ID.\n");
    goto failed;

failed:
    save_game_abort = 1;
    return;
}

//
// Thinkers and Mapthings
//


// [smite] A simple std::vector -style pointer-to-id mapping.
typedef struct
{
  void   *pointer;
} pointermap_cell_t;

typedef struct
{
  pointermap_cell_t *map; // array of cells
  unsigned int      used; // number of used cells in the array
  unsigned int alloc_len; // number of allocated cells
} pointermap_t;

static pointermap_t  mobj_ptrmap = {NULL,0,0};
static pointermap_t  mapthg_ptrmap = {NULL,0,0};

// Safe to call without knowing if was allocated or not.
static void ClearPointermap( pointermap_t * ptrmap )
{
  // Clean release of memory, setup for next call of Alloc_Pointermap 
  ptrmap->used = 0;
  ptrmap->alloc_len = 0;
  if( ptrmap->map )  free(ptrmap->map);
  ptrmap->map = NULL;
}

// Allocate or reallocate
// Current pointermap.used is unchanged.
static boolean  Alloc_Pointermap( pointermap_t * ptrmap, int num )
{
    // on failure allocpm==NULL, but pointmap.map will remain valid
    pointermap_cell_t * allocpm = realloc(ptrmap->map, num * sizeof(pointermap_cell_t));
    if( allocpm == NULL )
    {
      I_SoftError("LoadGame: Pointermap alloc failed.\n");
      save_game_abort = 1;  // will be detected by ReadSync
      return 0;
    }
    // update to new allocation
    ptrmap->map = allocpm;
    ptrmap->alloc_len = num;
    // num is one past the last new cell of new allocation
    // ptrmap->used is index of first uninitialized cell (one past end of old allocation)
    memset(&ptrmap->map[ptrmap->used], 0, (num-ptrmap->used) * sizeof(pointermap_cell_t));
    // All mapping has ID==0 map to NULL ptr.
    // This is less expensive than special tests.
    ptrmap->map[0].pointer = NULL;	// Map id==0 to NULL
    return 1;
}

static void InitPointermap_Save( pointermap_t * ptrmap, unsigned int size )
{
  ptrmap->used = 1;  // all will be free, except [0] == NULL ptr
  Alloc_Pointermap( ptrmap, size );
}

static void InitPointermap_Load( pointermap_t * ptrmap, unsigned int size )
{
  InitPointermap_Save( ptrmap, size );
  // mark everything as initialized (this condition holds all the time during loading)
  // Does not affect anything, yet.
  ptrmap->used = ptrmap->alloc_len;
}



// Saving: Returns the ID number corresponding to a pointer.
// [WDJ] see  WritePtr( mobj_t *p );
static uint32_t GetID(mobj_t *p)
{
  uint32_t id;
   
  // All NULL ptrs are mapped to ID==0
  if (!p)
    return 0; // NULL ptr has id == 0

  // see if pointer is already there
  for (id=0; id < mobj_ptrmap.used; id++)
    if (mobj_ptrmap.map[id].pointer == p)  // use existing mapping
      return id;

  // okay, not there, we must add it

  // is there still space or should we enlarge the mapping table?
  if (mobj_ptrmap.used == mobj_ptrmap.alloc_len)
  {
    if( ! Alloc_Pointermap( &mobj_ptrmap, mobj_ptrmap.alloc_len * 2 ) )
       return 0; // alloc fail
  }

  // add the new pointer mapping
  id = mobj_ptrmap.used++;
  mobj_ptrmap.map[id].pointer = p;
  return id;
}


// Loading, first phase: Upon read of Mobj and the ID from the save game file.
// Sets the Mobj ID to pointer mapping.
static void MapMobjID(uint32_t id, mobj_t *p)
{
  // Cannot have mobj ptr p == NULL, that would be Z_Malloc failure.
  // Cannot have ID==0, that would be failure in mobj save, or bad file.
  // map[0] is preset to NULL
#if 1
  if (id == 0 || id > 500000)  goto bad_id_err;  // bad id, probably corrupt or wrong file.
#else
  if (!p)
  {
    I_Error("P_Savegame_Load_game: Tried to assign NULL pointer to an ID.\n"); // NULL ptr always has id == 0
    return;
  }

  if (!id)
  {
    I_SoftError("LoadGame: Object with ID number 0.\n");
    goto failed;
  }
  if (id == 0 || id > 500000)	// bad id
  {
    I_SoftError("LoadGame: Object ID sanity check failed.\n");
    goto failed;
  }
#endif

  // is id in the initialized/allocated region?
  while (id >= mobj_ptrmap.alloc_len)
  {
    // no, enlarge the container
    if( ! Alloc_Pointermap( &mobj_ptrmap, mobj_ptrmap.alloc_len * 2 ) )  goto failed;
    mobj_ptrmap.used = mobj_ptrmap.alloc_len; // all initialized
  }

  if (mobj_ptrmap.map[id].pointer)  goto duplicate_err;  // already exists
  mobj_ptrmap.map[id].pointer = p;  // save the mapping
  return;

bad_id_err:
  I_SoftError("LoadGame: Mobj read has bad object ID.\n");
  goto failed;

duplicate_err:
  I_SoftError("LoadGame: Same ID number found for several Mobj.\n");
  goto failed;

failed:
  save_game_abort = 1;
  return;
}


// Loading, second phase: Returns the pointer corresponding to the ID number.
// Only call after all the saved objects have been created, and are in map.
static mobj_t * GetMobjPointer(uint32_t id)
{
  // Less expensive to have map[0]==NULL than have special tests.
  // Is id in the initialized/allocated region? has it been assigned?
//  if (id >= mobj_ptrmap.alloc_len || !mobj_ptrmap.map[id].pointer)
  if ( id >= mobj_ptrmap.alloc_len )   goto bad_ptr;
  mobj_t * mp = mobj_ptrmap.map[id].pointer;	// [0] is NULL
  if( (mp == NULL) && (id > 0) )   goto bad_ptr;
  return mp;
   
bad_ptr:
  // on error, let user load a different save game
#if 1
  // Assume some mobj ptrs saved might not be valid, such as killed target.
  // This has been observed in a fresh saved game. 
  // Not fatal, return NULL ptr and continue;
  I_SoftError("LoadGame: Ptr to non-existant Mobj, make NULL.\n");
#else
  // Assume a bad mobj ptr is a corrupt savegame.
  I_SoftError("LoadGame: Unknown Mobj ID number.\n");
  save_game_abort = 1;
#endif
  return NULL;
}

#define WRITE_MobjPointerID(p,mobj)  WRITEU32((p), GetID(mobj));
#define READ_MobjPointerID(p)   GetMobjPointer( READU32(p) )
// No difference in executable
//#define READ_MobjPointerID_S(p,mobj)   (mobj) = GetMobjPointer( READU32(p) )

// Save sector and line ptrs as index into their arrays
// Protect against NULL line and mapthing pointers.
#define WRITE_SECTOR_PTR( secp )   WRITE32(save_p, (secp) - sectors)
#define READ_SECTOR_PTR( secp )   (secp) = &sectors[READ32(save_p)]
#define WRITE_LINE_PTR( linp )   WRITE32(save_p, (linp)?((linp) - lines):0xFFFFFFFF)
#define READ_LINE_PTR( linp )   { uint32_t d = READ32(save_p); (linp) = (d==0xFFFFFFFF)? NULL:&lines[d]; }

// [WDJ] 2013/7/29 Handle FS extra mapthing in savegame
#define EXTRA_MAPTHING_ID0   0x10000000
#define MAPTHING_NULLVALUE   0xFFFFFFFF

// convert an unknown mapthing reference to a saveable id
static uint32_t  Get_Mapthing_ID( mapthing_t * mtp )
{
  uint32_t id = MAPTHING_NULLVALUE;
  if ( mtp )
  {
    if ((mtp >= mapthings) && (mtp <= &mapthings[nummapthings-1]))
    {
      id = mtp - mapthings;  // index mapthings array
    }
    else
    {
      id = P_Extra_Mapthing_Index( mtp );  // find in Extra
      if( id )
        id += EXTRA_MAPTHING_ID0;
      else
        id = MAPTHING_NULLVALUE;  // failed to find it
    }
  }
  return id;
}

   
// Upon read of Mapthing and the ID from the save game file.
// Sets the Mobj ID to pointer mapping.
static void Map_Mapthing_ID(uint32_t mtid, mapthing_t *mtp)
{
  // Cannot have mapthing ptr p == NULL, that would be Z_Malloc failure.
  // Cannot have ID==0 in the mapthing archive.
  // map[0] is preset to NULL
  if (mtid == 0 || mtid > 500000)  goto bad_id_err;  // bad id, probably corrupt or wrong file.

  // is id in the initialized/allocated region?
  while (mtid >= mapthg_ptrmap.alloc_len)
  {
    unsigned int req_size = (mtid + (mtid>>2) + 64) & ~(64-1);  // mult 64
    // no, enlarge the container
    if( ! Alloc_Pointermap( &mapthg_ptrmap, req_size ) )  goto failed;
  }
  if( mtid >= mapthg_ptrmap.used )
      mapthg_ptrmap.used = mtid;

  if (mapthg_ptrmap.map[mtid].pointer)  goto duplicate_err;  // already exists
  mapthg_ptrmap.map[mtid].pointer = mtp;  // save the mapping
  return;

bad_id_err:
  I_SoftError("LoadGame: Mapthing read has bad object ID.\n");
  goto failed;

duplicate_err:
  I_SoftError("LoadGame: Same ID number found for several Mapthing.\n");
  goto failed;

failed:
  save_game_abort = 1;
  return;
}


// convert the saved id to a usable mapthing ptr
// must already have loaded level and loaded extra mapthings from savegame
static mapthing_t * Get_Mapthing_Ptr( unsigned int mtid )
{
  mapthing_t * mtp = NULL;
  if ( mtid != MAPTHING_NULLVALUE )
  {
    if (mtid < nummapthings)
    {
      mtp = &mapthings[mtid];  // in mapthings array
    }
    else if ( mtid >= EXTRA_MAPTHING_ID0 )
    {
      // lookup in pointermap
      mtid -= EXTRA_MAPTHING_ID0;  // 1..
      if ( mtid > mapthg_ptrmap.used )   goto bad_ptr;
      mtp = mapthg_ptrmap.map[mtid].pointer;  // [0] is NULL
      if ( mtp == NULL )   goto bad_ptr;
    }
    else
      I_SoftError("LoadGame: Unknown Mapthing ID number.\n");
  }
  return mtp;
   
bad_ptr:
    // on error, let user load a different save game
#if 1
  // Assume some mapthing ptrs saved might not be valid, such as killed target.
  // Known for some spawn.
  // Not fatal, return NULL ptr and continue;
  I_SoftError("LoadGame: Ptr to non-existant Mapthing, make NULL.\n");
#else
  // Assume a bad mobj ptr is a corrupt savegame.
  I_SoftError("LoadGame: Unknown Mapthing ID number.\n");
  save_game_abort = 1;
#endif
  return NULL;
}


#define WRITE_MAPTHING_PTR( mtp )   WRITE32(save_p, Get_Mapthing_ID(mtp))
#define READ_MAPTHING_PTR( mtp )    (mtp) = Get_Mapthing_Ptr( READ32(save_p) )
// another read of mapthing in P_UnArchiveSpecials


// Extra mapthings

static void P_Archive_Mapthing(void)
{
    mapthing_t * mthing = NULL;
    uint32_t   mtid;

    for(;;)
    {
        mthing = P_Traverse_Extra_Mapthing(mthing);
        if ( !mthing )  break;
        mtid = P_Extra_Mapthing_Index(mthing);
        if (mtid)
        {
            // no diffs, no wad mapthing to compare to
            WRITE32(save_p, mtid );
            WRITE16(save_p, mthing->x );
            WRITE16(save_p, mthing->y );
            WRITE16(save_p, mthing->z );
            WRITE16(save_p, mthing->angle );
            WRITE16(save_p, mthing->type );  // objtype
            WRITE16(save_p, mthing->options );
            SG_Writebuf();
        }
    }
    // mark the end of the save section using reserved id
    WRITE32(save_p, 0);
    return;
}

static void P_UnArchive_Mapthing( void )
{
    const char * reason;
    uint32_t   mtid;  // mapthing id
    mapthing_t * mthing;  // extra mapthing

    // read in saved mapthings
    for(;;)
    {
        SG_Readbuf();
        mtid = READ32(save_p);
        if (mtid == 0)  // reserved id to end section
            break;
        mthing = P_Get_Extra_Mapthing( 0 );  // allocate
        if (!mthing)
        {
            reason = "Cannot get extra mapthing";
            goto err_report;
        }
        Map_Mapthing_ID( mtid, mthing );
        mthing->x = READ16(save_p);
        mthing->y = READ16(save_p);
        mthing->z = READ16(save_p);
        mthing->angle = READ16(save_p);
        mthing->type = READ16(save_p);  // objtype
        mthing->options = READ16(save_p);
    }
    return;

err_report:
    I_SoftError("LoadGame: %s\n", reason );
    save_game_abort = 1;
    return;
}


//
// Thinkers
//

typedef enum
{
    MD_SPAWNPOINT = 0x000001,
    MD_POS = 0x000002,
    MD_TYPE = 0x000004,
// Eliminated MD_Z to prevent 3dfloor hiccups SSNTails 03-17-2002
    MD_MOM = 0x000008,
    MD_RADIUS = 0x000010,
    MD_HEIGHT = 0x000020,
    MD_FLAGS = 0x000040,
    MD_HEALTH = 0x000080,
    MD_RTIME = 0x000100,
    MD_STATE = 0x000200,
    MD_TICS = 0x000400,
    MD_SPRITE = 0x000800,
    MD_FRAME = 0x001000,
    MD_EFLAGS = 0x002000,
    MD_PLAYER = 0x004000,
    MD_MOVEDIR = 0x008000,
    MD_MOVECOUNT = 0x010000,
    MD_THRESHOLD = 0x020000,
    MD_LASTLOOK = 0x040000,
    MD_TARGET = 0x080000,
    MD_TRACER = 0x100000,
    MD_FRICTION = 0x200000,
    MD_MOVEFACTOR = 0x400000,
    MD_FLAGS2 = 0x800000,
    MD_SPECIAL1 = 0x1000000,
    MD_SPECIAL2 = 0x2000000,
    MD_AMMO = 0x4000000,
    MD_TFLAGS = 0x8000000,
    MD_MBFCOUNT = 0x10000000,
    MD_MBFTIP = 0x20000000,
    MD_MBF_LASTENEMY = 0x40000000,
    MD_MD2_DIFF = 0x80000000,
} mobj_diff_t;

typedef enum
{
    MD2_MBF21_FLAGS3 = 0x000001,  // MBF21, HEXEN flags
    MD2_monster_vary = 0x000002,
    MD2_unused_3 = 0x000004,
    MD2_unused_4 = 0x000008,
    MD2_unused_5 = 0x000010,
    MD2_unused_6 = 0x000020,
    MD2_unused_7 = 0x000040,
    MD2_unused_8 = 0x000080,
    MD2_unused_9 = 0x000100,
    MD2_unused_10 = 0x000200,
    MD2_unused_11 = 0x000400,
    MD2_unused_12 = 0x000800,
    MD2_unused_13 = 0x001000,
    MD2_unused_14 = 0x002000,
    MD2_unused_15 = 0x004000,
    MD2_unused_16 = 0x008000,
    MD2_unused_17 = 0x010000,
    MD2_unused_18 = 0x020000,
    MD2_unused_19 = 0x040000,
    MD2_unused_20 = 0x080000,
    MD2_unused_21 = 0x100000,
    MD2_unused_22 = 0x200000,
    MD2_unused_23 = 0x400000,
    MD2_unused_24 = 0x800000,
    MD2_unused_25 = 0x1000000,
    MD2_unused_26 = 0x2000000,
    MD2_unused_27 = 0x4000000,
    MD2_unused_28 = 0x8000000,
    MD2_unused_29 = 0x10000000,
    MD2_unused_30 = 0x20000000,
    MD2_unused_31 = 0x40000000,
    MD2_unused_32 = 0x80000000,
} mobj149_diff_t;

enum
{
    tc_end = 1,	// reserved type mark to end section
    // Changing order will invalidate all previous save games.
    tc_mobj,
    tc_ceiling,
    tc_door,
    tc_floor,
    tc_plat,
    tc_flash,
    tc_strobe,
    tc_glow,
    tc_fireflicker,
    tc_lightfade,
    tc_elevator,                //SoM: 3/15/2000: Add extra boom types.
    tc_scroll,
    tc_friction,
    tc_pusher
     // add new values only at end
} specials_e;

//
// P_ArchiveThinkers
//
//
// Things to handle:
//
// P_MobjsThinker (all mobj)
// T_MoveCeiling, (ceiling_t: sector_t * swizzle), - active list
// T_VerticalDoor, (vldoor_t: sector_t * swizzle),
// T_MoveFloor, (floormove_t: sector_t * swizzle),
// T_LightFlash, (lightflash_t: sector_t * swizzle),
// T_StrobeFlash, (strobe_t: sector_t *),
// T_Glow, (glow_t: sector_t *),
// T_LightFade, (lightfader_t: sector_t *),
// T_PlatRaise, (plat_t: sector_t *), - active list
// BP: added missing : T_FireFlicker
//

#if 0
// [smite] Safe sectoreffect saving and loading using a macro hack.
// [WDJ] comment: This is fragile. It depends upon the struct definitions
// of all the sector effects having the thinker_t links and sector ptr as
// the first fields.
// There will be no compiler errors when this fails !!
// It does not save the thinker_t fields (links) of the structure, nor
// the sector ptr.  It writes a sector index before raw writing the
// structure fields that are after the thinker_t and sector ptr.
// It does not handle the ceilinglist ptr.
#define SE_HEADER_SIZE (sizeof(thinker_t) + sizeof(sector_t*))
#define SAVE_SE(th) \
  { int s = sizeof(*th) - SE_HEADER_SIZE;	      \
    WRITE32(save_p, (th)->sector - sectors);	      \
    WRITEMEM(save_p, ((byte *)(th))+SE_HEADER_SIZE, s); }

#define LOAD_SE(th) \
  { int s = sizeof(*th) - SE_HEADER_SIZE;	      \
    (th)->sector = &sectors[READ32(save_p)];	      \
    READMEM(save_p, ((byte *)(th))+SE_HEADER_SIZE, s);\
    P_AddThinker(&(th)->thinker); }

#define WRITE_THINKER(th) { WRITEMEM(save_p, ((byte *)(th))+sizeof(thinker_t), sizeof(*th)-sizeof(thinker_t)); }
#define READ_THINKER(th) {  READMEM(save_p, ((byte *)(th))+sizeof(thinker_t), sizeof(*th)-sizeof(thinker_t)); P_AddThinker(&(th)->thinker); }

#endif // smite

// A thinker of a sector effect that is being loaded is put in the thinker lists (P_AddThinker)
// before its function is set, and P_AddThinker classifies it by that function (P_UpdateClassThink:
// "is it a mobj?"). In memory from Z_Malloc the function is what a freed block held, often a mobj's
// function after the old level's mobjs were freed: the effect was then read as a mobj, with
// garbage in its flags and health, and put in the friends or enemies class-list, where
// P_LookForMonsters (a friendly bot or dog looking for a target) walked it. Which machine got which
// list depended on the heap: a game loaded from one savegame played on differently on native and on
// wasm (found by tests/savegame-portable.sh, bots stage, when F4 moved the heap). Start from zeros.
static void * SG_ThinkerAlloc( size_t size )
{
    void * p = Z_Malloc( size, PU_LEVEL, NULL );
    memset( p, 0, size );
    return p;
}



// [WDJ] comment: This is fragile. It depends upon the struct definitions
// of all the sector effects having the thinker_t links and sector ptr as
// the first fields.
// There will be no compiler errors when this fails !!
// It reads the thinker fields raw, from the start field, to the end
// of the structure.

// The raw layout is the one of savegame versions 144 to 149.  It depends
// on the compiler and on the size of a pointer (the tail padding of a struct
// differs between a 64-bit and a 32-bit build), so it cannot be passed
// between such machines.  It is only read, to load savegames written before
// the portable layout; the portable layout is below.

// Include reading the sector ptr.
#define READ_SECTOR_THINKER(th, typ, field) \
  { int offset = offsetof( typ, field );\
    READ_SECTOR_PTR( (th)->sector );\
    READMEM(save_p, ((byte *)(th))+offset, (sizeof(*th)-offset));\
    P_AddThinker(&(th)->thinker); }

#ifdef READ_LF_VER_144
#define READ144_SECTOR_THINKER(th, th144, typ, field) \
  { int offset = offsetof( typ, field );\
    READ_SECTOR_PTR( (th)->sector );\
    READMEM(save_p, ((byte *)(th144))+offset, (sizeof(*th144)-offset));\
    P_AddThinker(&(th)->thinker); }
#endif


// No extra fields
#define READ_THINKER(th, typ, field) \
  { int offset = offsetof( typ, field );\
    READMEM(save_p, ((byte *)(th))+offset, (sizeof(*th)-offset));\
    P_AddThinker(&(th)->thinker); }


// The portable layout of the sector effects (savegame version
// SG_PORTABLE_BASE + 149).  Each field is written by itself, in the order
// of its struct, at a fixed width and in the byte order of WRITE16/WRITE32:
// a boolean or an int8_t is one byte, an enum is 32 bits, a short or a
// lightlev_t is 16 bits, an int or a fixed_t is 32 bits.  No padding, no
// pointer.  The sector is written as an index (WRITE_SECTOR_PTR), as before.
// A savegame of this layout is the same on x86_64 and on wasm32.

static
void  WRITE_ceiling_fields( const ceiling_t * ceilp )
{
    WRITE_SECTOR_PTR( ceilp->sector );
    WRITE32(save_p, ceilp->type);
    WRITEFIXED(save_p, ceilp->bottomheight);
    WRITEFIXED(save_p, ceilp->topheight);
    WRITEFIXED(save_p, ceilp->speed);
    WRITEFIXED(save_p, ceilp->oldspeed);
    WRITEBOOLEAN(save_p, ceilp->crush);
    WRITEBYTE(save_p, ceilp->direction);
    WRITEBYTE(save_p, ceilp->olddirection);
    WRITEU16(save_p, ceilp->tag);
    WRITE16(save_p, ceilp->new_sec_special);
    WRITE16(save_p, ceilp->old_sec_special);
    WRITE16(save_p, ceilp->new_ceilingpic);
    // ceilinglist* does not need to be saved
}

static
void  READ_ceiling_fields( ceiling_t * ceilp )
{
    READ_SECTOR_PTR( ceilp->sector );
    ceilp->type = READ32(save_p);
    ceilp->bottomheight = READFIXED(save_p);
    ceilp->topheight = READFIXED(save_p);
    ceilp->speed = READFIXED(save_p);
    ceilp->oldspeed = READFIXED(save_p);
    ceilp->crush = READBOOLEAN(save_p);
    ceilp->direction = (int8_t) READBYTE(save_p);
    ceilp->olddirection = (int8_t) READBYTE(save_p);
    ceilp->tag = READU16(save_p);
    ceilp->new_sec_special = READ16(save_p);
    ceilp->old_sec_special = READ16(save_p);
    ceilp->new_ceilingpic = READ16(save_p);
}

static
void  WRITE_plat_fields( const plat_t * platp )
{
    WRITE_SECTOR_PTR( platp->sector );
    WRITE32(save_p, platp->type);
    WRITEFIXED(save_p, platp->speed);
    WRITEFIXED(save_p, platp->low);
    WRITEFIXED(save_p, platp->high);
    WRITEBOOLEAN(save_p, platp->crush);
    WRITEU16(save_p, platp->tag);
    WRITE32(save_p, platp->wait);
    WRITE32(save_p, platp->count);
    WRITE32(save_p, platp->status);
    WRITE32(save_p, platp->oldstatus);
    // platlist* does not need to be saved
}

static
void  READ_plat_fields( plat_t * platp )
{
    READ_SECTOR_PTR( platp->sector );
    platp->type = READ32(save_p);
    platp->speed = READFIXED(save_p);
    platp->low = READFIXED(save_p);
    platp->high = READFIXED(save_p);
    platp->crush = READBOOLEAN(save_p);
    platp->tag = READU16(save_p);
    platp->wait = READ32(save_p);
    platp->count = READ32(save_p);
    platp->status = READ32(save_p);
    platp->oldstatus = READ32(save_p);
}

static
void  WRITE_door_fields( const vldoor_t * door )
{
    WRITE_SECTOR_PTR( door->sector );
    WRITE32(save_p, door->type);
    WRITEFIXED(save_p, door->topheight);
    WRITEFIXED(save_p, door->speed);
    WRITE32(save_p, door->direction);
    WRITE32(save_p, door->topwait);
    WRITE32(save_p, door->topcountdown);
    WRITEU16(save_p, door->lighttag);
    // The line follows, as a line index.
}

static
void  READ_door_fields( vldoor_t * door )
{
    READ_SECTOR_PTR( door->sector );
    door->type = READ32(save_p);
    door->topheight = READFIXED(save_p);
    door->speed = READFIXED(save_p);
    door->direction = READ32(save_p);
    door->topwait = READ32(save_p);
    door->topcountdown = READ32(save_p);
    door->lighttag = READU16(save_p);
}

static
void  WRITE_floor_fields( const floormove_t * floormv )
{
    WRITE_SECTOR_PTR( floormv->sector );
    WRITE32(save_p, floormv->type);
    WRITEBOOLEAN(save_p, floormv->crush);
    WRITEFIXED(save_p, floormv->floordestheight);
    WRITEFIXED(save_p, floormv->speed);
    WRITEBYTE(save_p, floormv->direction);
    WRITE16(save_p, floormv->new_sec_special);
    WRITE16(save_p, floormv->old_sec_special);
    WRITE16(save_p, floormv->new_floorpic);
    WRITE16(save_p, floormv->new_floortype);
}

static
void  READ_floor_fields( floormove_t * floormv )
{
    READ_SECTOR_PTR( floormv->sector );
    floormv->type = READ32(save_p);
    floormv->crush = READBOOLEAN(save_p);
    floormv->floordestheight = READFIXED(save_p);
    floormv->speed = READFIXED(save_p);
    floormv->direction = (int8_t) READBYTE(save_p);
    floormv->new_sec_special = READ16(save_p);
    floormv->old_sec_special = READ16(save_p);
    floormv->new_floorpic = READ16(save_p);
    floormv->new_floortype = READ16(save_p);
}

static
void  WRITE_flash_fields( const lightflash_t * flash )
{
    WRITE_SECTOR_PTR( flash->sector );
    WRITE16(save_p, flash->minlight);
    WRITE16(save_p, flash->maxlight);
    WRITE32(save_p, flash->mintime);
    WRITE32(save_p, flash->maxtime);
    WRITE32(save_p, flash->count);
}

static
void  READ_flash_fields( lightflash_t * flash )
{
    READ_SECTOR_PTR( flash->sector );
    flash->minlight = READ16(save_p);
    flash->maxlight = READ16(save_p);
    flash->mintime = READ32(save_p);
    flash->maxtime = READ32(save_p);
    flash->count = READ32(save_p);
}

static
void  WRITE_strobe_fields( const strobe_t * strobe )
{
    WRITE_SECTOR_PTR( strobe->sector );
    WRITE16(save_p, strobe->minlight);
    WRITE16(save_p, strobe->maxlight);
    WRITE32(save_p, strobe->darktime);
    WRITE32(save_p, strobe->brighttime);
    WRITE32(save_p, strobe->count);
}

static
void  READ_strobe_fields( strobe_t * strobe )
{
    READ_SECTOR_PTR( strobe->sector );
    strobe->minlight = READ16(save_p);
    strobe->maxlight = READ16(save_p);
    strobe->darktime = READ32(save_p);
    strobe->brighttime = READ32(save_p);
    strobe->count = READ32(save_p);
}

static
void  WRITE_glow_fields( const glow_t * glow )
{
    WRITE_SECTOR_PTR( glow->sector );
    WRITE16(save_p, glow->minlight);
    WRITE16(save_p, glow->maxlight);
    WRITEBYTE(save_p, glow->direction);
}

static
void  READ_glow_fields( glow_t * glow )
{
    READ_SECTOR_PTR( glow->sector );
    glow->minlight = READ16(save_p);
    glow->maxlight = READ16(save_p);
    glow->direction = (int8_t) READBYTE(save_p);
}

static
void  WRITE_fireflicker_fields( const fireflicker_t * ff )
{
    WRITE_SECTOR_PTR( ff->sector );
    WRITE16(save_p, ff->minlight);
    WRITE16(save_p, ff->maxlight);
    WRITE32(save_p, ff->count);
}

static
void  READ_fireflicker_fields( fireflicker_t * ff )
{
    READ_SECTOR_PTR( ff->sector );
    ff->minlight = READ16(save_p);
    ff->maxlight = READ16(save_p);
    ff->count = READ32(save_p);
}

static
void  WRITE_lightfade_fields( const lightfader_t * fade )
{
    WRITE_SECTOR_PTR( fade->sector );
    WRITE16(save_p, fade->destlight);
    WRITE16(save_p, fade->speed);
}

static
void  READ_lightfade_fields( lightfader_t * fade )
{
    READ_SECTOR_PTR( fade->sector );
    fade->destlight = READ16(save_p);
    fade->speed = READ16(save_p);
}

static
void  WRITE_elevator_fields( const elevator_t * elevator )
{
    WRITE_SECTOR_PTR( elevator->sector );
    WRITE32(save_p, elevator->type);
    WRITEBYTE(save_p, elevator->direction);
    WRITEFIXED(save_p, elevator->floordestheight);
    WRITEFIXED(save_p, elevator->ceilingdestheight);
    WRITEFIXED(save_p, elevator->speed);
}

static
void  READ_elevator_fields( elevator_t * elevator )
{
    READ_SECTOR_PTR( elevator->sector );
    elevator->type = READ32(save_p);
    elevator->direction = (int8_t) READBYTE(save_p);
    elevator->floordestheight = READFIXED(save_p);
    elevator->ceilingdestheight = READFIXED(save_p);
    elevator->speed = READFIXED(save_p);
}

// The next three have no sector ptr.
static
void  WRITE_scroll_fields( const scroll_t * scroll )
{
    WRITE32(save_p, scroll->type);
    WRITE32(save_p, scroll->affectee);
    WRITE32(save_p, scroll->control);
    WRITE32(save_p, scroll->accel);
    WRITEFIXED(save_p, scroll->dx);
    WRITEFIXED(save_p, scroll->dy);
    WRITEFIXED(save_p, scroll->last_height);
    WRITEFIXED(save_p, scroll->vdx);
    WRITEFIXED(save_p, scroll->vdy);
}

static
void  READ_scroll_fields( scroll_t * scroll )
{
    scroll->type = READ32(save_p);
    scroll->affectee = READ32(save_p);
    scroll->control = READ32(save_p);
    scroll->accel = READ32(save_p);
    scroll->dx = READFIXED(save_p);
    scroll->dy = READFIXED(save_p);
    scroll->last_height = READFIXED(save_p);
    scroll->vdx = READFIXED(save_p);
    scroll->vdy = READFIXED(save_p);
}

#ifdef FRICTIONTHINKER
static
void  WRITE_friction_fields( const friction_t * friction )
{
    WRITE32(save_p, friction->affectee);
    WRITE32(save_p, friction->friction);
    WRITE32(save_p, friction->movefactor);
}

static
void  READ_friction_fields( friction_t * friction )
{
    friction->affectee = READ32(save_p);
    friction->friction = READ32(save_p);
    friction->movefactor = READ32(save_p);
}
#endif

static
void  WRITE_pusher_fields( const pusher_t * pusher )
{
    WRITE32(save_p, pusher->type);
    WRITE32(save_p, pusher->affectee);
    WRITE32(save_p, pusher->x_mag);
    WRITE32(save_p, pusher->y_mag);
    WRITE32(save_p, pusher->magnitude);
    WRITE32(save_p, pusher->radius);
    WRITEFIXED(save_p, pusher->x_src);
    WRITEFIXED(save_p, pusher->y_src);
    // source is rebuilt on load from affectee
}

static
void  READ_pusher_fields( pusher_t * pusher )
{
    pusher->type = READ32(save_p);
    pusher->affectee = READ32(save_p);
    pusher->x_mag = READ32(save_p);
    pusher->y_mag = READ32(save_p);
    pusher->magnitude = READ32(save_p);
    pusher->radius = READ32(save_p);
    pusher->x_src = READFIXED(save_p);
    pusher->y_src = READFIXED(save_p);
}


// Each sector effect is written as its marker, its fields, and what follows
// them.  Called for stopped ceiling or active ceiling.
// Must be consistent, there is one reader for both.
static
void  WRITE_ceiling( const ceiling_t * ceilp, byte active )
{
    WRITEBYTE(save_p, tc_ceiling); // ceiling marker
    WRITE_ceiling_fields( ceilp );
    WRITEBYTE(save_p, active); // active or stopped ceiling
}


// Called for stopped platform or active platform.
// Must be consistent, there is one reader for both.
static
void  WRITE_plat( const plat_t * platp, byte active )
{
    WRITEBYTE(save_p, tc_plat);  // platform marker
    WRITE_plat_fields( platp );
    WRITEBYTE(save_p, active); // active or stopped plat
}

static
void  WRITE_door( const vldoor_t * door )
{
    WRITEBYTE(save_p, tc_door);  // door marker
    WRITE_door_fields( door );
    WRITE_LINE_PTR( door->line );  // can be NULL
}

static
void  WRITE_floor( const floormove_t * floormv )
{
    WRITEBYTE(save_p, tc_floor);
    WRITE_floor_fields( floormv );
}

static
void  WRITE_flash( const lightflash_t * flash )
{
    WRITEBYTE(save_p, tc_flash);
    WRITE_flash_fields( flash );
}

static
void  WRITE_strobe( const strobe_t * strobe )
{
    WRITEBYTE(save_p, tc_strobe);
    WRITE_strobe_fields( strobe );
}

static
void  WRITE_glow( const glow_t * glow )
{
    WRITEBYTE(save_p, tc_glow);
    WRITE_glow_fields( glow );
}

static
void  WRITE_fireflicker( const fireflicker_t * ff )
{
    WRITEBYTE(save_p, tc_fireflicker);
    WRITE_fireflicker_fields( ff );
}

static
void  WRITE_lightfade( const lightfader_t * fade )
{
    WRITEBYTE(save_p, tc_lightfade);
    WRITE_lightfade_fields( fade );
}

static
void  WRITE_elevator( const elevator_t * elevator )
{
    WRITEBYTE(save_p, tc_elevator);
    WRITE_elevator_fields( elevator );
}

static
void  WRITE_scroll( const scroll_t * scroll )
{
    WRITEBYTE(save_p, tc_scroll);
    WRITE_scroll_fields( scroll );
}

#ifdef FRICTIONTHINKER
static
void  WRITE_friction( const friction_t * friction )
{
    // Friction thinkers are obsolete
    WRITEBYTE(save_p, tc_friction);
    WRITE_friction_fields( friction );
}
#endif

static
void  WRITE_pusher( const pusher_t * pusher )
{
    WRITEBYTE(save_p, tc_pusher);
    WRITE_pusher_fields( pusher );
}


// Test-only (-testsizes).  Reports, for each sector effect, the number of bytes
// one record takes in a savegame, and whether a record survives a trip: every
// byte of the struct is set to a value of its own (not zero), the record is
// written and read into a zeroed struct, every saved field of which must equal
// the original (a field cut to a smaller width, or left out of the writing and
// the reading both, fails here), and written again: the two records must be
// the same.  The writing and the reading are the ones the savegame
// uses, so the numbers do not depend on the build, which is the point: native
// and wasm must print the same.  Sector effects that no demo makes (ceilings,
// light fades, elevators, friction, pushers, stopped ones) are covered this way.
// The fields the savegame does not hold (the thinker links, the lists, the
// pusher's source) are not read by the writing, so their values do not matter,
// and a door's line is NULL.
#define EQ(f)  (th.f == th2.f)
#define SG_TRIP_BODY( name, typ, wcall, rcall, SETUP, SAME ) \
    {  typ th, th2;  size_t k;  int n, n2;                              \
       for (k = 0; k < sizeof(th); k++)  ((byte *)&th)[k] = (byte)(k * 37 + 11); \
       memset( &th2, 0, sizeof(th2) );                                  \
       SETUP;                                                           \
       save_p = buf;  wcall;  n = save_p - buf;                        \
       save_p = buf + 1;  rcall;  /* after the marker */                \
       { int same = (SAME);  /* the saved fields come back as they were */ \
       save_p = buf2;  th = th2;  wcall;  n2 = save_p - buf2;           \
       report( name, n, (same && n == n2 && memcmp( buf, buf2, n ) == 0) ); } }

void P_Savegame_Effect_Sizes( void (*report)( const char * name, int bytes, int roundtrip_ok ) )
{
    byte buf[256], buf2[256];
    byte * saved_p = save_p;

#define SECTOR_SETUP     th.sector = sectors;  th2.sector = sectors
// (a boolean is written as 0 or 1: crush is set to 1)
#define NO_SETUP         ((void)0)
    SG_TRIP_BODY( "ceiling", ceiling_t, WRITE_ceiling( &th, 1 ), READ_ceiling_fields( &th2 ), { SECTOR_SETUP;  th.crush = 1; } ,
                  EQ(type) && EQ(bottomheight) && EQ(topheight) && EQ(speed) && EQ(oldspeed) && EQ(crush) && EQ(direction) && EQ(olddirection) && EQ(tag) && EQ(new_sec_special) && EQ(old_sec_special) && EQ(new_ceilingpic) );
    SG_TRIP_BODY( "door", vldoor_t, WRITE_door( &th ),
                  { READ_door_fields( &th2 );  READ_LINE_PTR( th2.line ); },
                  { th.sector = sectors;  th2.sector = sectors;  th.line = NULL; } ,
                  EQ(type) && EQ(topheight) && EQ(speed) && EQ(direction) && EQ(topwait) && EQ(topcountdown) && EQ(lighttag) && EQ(line) );
    SG_TRIP_BODY( "floor", floormove_t, WRITE_floor( &th ), READ_floor_fields( &th2 ), { SECTOR_SETUP;  th.crush = 1; } ,
                  EQ(type) && EQ(crush) && EQ(floordestheight) && EQ(speed) && EQ(direction) && EQ(new_sec_special) && EQ(old_sec_special) && EQ(new_floorpic) && EQ(new_floortype) );
    SG_TRIP_BODY( "plat", plat_t, WRITE_plat( &th, 1 ), READ_plat_fields( &th2 ), { SECTOR_SETUP;  th.crush = 1; } ,
                  EQ(type) && EQ(speed) && EQ(low) && EQ(high) && EQ(crush) && EQ(tag) && EQ(wait) && EQ(count) && EQ(status) && EQ(oldstatus) );
    SG_TRIP_BODY( "flash", lightflash_t, WRITE_flash( &th ), READ_flash_fields( &th2 ), SECTOR_SETUP ,
                  EQ(minlight) && EQ(maxlight) && EQ(mintime) && EQ(maxtime) && EQ(count) );
    SG_TRIP_BODY( "strobe", strobe_t, WRITE_strobe( &th ), READ_strobe_fields( &th2 ), SECTOR_SETUP ,
                  EQ(minlight) && EQ(maxlight) && EQ(darktime) && EQ(brighttime) && EQ(count) );
    SG_TRIP_BODY( "glow", glow_t, WRITE_glow( &th ), READ_glow_fields( &th2 ), SECTOR_SETUP ,
                  EQ(minlight) && EQ(maxlight) && EQ(direction) );
    SG_TRIP_BODY( "fireflicker", fireflicker_t, WRITE_fireflicker( &th ), READ_fireflicker_fields( &th2 ), SECTOR_SETUP ,
                  EQ(minlight) && EQ(maxlight) && EQ(count) );
    SG_TRIP_BODY( "lightfade", lightfader_t, WRITE_lightfade( &th ), READ_lightfade_fields( &th2 ), SECTOR_SETUP ,
                  EQ(destlight) && EQ(speed) );
    SG_TRIP_BODY( "elevator", elevator_t, WRITE_elevator( &th ), READ_elevator_fields( &th2 ), SECTOR_SETUP ,
                  EQ(type) && EQ(direction) && EQ(floordestheight) && EQ(ceilingdestheight) && EQ(speed) );
    SG_TRIP_BODY( "scroll", scroll_t, WRITE_scroll( &th ), READ_scroll_fields( &th2 ), NO_SETUP ,
                  EQ(type) && EQ(affectee) && EQ(control) && EQ(accel) && EQ(dx) && EQ(dy) && EQ(last_height) && EQ(vdx) && EQ(vdy) );
#ifdef FRICTIONTHINKER
    SG_TRIP_BODY( "friction", friction_t, WRITE_friction( &th ), READ_friction_fields( &th2 ), NO_SETUP ,
                  EQ(affectee) && EQ(friction) && EQ(movefactor) );
#endif
    SG_TRIP_BODY( "pusher", pusher_t, WRITE_pusher( &th ), READ_pusher_fields( &th2 ), NO_SETUP ,
                  EQ(type) && EQ(affectee) && EQ(x_mag) && EQ(y_mag) && EQ(magnitude) && EQ(radius) && EQ(x_src) && EQ(y_src) );
    save_p = saved_p;
}

static inline
uint16_t  translate_old_dropped_ammo( int old_ammo_dropped )
{
    // An empty clip was encoded as -1, it is now encoded as
#define TST_AMMO_0    0xFFFF
    return (old_ammo_dropped < 0) ? TST_AMMO_0 : old_ammo_dropped;
}


static
void P_ArchiveThinkers(void)
{
    thinker_t *th;
    mobj_t *mobj;
    uint32_t diff1;
#ifdef WRITE_DIFF2
    uint32_t diff2;
#endif

    // save the current thinkers
    for (th = thinkercap.next; th != &thinkercap; th = th->next)
    {
        // Must be up here because of continue stmts.
        SG_Writebuf();

        if (th->function == TFI_MobjThinker)
        {
            // Mobj thinker
            mobj = (mobj_t *) th;

#if 0
            // [WDJ] DEBUG
            boolean voodoo_doll = 0;
            if( mobj->player )
            {
                if( mobj->player->mo != mobj )
                   voodoo_doll = 1;
            }
#endif
/*
            // not a monster nor a pickable item so don't save it
            if( (((mobj->flags & (MF_COUNTKILL | MF_PICKUP | MF_SHOOTABLE )) == 0)
                 && (mobj->flags & MF_MISSILE)
                 && (mobj->info->doomednum !=-1) )
                || (mobj->type == MT_BLOOD) )
                continue;
*/
            // Either save MD_SPAWNPOINT, or save MD_TYPE, or both
            if (mobj->spawnpoint
                && (!(mobj->spawnpoint->options & MTF_FS_SPAWNED))
                && (mobj->info->doomednum != -1))
            {
                // spawnpoint is not modified but we must save it since it is a identifier
                diff1 = MD_SPAWNPOINT;

                if ((mobj->x != mobj->spawnpoint->x << FRACBITS)
                    || (mobj->y != mobj->spawnpoint->y << FRACBITS)
                    || (mobj->angle != wad_to_angle(mobj->spawnpoint->angle)))
                    diff1 |= MD_POS;
                if (mobj->info->doomednum != mobj->spawnpoint->type)
                    diff1 |= MD_TYPE;
            }
            else
            {
                // not a map spawned thing so make it from scratch
                diff1 = MD_POS | MD_TYPE;
                // if might respawn then need to save spawnpoint too
                if( mobj->spawnpoint )
                    diff1 |= MD_SPAWNPOINT;  // save extra mapthing ref
            }

            // not the default but the most probable
            if ((mobj->momx != 0) || (mobj->momy != 0) || (mobj->momz != 0))
                diff1 |= MD_MOM;
            if (mobj->radius != mobj->info->radius)
                diff1 |= MD_RADIUS;
            if (mobj->height != mobj->info->height)
                diff1 |= MD_HEIGHT;
            if (mobj->flags != mobj->info->flags)
                diff1 |= MD_FLAGS;
            if (mobj->flags2 != mobj->info->flags2)
                diff1 |= MD_FLAGS2;
            if (mobj->health != mobj->info->spawnhealth)
                diff1 |= MD_HEALTH;
            if (mobj->reactiontime != mobj->info->reactiontime)
                diff1 |= MD_RTIME;
            if (mobj->state - states != mobj->info->spawnstate)
                diff1 |= MD_STATE;
            if (mobj->tics != mobj->state->tics)
                diff1 |= MD_TICS;
            if (mobj->sprite != mobj->state->sprite)
                diff1 |= MD_SPRITE;
            if (mobj->frame != mobj->state->frame)
                diff1 |= MD_FRAME;
            if (mobj->eflags)
                diff1 |= MD_EFLAGS;
            if (mobj->player)
                diff1 |= MD_PLAYER;

            if (mobj->movedir)
                diff1 |= MD_MOVEDIR;
            if (mobj->movecount)
                diff1 |= MD_MOVECOUNT;
            if (mobj->threshold)
                diff1 |= MD_THRESHOLD;
            if (mobj->lastlook != -1)
                diff1 |= MD_LASTLOOK;
#ifdef DSDA_EE_BLOODCOLOR
            // [WDJ] This is only used by type MT_BLOOD.  Union with lastlook, which is not needed by MT_BLOOD.
            if (mobj->type == MT_BLOOD && mobj->b_blood ) // splat blood color
            {
                diff1 |= MD_LASTLOOK;
            }
#endif
            if (mobj->target)
                diff1 |= MD_TARGET;
            if (mobj->tracer)
                diff1 |= MD_TRACER;
            if (mobj->friction != ORIG_FRICTION)
                diff1 |= MD_FRICTION;
            if (mobj->movefactor != ORIG_FRICTION_FACTOR)
                diff1 |= MD_MOVEFACTOR;
            if (mobj->special1)
                diff1 |= MD_SPECIAL1;
            if (mobj->special2)
                diff1 |= MD_SPECIAL2;
            if (mobj->dropped_ammo_count)
                diff1 |= MD_AMMO;
            if (mobj->tflags)
                diff1 |= MD_TFLAGS;
            if (mobj->pursuecount || mobj->strafecount)
                diff1 |= MD_MBFCOUNT;
            if (mobj->tipcount || mobj->dropoffz != mobj->floorz)
                diff1 |= MD_MBFTIP;
            if (mobj->lastenemy)
                diff1 |= MD_MBF_LASTENEMY;

#ifdef WRITE_DIFF2
            diff2 = 0;
#ifdef MOBJ_HAS_FLAGS3
            if (mobj->flags3 != mobj->info->flags3)
                diff2 |= MD2_MBF21_FLAGS3;
#endif

#ifdef MONSTER_VARY
            if( mobj->vary_index )
                diff2 |= MD2_monster_vary;
#endif

#endif

            WRITEBYTE(save_p, tc_mobj);	// mark as mobj

#ifdef WRITE_DIFF2
            if( diff2 )
                diff1 |= MD_MD2_DIFF;
#endif
            WRITEU32(save_p, diff1);

#ifdef WRITE_DIFF2
            if( diff2 )
            {
                WRITEU32(save_p, diff2);  // VERSION >= 149
            }
#endif

            // Save ID number of this Mobj so that pointers can be restored.
            // NOTE: does not check if this mobj has been already saved, so it'd better not appear twice.
            WRITE_MobjPointerID(save_p, mobj);
            WRITEFIXED(save_p, mobj->z);        // Force this so 3dfloor problems don't arise. SSNTails 03-17-2002
            WRITEFIXED(save_p, mobj->floorz);
            WRITEFIXED(save_p, mobj->ceilingz);  // portable layout, it can be stale

            if (diff1 & MD_SPAWNPOINT)
                WRITE_MAPTHING_PTR( mobj->spawnpoint );
            if (diff1 & MD_TYPE)
                WRITEU32(save_p, mobj->type);
            if (diff1 & MD_POS)
            {
                WRITEFIXED(save_p, mobj->x);
                WRITEFIXED(save_p, mobj->y);
                WRITEANGLE(save_p, mobj->angle);
            }
            if (diff1 & MD_MOM)
            {
                WRITEFIXED(save_p, mobj->momx);
                WRITEFIXED(save_p, mobj->momy);
                WRITEFIXED(save_p, mobj->momz);
            }
            if (diff1 & MD_RADIUS)
                WRITEFIXED(save_p, mobj->radius);
            if (diff1 & MD_HEIGHT)
                WRITEFIXED(save_p, mobj->height);
            if (diff1 & MD_FLAGS)
                WRITE32(save_p, mobj->flags);
            if (diff1 & MD_FLAGS2)
                WRITE32(save_p, mobj->flags2);
            if (diff1 & MD_HEALTH)
                WRITE32(save_p, mobj->health);
            if (diff1 & MD_RTIME)
                WRITE32(save_p, mobj->reactiontime);
            if (diff1 & MD_STATE)
                WRITEU16(save_p, mobj->state - states);
            if (diff1 & MD_TICS)
                WRITE32(save_p, mobj->tics);
            if (diff1 & MD_SPRITE)
                WRITEU16(save_p, mobj->sprite);
            if (diff1 & MD_FRAME)
                WRITEU32(save_p, mobj->frame);
            if (diff1 & MD_EFLAGS)
                WRITEU32(save_p, mobj->eflags);
            if (diff1 & MD_PLAYER)
            {
                unsigned int st = mobj->player - players;
                if( mobj->player->mo != mobj )
                   st += 128;  // voodoo doll flag
                WRITEBYTE(save_p, st);
            }
            if (diff1 & MD_MOVEDIR)
                WRITE32(save_p, mobj->movedir);
            if (diff1 & MD_MOVECOUNT)
                WRITE32(save_p, mobj->movecount);
            if (diff1 & MD_THRESHOLD)
                WRITE32(save_p, mobj->threshold);
            if (diff1 & MD_LASTLOOK)
                WRITE32(save_p, mobj->lastlook);
            if (diff1 & MD_TARGET)
                WRITE_MobjPointerID(save_p, mobj->target);
            if (diff1 & MD_TRACER)
                WRITE_MobjPointerID(save_p, mobj->tracer);
            if (diff1 & MD_FRICTION)
                WRITE32(save_p, mobj->friction);
            if (diff1 & MD_MOVEFACTOR)
                WRITE32(save_p, mobj->movefactor);
            if (diff1 & MD_SPECIAL1)
                WRITE32(save_p, mobj->special1);
            if (diff1 & MD_SPECIAL2)
                WRITE32(save_p, mobj->special2);
            if (diff1 & MD_AMMO)
#if DL_VERSION >= 149
                // as of svn 1672 (1.48.15), dropped_ammo_count is 16 bit
                WRITE16(save_p, mobj->dropped_ammo_count);  // save game version 149
#else
                WRITE32(save_p, mobj->dropped_ammo_count);  // save game version before 149
#endif
            if (diff1 & MD_TFLAGS)
                WRITE32(save_p, mobj->tflags);
            if (diff1 & MD_MBFCOUNT)
            {
                WRITE16(save_p, mobj->strafecount);
                WRITE16(save_p, mobj->pursuecount);
            }
            if (diff1 & MD_MBFTIP)
            {
                WRITE16(save_p, mobj->tipcount);
                WRITEFIXED(save_p, mobj->dropoffz);
            }
            if (diff1 & MD_MBF_LASTENEMY)
                WRITE_MobjPointerID(save_p, mobj->lastenemy);

#ifdef WRITE_DIFF2
#ifdef MOBJ_HAS_FLAGS3
            // [WDJ] MBF21, HEXEN
            if (diff2 & MD2_MBF21_FLAGS3)
                WRITE32(save_p, mobj->flags3);
#endif
#ifdef MONSTER_VARY
            if( diff2 & MD2_monster_vary )
                WRITEBYTE(save_p, mobj->vary_index);
#endif
#endif
        }
        // Use action as determinant of its owner.
        // acv == TFI_RemoveThinker : means deallocated (see P_RemoveThinker)
        else if (th->function == TFI_NULL)
        {
            // No action function.
            // This thinker can be a stopped ceiling or platform.
            // Each sector action has a separate thinker.

            boolean done = false;
            //SoM: 3/15/2000: Boom stuff...
            ceilinglist_t *cl;

            // search for this thinker being a stopped active ceiling
            for (cl = activeceilings; cl; cl = cl->next)
            {
                if (cl->ceiling == (ceiling_t *) th)  // found in ceilinglist
                {
                    WRITE_ceiling( (ceiling_t*)th, 0 ); // stopped ceiling
                    done = true;
                    break;
                }
            }

            if (done)
              continue;

            // [smite] Added a similar search for stopped plats.
            platlist_t *pl;
            // search for this thinker being a stopped active platform
            for (pl = activeplats; pl; pl = pl->next)
            {
                if (pl->plat == (plat_t *) th)  // found in platform list
                {
                    WRITE_plat( (plat_t *)th, 0 ); // stopped plat
                    break;
                }
            }

            continue;
        }
        else if (th->function == TFI_MoveCeiling)
        {
            WRITE_ceiling( (ceiling_t *)th, 1 );  // moving ceiling
            continue;
        }
        else if (th->function == TFI_PlatRaise)
        {
            WRITE_plat( (plat_t *)th, 1 ); // moving plat
            continue;
        }
        else if (th->function == TFI_VerticalDoor)
        {
            WRITE_door( (vldoor_t *)th );
            continue;
        }
        else if (th->function == TFI_MoveFloor)
        {
            WRITE_floor( (floormove_t *)th );
            continue;
        }
        else if (th->function == TFI_LightFlash)
        {
            WRITE_flash( (lightflash_t *)th );
            continue;
        }
        else if (th->function == TFI_StrobeFlash)
        {
            WRITE_strobe( (strobe_t *)th );
            continue;
        }
        else if (th->function == TFI_Glow)
        {
            WRITE_glow( (glow_t *)th );
            continue;
        }
        else
            // BP added T_FireFlicker
        if (th->function == TFI_FireFlicker)
        {
            WRITE_fireflicker( (fireflicker_t *)th );
            continue;
        }
        else if (th->function == TFI_LightFade)
        {
            WRITE_lightfade( (lightfader_t *)th );
            continue;
        }
        else
            //SoM: 3/15/2000: Added extra Boom thinker types.
        if (th->function == TFI_MoveElevator)
        {
            WRITE_elevator( (elevator_t *)th );
            continue;
        }
        else if (th->function == TFI_Scroll)
        {
            WRITE_scroll( (scroll_t *)th );
            continue;
        }
#ifdef FRICTIONTHINKER
        else if (th->function == TFI_Friction)
        {
            WRITE_friction( (friction_t *)th );
            continue;
        }
#endif       
        else if (th->function == TFI_Pusher)
        {
            WRITE_pusher( (pusher_t *)th );
            continue;
        }
#ifdef PARANOIA
        else if (th->function != TFI_RemoveThinker) // wait garbage collection
        {
            I_SoftError("SaveGame: Unknown thinker type %i\n", th->function);
        }
#endif
    }

    // mark the end of the save section using reserved type mark
    WRITEBYTE(save_p, tc_end);
    return;
}



//
// P_UnArchiveThinkers
//
static
void P_UnArchiveThinkers(void)
{
    mobj_t * mobj;
    uint32_t diff1;
#ifdef READ_DIFF2
    uint32_t diff2;
#endif
    int i;
    byte tclass;
    const char * reason; // err
   
    // remove all the current thinkers
    thinker_t *currentthinker = thinkercap.next;
    while (currentthinker != &thinkercap)
    {
        thinker_t * next = currentthinker->next;  // because of unlinking

        mobj = (mobj_t *) currentthinker;
        if (currentthinker->function == TFI_MobjThinker)
        {
            // since this item isn't save don't remove it
/*            if( !((((mobj->flags & (MF_COUNTKILL | MF_PICKUP | MF_SHOOTABLE )) == 0)
                   && (mobj->flags & MF_MISSILE)
                   && (mobj->info->doomednum !=-1) )
                  || (mobj->type == MT_BLOOD) ) )
*/
            P_RemoveMobj((mobj_t *) currentthinker);
        }
        else
            Z_Free(currentthinker);

        currentthinker = next;
    }
    // BP: we don't want the removed mobj come back !!!
    iquetail = iquehead = 0;
    P_Init_Thinkers();

    // read in saved thinkers
    while (1)
    {
        SG_Readbuf();
        tclass = READBYTE(save_p);
        if (tclass == tc_end)	// reserved type mark to end section
            break;      // leave the while
        switch (tclass)
        {
            case tc_mobj:

                mobj = Z_Malloc(sizeof(mobj_t), PU_LEVEL, NULL);
                memset(mobj, 0, sizeof(mobj_t));

                diff1 = READU32(save_p);
#ifdef READ_DIFF2
                diff2 = 0;
                // [WDJ] Savegame version 149, for MBF21 and HEXEN.
                // Needed at version 1.48.16, for MBF21 and VARY.
# ifdef FORCE_SAVEGAME_149
                if( (sg_version >= 148) && (diff1 & MD_MD2_DIFF) )
# else
                if( (sg_version >= 149) && (diff1 & MD_MD2_DIFF) )
# endif
                    diff2 = READU32(save_p);
#endif

                // [WDJ] initializing the lookup for GetMobjPointer and READ_MobjPointerID(),
                // this is the id number for the mobj being read here.
                MapMobjID(READU32(save_p), mobj); // assign the ID to the newly created mobj

                mobj->z = READFIXED(save_p);    // Force this so 3dfloor problems don't arise. SSNTails 03-17-2002
                mobj->floorz = READFIXED(save_p);
                if( sg_portable )
                    mobj->ceilingz = READFIXED(save_p);

                // [WDJ] Keep all combinations of MD_SPAWNPOINT and MD_TYPE,
                // so can read older savegames made with different invariants.
                if (diff1 & MD_SPAWNPOINT)
                {
                    READ_MAPTHING_PTR( mobj->spawnpoint );
                    if( mobj->spawnpoint )
                        mobj->spawnpoint->mobj = mobj;
                }
                if (diff1 & MD_TYPE)
                {
                    mobj->type = READU32(save_p);
                }
                else
                {
                    // [WDJ] even if have MD_SPAWNPOINT, the lookup might return NULL
                    if( mobj->spawnpoint == NULL )
                    {
                        reason = "No Type and No Spawnpoint";
                        goto err_report;
                    }
                    for (i = 0; i < NUMMOBJTYPES; i++)
                        if (mobj->spawnpoint->type == mobjinfo[i].doomednum)
                            break;
                    if (i == NUMMOBJTYPES)
                    {
                        reason = "Spawnpoint type invalid";
                        goto err_report;
                    }
                    mobj->type = i;
                }
                mobj->info = &mobjinfo[mobj->type];
                if (diff1 & MD_POS)
                {
                    mobj->x = READFIXED(save_p);
                    mobj->y = READFIXED(save_p);
                    mobj->angle = READANGLE(save_p);
                }
                else
                {
                    mobj->x = mobj->spawnpoint->x << FRACBITS;
                    mobj->y = mobj->spawnpoint->y << FRACBITS;
                    mobj->angle = ANG45 * (mobj->spawnpoint->angle / 45);
                }
                if (diff1 & MD_MOM)
                {
                    mobj->momx = READFIXED(save_p);
                    mobj->momy = READFIXED(save_p);
                    mobj->momz = READFIXED(save_p);
                }       // else 0 (memset)

                if (diff1 & MD_RADIUS)
                    mobj->radius = READFIXED(save_p);
                else
                    mobj->radius = mobj->info->radius;
                if (diff1 & MD_HEIGHT)
                    mobj->height = READFIXED(save_p);
                else
                    mobj->height = mobj->info->height;
                if (diff1 & MD_FLAGS)
                    mobj->flags = READ32(save_p);
                else
                    mobj->flags = mobj->info->flags;
                if (diff1 & MD_FLAGS2)
                    mobj->flags2 = READ32(save_p);
                else
                    mobj->flags2 = mobj->info->flags2;
                if (diff1 & MD_HEALTH)
                    mobj->health = READ32(save_p);
                else
                    mobj->health = mobj->info->spawnhealth;
                if (diff1 & MD_RTIME)
                    mobj->reactiontime = READ32(save_p);
                else
                    mobj->reactiontime = mobj->info->reactiontime;

                if (diff1 & MD_STATE)
                    mobj->state = &states[READU16(save_p)];
                else
                    mobj->state = &states[mobj->info->spawnstate];
                if (diff1 & MD_TICS)
                    mobj->tics = READ32(save_p);
                else
                    mobj->tics = mobj->state->tics;
                if (diff1 & MD_SPRITE)
                    mobj->sprite = READU16(save_p);
                else
                    mobj->sprite = mobj->state->sprite;
                if (diff1 & MD_FRAME)
                    mobj->frame = READU32(save_p);
                else
                    mobj->frame = mobj->state->frame;
                if (diff1 & MD_EFLAGS)
                    mobj->eflags = READU32(save_p);
                if (diff1 & MD_PLAYER)
                {
                    i = READBYTE(save_p);
                    if( i < MAXPLAYERS )
                    {
                        mobj->player = &players[i];
                        mobj->player->mo = mobj;  // connect player to this mobj
                        // added for angle prediction
                        if (consoleplayer == i)
                            localangle[0] = mobj->angle;
                        if (displayplayer2 == i)  // player 2
                            localangle[1] = mobj->angle;
                    }
                    else if( i >= 128 && i < MAXPLAYERS+128 )
                    {
                        // voodoo dolls
                        i -= 128; // voodoo doll flag
                        mobj->player = &players[i];
                    }
                    else
                    {
                        // [WDJ] FIXME later, for now accept previous savegames
                        I_SoftError( "Savegame load: mobj has bad player id, %d, setting to 0.\n", i );
                        i = 0;
                    }
                }
                if (diff1 & MD_MOVEDIR)
                    mobj->movedir = READ32(save_p);
                if (diff1 & MD_MOVECOUNT)
                    mobj->movecount = READ32(save_p);
                if (diff1 & MD_THRESHOLD)
                    mobj->threshold = READ32(save_p);
                if (diff1 & MD_LASTLOOK)
                    mobj->lastlook = READ32(save_p);
                else
                    mobj->lastlook = -1;
#ifdef DSDA_EE_BLOODCOLOR
                // [WDJ] This is only used by type MT_BLOOD.  Union with lastlook, which is not needed by MT_BLOOD.
                // Not enabled, just for reference.
                if (mobj->type == MT_BLOOD ) // splat blood color
                {
                    if( mobj->lastlook < 0 )  mobj->b_blood = 0;  // ???
                }
#endif
                if (diff1 & MD_TARGET)
                  mobj->target_id = READU32(save_p); // id number is replaced with the corresponding pointer at the end of the function
                if (diff1 & MD_TRACER)
                  mobj->tracer_id = READU32(save_p); // same here
                if (diff1 & MD_FRICTION)
                    mobj->friction = READ32(save_p);
                else
                    mobj->friction = ORIG_FRICTION;
                if (diff1 & MD_MOVEFACTOR)
                    mobj->movefactor = READ32(save_p);
                else
                    mobj->movefactor = ORIG_FRICTION_FACTOR;
                if (diff1 & MD_SPECIAL1)
                    mobj->special1 = READ32(save_p);
                if (diff1 & MD_SPECIAL2)
                    mobj->special2 = READ32(save_p);
                if (diff1 & MD_AMMO)
                {
#if DL_VERSION >= 149
                   // as of svn 1672 (1.48.15), dropped_ammo_count is 16 bit, and different encoding.
                   mobj->dropped_ammo_count = (sg_version < 149)?
                        translate_old_dropped_ammo( READ32(save_p) )  // old
                        : READ16(save_p);  // as of savegame ver 149
#else
                   mobj->dropped_ammo_count = READ32(save_p);
#endif
                }
                if (diff1 & MD_TFLAGS)
                    mobj->tflags = READ32(save_p);
                if (diff1 & MD_MBFCOUNT)
                {
                    mobj->strafecount = READ16(save_p);
                    mobj->pursuecount = READ16(save_p);
                }
                if (diff1 & MD_MBFTIP)
                {
                    mobj->tipcount = READ16(save_p);
                    mobj->dropoffz = READFIXED(save_p);
                }
                else
                {
                    mobj->dropoffz = mobj->floorz;	   
                }
                if (diff1 & MD_MBF_LASTENEMY)
                  mobj->lastenemy_id = READU32(save_p); // same here

#ifdef READ_DIFF2
                // [WDJ] MBF21, HEXEN
                if (diff2 & MD2_MBF21_FLAGS3)
                {
#ifdef MOBJ_HAS_FLAGS3
                    mobj->flags3 = READ32(save_p);
#else
                    READ32(save_p);
#endif
                }
#ifdef MOBJ_HAS_FLAGS3
                else
                {
                    // Not saved when it is the one of the type.
                    mobj->flags3 = mobj->info->flags3;
                }
#endif

#ifdef MONSTER_VARY
                if( diff2 & MD2_monster_vary )
                {
                    mobj->vary_index = READBYTE(save_p);
                }
                // must be after radius, height, speed
                {
                    // mobj_varied assigns radius and height from info, even
                    // when not varied, and would undo a saved radius or
                    // height (a corpse is lower and slimmer).
                    fixed_t  rad = mobj->radius, ht = mobj->height;
                    mobj_varied( mobj );  // assigns fields from info even when not varied
                    if (diff1 & MD_RADIUS)  mobj->radius = rad;
                    if (diff1 & MD_HEIGHT)  mobj->height = ht;
                }
#endif
#endif

                // [WDJ] Fix old savegames for corpse health < 0.
                if((mobj->flags & MF_CORPSE) && (mobj->health > 0))
                {
                    mobj->health = -mobj->health - (mobj->info->spawnhealth/2);
                }

#ifdef READ_FLAGS144
                // [WDJ] Fix old savegame flag positions
                if( sg_version < READ_FLAGS144 )
                {
                    // Old savegame, some flags have moved.
                    if( mobj->flags & MFO_NOCLIPTHING )
                    {
                       mobj->flags &= ~MFO_NOCLIPTHING;
                       mobj->flags2 |= MF2_NOCLIPTHING;
                    }
                    if( mobj->flags & MFO_TRANSLATION4 )  // color
                    {
                       mobj->flags &= ~MFO_TRANSLATION4;
                       mobj->tflags |= (mobj->flags & MFO_TRANSLATION4) >> (MFO_TRANSSHIFT - MFT_TRANSSHIFT);
                    }
                }
#endif
                // now set deductable field
                // TODO : save this too
                mobj->skin = NULL;

                // set sprev, snext, bprev, bnext, subsector
                P_SetThingPosition(mobj);

                /*
                   // This causes 3dfloor problems! SSNTails 03-17-2002
                   mobj->floorz = mobj->subsector->sector->floorheight;
                   if( (diff1 & MD_Z) == 0 )
                   mobj->z = mobj->floorz;
                 */
                if (mobj->player && (mobj->player->mo == mobj)) // real player
                {
                    mobj->player->viewz = mobj->player->mo->z + mobj->player->viewheight;
                    //debug_Printf("P_UnArchiveThinkers: viewz = %f\n",FIXED_TO_FLOAT(mobj->player->viewz));
                }
                if( ! sg_portable )
                    mobj->ceilingz = mobj->subsector->sector->ceilingheight;
                mobj->thinker.function = TFI_MobjThinker;
                P_AddThinker(&mobj->thinker);
                break;

            case tc_ceiling:
              {
                ceiling_t *ceiling = SG_ThinkerAlloc(sizeof(*ceiling));
                if( sg_portable )
                {
                    READ_ceiling_fields( ceiling );
                    P_AddThinker(&ceiling->thinker);
                }
                else
                {
                    READ_SECTOR_THINKER( ceiling, ceiling_t, type );
                }
                ceiling->sector->ceilingdata = ceiling;
                byte moving = READBYTE(save_p); // moving ceiling?
                ceiling->thinker.function = moving ? TFI_MoveCeiling : AI_NULL;
                P_AddActiveCeiling(ceiling);
              }
              break;

            case tc_door:
              {
                vldoor_t *door = SG_ThinkerAlloc(sizeof(*door));
                if( sg_portable )
                {
                    READ_door_fields( door );
                    P_AddThinker(&door->thinker);
                }
                else
#ifdef READ_LF_VER_144
                if( sg_version < 147 )
                {
                  // Version 144, Field layout is identical, just missing lighttag.
                  vldoor_144_t  vld;
                  READ144_SECTOR_THINKER( door, &vld, vldoor_144_t, type );
                  memcpy( &door->type, &vld.type, sizeof(vld));
                  door->lighttag = 0;
                }
                else		 
#endif
                {
                  // Version 147
                  READ_SECTOR_THINKER( door, vldoor_t, type );
                }
                READ_LINE_PTR( door->line );  // can be NULL
                door->sector->ceilingdata = door;
                door->thinker.function = TFI_VerticalDoor;
              }
              break;

            case tc_floor:
              {
                floormove_t *floormv = SG_ThinkerAlloc(sizeof(*floormv));
                if( sg_portable )
                {
                    READ_floor_fields( floormv );
                    P_AddThinker(&floormv->thinker);
                }
                else
                {
                    READ_SECTOR_THINKER( floormv, floormove_t, type );
                }
                floormv->sector->floordata = floormv;
                floormv->thinker.function = TFI_MoveFloor;
              }
              break;

            case tc_plat:
              {
                plat_t *plat = SG_ThinkerAlloc(sizeof(*plat));
                if( sg_portable )
                {
                    READ_plat_fields( plat );
                    P_AddThinker(&plat->thinker);
                }
                else
#ifdef READ_PLAT144
                if( sg_version < READ_PLAT144 )
                {
                  plat_144_t  pt;
                  READ144_SECTOR_THINKER( plat, &pt, plat_144_t, type );
                  plat->type = pt.type;
                  plat->speed = pt.speed;
                  plat->low = pt.low;
                  plat->high = pt.high;
                  plat->crush = pt.crush;
                  plat->tag = pt.tag;
                  plat->wait = pt.wait;
                  plat->count = pt.count;
                  plat->status = pt.status;
                  plat->oldstatus = pt.oldstatus;
                }
                else
#endif
                {
                READ_SECTOR_THINKER( plat, plat_t, type );
                }
                plat->sector->floordata = plat;
                byte moving = READBYTE(save_p); // moving plat?
                plat->thinker.function = moving ? TFI_PlatRaise : TFI_NULL;
                P_AddActivePlat(plat);
              }
              break;

            case tc_flash:
              {
                lightflash_t *flash = SG_ThinkerAlloc(sizeof(*flash));
                if( sg_portable )
                {
                    READ_flash_fields( flash );
                    P_AddThinker(&flash->thinker);
                }
                else
#ifdef READ_LF_VER_144
                if( sg_version < 147 )
                {
                  lightflash_144_t  lf;
                  READ144_SECTOR_THINKER( flash, &lf, lightflash_144_t, count );
                  flash->count = lf.count;
                  flash->minlight = lf.minlight;
                  flash->maxlight = lf.maxlight;
                  flash->mintime = lf.mintime;
                  flash->maxtime = lf.maxtime;
                }
                else		 
#endif
                {
                READ_SECTOR_THINKER( flash, lightflash_t, minlight );
                }
                flash->thinker.function = TFI_LightFlash;
              }
              break;

            case tc_strobe:
              {
                strobe_t *strobe = SG_ThinkerAlloc(sizeof(*strobe));
                if( sg_portable )
                {
                    READ_strobe_fields( strobe );
                    P_AddThinker(&strobe->thinker);
                }
                else
#ifdef READ_LF_VER_144
                if( sg_version < 147 )
                {
                  strobe_144_t  st;
                  READ144_SECTOR_THINKER( strobe, &st, strobe_144_t, count );
                  strobe->minlight = st.minlight;
                  strobe->maxlight = st.maxlight;
                  strobe->darktime = st.darktime;
                  strobe->brighttime = st.brighttime;
                  strobe->count = st.count;
                }
                else		 
#endif
                {
                READ_SECTOR_THINKER( strobe, strobe_t, minlight );
                }
                strobe->thinker.function = TFI_StrobeFlash;
              }
              break;

            case tc_glow:
              {
                glow_t *glow = SG_ThinkerAlloc(sizeof(*glow));
                if( sg_portable )
                {
                    READ_glow_fields( glow );
                    P_AddThinker(&glow->thinker);
                }
                else
#ifdef READ_LF_VER_144
                if( sg_version < 147 )
                {
                  glow_144_t  gl;
                  READ144_SECTOR_THINKER( glow, &gl, glow_144_t, minlight );
                  glow->minlight = gl.minlight;
                  glow->maxlight = gl.maxlight;
                  glow->direction = gl.direction;
                }
                else		 
#endif
                {
                READ_SECTOR_THINKER( glow, glow_t, minlight );
                }
                glow->thinker.function = TFI_Glow;
              }
              break;

            case tc_fireflicker:
              {
                fireflicker_t *fireflicker = SG_ThinkerAlloc(sizeof(*fireflicker));
                if( sg_portable )
                {
                    READ_fireflicker_fields( fireflicker );
                    P_AddThinker(&fireflicker->thinker);
                }
                else
#ifdef READ_LF_VER_144
                if( sg_version < 147 )
                {
                  fireflicker_144_t  ff;
                  READ144_SECTOR_THINKER( fireflicker, &ff, fireflicker_144_t, count );
                  fireflicker->minlight = ff.minlight;
                  fireflicker->maxlight = ff.maxlight;
                  fireflicker->count = ff.count;
                }
                else		 
#endif
                {
                READ_SECTOR_THINKER( fireflicker, fireflicker_t, minlight );
                }
                fireflicker->thinker.function = TFI_FireFlicker;
              }
              break;

            case tc_lightfade:
              {
                lightfader_t *fade = SG_ThinkerAlloc(sizeof(*fade));
                if( sg_portable )
                {
                    READ_lightfade_fields( fade );
                    P_AddThinker(&fade->thinker);
                }
                else
#ifdef READ_LF_VER_144
                if( sg_version < 147 )
                {
                  lightfader_144_t  lf;
                  READ144_SECTOR_THINKER( fade, &lf, lightfader_144_t, destlevel );
                  fade->destlight = lf.destlevel;
                  fade->speed = lf.speed;
                }
                else		 
#endif
                {
                READ_SECTOR_THINKER( fade, lightfader_t, destlight );
                }
                fade->thinker.function = TFI_LightFade;
              }
              break;

            case tc_elevator:
              {
                elevator_t *elevator = SG_ThinkerAlloc(sizeof(elevator_t));
                if( sg_portable )
                {
                    READ_elevator_fields( elevator );
                    P_AddThinker(&elevator->thinker);
                }
                else
                {
                    READ_SECTOR_THINKER( elevator, elevator_t, type );
                }
                elevator->sector->floordata = elevator; //jff 2/22/98
                elevator->sector->ceilingdata = elevator;       //jff 2/22/98
                elevator->thinker.function = TFI_MoveElevator;
              }
              break;

            case tc_scroll:
              {
                scroll_t *scroll = SG_ThinkerAlloc(sizeof(scroll_t));
                if( sg_portable )
                {
                    READ_scroll_fields( scroll );
                    P_AddThinker(&scroll->thinker);
                }
                else
                {
                    READ_THINKER( scroll, scroll_t, type );
                }
                scroll->thinker.function = TFI_Scroll;
              }
              break;

            case tc_friction:
              {
#ifdef FRICTIONTHINKER
                 // friction thinkers are obsolete
                friction_t *friction = SG_ThinkerAlloc(sizeof(friction_t));
                if( sg_portable )
                {
                    READ_friction_fields( friction );
                    P_AddThinker(&friction->thinker);
                }
                else
                {
                    READ_THINKER( friction, friction_t, affectee );
                }
                friction->thinker.function = TFI_Friction;
#else
                // skip, to handle old savegames
                save_p += (sg_portable)? 3 * sizeof(int32_t) : sizeof(thinker_t);
#endif
              }
              break;

            case tc_pusher:
              {
                pusher_t *pusher = SG_ThinkerAlloc(sizeof(pusher_t));
                if( sg_portable )
                {
                    READ_pusher_fields( pusher );
                    P_AddThinker(&pusher->thinker);
                }
                else
                {
                    READ_THINKER( pusher, pusher_t, type );
                }
                pusher->source = P_GetPushThing(pusher->affectee);
                pusher->thinker.function = TFI_Pusher;
              }
                break;

            default:
              I_SoftError("LoadGame: Unknown thinker type %i", tclass);
              goto err_exit;
        }
    }

    // Reversing the HACK: Convert ID numbers to proper mobj_t*:s
    for (currentthinker = thinkercap.next; currentthinker != &thinkercap; currentthinker = currentthinker->next)
    {
      if (currentthinker->function == TFI_MobjThinker)
      {
        mobj = (mobj_t *) currentthinker;
        if (mobj->tracer)
          mobj->tracer = GetMobjPointer(mobj->tracer_id);

        if (mobj->target)
          mobj->target = GetMobjPointer(mobj->target_id);

        if (mobj->lastenemy)
          mobj->lastenemy = GetMobjPointer(mobj->lastenemy_id);
      }
    }
    return;

err_report:
    I_SoftError("LoadGame: %s\n", reason );
err_exit:
    save_game_abort = 1;
    return;
}


//
// P_ArchiveSpecials
//

// BP: added : itemrespawnqueue
//
static
void P_ArchiveSpecials(void)
{
    int i;

    // BP: added save itemrespawn queue for deathmatch
    i = iquetail;
    while (iquehead != i)
    {
        WRITE_MAPTHING_PTR( itemrespawnque[i] );
        WRITE32(save_p, itemrespawntime[i]);
        i = (i + 1) & (ITEMQUESIZE - 1);
        SG_Writebuf();
    }

    // end delimiter
    WRITE32(save_p, 0xffffffff);
}

//
// P_UnArchiveSpecials
//
static
void P_UnArchiveSpecials(void)
{
    int i;
   
    // BP: added save itemrespawn queue for deathmatch
    iquetail = iquehead = 0;
    while ((i = READ32(save_p)) != 0xffffffff)
    {
        SG_Readbuf();
        itemrespawnque[iquehead] = &mapthings[i];
        itemrespawntime[iquehead++] = READ32(save_p);
    }
}

// The sector soundtarget: the mobj that last made a noise that reached the
// sector (P_RecursiveSound), which A_Look reads to wake a monster that cannot
// see the player.  The mobj ids exist only after the thinkers have been
// read, so this is a section of its own, after the specials.  Optional: it is
// there when some sector has one.  A soundtarget that is not a mobj of the
// level any more (nothing keeps it alive) is not saved.

// Only a mobj that P_ArchiveThinkers saved has an id the loader knows.
static
boolean  SG_is_saved_mobj( const mobj_t * mo )
{
    const thinker_t * th;
    for (th = thinkercap.next; th != &thinkercap; th = th->next)
    {
        if( th == (const thinker_t *) mo )
            return (th->function == TFI_MobjThinker);
    }
    return false;
}

static
boolean  SG_soundtarget_detect( void )
{
    uint32_t i;
    for (i = 0; i < numsectors; i++)
    {
        if( sectors[i].soundtarget && SG_is_saved_mobj( sectors[i].soundtarget ) )
            return true;
    }
    return false;
}

static
void  P_Archive_Soundtargets( void )
{
    uint32_t i;
    for (i = 0; i < numsectors; i++)
    {
        mobj_t * mo = sectors[i].soundtarget;
        if( mo && SG_is_saved_mobj( mo ) )
        {
            WRITE32(save_p, i);  // sector index
            WRITE_MobjPointerID(save_p, mo);
            SG_Writebuf();
        }
    }
    WRITE32(save_p, 0xffffffff);  // end delimiter
}

static
void  P_UnArchive_Soundtargets( void )
{
    uint32_t i;
    SG_Readbuf();
    while ((i = READ32(save_p)) != 0xffffffff)
    {
        mobj_t * mo = READ_MobjPointerID(save_p);
        if( i >= numsectors )
        {
            I_SoftError( "LoadGame: soundtarget of a sector that does not exist.\n" );
            save_game_abort = 1;
            return;
        }
        SET_TARGET_REF( sectors[i].soundtarget, mo );
        SG_Readbuf();
        if( save_game_abort )  return;
    }
}

/////////////////////////////////////////////////////////////////////////////
// BIG NOTE FROM SOM!
//
// SMMU/MBF use the CheckSaveGame function to dynamically expand the savegame
// buffer which would eliminate all limits on savegames... Could/Should we
// use this method?
/////////////////////////////////////////////////////////////////////////////

#ifdef FRAGGLESCRIPT


static unsigned int P_NumberFSArrays(void)
{
  unsigned int count = 0;
#ifdef FS_ARRAYLIST_STRUCTHEAD
  fs_array_t *cur = fs_arraylist.next; // start at first array
#else
  fs_array_t *cur = fs_arraylist; // start at first array
#endif
  while (cur)
  {
    cur->saveindex = ++count;  // replaces ptr in save game
    cur = cur->next;
  }

  return count;
}


static void  WRITE_SFArrayPtr( fs_array_t * arrayptr )
{
    // write the array id (saveindex) for the ptr
#ifdef FS_ARRAYLIST_STRUCTHEAD
    fs_array_t *cur = fs_arraylist.next;
#else
    fs_array_t *cur = fs_arraylist;
#endif
    while(cur && (cur != arrayptr))  // verify if valid ptr
            cur = cur->next;

    // zero is unused, so use it for NULL
    // The arrays have been numbered in saveindex, see ReadSFArrayPtr
    WRITE32(save_p, (cur ? cur->saveindex : 0) );
}
   
static fs_array_t * READ_SFArrayPtr( void )
{
    int svindx;
    fs_array_t *cur = NULL;
    // All arrays were numbered in saveindex
    svindx = READU32(save_p);  // consistent with Write saveindex

    if(svindx)		// 0 is NULL ptr
    {
#ifdef FS_ARRAYLIST_STRUCTHEAD
        cur = fs_arraylist.next;  // start of all arrays
#else
        cur = fs_arraylist;  // start of all arrays
#endif
        while(cur)	// search for matching saveindex
        {
            if(svindx == cur->saveindex)  break;
            cur = cur->next;
        }
        // not found is NULL ptr
    }
    return cur;   // which may be NULL
}
  
// SoM: Added FraggleScript stuff.
// Save all the neccesary FraggleScript data.
// we need to save fs_levelscript (all global variables) and
// fs_runningscripts (scripts currently suspended)

static
void P_ArchiveSValue(fs_value_t *s)
{
  switch (s->type)   // store depending on type
  {
    case FSVT_string:
      {
        strcpy((char *)save_p, s->value.s);
        save_p += strlen(s->value.s) + 1;
        break;
      }
    case FSVT_int:
      {
        WRITE32(save_p, s->value.i);
        break;
      }
    case FSVT_fixed:
      {
        WRITEFIXED(save_p, s->value.f);
        break;
      }
    case FSVT_mobj:
      {
        WRITE_MobjPointerID(save_p, s->value.mobj);
        break;
      }
    default:
      // other types do not appear in user scripts
      break;
  }
}

void P_UnArchiveSValue(fs_value_t *s)
{
  switch (s->type)       // read depending on type
  {
    case FSVT_string:
      {
        s->value.s = Z_Strdup((char *)save_p, PU_LEVEL, 0);
        save_p += strlen(s->value.s) + 1;
        break;
      }
    case FSVT_int:
      {
        s->value.i = READ32(save_p);
        break;
      }
    case FSVT_fixed:
      {
        s->value.f = READFIXED(save_p);
        break;
      }
    case FSVT_mobj:
      {
        s->value.mobj = READ_MobjPointerID(save_p);
        break;
      }
    default:
      break;
  }
}



static
void P_ArchiveFSVariables(fs_variable_t **vars)
{
  int i;

  // count number of variables
  int num_variables = 0;
  for (i = 0; i < VARIABLESLOTS; i++)
  {
    fs_variable_t *sv = vars[i];

    // once we get to a label there can be no more actual
    // variables in the list to store
    while (sv && sv->type != FSVT_label)
    {
      num_variables++;
      sv = sv->next;
    }
  }

  //CheckSaveGame(sizeof(short));
  WRITE16(save_p, num_variables);  // write num_variables

  // go thru hash chains, store each variable
  for (i = 0; i < VARIABLESLOTS; i++)
  {
    // go thru this hashchain
    fs_variable_t *sv = vars[i];

    while (sv && sv->type != FSVT_label)
    {
      //CheckSaveGame(strlen(sv->name)+10); // 10 for type and safety
      // write svariable: name
      strcpy((char *)save_p, sv->name);
      save_p += strlen(sv->name) + 1;     // 1 extra for ending NULL

      WRITEBYTE(save_p, sv->type); // store type;

      // Those that are not handled by P_ArchiveSValue
      if (sv->type == FSVT_array) // haleyjd: arrays
      {
          WRITE_SFArrayPtr( sv->value.a );
          break;
      }
      else
      {
          // [smite] TODO fs_variable_t should simply inherit fs_value_t
          // also fs_value_t should have array as a possible subtype
          fs_value_t s;
          s.type  = sv->type;

          s.value.mobj = sv->value.mobj; // HACK largest type in union
          P_ArchiveSValue(&s);
      }

      sv = sv->next;
      SG_Writebuf();
    }
  }
}


static
void P_UnArchiveFSVariables(fs_variable_t **vars)
{
  int i;

  SG_Readbuf();
  // now read the number of variables from the savegame file
  int num_variables = READ16(save_p);

  for (i = 0; i < num_variables; i++)
  {
    fs_variable_t *sv = Z_Malloc(sizeof(fs_variable_t), PU_LEVEL, 0);
    SG_Readbuf();

    // name
    sv->name = Z_Strdup((char *)save_p, PU_LEVEL, 0);
    save_p += strlen(sv->name) + 1;

    sv->type = READBYTE(save_p);

    if (sv->type == FSVT_array) // Exl; arrays
    {
        sv->value.a = READ_SFArrayPtr();
    }
    else
    {
        // [smite] TODO fs_variable_t should simply inherit fs_value_t, but...
        fs_value_t s;
        s.value.mobj = NULL; // compiler complaint
        s.type = sv->type;

        P_UnArchiveSValue(&s);
        sv->value.mobj = s.value.mobj; // HACK largest type in union
    }

    // link in the new variable
    int hashkey = variable_hash(sv->name);
    sv->next = vars[hashkey];
    vars[hashkey] = sv;
  }
}



/***************** save the levelscript *************/
// make sure we remember all the global
// variables.

static
void P_ArchiveLevelScript()
{
  // all we really need to do is save the variables
  P_ArchiveFSVariables(fs_levelscript.variables);
}

static
void P_UnArchiveLevelScript()
{
  int i;

  // free all the variables in the current levelscript first
  for (i = 0; i < VARIABLESLOTS; i++)
  {
    fs_variable_t *sv = fs_levelscript.variables[i];

    while (sv && sv->type != FSVT_label)
    {
      fs_variable_t *next = sv->next;
      Z_Free(sv);
      sv = next;
    }
    fs_levelscript.variables[i] = sv;  // null or label
  }


  P_UnArchiveFSVariables(fs_levelscript.variables);
}

/**************** save the runningscripts ***************/

runningscript_t * new_runningscript();   // t_script.c
void clear_runningscripts();    // t_script.c

// save a given runningscript
static
void P_ArchiveRunningScript(runningscript_t * rs)
{
    //CheckSaveGame(sizeof(short) * 8); // room for 8 shorts
    WRITE16(save_p, rs->script->scriptnum);  // save scriptnum
    // char* into data, saved as index
    WRITE16(save_p, rs->savepoint - rs->script->data);       // offset
    WRITE16(save_p, rs->wait_type);
    WRITE16(save_p, rs->wait_data);

    // save trigger ID
    WRITE_MobjPointerID(save_p, rs->trigger);

    P_ArchiveFSVariables(rs->variables);
    SG_Writebuf();
}

// get the next runningscript
static
runningscript_t *P_UnArchiveRunningScript()
{
    int i;

    // create a new runningscript
    runningscript_t *rs = new_runningscript();

    SG_Readbuf();
    int scriptnum = READ16(save_p);      // get scriptnum

    if (scriptnum == -1)  // levelscript?
        rs->script = &fs_levelscript;
    else
        rs->script = fs_levelscript.children[scriptnum];

    // read out offset from save, convert index into ptr = &data[index]
    rs->savepoint = rs->script->data + READ16(save_p);
    rs->wait_type = READ16(save_p);
    rs->wait_data = READ16(save_p);

    // read out trigger thing
    rs->trigger = READ_MobjPointerID(save_p);


    // read out the variables now (fun!)
    // start with basic script slots/labels FIXME why?
    for (i = 0; i < VARIABLESLOTS; i++)
      rs->variables[i] = rs->script->variables[i];

    P_UnArchiveFSVariables(rs->variables);

    return rs;
}

// archive all runningscripts in chain
static
void P_ArchiveRunningScripts()
{
    runningscript_t *rs;
    int num_runningscripts = 0;

    // count runningscripts
    for (rs = fs_runningscripts.next; rs; rs = rs->next)
        num_runningscripts++;

    //CheckSaveGame(sizeof(long));

    // store num_runningscripts
    WRITEU32(save_p, num_runningscripts);

    // now archive them
    rs = fs_runningscripts.next;
    while (rs)
    {
        P_ArchiveRunningScript(rs);
        rs = rs->next;
    }
}

// restore all runningscripts from save_p
static
void P_UnArchiveRunningScripts()
{
    runningscript_t *rs;
    int num_runningscripts;
    int i;

    // remove all runningscripts first : may have been started
    // by levelscript on level load

    clear_runningscripts();

    // get num_runningscripts
    num_runningscripts = READU32(save_p);

    for (i = 0; i < num_runningscripts; i++)
    {
        // get next runningscript
        rs = P_UnArchiveRunningScript();

        // hook into chain
        rs->next = fs_runningscripts.next;
        rs->prev = &fs_runningscripts;
        rs->prev->next = rs;
        if (rs->next)
            rs->next->prev = rs;
    }
}




//
// FS Array Saving
//
// Array variables are saved by the code above for the level and
// running scripts, but first this stuff needs to be done -- enumerate
// and archive the arrays themselves.
//


// must be called before running/level script archiving
static
void P_ArchiveFSArrays(void)
{
  // [smite] FIXME can we have several array variables reference the same object? 
  // Because if arrays are handled by value, this is unnecessary and they can be treated like normal variables.
  
  unsigned int num_fsarrays = P_NumberFSArrays(); // number all the arrays

  // write number of FS arrays
  WRITEU32(save_p, num_fsarrays);
      
#ifdef FS_ARRAYLIST_STRUCTHEAD
  fs_array_t *cur = fs_arraylist.next; // start at first array
#else
  fs_array_t *cur = fs_arraylist; // start at first array
#endif
  while(cur)
  {
    unsigned int i;

    // write the length of this array
    WRITEU32(save_p, cur->length);

    // values[] is array of fs_value_s, which is a union of possible values
    // marked with the type, each array element can be of a different type

    // write the contents of this array
    for (i=0; i<cur->length; i++)
    {
      WRITEBYTE(save_p, cur->values[i].type); // store type;
      P_ArchiveSValue(&cur->values[i]);
    }

    cur = cur->next;
  }
}

// must be called before unarchiving running/level scripts
static
void P_UnArchiveFSArrays(void)
{
  T_Init_FSArrayList(); // reinitialize the save list
     // All PU_LEVEL memory already cleared by P_UnArchiveMisc()

  // read number of FS arrays
  SG_Readbuf();
  unsigned int num_fsarrays = READU32(save_p);

#ifdef FS_ARRAYLIST_STRUCTHEAD
  fs_array_t *last = fs_arraylist.next; // start at first array
#else
  fs_array_t *last = fs_arraylist; // start at first array
#endif

  // read all the arrays
  unsigned int q;
  for(q=0; q<num_fsarrays; q++)
  {
    fs_array_t *newArray = Z_Malloc(sizeof(fs_array_t), PU_LEVEL, NULL);
    memset(newArray, 0, sizeof(fs_array_t));

    // read length of this array
    newArray->length = READU32(save_p);
      
    newArray->values = Z_Malloc(newArray->length * sizeof(fs_value_t), PU_LEVEL, NULL);
    CONS_Printf("%i", newArray->length);
      
    // read all archived values
    unsigned int i;
    for(i=0; i<newArray->length; i++)
    {
      newArray->values[i].type = READBYTE(save_p);
      P_UnArchiveSValue(&newArray->values[i]);
    }

    // link in the new array -- must reconstruct list in same
    // order as read (T_Add_FSArray will not work for this)
    last->next = newArray;
    last = newArray;
  }

  // now number all the arrays
  P_NumberFSArrays();
}


static
void P_ArchiveScripts()
{
    // save FS arrays
    P_ArchiveFSArrays();

    // save levelscript
    P_ArchiveLevelScript();

    // save runningscripts
    P_ArchiveRunningScripts();

    WRITEBOOLEAN(save_p, script_camera_on);
    WRITE_MobjPointerID(save_p, script_camera.mo);
    WRITEANGLE(save_p, script_camera.aiming);
    WRITEFIXED(save_p, script_camera.viewheight);
    WRITEANGLE(save_p, script_camera.startangle);
    SG_Writebuf();
}

static
void P_UnArchiveScripts()
{
    // restore FS arrays
    P_UnArchiveFSArrays();
    
    // restore levelscript
    P_UnArchiveLevelScript();

    // restore runningscripts
    P_UnArchiveRunningScripts();

    // Unarchive the script camera
    SG_Readbuf();
    script_camera_on = READBOOLEAN(save_p);
    script_camera.mo = READ_MobjPointerID(save_p);
    script_camera.aiming = READANGLE(save_p);
    script_camera.viewheight = READFIXED(save_p);
    script_camera.startangle = READANGLE(save_p);
}

// [WDJ] return true if there is fragglescript state to be saved
static
boolean SG_fragglescript_detect( void )
{
    int i;
#ifdef FS_ARRAYLIST_STRUCTHEAD
    if( fs_arraylist.next ) goto found_state;	// start of arrays
#else
    if( fs_arraylist ) goto found_state;	// start of arrays
#endif
    for(i=0; i<VARIABLESLOTS; i++)
    {
        if( fs_levelscript.variables[i] ) goto found_state;  // levelscript has vars
    }
    if( fs_runningscripts.next ) goto found_state;  // there is a running script
    if( script_camera_on ) goto found_state;
    if( script_camera.mo || script_camera.viewheight
        || script_camera.aiming || script_camera.startangle )
                goto found_state; // camera was on
 
    return 0;

 found_state:
    return 1;	// must save fragglescript
}

#endif // FRAGGLESCRIPT


// =======================================================================
//          Bots
// =======================================================================

typedef enum {
   PB_item = 0x01,
   PB_enemy = 0x02,
   PB_missile = 0x04,
   PB_teammate = 0x08
} PB_bots_e;

// Ver 1.49
static
void P_Archive_Bots()
{
    int i;
    player_t * ply;
    bot_t * botp;
    byte  saveflags;

    for (i = 0; i < MAXPLAYERS; i++)
    {
        if (!playeringame[i])  continue;

        ply = &players[i];
        botp = ply->bot;

        if( ! botp )  continue;
       
        saveflags = 0;

        SG_SaveSync( SYNC_bots );  // before each bot
        WRITEBYTE(save_p, ply - players ); // player number
        WRITEBYTE(save_p, botp->skill);
        WRITEBYTE(save_p, botp->lastNumWeapons);
//        WRITEBYTE(save_p, botp->straferight);  // 1.48
        WRITE16(save_p, botp->flags);  // 1.49, bot got flags, incl straferight
        WRITEBYTE(save_p, botp->what); // 1.49
        WRITEBYTE(save_p, botp->turn_timer); // 1.49

        if( botp->bestSeenItem || botp->bestItem )  saveflags |= PB_item;
        if( botp->closestEnemy || botp->closestUnseenEnemy || botp->lastMobj )  saveflags |= PB_enemy;
        if( botp->closestMissile )  saveflags |= PB_missile;
        if( botp->teammate || botp->closestUnseenTeammate )  saveflags |= PB_teammate;

        WRITEBYTE(save_p, saveflags);

        if(saveflags & PB_item )
        {
            WRITE_MobjPointerID(save_p, botp->bestSeenItem );
            WRITE_MobjPointerID(save_p, botp->bestItem );
        }
        if(saveflags & PB_enemy )
        {
            WRITE_MobjPointerID(save_p, botp->closestEnemy );
            WRITE_MobjPointerID(save_p, botp->closestUnseenEnemy );
            WRITE_MobjPointerID(save_p, botp->lastMobj );
        }
        if(saveflags & PB_missile )
        {
            WRITE_MobjPointerID(save_p, botp->closestMissile );
        }
        if(saveflags & PB_teammate )
        {
            WRITE_MobjPointerID(save_p, botp->teammate );
            WRITE_MobjPointerID(save_p, botp->closestUnseenTeammate );
        }
        // What these records leave out is in the section of SYNC_botstate.
        SG_Writebuf();
    }
}

// The rest of what the bots' decisions read.  Every machine runs every bot, so
// all of it is game state, and saving it must not change the saving game: nothing
// is forgotten here.  A section of its own, after the bots, so that a build
// that does not know it stops at the sync byte instead of misreading the bots.
// The path and the destination are grid coordinates, not pointers.
//   oksector (32, a sector index or 0xFFFFFFFF)
//   (savegame 10149 only: the walking bob of every player in the game, count (8), then per
//            player the number (8), bob_momx and bob_momy (32 each). It is in the players'
//            records since 10150, for every game; this section has it no more.)
//   per bot: player (8), blockedcount, avoidtimer, strafetimer,
//            weaponchangetimer, runtimer, lastMobjX, lastMobjY (32 each),
//            destNode x and y (32 each, both 0xFFFFFFFF for none),
//            path length (32), the x and y (32 each) of each node, first node first
//   0xFF
#define BOTSTATE_END  0xFF
#define BOTSTATE_NONE  0xFFFFFFFF

static
void P_Archive_Botstate()
{
    int i;
    int32_t n;
    bot_t * botp;
    SearchNode_t * node;

    WRITE32(save_p, oksector? (oksector - sectors) : BOTSTATE_NONE);
    // (The walking bob is in the players' records since SG_BOB_VERSION; the F3 section
    // had it here, for the games with bots.)
    SG_Writebuf();
    for (i = 0; i < MAXPLAYERS; i++)
    {
        if (!playeringame[i])  continue;
        botp = players[i].bot;
        if( ! botp )  continue;

        WRITEBYTE(save_p, i);
        WRITE32(save_p, botp->blockedcount);
        WRITE32(save_p, botp->avoidtimer);
        WRITE32(save_p, botp->strafetimer);
        WRITE32(save_p, botp->weaponchangetimer);
        WRITE32(save_p, botp->runtimer);
        WRITE32(save_p, botp->lastMobjX);
        WRITE32(save_p, botp->lastMobjY);
        if( botp->destNode )
        {
            WRITE32(save_p, botp->destNode->x);
            WRITE32(save_p, botp->destNode->y);
        }
        else
        {
            WRITE32(save_p, BOTSTATE_NONE);
            WRITE32(save_p, BOTSTATE_NONE);
        }
        n = 0;
        for (node = botp->path->first; node; node = node->vnext)  n++;
        WRITE32(save_p, n);
        n = 0;
        for (node = botp->path->first; node; node = node->vnext)
        {
            WRITE32(save_p, node->x);
            WRITE32(save_p, node->y);
            // a long path is written in pieces, so that it cannot overrun the buffer
            if( (++n & 0x3FF) == 0 )  SG_Writebuf();
        }
        SG_Writebuf();
    }
    WRITEBYTE(save_p, BOTSTATE_END);
    SG_Writebuf();
}

// Ver 1.48, 1.49
// [WDJ]
static
void P_UnArchive_Bots()
{
    player_t * player;
    bot_t * botp;
    byte  saveflags;
    byte  playernum;
   
    // This cannot be in player section because it needs mobj pointers, which are only
    // valid after the mobj section.
   
    DemoAdapt_bots();

    // Bots sections starts with 2 Sync_bots, one for the section, one for the first bot.
    while( SG_ReadSync( SYNC_bots, 1 ) )  // marker for each bot
    {
        SG_Readbuf();

        playernum = READBYTE(save_p);
        if( playernum >= MAXPLAYERS )
        {
            I_SoftError( "SaveGame Bots: Bad Player number\n" );
            save_game_abort = 1;
            return;
        }
        player = & players[playernum];

        B_Create_Bot( player );
        botp = player->bot;
       
        botp->skill = READBYTE(save_p);
        botp->lastNumWeapons = READBYTE(save_p);
        if( sg_version >= 149 )
        {
            botp->flags = READ16(save_p);   // 1.49
            botp->what = READBYTE(save_p);  // 1.49
            botp->turn_timer = READBYTE(save_p);  // 1.49;
        }
        else
        {
            // 1.48, translated to flags
            // straferight was boolean saved as byte, is now in flags
            botp->flags = ( READBYTE(save_p) )? BF_straferight : 0;
            botp->what = 0;
            botp->turn_timer = 0;
        }

        saveflags = READBYTE(save_p);  // savegame field flags

        if(saveflags & PB_item )
        {
            botp->bestSeenItem = READ_MobjPointerID(save_p);
            botp->bestItem = READ_MobjPointerID(save_p);
        }
        if(saveflags & PB_enemy )
        {
            botp->closestEnemy = READ_MobjPointerID(save_p);
            botp->closestUnseenEnemy = READ_MobjPointerID(save_p);
            botp->lastMobj = READ_MobjPointerID(save_p);
        }
        if(saveflags & PB_missile )
        {
            botp->closestMissile = READ_MobjPointerID(save_p);
        }
        if(saveflags & PB_teammate )
        {
            botp->teammate = READ_MobjPointerID(save_p);
            botp->closestUnseenTeammate = READ_MobjPointerID(save_p);
        }
        // The path and the destination are in the section of SYNC_botstate,
        // which a savegame of an older build does not have: they stay empty.
    }
}

// The grid point x, y of the bot's node grid, or NULL when there is none.
static
SearchNode_t * SG_bot_grid_node( int32_t x, int32_t y )
{
    if( (x < 0) || (x >= xSize) || (y < 0) || (y >= ySize) || !botNodeArray )
        return NULL;
    return botNodeArray[x][y];
}

// True when n more bytes of the savegame are in the buffer: for a save read from a file,
// what the file had (a truncated file has less), for a buffer, its size.
static
boolean SG_have( size_t n )
{
    size_t used = save_p - savebuffer;
    size_t avail = savefile? (size_t) extfile.bufcnt : savebuffer_size;
    return (used <= avail) && (n <= (avail - used));
}

#define BOTSTATE_CHUNK  1024  // path nodes read before the buffer is refilled

static
void P_UnArchive_Botstate()
{
    int32_t n, k, m, x, y;
    uint32_t ui;
    byte  pn;
    bot_t * botp;
    SearchNode_t * node;
    int32_t * xy;

    SG_Readbuf();
    if( ! SG_have( 4 + 1 ) )  goto bad_data;
    ui = READU32(save_p);
    if( ui == BOTSTATE_NONE )
        oksector = NULL;
    else if( ui < numsectors )
        oksector = &sectors[ui];
    else
        goto bad_data;

    if( sg_version < SG_BOB_VERSION )
    {
        // the walking bob of the players, in the section of a savegame of F3
        n = READBYTE(save_p);
        if( ! SG_have( (size_t)n * 9 + 1 ) )  goto bad_data;
        for( k = 0; k < n; k++ )
        {
            pn = READBYTE(save_p);
            x = READ32(save_p);
            y = READ32(save_p);
            if( (pn >= MAXPLAYERS) || !playeringame[pn] )  goto bad_data;
            players[pn].bob_momx = x;
            players[pn].bob_momy = y;
        }
    }

    while( (pn = READBYTE(save_p)) != BOTSTATE_END )
    {
        SG_Readbuf();
        // the fixed part of a record: 9 numbers and the length
        if( save_game_abort || !SG_have( 10 * 4 ) )  goto bad_data;
        if( (pn >= MAXPLAYERS) || !playeringame[pn] || !players[pn].bot )
            goto bad_data;
        botp = players[pn].bot;

        botp->blockedcount = READ32(save_p);
        botp->avoidtimer = READ32(save_p);
        botp->strafetimer = READ32(save_p);
        botp->weaponchangetimer = READ32(save_p);
        botp->runtimer = READ32(save_p);
        botp->lastMobjX = READ32(save_p);
        botp->lastMobjY = READ32(save_p);
        x = READ32(save_p);
        y = READ32(save_p);
        if( (x == (int32_t)BOTSTATE_NONE) && (y == (int32_t)BOTSTATE_NONE) )
        {
            botp->destNode = NULL;
        }
        else
        {
            botp->destNode = SG_bot_grid_node( x, y );
            if( ! botp->destNode )  goto bad_data;
        }
        n = READ32(save_p);
        // A path has each node of the grid once at most.
        if( (n < 0) || (n > numbotnodes) )  goto bad_data;
        B_LLClear( botp->path );
        // first node first in the file: put the last one in first
        // (the list is made as it is by B_FindNextNode)
        xy = Z_Malloc( (n + 1) * 2 * sizeof(int32_t), PU_STATIC, 0 );
        for( k = 0; k < n; k += m )
        {
            // In pieces: the buffer is refilled between them, and each piece is checked
            // against what the file still has, so that a length the file does not back
            // reads nothing.  Each node must be a point of the grid.
            m = n - k;
            if( m > BOTSTATE_CHUNK )  m = BOTSTATE_CHUNK;
            SG_Readbuf();
            if( save_game_abort || !SG_have( (size_t)m * 8 ) )  { Z_Free( xy );  goto bad_data; }
            for( x = 0; x < m; x++ )
            {
                xy[2*(k+x)] = READ32(save_p);
                xy[2*(k+x)+1] = READ32(save_p);
                if( (xy[2*(k+x)] < 0) || (xy[2*(k+x)] >= xSize)
                    || (xy[2*(k+x)+1] < 0) || (xy[2*(k+x)+1] >= ySize) )
                {   Z_Free( xy );  goto bad_data;  }
            }
        }
        for( k = n - 1; k >= 0; k-- )
        {
            node = Z_Malloc( sizeof(SearchNode_t), PU_STATIC, 0 );
            memset( node, 0, sizeof(SearchNode_t) );
            node->x = xy[2*k];
            node->y = xy[2*k+1];
            B_LLInsertFirstNode( botp->path, node );
        }
        Z_Free( xy );
        SG_Readbuf();
        if( save_game_abort )  return;
        if( ! SG_have( 1 ) )  goto bad_data;
    }
    return;

bad_data:
    I_SoftError( "LoadGame: bad bot state.\n" );
    save_game_abort = 1;
}

// =======================================================================
//          Misc
// =======================================================================
static
void P_ArchiveMisc()
{
    uint32_t pig = 0;
    int i;

    WRITEBYTE(save_p, gameskill);
    WRITEBYTE(save_p, gameepisode);
    WRITEBYTE(save_p, gamemap);

    for (i = 0; i < MAXPLAYERS; i++)
        pig |= (playeringame[i] != 0) << i;

    WRITEU32(save_p, pig);

    WRITEU32(save_p, leveltime);
    WRITEBYTE(save_p, P_Rand_GetIndex());
    // ver 1.48, save B_Random, E_Random
    WRITEBYTE(save_p, B_Rand_GetIndex());
    uint32_t rand1, rand2; // cannot trust compiler to keep order
    rand1 = E_Rand_Get( & rand2 );
    WRITEU32(save_p, rand1);
    WRITEU32(save_p, rand2);

    SG_Writebuf();
}

static
boolean P_UnArchiveMisc()
{
    uint32_t pig;
    int i;

    SG_Readbuf();
    gameskill = READBYTE(save_p);
    gameepisode = READBYTE(save_p);
    gamemap = READBYTE(save_p);

    pig = READU32(save_p);

    for (i = 0; i < MAXPLAYERS; i++)
    {
        playeringame[i] = (pig & (1 << i)) != 0;
        player_state[i] = (playeringame[i])? PS_player_from_savegame : 0;
        players[i].playerstate = PST_REBORN;
    }

    // Purge all previous PU_LEVEL memory.
    if (!P_SetupLevel(gameepisode, gamemap, gameskill, NULL))
        return false;

    // get the time
    leveltime = READU32(save_p);
    P_Rand_SetIndex(READBYTE(save_p));
    if( sg_version >= 148 )
    {
        B_Rand_SetIndex(READBYTE(save_p));
        uint32_t rand1 = READU32(save_p); // cannot trust compiler to keep order
        uint32_t rand2 = READU32(save_p);
        E_Rand_Set( rand1, rand2 );
    }

    return true;
}

// =======================================================================
//          Net vars
// =======================================================================

// load cv_ vars, variable length
static
void P_LoadNetVars( void )
{
    const int mincnt = 23; // Smallest number of netvar in a 144 savegame
    int count = 0;
    xcmd_t  xc;

    // [WDJ] Every addition of a cv_ var changes the number of NetVar loaded here.
    // Make it adaptable so that old save games can be loaded.
    // This works for now, but it is a conflict between SYNC_sync
    // and the netvar id number.
    SG_Readbuf();
    // continue loading net vars until hit the sync
    xc.playernum = 0;
    xc.endpos = & savebuffer[savebuffer_size-1];
    for (;;count++)
    {
        if( count>=mincnt )
            if( save_p[0] == SYNC_sync && save_p[1] == SYNC_misc ) break;
        xc.curpos = save_p;
        Got_NetXCmd_NetVar( &xc );
        save_p = xc.curpos;
        if( save_p > xc.endpos )
        {
            save_game_abort = 1;  // Buffer overrun
            break;
        }
    }
//    GenPrintf(EMSG_info, "Loaded %d netvars\n", count ); // [WDJ] DEBUG
}

// =======================================================================
//          Save game
// =======================================================================

// Save game header support

// Get the name of the wad containing the current level map
// Write operation for :map: line.
static
const char * level_wad( void )
{
    char * mapwad;
    // level_lumpnum contains index to the wad containing current map.
    int mapwadnum = WADFILENUM( level_lumpnum );
    if( mapwadnum >= numwadfiles )  goto defname;
    mapwad = wadfiles[ mapwadnum ]->filename;
    if( mapwad == NULL )  goto defname;
    return FIL_Filename_of( mapwad );  // ignore directories

 defname:
    return gamedesc.iwad_filename[0];  // first is default
}

// Check if the wad name is in the wadfiles
// Read operation for :map: line.
static
boolean  check_have_wad( char * ckwad )
{
    int i;
    // search all known wad names for a match
    for( i=0; i<numwadfiles; i++ )
    {
        char * tt = FIL_Filename_of( wadfiles[i]->filename );
        if( strcmp( tt, ckwad ) == 0 )  return true;
    }
    return false;
}


// Write the command line switches to savebuffer.
// Write operation for :cmd: line.
static
void WRITE_command_line( void )
{
    int i;
    SG_write_string( ":cmd:" );
    save_p --;  // No term 0 on header writes
    for( i=1; i<myargc; i++ )	// skip executable
    {
      int len = sprintf( (char *)save_p, " %s", myargv[i] );
        save_p += len;
    }
    SG_write_string( "\n" );
    save_p --;
}

// Save game header
// Langid format requires underlines.
const char * sg_head_format =
"!!Legacy_save_game.V%i\n:name:%s\n:game:%s\n:wad:%s\n:map:%s\n:time:%2i:%02i\n";
const short idname_length = 18;  // !!<name> length

const char * sg_netgame_head_format =
"!!Legacy_netgame.V%i\n";
const short netgame_idname_length = 16;  // !!<name> length

#define sg_head_END "::END\n"

// __BIG_ENDIAN__ is defined on MAC compilers, not on WIN, nor LINUX
#ifdef __BIG_ENDIAN__
const byte sg_big_endian = 1;
#else
const byte sg_big_endian = 0;
#endif

// Called from menu via G_DoSaveGame via network Got_SaveGame_cmd.
// Used for savegame file and netgame.
//   write_netgame : 1 for network passed netgame
// Write savegame header to savegame buffer.
void P_Savegame_Write_header( const char * description, byte write_netgame )
{
    int len;
    int l_min, l_sec;

    save_p = savebuffer;

    // To write savegame version DL_VERSION, which may be different than VERSION.
    if( write_netgame )
    {
        len = sprintf( (char *)save_p, sg_netgame_head_format, VERSION );
        save_p += len;  // does not include string term 0
    }
    else
    {
        // [WDJ] A consistent header across all save game versions.
        // Save Langid game header
        // Do not use WRITESTRING as that will put term 0 into the header.

        // time into level
        l_sec = leveltime / TICRATE;  // seconds
        l_min = l_sec / 60;
        l_sec -= l_min * 60;

        len = sprintf( (char *)save_p, sg_head_format,
                    VERSION, description, gamedesc.gname,
                    level_wad(), level_mapname, l_min, l_sec );
        save_p += len;  // does not include string term 0
        WRITE_command_line();
    }
    len = sprintf( (char *)save_p, sg_head_END );
    save_p += len;  // does not include string term 0
    WRITEBYTE( save_p, 0 );  // The only 0 in the header is after the END
    // the level number is also saved in ArchiveMisc

    // binary header data
    // 16 bit game version that wrote file
    WRITE16( save_p, SG_PORTABLE_BASE + SG_BOB_VERSION );  // savegame version
    WRITEBYTE( save_p, sg_big_endian );
    WRITEBYTE( save_p, sg_padded );
    WRITEBYTE( save_p, sizeof(int) );	// word size
    WRITEBYTE( save_p, sizeof(boolean) );	// machine dependent
    // reserved
    WRITEBYTE( save_p, 0 );
    WRITEBYTE( save_p, 0 );
    WRITEBYTE( save_p, 0 );
    WRITEBYTE( save_p, 0 );
    SG_Writebuf();
}


// Find the header line in the savebuffer
char *  read_header_line( const char * idstr )
{
    char * fnd = strstr( (char *)save_p, idstr ); // find the :name:
    if( fnd ) // NULL if not found
        fnd += strlen(idstr);  // start of line content
    return fnd;
}

// Terminate strings, this modifies the header in the savebuffer
// Must be only done after all header reads.
void  term_header_line( char * infodest )
{
    if( infodest ) // NULL if not found
    {
        // terminate strings, this modifies the header in the savebuffer
        * strpbrk( infodest, "\r\n" ) = 0;
    }
}


// Called from G_DoLoadGame, M_Read_savestrings
// Only for savegame file and netgame.
// Read savegame header from savegame buffer.
//   read_netgame : 1 for network passed netgame
// Returns header info in infop.
// Returns 1 when header is correct.
boolean P_Savegame_Read_header( savegame_info_t * infop, byte read_netgame )
{
    const char * reason;

    // Read header
    save_game_abort = 0;	// all sync reads will check this
    sg_net_load = read_netgame;
    SG_Readbuf();
    save_p = savebuffer;

    if( read_netgame )
    {
        if( strncmp( (char *)save_p, sg_netgame_head_format, netgame_idname_length ) )  goto not_save;
        if( ! strstr( (char *)save_p, "::END" ) )  goto not_save;
        save_p += strlen( (char *)save_p ) + 1; // find 0, to get past Langid header;
    }
    else
    {
        if( strncmp( (char *)save_p, sg_head_format, idname_length ) )  goto not_save;
        if( ! strstr( (char *)save_p, "::END" ) )  goto not_save;

        // find header strings
        infop->name = read_header_line( ":name:" );
        infop->game = read_header_line( ":game:" );
        infop->wad = read_header_line( ":wad:" );
        infop->map = read_header_line( ":map:" );
        infop->levtime = read_header_line( ":time:" );
        save_p += strlen( (char *)save_p ) + 1; // find 0, to get past Langid header;

        // terminate the strings, this modifies the header in the savebuffer
        // and prevents finding any more header lines
        term_header_line( infop->name );
        term_header_line( infop->game );
        term_header_line( infop->wad );
        term_header_line( infop->map );
        term_header_line( infop->levtime );

        // validity tests
        infop->have_game = ( strcmp( gamedesc.gname, infop->game ) == 0 );
        infop->have_wad = check_have_wad( infop->wad );
    }

    // binary header data
    reason = "version";
    sg_version = READ16( save_p );  // savegame version
    sg_portable = ( sg_version >= SG_PORTABLE_BASE );
    if( sg_portable )  sg_version -= SG_PORTABLE_BASE;
    if( sg_version < MIN_READSAVE_VERSION )  goto wrong;
    // The portable layout is written with DL_VERSION (F2, F3) and SG_BOB_VERSION (F4).
    if( sg_version > ((sg_portable)? SG_BOB_VERSION : MAX_READSAVE_VERSION) )  goto wrong;
    // Nothing writes the portable layout with another version than these.
    if( sg_portable && sg_version != DL_VERSION && sg_version != SG_BOB_VERSION )  goto wrong;
    // A savegame of the old layout holds raw memory of the machine that
    // wrote it. It can only be read by the same kind of machine, which
    // a game that is joined cannot know.
    if( read_netgame && ! sg_portable )  goto old_layout;
    // A joining client has no bob to start from in an older savegame: the joiner's players
    // would differ from the server's as soon as one has been walking (L53). Refuse it,
    // with the message of any other version.
    if( read_netgame && sg_version < SG_BOB_VERSION )  goto wrong;
    reason = "endian";
    if( READBYTE( save_p ) != sg_big_endian )  goto wrong;
    reason = "padding";
    if( READBYTE( save_p ) != sg_padded )  goto wrong;
    reason = "integer size";
    if( READBYTE( save_p ) != sizeof(int))  goto wrong;
    reason = "boolean size";
    if( READBYTE( save_p ) != sizeof(boolean))  goto wrong;
    // skip reserved header bytes
    save_p += 4;

    infop->msg[0] = 0;    
    return 1;

 not_save:
   snprintf( infop->msg, 60, "Not Legacy savegame\n" );
   goto failed;

 wrong:
   snprintf( infop->msg, 60, "Invalid savegame: wrong %s\n", reason );
   goto failed;

 old_layout:
   snprintf( infop->msg, sizeof(infop->msg), "Invalid savegame: the server's savegame is not the portable layout (an older or upstream build)\n" );
   goto failed;

 failed:
    return false;
}


// Called from menu via G_DoSaveGame via network Got_SaveGame_cmd,
// and called from SV_Send_SaveGame by network for JOININGAME.
// Write game data to savegame buffer.
void P_Savegame_Save_game( void )
{
    xcmd_t xc;

    InitPointermap_Save(&mobj_ptrmap, 1024);

    SG_SaveSync( SYNC_net );
    xc.playernum = 0;
    xc.curpos = save_p;
    xc.endpos = & savebuffer[savebuffer_size-1];
    CV_SaveNetVars( &xc );
    save_p = xc.curpos;
    SG_SaveSync( SYNC_misc );
    P_ArchiveMisc();
    SG_SaveSync( SYNC_players );
    P_ArchivePlayers();
    SG_SaveSync( SYNC_world );
    P_ArchiveWorld();
    if ( P_Traverse_Extra_Mapthing(NULL) )  // optional
    {
        SG_SaveSync( SYNC_extra_mapthing );
        P_Archive_Mapthing();
    }
    SG_SaveSync( SYNC_thinkers );
    P_ArchiveThinkers();
    SG_SaveSync( SYNC_specials );
    P_ArchiveSpecials();
    // Optional soundtarget section, when some sector has one.
    if( SG_soundtarget_detect() )
    {
        SG_SaveSync( SYNC_soundtarget );
        P_Archive_Soundtargets();
    }
#ifdef FRAGGLESCRIPT
    // Only save fragglescript if the level uses it.
    if( SG_fragglescript_detect() )
    {
        SG_SaveSync( SYNC_fragglescript );
        P_ArchiveScripts();
    }
#endif
    // Optional bots section
    if( bots_detected )
    {
        SG_SaveSync( SYNC_bots );
        P_Archive_Bots();  // Player Bots
        SG_SaveSync( SYNC_botstate );
        P_Archive_Botstate();
    }
   
    SG_SaveSync( SYNC_end );

#if 0
    // debug
    uint32_t k;
    for (k=0; k < mobj_ptrmap.used; k++)
      {
        I_OutputMsg("%d  %p\n", k, mobj_ptrmap.map[k].pointer);
        if (mobj_ptrmap.map[k].pointer == NULL)
          I_Error("P_Savegame_Save_game: Hole in mobj_ptrmap!\n");
        //debug_Printf("P_Savegame_Save_game: %d  %p\n", k, mobj_ptrmap.map[k].pointer);
      }
#endif

    ClearPointermap( &mobj_ptrmap );
}


   
// Called from G_DoLoadGame
// Read game data in savegame buffer.
boolean P_Savegame_Load_game(void)
{
    InitPointermap_Load(&mobj_ptrmap, 1024);
    InitPointermap_Load(&mapthg_ptrmap, 64);

    if( ! SG_ReadSync( SYNC_net, 0 ) )  goto sync_err;
    P_LoadNetVars();
    if( ! SG_ReadSync( SYNC_misc, 0 ) )  goto sync_err;
    // Misc does level setup, and purges all previous PU_LEVEL memory.
    if (!P_UnArchiveMisc())  goto failed;
    if( ! SG_ReadSync( SYNC_players, 0 ) )  goto sync_err;
    P_UnArchivePlayers();
    if( ! SG_ReadSync( SYNC_world, 0 ) )  goto sync_err;
    P_UnArchiveWorld();
    if( SG_ReadSync( SYNC_extra_mapthing, 1 ) )  // optional
    {
        P_UnArchive_Mapthing();
    }
    if( ! SG_ReadSync( SYNC_thinkers, 0 ) )  goto sync_err;
    P_UnArchiveThinkers();
    if( ! SG_ReadSync( SYNC_specials, 0 ) )  goto sync_err;
    P_UnArchiveSpecials();
    // Optional soundtarget section
    if( SG_ReadSync( SYNC_soundtarget, 1 ) )
    {
        P_UnArchive_Soundtargets();
    }
    // Optional fragglescript section
    if( SG_ReadSync( SYNC_fragglescript, 1 ) )
#ifdef FRAGGLESCRIPT
    {
        P_UnArchiveScripts();
    }
    else
    {
        // This is all the setup does
        T_Init_FSArrayList();             // Setup FS array list
        // FIXME: kill any existing fragglescript
    }
#else   
    {
        I_SoftError( "Fragglescript required for this save game" );
        goto failed;
    }
#endif
    // Optional bots section
    if( SG_ReadSync( SYNC_bots, 1 ) )
    {
        P_UnArchive_Bots();
        // Optional, a savegame of an older build does not have it
        if( SG_ReadSync( SYNC_botstate, 1 ) )
        {
            P_UnArchive_Botstate();
        }
        else if( sg_net_load )
        {
            // A server whose bots have no state in the savegame is a build from before F3.
            // Its bots (the phase of regulate(), the aim, oksector) do not play as ours,
            // so a game with bots cannot be shared with it: refuse the join.
            // (A savegame file of such a build loads, with the bots' new fields empty.)
            I_SoftError( "LoadGame: the server's savegame has bots without their state: it is from a build before the bot changes (F3), whose bots play differently. Join refused.\n" );
            save_game_abort = 1;
            goto failed;
        }
    }

    if( ! SG_ReadSync( SYNC_end, 1 ) )  goto sync_err;
   
    ClearPointermap( &mobj_ptrmap );
    ClearPointermap( &mapthg_ptrmap );
    return true;
   
 sync_err:
    I_SoftError( "Legacy save game sync error\n" );

 failed:
    ClearPointermap( &mobj_ptrmap );	// safe clear
    ClearPointermap( &mapthg_ptrmap );
    return false;
}
