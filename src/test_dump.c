// SPDX-License-Identifier: GPL-2.0-or-later
//
// Test-only per-tic game state hash, to compare machines record for record.
//
//   -testdump FILE        write one 28-byte record per game tic to FILE
//   -teststate FROM [TO]  with -testdump: also write FILE.state, the whole
//                         state as text (one line per object), for game tics
//                         FROM..TO (TO defaults to FROM)
//
// Test hooks for the savegame (brief F2), each independent of -testdump:
//   -testsave TIC FILE [game]
//                         at game tic TIC, right after its record, write the
//                         savegame the join sends (P_Savegame_Write_header with
//                         the netgame header, P_Savegame_Save_game) to FILE.
//                         "game": the header of a savegame file instead.
//                         May be given several times.
//   -testquit TIC         quit (status 0) at game tic TIC, after the above
//   -testload FILE        at the first tic, load FILE as a joining client does
//                         (P_Savegame_Read_header, P_Savegame_Load_game), in a
//                         single-player game, and play on with no input as fast
//                         as possible and with no drawing.  The first record
//                         after it is the state as loaded.
//   -testaddbots TIC N    (brief F3) at game tic TIC, on the server, add N bots, as the
//                         console command "addbot" does.  The command line's +addbot
//                         runs before the level starts, and the first bot then takes
//                         the host's own player slot.
//   -testcmd TIC TEXT     (F3 fix round 1) at game tic TIC run the console command TEXT
//                         (for example "map e1m4"); may be given several times
//   -testcensus           print how many thinkers of each kind the level has,
//                         each time one of the counts reaches a new maximum
//   -testsizes            print the bytes one record of each sector effect takes
//                         in a savegame, and quit
//
// Record (seven 32-bit little endian words):
//   tic, total, random, players, mobjs, world, specials
// "tic" is gametic after the tic has run.  The five hashes are 32-bit FNV-1a
// over the fields below, and "total" is the FNV-1a of those five and the
// globals.  They are kept apart so that the first difference says which part of
// the state parted.
//
// Taken in TryRunTics (d_clisrv.c) right after G_Ticker and ExtraDataTicker,
// on every node, whatever drew or did not draw.  Nothing reads the drawing
// state and nothing here writes game state.  Nothing is sent on the wire, and
// without -testdump and the savegame hooks TestDump_Tic is a few tests of flags.
//
// Never hashed: pointers (objects are numbered by their place in the thinker
// list), the screen, sound, the menu, M_Random (music, status bar), A_Random
// (ambience) and N_Random (blood, smoke).

#include "doomincl.h"
#include "doomstat.h"
#include "g_game.h"
#include "m_argv.h"
#include "m_random.h"
#include "p_mobj.h"
#include "p_tick.h"
#include "p_spec.h"
#include "r_state.h"
#include "info.h"
#include "d_player.h"
#include "d_think.h"
#include "doomdata.h"
#include "test_dump.h"
#include "p_saveg.h"
#include "d_main.h"
#include "d_clisrv.h"
#include "r_main.h"
#include "r_draw.h"
#include "console.h"
#include "command.h"
#include "hu_stuff.h"
#include "am_map.h"
#include "i_system.h"
#include "b_game.h"
#include "b_node.h"

int  testdump_active = 0;

static FILE * dump_file = NULL;
static FILE * state_file = NULL;
static tic_t  state_from = 1, state_to = 0;   // state_to < state_from: none

// ---- hashing (and the text dump, when it is on) ----

static uint32_t  hv;      // hash being built
static FILE *    txt;     // text output for this tic, or NULL

#define FNV_BASIS  2166136261u
#define FNV_PRIME  16777619u

static void hash_u32( uint32_t v )
{
    int i;
    for( i = 0; i < 4; i++ )
    {
        hv ^= (v >> (8 * i)) & 0xFF;   // always little endian order
        hv *= FNV_PRIME;
    }
}

// One field.
static void fld( const char * name, int32_t v )
{
    hash_u32( (uint32_t) v );
    if( txt )  fprintf( txt, " %s=%d", name, (int) v );
}
#define F(name, expr)  fld( #name, (int32_t)(expr) )

static void begin( uint32_t seed )
{
    hv = FNV_BASIS;
    hash_u32( seed );
}

static void line_begin( const char * fmt, int a )
{
    if( txt )  fprintf( txt, fmt, a );
}

static void line_end( void )
{
    if( txt )  fputc( '\n', txt );
}

// ---- numbering objects by place in the thinker list ----

typedef struct { const void * p;  int ord; } ptr_ord_t;

static ptr_ord_t * ords = NULL;
static int         num_ords = 0, max_ords = 0;

static int cmp_ptr( const void * a, const void * b )
{
    const void * pa = ((const ptr_ord_t *) a)->p;
    const void * pb = ((const ptr_ord_t *) b)->p;
    return (pa < pb) ? -1 : (pa > pb) ? 1 : 0;
}

// Stopped platforms and crushers stay in the thinker list with function 0
// (EV_StopPlat, EV_CeilingCrushStop, the savegame loader); they are live, and
// are told apart by the activeplats and activeceilings lists.
static int live_thinker( const thinker_t * th )
{
    return th->function != TFI_RemoveThinker;
}

