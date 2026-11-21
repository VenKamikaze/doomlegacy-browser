// SPDX-License-Identifier: GPL-2.0-or-later
//
// Test-only per-tic game state hash, to compare machines record for record.
//
//   -testdump FILE        write one 28-byte record per game tic to FILE
//   -teststate FROM [TO]  with -testdump: also write FILE.state, the whole
//                         state as text (one line per object), for game tics
//                         FROM..TO (TO defaults to FROM)
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
// without -testdump TestDump_Tic is one test of a flag.
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

static int live_thinker( const thinker_t * th )
{
    return th->function != 0 && th->function != TFI_RemoveThinker;
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
        F( specialsector, pl->specialsector );
        F( skin, pl->skin );
        F( bot, pl->bot != NULL );
        for( j = 0; j < NUMPSPRITES; j++ )
        {
            F( ps_state, state_num( pl->psprites[j].state ) );
            F( ps_tics, pl->psprites[j].tics );
        }
        F( chicken, pl->chickenTics );
        F( flyheight, pl->flyheight );
        line_end();
    }
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
    F( tflags, mo->tflags );  F( eflags, mo->eflags );
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
    F( fn, th->function );
    switch( th->function )
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

void TestDump_Tic( void )
{
    uint32_t h[5], total;
    byte rec[28];
    int in_level, i;

    if( ! testdump_active )  return;

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
    F( paused, paused );
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

void TestDump_Init( void )
{
    int p = M_CheckParm( "-testdump" );

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