static int in_active_plats( const thinker_t * th )
{
    const platlist_t * pl;
    for( pl = activeplats; pl; pl = pl->next )
        if( (const thinker_t *) pl->plat == th )  return 1;
    return 0;
}

static int in_active_ceilings( const thinker_t * th )
{
    const ceilinglist_t * cl;
    for( cl = activeceilings; cl; cl = cl->next )
        if( (const thinker_t *) cl->ceiling == th )  return 1;
    return 0;
}

static int mobj_function( const thinker_t * th )
{
    return th->function == TFI_MobjThinker
        || th->function == TFI_MobjNullThinker
        || th->function == TFI_BlasterMobjThinker;
}

// Numbers the live thinkers 0.. in list order, and makes them searchable.
static void number_thinkers( void )
{
    thinker_t * th;
    int n = 0;

    num_ords = 0;
    for( th = thinkercap.next; th != &thinkercap; th = th->next )
    {
        if( ! live_thinker( th ) )  continue;
        if( num_ords >= max_ords )
        {
            max_ords = max_ords ? max_ords * 2 : 1024;
            ords = realloc( ords, max_ords * sizeof(ptr_ord_t) );
            if( ! ords )  I_Error( "testdump: out of memory" );
        }
        ords[num_ords].p = th;
        ords[num_ords].ord = n++;
        num_ords++;
    }
    qsort( ords, num_ords, sizeof(ptr_ord_t), cmp_ptr );
}

// -1: NULL.  -2: not a live thinker (never dereferenced).
static int ord_of( const void * p )
{
    int lo = 0, hi = num_ords - 1;
    if( p == NULL )  return -1;
    while( lo <= hi )
    {
        int mid = (lo + hi) / 2;
        if( ords[mid].p == p )  return ords[mid].ord;
        if( ords[mid].p < p )  lo = mid + 1;  else  hi = mid - 1;
    }
    return -2;
}

static int sector_num( const sector_t * s )
{
    if( s == NULL )  return -1;
    if( s < sectors || s >= sectors + numsectors )  return -2;
    return (int)( s - sectors );
}

static int line_num( const line_t * l )
{
    if( l == NULL )  return -1;
    if( l < lines || l >= lines + numlines )  return -2;
    return (int)( l - lines );
}

static int state_num( const state_t * s )
{
    if( s == NULL )  return -1;
    if( s < states || s >= states + NUMSTATES_EXT )  return -2;
    return (int)( s - states );
}

static int player_num( const player_t * p )
{
    if( p == NULL )  return -1;
    if( p < players || p >= players + MAXPLAYERS )  return -2;
    return (int)( p - players );
}

// ---- the parts ----

static uint32_t hash_random( void )
{
    uint32_t rs;
    uint32_t r1 = E_Rand_Get( &rs );

    begin( 1 );
    if( txt )  fputs( "random", txt );
    F( prnd, P_Rand_GetIndex() );
    F( brnd, B_Rand_GetIndex() );
    F( e1, r1 );
    F( e2, rs );
    line_end();
    return hv;
}

#ifdef SG_BOT_STATE
// A bot's whole state: every machine runs every bot, so all of it decides a later
// ticcmd (brief F3).  Pointers are numbers in the thinker list; the destination and the
// path are grid coordinates.
static void hash_bot( const bot_t * b )
{
    const SearchNode_t * n;
    int len = 0;

    F( bflags, b->flags );  F( blastnum, b->lastNumWeapons );
    F( bskill, b->skill );  F( bwhat, b->what );  F( bturn, b->turn_timer );
    F( bblocked, b->blockedcount );  F( bavoid, b->avoidtimer );
    F( bstrafe, b->strafetimer );  F( bweaponchange, b->weaponchangetimer );
    F( brun, b->runtimer );
    F( blastx, b->lastMobjX );  F( blasty, b->lastMobjY );
    F( bbestseen, ord_of( b->bestSeenItem ) );  F( bbest, ord_of( b->bestItem ) );
    F( benemy, ord_of( b->closestEnemy ) );
    F( bmissile, ord_of( b->closestMissile ) );
    F( bunseenenemy, ord_of( b->closestUnseenEnemy ) );
    F( bunseenmate, ord_of( b->closestUnseenTeammate ) );
    F( blast, ord_of( b->lastMobj ) );  F( bmate, ord_of( b->teammate ) );
    if( b->destNode )  { F( bdestx, b->destNode->x );  F( bdesty, b->destNode->y ); }
    else               { F( bdest, -1 ); }
    if( b->path )
    {
        for( n = b->path->first; n; n = n->vnext )
        {
            F( bpathx, n->x );  F( bpathy, n->y );
            len++;
        }
    }
    F( bpathlen, len );
}
#endif

static uint32_t hash_players( void )
{
    int i, j;

    begin( 2 );
    for( i = 0; i < MAXPLAYERS; i++ )
    {
        const player_t * pl = &players[i];
        if( ! playeringame[i] )  continue;
        line_begin( "player %d", i );
        F( state, pl->playerstate );
        F( mo, (gamestate == GS_LEVEL) ? ord_of( pl->mo ) : -3 );
        if( gamestate == GS_LEVEL && pl->mo )
        {
            F( x, pl->mo->x );  F( y, pl->mo->y );  F( z, pl->mo->z );
            F( momx, pl->mo->momx );  F( momy, pl->mo->momy );
            F( momz, pl->mo->momz );  F( angle, pl->mo->angle );
        }
        // Not hashed: viewz, bob, bob_momx and bob_momy (and the weapon sprite's
        // sx and sy below). They are the view bobbing: a savegame does not hold
        // them, so a player that joined by savegame has them differ for a while
        // (they decay with friction), and nothing in the game reads them. The
        // weapon's state and tics are hashed, which is what the bob can change.
        F( viewheight, pl->viewheight );
        F( deltaviewheight, pl->deltaviewheight );
        F( aiming, pl->aiming );
        F( health, pl->health );
        F( armor, pl->armorpoints );
        F( armortype, pl->armortype );
        for( j = 0; j < NUMPOWERS; j++ )   F( power, pl->powers[j] );
        F( cards, pl->cards );
        F( gb, pl->GB_flags );
        F( gf, pl->GF_flags );
        F( addfrags, pl->addfrags );
        for( j = 0; j < MAXPLAYERS; j++ )  F( frag, pl->frags[j] );
        F( ready, pl->readyweapon );
        F( pending, pl->pendingweapon );
        for( j = 0; j < NUMWEAPONS; j++ )  F( owned, pl->weaponowned[j] );
        for( j = 0; j < NUMAMMO; j++ )     F( ammo, pl->ammo[j] );
        for( j = 0; j < NUMAMMO; j++ )     F( maxammo, pl->maxammo[j] );
        F( refire, pl->refire );
        F( kills, pl->killcount );
        F( items, pl->itemcount );
        F( secrets, pl->secretcount );
        F( cheats, pl->cheats );
        F( damagecount, pl->damagecount );
        F( bonuscount, pl->bonuscount );
        // Not hashed: specialsector. P_PlayerInSpecialSector sets it every tic and nothing
        // reads it but the text of a death message (p_inter.c:1852); a savegame does not
        // hold it, so a player standing in a nukage sector has 0 until its next tic
        // (bugs.md L44).
        F( skin, pl->skin );
        F( bot, pl->bot != NULL );
#ifdef SG_BOT_STATE
        if( pl->bot )  hash_bot( pl->bot );
#endif
        for( j = 0; j < NUMPSPRITES; j++ )
        {
            F( ps_state, state_num( pl->psprites[j].state ) );
            F( ps_tics, pl->psprites[j].tics );
        }
        F( chicken, pl->chickenTics );
        F( flyheight, pl->flyheight );
        line_end();
    }
#ifdef SG_BOT_STATE
    // The bots' globals: the sector the last path query left (b_node.c), the speed
    // numbers B_BuildTiccmd keeps between bots (b_game.c).  Only with a bot.
    for( i = 0; i < MAXPLAYERS; i++ )
        if( playeringame[i] && players[i].bot )  break;
    if( i < MAXPLAYERS )
    {
        byte frac, tics;
        line_begin( "botglobals %d", 0 );
        F( oksector, sector_num( oksector ) );
        F( grid, B_Grid_Hash() );   // every machine must have built the same node grid
        // The players' walking bob, which a savegame holds when there are bots (bugs.md
        // L25, L53): it decides when a player's mobj leaves its running frames.
        for( j = 0; j < MAXPLAYERS; j++ )
        {
            if( ! playeringame[j] )  continue;
            F( bobx, players[j].bob_momx );  F( boby, players[j].bob_momy );
        }
        if( B_Get_speed_state( &frac, &tics ) )
        {
            F( speedfrac, frac );  F( runtics, tics );
        }
        line_end();
    }
#endif
    return hv;
}

static void hash_mobj( int ord, const mobj_t * mo )
{
    line_begin( "mobj %d", ord );
    F( type, mo->type );
    F( x, mo->x );  F( y, mo->y );  F( z, mo->z );
    F( momx, mo->momx );  F( momy, mo->momy );  F( momz, mo->momz );
    F( floorz, mo->floorz );  F( ceilingz, mo->ceilingz );
    F( dropoffz, mo->dropoffz );
    F( radius, mo->radius );  F( height, mo->height );
    F( angle, mo->angle );
    F( sprite, mo->sprite );  F( frame, mo->frame );
    F( flags, mo->flags );  F( flags2, mo->flags2 );
#ifdef MOBJ_HAS_FLAGS3
    F( flags3, mo->flags3 );
#endif
    // The colour translation (MFT_TRANSLATION6) is how the renderer paints a player. A load
    // sends a bot's colour again from the local botinfo table, and in a single-player
    // -testload that table differs from run to run, so the mask keeps those runs
    // comparable. It does hide a real state change: skincolor, which teamplay "Color"
    // reads (ST_SameTeam). In a netgame every machine gets the same NameColor xcmd from
    // the server, so a join does not part on it (bugs.md L49). skincolor itself is not
    // hashed for the same reason.
    F( tflags, mo->tflags & ~MFT_TRANSLATION6 );  F( eflags, mo->eflags );
    F( special1, mo->special1 );  F( special2, mo->special2 );
    F( health, mo->health );
    F( tics, mo->tics );
    F( state, state_num( mo->state ) );
    F( target, ord_of( mo->target ) );
    F( tracer, ord_of( mo->tracer ) );
    F( lastenemy, ord_of( mo->lastenemy ) );
    F( nextnode, ord_of( mo->nextnode ) );
    F( targetnode, ord_of( mo->targetnode ) );
    F( player, player_num( mo->player ) );
    F( lastlook, mo->lastlook );
    F( movedir, mo->movedir );
    F( movecount, mo->movecount );
    F( reactiontime, mo->reactiontime );
    F( threshold, mo->threshold );
    F( strafecount, mo->strafecount );
    F( pursuecount, mo->pursuecount );
    F( tipcount, mo->tipcount );
    F( friction, mo->friction );
    F( movefactor, mo->movefactor );
    F( dropped_ammo, mo->dropped_ammo_count );
    F( nodescript, mo->nodescript );
    F( nodewait, mo->nodewait );
#ifdef MONSTER_VARY
    F( speed, mo->speed );
    F( vary, mo->vary_index );
#endif
    line_end();
}

// A sector effect: the thinker types that have a sector as first data field.
static void hash_effect( int ord, const thinker_t * th )
{
    line_begin( "effect %d", ord );
    int kind = th->function;
    F( fn, th->function );
    if( kind == 0 )
    {
        if( in_active_plats( th ) )          kind = TFI_PlatRaise;
        else if( in_active_ceilings( th ) )  kind = TFI_MoveCeiling;
    }
    switch( kind )
    {
     case TFI_MoveCeiling:
      {
        const ceiling_t * c = (const ceiling_t *) th;
        F( sector, sector_num( c->sector ) );
        F( type, c->type );  F( bottom, c->bottomheight );
        F( top, c->topheight );  F( speed, c->speed );
        F( oldspeed, c->oldspeed );  F( crush, c->crush );
        F( dir, c->direction );  F( olddir, c->olddirection );
        F( tag, c->tag );
        // new_sec_special, old_sec_special and new_ceilingpic are only set by
        // some makers (the zone does not clear blocks) and only copied into the
        // sector when the move ends, which the sector hash then shows.
      }
      break;
     case TFI_VerticalDoor:
      {
        const vldoor_t * d = (const vldoor_t *) th;
        F( sector, sector_num( d->sector ) );
        F( line, line_num( d->line ) );
        F( type, d->type );  F( top, d->topheight );  F( speed, d->speed );
        F( dir, d->direction );
        // topcountdown is read only while waiting (0) or in the initial wait (2),
        // and the door makers (p_doors.c) leave it, and topwait, unset otherwise:
        // the zone does not clear blocks, so there it holds whatever was there.
        if( d->direction == 0 || d->direction == 2 )
            F( countdown, d->topcountdown );
        F( lighttag, d->lighttag );
      }
      break;
     case TFI_MoveFloor:
      {
        const floormove_t * f = (const floormove_t *) th;
        F( sector, sector_num( f->sector ) );
        F( type, f->type );  F( crush, f->crush );
        F( dest, f->floordestheight );  F( speed, f->speed );
        F( dir, f->direction );
        // new_sec_special, old_sec_special, new_floorpic and new_floortype:
        // as for ceilings.
      }
      break;
     case TFI_PlatRaise:
      {
        const plat_t * p = (const plat_t *) th;
        F( sector, sector_num( p->sector ) );
        F( type, p->type );  F( speed, p->speed );
        F( low, p->low );  F( high, p->high );  F( crush, p->crush );
        F( tag, p->tag );  F( wait, p->wait );
        F( status, p->status );
        // count is read only while waiting, oldstatus only after a stop; the
        // makers (p_plats.c) leave them unset otherwise.
        if( p->status == PLATS_waiting )   F( count, p->count );
        if( p->status == PLATS_in_stasis ) F( oldstatus, p->oldstatus );
      }
      break;
     case TFI_LightFlash:
      {
        const lightflash_t * l = (const lightflash_t *) th;
        F( sector, sector_num( l->sector ) );
        F( min, l->minlight );  F( max, l->maxlight );
        F( mintime, l->mintime );  F( maxtime, l->maxtime );
        F( count, l->count );
      }
      break;
     case TFI_StrobeFlash:
      {
        const strobe_t * s = (const strobe_t *) th;
        F( sector, sector_num( s->sector ) );
        F( min, s->minlight );  F( max, s->maxlight );
        F( dark, s->darktime );  F( bright, s->brighttime );
        F( count, s->count );
      }
      break;
     case TFI_Glow:
      {
        const glow_t * g = (const glow_t *) th;
        F( sector, sector_num( g->sector ) );
        F( min, g->minlight );  F( max, g->maxlight );
        F( dir, g->direction );
      }
      break;
     case TFI_FireFlicker:
      {
        const fireflicker_t * f = (const fireflicker_t *) th;
        F( sector, sector_num( f->sector ) );
        F( min, f->minlight );  F( max, f->maxlight );
        F( count, f->count );
      }
      break;
     case TFI_LightFade:
      {
        const lightfader_t * l = (const lightfader_t *) th;
        F( sector, sector_num( l->sector ) );
        F( dest, l->destlight );  F( speed, l->speed );
      }
      break;
     case TFI_MoveElevator:
      {
        const elevator_t * e = (const elevator_t *) th;
        F( sector, sector_num( e->sector ) );
        F( type, e->type );  F( dir, e->direction );
        F( floordest, e->floordestheight );
        F( ceildest, e->ceilingdestheight );
        F( speed, e->speed );
      }
      break;
     default:
      // TFI_Scroll, TFI_Friction, TFI_Pusher: their structs are in
      // p_spec.c, not a header.  They hold no state that changes after
      // they are made, except the scroll offsets, which are in the sides
      // and sectors hashed in hash_world.
      break;
    }
    line_end();
}

// All thinkers, in list order.  Mobjs go into the "mobjs" hash, the sector
// effects into "specials".  Returns the mobjs hash.
static uint32_t hash_thinkers( uint32_t * special_hash )
{
    thinker_t * th;
    uint32_t mobjs_h;
    int ord;

    // pass 1: mobjs, so that the order inside each hash is the list order
    begin( 3 );
    for( th = thinkercap.next, ord = 0; th != &thinkercap; th = th->next )
    {
        if( ! live_thinker( th ) )  continue;
        if( mobj_function( th ) )
            hash_mobj( ord, (const mobj_t *) th );
        ord++;
    }
    mobjs_h = hv;

    begin( 5 );
    for( th = thinkercap.next, ord = 0; th != &thinkercap; th = th->next )
    {
        if( ! live_thinker( th ) )  continue;
        if( ! mobj_function( th ) )
            hash_effect( ord, th );
        ord++;
    }
    F( numthinkers, ord );
    line_end();
    {
        // buttons (switch timers)
        int i;
        for( i = 0; i < MAXBUTTONS; i++ )
        {
            if( buttonlist[i].btimer == 0 )  continue;
            line_begin( "button %d", i );
            F( line, line_num( buttonlist[i].line ) );
            F( where, buttonlist[i].where );
            F( texture, buttonlist[i].btexture );
            F( timer, buttonlist[i].btimer );
            line_end();
        }
    }
    *special_hash = hv;
    return mobjs_h;
}

static uint32_t hash_world( void )
{
    uint32_t i;

    begin( 4 );
    for( i = 0; i < numsectors; i++ )
    {
        const sector_t * s = &sectors[i];
        line_begin( "sector %d", (int) i );
        F( floor, s->floorheight );  F( ceiling, s->ceilingheight );
        F( floorpic, s->floorpic );  F( ceilingpic, s->ceilingpic );
        F( light, s->lightlevel );
        F( special, s->special );  F( tag, s->tag );
        F( floorx, s->floor_xoffs );  F( floory, s->floor_yoffs );
        F( ceilx, s->ceiling_xoffs );  F( ceily, s->ceiling_yoffs );
        F( stairlock, s->stairlock );
        F( prevsec, s->prevsec );  F( nextsec, s->nextsec );
        // soundtarget: read by A_Look, set by P_RecursiveSound. A savegame holds
        // it since F2 (bugs.md L30).
        F( soundtarget, ord_of( s->soundtarget ) );
        line_end();
    }
    for( i = 0; i < numlines; i++ )
    {
        const line_t * l = &lines[i];
        // ML_MAPPED is set by the renderer (r_segs.c:2750), for the
        // automap only: not game state, and it depends on what was drawn.
        line_begin( "line %d", (int) i );
        F( special, l->special );  F( tag, l->tag );
        F( flags, l->flags & ~ML_MAPPED );
        line_end();
    }
    for( i = 0; i < numsides; i++ )
    {
        const side_t * s = &sides[i];
        line_begin( "side %d", (int) i );
        F( xoff, s->textureoffset );  F( yoff, s->rowoffset );
        F( top, s->toptexture );  F( bottom, s->bottomtexture );
        F( mid, s->midtexture );
        line_end();
    }
    return hv;
}

// ---- the record ----

static void put_u32( byte * b, uint32_t v )
{
    b[0] = v & 0xFF;  b[1] = (v >> 8) & 0xFF;
    b[2] = (v >> 16) & 0xFF;  b[3] = (v >> 24) & 0xFF;
}

// ---- savegame hooks ----

#ifdef SG_EFFECT_SIZES
#define SG_LAYOUT()  (sg_portable ? ", portable" : "")
#else
// A build from before the portable layout, with this file copied in.
extern int sg_version;
#define SG_LAYOUT()  ""
#endif

#define MAX_TESTSAVE  64
static struct { tic_t tic; const char * file; int game_header; } testsave[MAX_TESTSAVE];
static int  num_testsave = 0;
static tic_t  testquit_tic = 0;
static const char *  testload_file = NULL;
static int  options_read = 0;
static int  census_on = 0;
#define MAX_TESTCMD  8
static struct { tic_t tic; const char * text; } testcmd[MAX_TESTCMD];
static int  num_testcmd = 0;
static tic_t  addbots_tic = 0;
static int  addbots_count = 0;

static void read_options( void )
{
    int i;

    options_read = 1;
    for( i = 1; i + 2 < myargc && num_testsave < MAX_TESTSAVE; i++ )
    {
        if( strcmp( myargv[i], "-testsave" ) != 0 )  continue;
        testsave[num_testsave].tic = (tic_t) atoi( myargv[i + 1] );
        testsave[num_testsave].file = myargv[i + 2];
        testsave[num_testsave].game_header =
            ( i + 3 < myargc && strcmp( myargv[i + 3], "game" ) == 0 );
        num_testsave++;
    }
    i = M_CheckParm( "-testquit" );
    if( i && M_IsNextParm() )  testquit_tic = (tic_t) atoi( M_GetNextParm() );
    i = M_CheckParm( "-testload" );
    if( i && M_IsNextParm() )  testload_file = M_GetNextParm();
    census_on = M_CheckParm( "-testcensus" );
    for( i = 1; i + 2 < myargc && num_testcmd < MAX_TESTCMD; i++ )
    {
        if( strcmp( myargv[i], "-testcmd" ) != 0 )  continue;
        testcmd[num_testcmd].tic = (tic_t) atoi( myargv[i + 1] );
        testcmd[num_testcmd].text = myargv[i + 2];
        num_testcmd++;
    }
    i = M_CheckParm( "-testaddbots" );
    if( i && i + 2 < myargc )
    {
        addbots_tic = (tic_t) atoi( myargv[i + 1] );
        addbots_count = atoi( myargv[i + 2] );
    }
}

// What the level holds that a savegame has records for: the number of each
// kind of thinker, and of sectors with a soundtarget.  Printed when a savegame
// is written and when it is loaded, to show what a save holds.
#define CENSUS_KINDS  21
static const char * const census_name[CENSUS_KINDS] =
{
    "mobj", "ceiling", "stopped-ceiling", "door", "floor", "plat", "stopped-plat",
    "flash", "strobe", "glow", "fireflicker", "lightfade", "elevator",
    "scroll", "friction", "pusher", "soundtarget", "bot", "bot-dest", "bot-path-node",
    "thinker-total"
};

static void take_census( int * c )
{
    const thinker_t * th;
    uint32_t i;

    memset( c, 0, CENSUS_KINDS * sizeof(int) );
    for( th = thinkercap.next; th != &thinkercap; th = th->next )
    {
        c[CENSUS_KINDS - 1]++;
        switch( th->function )
        {
         case TFI_MobjThinker:    c[0]++;  break;
         case TFI_MoveCeiling:    c[1]++;  break;
         case TFI_VerticalDoor:   c[3]++;  break;
         case TFI_MoveFloor:      c[4]++;  break;
         case TFI_PlatRaise:      c[5]++;  break;
         case TFI_LightFlash:     c[7]++;  break;
         case TFI_StrobeFlash:    c[8]++;  break;
         case TFI_Glow:           c[9]++;  break;
         case TFI_FireFlicker:    c[10]++;  break;
         case TFI_LightFade:      c[11]++;  break;
         case TFI_MoveElevator:   c[12]++;  break;
         case TFI_Scroll:         c[13]++;  break;
         case TFI_Friction:       c[14]++;  break;
         case TFI_Pusher:         c[15]++;  break;
         case TFI_NULL:
            if( in_active_ceilings( th ) )  c[2]++;
            else if( in_active_plats( th ) )  c[6]++;
            break;
         default:  break;
        }
    }
    for( i = 0; i < numsectors; i++ )
        if( sectors[i].soundtarget )  c[16]++;
    for( i = 0; i < MAXPLAYERS; i++ )
    {
        const bot_t * b = players[i].bot;
        const SearchNode_t * n;
        if( ! playeringame[i] || ! b )  continue;
        c[17]++;
        if( b->destNode )  c[18]++;
        for( n = b->path ? b->path->first : NULL; n; n = n->vnext )  c[19]++;
    }
}

static void print_census( const char * what )
{
    int c[CENSUS_KINDS], i;

    take_census( c );
    printf( "TEST: %s holds:", what );
    for( i = 0; i < CENSUS_KINDS - 1; i++ )
        printf( " %s %d", census_name[i], c[i] );
    printf( "\n" );
}

// -testcensus: every time a kind of thinker (or a soundtarget) reaches a number
// it has not had before in this run, print the census.  The last line has the
// most of each, which says which kinds a run never produces.
static int  census_max[CENSUS_KINDS];

static void census_tic( void )
{
    int c[CENSUS_KINDS], i, grew = 0;

    if( gamestate != GS_LEVEL )  return;
    take_census( c );
    for( i = 0; i < CENSUS_KINDS - 1; i++ )
    {
        if( c[i] > census_max[i] )  { census_max[i] = c[i];  grew = 1; }
    }
    if( grew )
    {
        printf( "TEST: census at gametic %u:", (unsigned) gametic );
        for( i = 0; i < CENSUS_KINDS - 1; i++ )
            printf( " %s %d", census_name[i], census_max[i] );
        printf( "\n" );
        fflush( stdout );
    }
}

// What the join sends (SV_Send_SaveGame), written to a file.
static void write_savegame( const char * name, int game_header )
{
    FILE * f;
    size_t length;

    P_Alloc_savebuffer( 1 );
    if( ! savebuffer )  I_Error( "-testsave: no memory" );
    print_census( "save" );
    if( game_header )
        P_Savegame_Write_header( "test", 0 );
    else
        P_Savegame_Write_header( NULL, 1 );
    P_Savegame_Save_game();
    length = P_Savegame_length();
    if( length >= SAVEBUF_OVERFLOW_LENGTH )  I_Error( "-testsave: buffer overrun" );
    f = fopen( name, "wb" );
    if( ! f || fwrite( savebuffer, 1, length, f ) != length || fclose( f ) != 0 )
        I_Error( "-testsave: cannot write %s", name );
    free( savebuffer );
    savebuffer = NULL;
    printf( "TEST: saved gametic %u (%u bytes) to %s\n", (unsigned) gametic,
            (unsigned) length, name );
    fflush( stdout );
}

// What CL_Load_Received_Savegame and G_DoLoadGame do, in a single-player game.
static void load_savegame( const char * name )
{
    savegame_info_t sginfo;
    char magic[16];
    int netgame_header = 0, in_demo;
    FILE * f = fopen( name, "rb" );

    if( ! f )  I_Error( "-testload: cannot read %s", name );
    if( fread( magic, 1, sizeof(magic), f ) == sizeof(magic) )
        netgame_header = ( memcmp( magic, "!!Legacy_netgame", sizeof(magic) ) == 0 );
    fclose( f );

    // Under -timedemo or -playdemo the game keeps the settings the demo made
    // (demo version, compatibility switches, changes to mobjinfo) and takes
    // over from the demo: a savegame taken inside a demo needs them, and
    // the loaded game then plays on with no input.
    in_demo = demoplayback;
    if( ! in_demo )
    {
        D_DisableDemo();
        SV_SpawnServer();
    }
    sginfo.msg[0] = 0;
    if( P_Savegame_Readfile( name ) < 0 )  I_Error( "-testload: cannot read %s", name );
    if( ! P_Savegame_Read_header( &sginfo, netgame_header ) )
        I_Error( "-testload: %s", sginfo.msg );
    if( ! in_demo )  G_setup_VERSION();
    paused = 0;
    automapactive = false;
    playerdeadview = false;
    P_Savegame_Load_game();
    if( P_Savegame_Closefile( 0 ) < 0 )  I_Error( "-testload: %s is corrupted", name );
    gameaction = ga_nothing;
    gamestate = GS_LEVEL;
    displayplayer = consoleplayer;
    displayplayer_ptr = consoleplayer_ptr;
    multiplayer = playeringame[1];
    if( setsizeneeded )  R_ExecuteSetViewSize();
    R_FillBackScreen();
    CON_ToggleOff();
    print_census( "load" );
    // No input, as fast as possible, nothing drawn.
    demoplayback = false;
    timingdemo = false;
    singletics = true;
    nodrawers = true;
    printf( "TEST: loaded %s (%s, version %d%s) at gametic %u\n", name,
            netgame_header ? "netgame header" : "game header", sg_version,
            SG_LAYOUT(), (unsigned) gametic );
    fflush( stdout );
}

#ifdef SG_EFFECT_SIZES
static void report_size( const char * name, int bytes, int roundtrip_ok )
{
    printf( "size %s %d roundtrip %s\n", name, bytes, roundtrip_ok ? "ok" : "FAIL" );
}
#endif

static void record_tic( void )
{
    uint32_t h[5], total;
    byte rec[28];
    int in_level, i;

    txt = ( state_file && gametic >= state_from && gametic <= state_to )
          ? state_file : NULL;
    if( txt )
        fprintf( txt, "tic %u gamestate=%d leveltime=%u map=%d episode=%d\n",
                 (unsigned) gametic, (int) gamestate, (unsigned) leveltime,
                 (int) gamemap, (int) gameepisode );

    in_level = ( gamestate == GS_LEVEL );
    if( in_level )  number_thinkers();

    h[0] = hash_random();
    h[1] = hash_players();
    if( in_level )
    {
        h[2] = hash_thinkers( &h[4] );
        h[3] = hash_world();
    }
    else
    {
        h[2] = h[3] = h[4] = 0;
    }

    begin( 6 );
    for( i = 0; i < 5; i++ )  hash_u32( h[i] );
    F( leveltime, leveltime );
    F( gamemap, gamemap );  F( gameepisode, gameepisode );
    F( gamestate, gamestate );
    // Not hashed: `paused`. It is an input to the next tic (set by a pause key or
    // by the server's network wait before that tic runs), so a record taken just
    // before a pause is set differs between machines that did or did not set it
    // yet (a joining client loads the savegame with the pause already on); what
    // it does shows in leveltime and the world.
    total = hv;
    if( txt )
    {
        fprintf( txt, "\n" );
        fflush( txt );
    }
    txt = NULL;

    put_u32( rec, (uint32_t) gametic );
    put_u32( rec + 4, total );
    for( i = 0; i < 5; i++ )  put_u32( rec + 8 + 4 * i, h[i] );
    fwrite( rec, 1, sizeof(rec), dump_file );
    fflush( dump_file );
}

void TestDump_Tic( void )
{
    int i;

    if( ! options_read )  read_options();
    if( testload_file )
    {
        const char * name = testload_file;
        testload_file = NULL;
        load_savegame( name );
    }

    for( i = 0; i < num_testcmd; i++ )
    {
        if( testcmd[i].tic == gametic )
        {
            COM_BufAddText( testcmd[i].text );
            COM_BufAddText( "\n" );
        }
    }
    if( addbots_count && gametic == addbots_tic && server )
    {
        // as the console does; the bots exist at the next tic
        for( i = 0; i < addbots_count; i++ )  Command_AddBot();
        addbots_count = 0;
    }
    if( testdump_active )
    {
        // How many bots are in the game, printed when it changes: the tests that add bots
        // check that they did (a test that lost its bots would pass as a game without).
        static int  last_bots = -1;
        int  nb = 0, k;
        for( k = 0; k < MAXPLAYERS; k++ )
            if( playeringame[k] && players[k].bot )  nb++;
        if( nb != last_bots && gamestate == GS_LEVEL )
        {
            last_bots = nb;
            printf( "TEST: bots in game: %d at gametic %u\n", nb, (unsigned) gametic );
            fflush( stdout );
        }
        record_tic();
    }
    if( census_on )
        census_tic();
    for( i = 0; i < num_testsave; i++ )
    {
        if( testsave[i].tic == gametic )
            write_savegame( testsave[i].file, testsave[i].game_header );
    }
    if( testquit_tic && gametic >= testquit_tic )
    {
#ifdef SG_BOT_STATE
        printf( "TEST: bot aim calls: %u, hash of the aim values %08x\n", bot_aim_calls,
                (unsigned) bot_aim_hash );
#ifdef BOT_AIM_COMPARE
        printf( "TEST: largest difference from libm atan: %d\n", bot_aim_maxdiff );
        fflush( stdout );
#endif
        fflush( stdout );
#endif
        I_Quit();
    }
}

void TestDump_Init( void )
{
    int p;

#ifdef SG_EFFECT_SIZES
    if( M_CheckParm( "-testsizes" ) )
    {
        P_Savegame_Effect_Sizes( report_size );
        fflush( stdout );
        I_Quit();
    }
#endif
    p = M_CheckParm( "-testdump" );
    if( ! p )  return;
    if( ! M_IsNextParm() )
    {
        I_SoftError( "-testdump needs a file name\n" );
        return;
    }
    {
        const char * name = M_GetNextParm();
        dump_file = fopen( name, "wb" );
        if( ! dump_file )
        {
            I_SoftError( "-testdump: cannot write %s\n", name );
            return;
        }
        testdump_active = 1;

        p = M_CheckParm( "-teststate" );
        if( p && M_IsNextParm() )
        {
            char path[MAX_WADPATH + 8];
            state_from = atoi( M_GetNextParm() );
            state_to = M_IsNextParm() ? atoi( M_GetNextParm() ) : state_from;
            snprintf( path, sizeof(path), "%s.state", name );
            state_file = fopen( path, "w" );
            if( ! state_file )
                I_SoftError( "-teststate: cannot write %s\n", path );
        }
    }
}

void TestDump_BotsAtLevelStart( void )
{
    int i, nb = 0, np = 0, nd = 0, ns = 0;
    const SearchNode_t * n;

    if( ! testdump_active )  return;
    for( i = 0; i < MAXPLAYERS; i++ )
    {
        const bot_t * b = players[i].bot;
        if( ! b )  continue;
        nb++;
        np += (b->bestSeenItem != NULL) + (b->bestItem != NULL) + (b->closestEnemy != NULL)
            + (b->closestMissile != NULL) + (b->closestUnseenEnemy != NULL)
            + (b->closestUnseenTeammate != NULL) + (b->lastMobj != NULL) + (b->teammate != NULL);
        nd += (b->destNode != NULL);
        for( n = b->path ? b->path->first : NULL; n; n = n->vnext )  ns++;
    }
    if( nb == 0 )  return;
    printf( "TEST: bots at level start: %d bots, %d pointers, %d destinations, %d path nodes\n",
            nb, np, nd, ns );
    fflush( stdout );
}

int TestDump_UnpauseDelay( unsigned int now )
{
    static int n = -1;
    static unsigned int until = 0;
    if( n < 0 )
    {
        int p = M_CheckParm( "-testunpausedelay" );
        n = ( p && M_IsNextParm() ) ? atoi( M_GetNextParm() ) : 0;
    }
    if( n <= 0 )  return 0;
    if( until == 0 )  until = now + n;
    if( now < until )  return 1;
    until = 0;
    return 0;
}
