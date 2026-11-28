// SPDX-License-Identifier: GPL-2.0-or-later
//-----------------------------------------------------------------------------
//
// DESCRIPTION:
//   Network driver on vnet.  See i_vnet.h.
//
//   Fills the driver table of d_net.c (I_NetOpenSocket, I_NetGet,
//   I_NetSend, I_NetMakeNode, I_NetFreeNode, I_NetCloseSocket) the way
//   i_tcp.c does for UDP.  Node numbers map to vnet_addr; node 0 is this
//   machine.  Nothing here changes, reorders or drops a packet beyond what
//   vnet does: a datagram vnet refuses is reported, never swallowed.
//
//   The game's blocking loops (CL_ConnectToServer, the savegame download, the
//   wait for players, the level load) all reach I_NetGet() through
//   Net_Packet_Handler/HGetPacket, and every game frame does so through
//   TryRunTics, so the context is pumped in every state and the relay's
//   15 s silence limit is never approached.
//
// Without USE_VNET (no ext/vnet checked out, or the browser build for now)
// the file holds stubs that refuse -relay with a message.
//
//-----------------------------------------------------------------------------

#include <stdarg.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <strings.h>

#include "doomincl.h"
#include "i_vnet.h"
#include "i_net.h"
#include "i_tcp.h"
#include "i_system.h"
#include "d_net.h"
#include "d_clisrv.h"
#include "d_netcmd.h"
#include "d_netfil.h"
#include "m_argv.h"
#include "command.h"
#include "doomstat.h"
#include "i_web.h"

#ifndef USE_VNET

// ---------------------------------------------------------------------------
// A build without vnet.

boolean I_VNet_Requested(void)
{
    return M_CheckParm("-relay") != 0;
}

boolean I_VNet_Configure(const char * relay, const char * room, char * err, size_t err_size)
{
    (void) relay; (void) room;
    if( err && err_size )
        snprintf(err, err_size, "this build has no vnet support");
    return false;
}

void I_Init_VNet_Network(void)
{
    printf("vnet: -relay: this build has no vnet support\n");
    fflush(stdout);
    netgame = false;   // see vn_fatal_arg in the vnet build
    I_Error("-relay: this build has no vnet support");
}

void I_VNet_Set_Packet_Length(void) {}
void I_VNet_Poll(void) {}
ivn_state_t I_VNet_State(void) { return IVN_OFF; }
const char * I_VNet_Room_Code(void) { return ""; }
const char * I_VNet_Self_Address(void) { return ""; }
int  I_VNet_Max_Members(void) { return 0; }
const char * I_VNet_Error_Text(void) { return ""; }
int  I_VNet_Error_Code(void) { return 0; }
const char * I_VNet_Transport(void) { return ""; }
int  I_VNet_Relay_Rtt_Ms(void) { return -1; }

#else // USE_VNET

#include "vnet.h"

// The game's own command to end a network game: "exitgame".
extern void Command_ExitGame_f(void);

// How long a joiner waits for the room's host to answer anything before it
// gives up (the host may be loading a level: askinfo goes out every 2 s).
// Over UDP the same wait has no limit (the player presses Q).
#define HOST_ANSWER_LIMIT_MS  20000

// Datagrams held while the context is still entering its room (the first
// PT_ASKINFO goes out before the relay has answered).
#define PENDING_MAX  16

typedef struct {
    vnet_addr  to;
    uint16_t   len;
    byte       data[VNET_MAX_DATAGRAM];
} pending_t;

static boolean   selected = false;       // vnet is the driver
static char      relay_name[160];        // -relay as given
static char      relay_numeric[96];      // "ip:port", resolved once
static char      room_request[16];       // room to join; "" creates one
static boolean   args_done = false;
static uint16_t  client_port = 0;        // -clientport; 0: the server port

static vnet *    ctx = NULL;
static int       sock = -1;
static uint16_t  my_port = 0;
static ivn_state_t  state = IVN_OFF;
static boolean   was_ready = false;      // reached READY at least once
static boolean   joining = false;        // this context joins a room (a client)
static boolean   ending = false;         // the game is being ended: no more reporting
static boolean   opening = false;        // inside open_socket: a failure ends the game later
static boolean   end_pending = false;    // the context failed while opening
static uint64_t  open_time = 0;
static boolean   host_heard = false;     // a joiner got anything from a peer
static char      room_code[8] = "";
static char      self_text[24] = "";
static int       max_members = 0;
static int       relay_rtt = -1;
static char      transport[16] = "";
static int       error_code = 0;
static char      error_text[200] = "";

// Node mapping: like i_tcp.c, node 0 is self.
static vnet_addr nodeaddr[MAX_CON_NETNODE];
static boolean   nodeused[MAX_CON_NETNODE];

static pending_t pending[PENDING_MAX];
static int       pending_count = 0;

// Statistics for the audit of packet sizes.
static unsigned  max_send_len = 0;
static byte      max_send_type = 0;
static boolean   reported_oversize = false;
static boolean   reported_pending_full = false;


// ---------------------------------------------------------------------------
// Messages: stdout (flushed) and the console.

static void vn_say(const char * fmt, ...)
{
    char buf[400];
    va_list ap;

    va_start(ap, fmt);
    vsnprintf(buf, sizeof(buf), fmt, ap);
    va_end(ap);
    printf("%s\n", buf);
    fflush(stdout);
    GenPrintf(EMSG_hud, "%s\n", buf);
}

// A bad argument: say so on stdout and end the program.
static void vn_fatal_arg(const char * fmt, ...)
{
    char buf[400];
    va_list ap;

    va_start(ap, fmt);
    vsnprintf(buf, sizeof(buf), fmt, ap);
    va_end(ap);
    printf("vnet: %s\n", buf);
    fflush(stdout);
    // I_Error leaves a network game first (D_Quit_NetGame), which sends a
    // packet through netbuffer; that is not set yet this early in start-up
    // (upstream crashes the same way on "-server 1 -udpport").
    netgame = false;
    I_Error("vnet: %s", buf);
}

static void vn_log(void * user, int level, const char * msg)
{
    (void) user;
    // Errors, and the one information line that shows vnet itself took the
    // impairment from VNET_IMPAIR (tests/net/test-relay.sh looks for it: the
    // game's own echo of getenv proves nothing about vnet).
    if( level <= VNET_LOG_ERROR
        || ( level == VNET_LOG_INFO && strncmp(msg, "impairment from ", 16) == 0 ) )
    {
        printf("vnet: %s\n", msg);
        fflush(stdout);
    }
}


// ---------------------------------------------------------------------------
// Room codes: six symbols of ABCDEFGHJKLMNPQRSTUVWXYZ23456789, any case.

static boolean valid_room_code(const char * s)
{
    int i;
    if( strlen(s) != 6 )  return false;
    for( i=0; i<6; i++ )
    {
        char c = s[i];
        if( c >= 'a' && c <= 'z' )  c -= 32;
        if( ! ( (c >= 'A' && c <= 'Z' && c != 'I' && c != 'O') || (c >= '2' && c <= '9') ) )
            return false;
    }
    return true;
}

static void copy_upper(char * dst, size_t size, const char * src)
{
    size_t i;
    for( i=0; i+1<size && src[i]; i++ )
        dst[i] = (src[i] >= 'a' && src[i] <= 'z')? src[i] - 32 : src[i];
    dst[i] = '\0';
}


#ifdef __EMSCRIPTEN__
// The browser's -relay: "ws://" or "wss://" (any case), a host (letters, digits, '.', '-', or a [v6] literal),
// an optional ":PORT" (1 to 65535) and a path that starts with '/'; no spaces or control characters; and
// short enough for relay_name.  The message says what is wrong.
static boolean valid_relay_url(const char * url, char * err, size_t err_size)
{
    const char * p = url;
    const char * host;
    size_t n, hostlen;
    const char * syntax = "the relay's WebSocket URL, ws://HOST:PORT/vnet or wss://HOST/vnet";
    char why[160];

    why[0] = '\0';
    n = strlen(url);
    if( n >= sizeof(relay_name) )
        snprintf(why, sizeof(why), "it is %u characters long (at most %u)", (unsigned) n, (unsigned) sizeof(relay_name) - 1);
    else
    {
        size_t i;
        for( i=0; i<n; i++ )
            if( (unsigned char) url[i] <= ' ' || (unsigned char) url[i] >= 127 )
            {
                snprintf(why, sizeof(why), "it has a space or a control character");
                break;
            }
    }
    if( ! why[0] )
    {
        if( strncasecmp(p, "ws://", 5) == 0 )  p += 5;
        else if( strncasecmp(p, "wss://", 6) == 0 )  p += 6;
        else snprintf(why, sizeof(why), "it does not start with ws:// or wss://");
    }
    if( ! why[0] )
    {
        host = p;
        while( *p && *p != '/' && *p != ':' && *p != '[' )  p++;
        if( *host == '[' )
        {
            const char * close = strchr(host, ']');
            if( ! close )  snprintf(why, sizeof(why), "an address in [ ] is not closed");
            else  p = close + 1;
        }
        hostlen = (size_t) (p - host);
        if( ! why[0] && hostlen == 0 )  snprintf(why, sizeof(why), "it has no host name");
        if( ! why[0] && *p == ':' )
        {
            long port = 0;
            const char * q = ++p;
            while( *q >= '0' && *q <= '9' && port < 100000 )  port = port * 10 + (*q++ - '0');
            if( q == p || port < 1 || port > 65535 || (*q && *q != '/') )
                snprintf(why, sizeof(why), "the port is not a number from 1 to 65535");
            p = q;
        }
        if( ! why[0] && *p != '/' )
            snprintf(why, sizeof(why), "it has no path (the relay's is /vnet)");
    }
    if( why[0] )
    {
        if( err && err_size )
            snprintf(err, err_size, "-relay %.100s: %s; the browser takes %s", url, why, syntax);
        return false;
    }
    return true;
}

// The test-only knobs (the page sets them in the environment only on a ?test=1 page): the WebTransport
// address, the SHA-256 of the relay's development certificate, and VNET_IMPAIR.  A bad value is refused
// with a message, never cut.
static void check_page_knobs(void)
{
    const char * wt = getenv("DL_RELAY_WT");
    const char * cert = getenv("DL_RELAY_CERT");
    const char * imp = getenv("VNET_IMPAIR");
    vnet_impair parsed;
    size_t i;

    if( wt && wt[0] )
    {
        if( strlen(wt) > 190 || strncasecmp(wt, "https://", 8) != 0 || wt[8] == '\0' )
            vn_fatal_arg("the WebTransport address must be https://HOST:PORT/vnet (at most 190 characters)");
        for( i=0; wt[i]; i++ )
            if( (unsigned char) wt[i] <= ' ' || (unsigned char) wt[i] >= 127 )
                vn_fatal_arg("the WebTransport address has a space or a control character");
    }
    if( cert && cert[0] )
    {
        if( strlen(cert) != 64 )
            vn_fatal_arg("the relay certificate hash must be 64 hex digits, it is %u characters", (unsigned) strlen(cert));
        for( i=0; i<64; i++ )
            if( ! ( (cert[i] >= '0' && cert[i] <= '9') || (cert[i] >= 'a' && cert[i] <= 'f') || (cert[i] >= 'A' && cert[i] <= 'F') ) )
                vn_fatal_arg("the relay certificate hash must be 64 hex digits");
    }
    if( imp && imp[0] )
    {
        if( strlen(imp) > 120 )
            vn_fatal_arg("the impairment spec is %u characters long (at most 120)", (unsigned) strlen(imp));
        if( vnet_impair_parse(imp, &parsed) != 0 )
            vn_fatal_arg("the impairment spec \"%s\" is not valid (for example lat=30,jit=10,loss=3,dup=2,reorder=3,seed=7)", imp);
    }
}
#endif

// ---------------------------------------------------------------------------
// Selecting the driver.

boolean I_VNet_Requested(void)
{
    return selected || M_CheckParm("-relay") != 0;
}

boolean I_VNet_Configure(const char * relay, const char * room, char * err, size_t err_size)
{
    vnet_addr a;
    int rc;
    char tmp[96];

#ifdef __EMSCRIPTEN__
    // The browser: the relay is its WebSocket URL, ws://HOST[:PORT]/PATH or wss://HOST[:PORT]/PATH.  There is no
    // resolver; vnet derives the WebTransport address of a wss:// URL by itself.
    if( ! relay || ! relay[0] )
    {
        if( err && err_size )  snprintf(err, err_size, "-relay needs the relay's WebSocket URL (ws://HOST:PORT/vnet or wss://HOST/vnet)");
        return false;
    }
    if( ! valid_relay_url(relay, err, err_size) )
        return false;
    if( room && room[0] && ! valid_room_code(room) )
    {
        if( err && err_size )
            snprintf(err, err_size, "'%s' is not a room code (six letters and digits, such as ABC234)", room);
        return false;
    }
    (void) a; (void) rc; (void) tmp;
    if( relay != relay_name )
        snprintf(relay_name, sizeof(relay_name), "%s", relay);
    snprintf(relay_numeric, sizeof(relay_numeric), "%s", relay);
    room_request[0] = '\0';
    if( room && room[0] )
        copy_upper(room_request, sizeof(room_request), room);
    selected = true;
    if( state == IVN_OFF )  state = IVN_IDLE;
    return true;
#else
    if( ! relay || ! relay[0] )
    {
        if( err && err_size )  snprintf(err, err_size, "-relay needs HOST:PORT (the relay's UDP address)");
        return false;
    }
    if( strstr(relay, "://") )
    {
        if( err && err_size )
            snprintf(err, err_size, "-relay %s: a URL is for the browser build; natively give the relay's UDP address HOST:PORT", relay);
        return false;
    }
    if( room && room[0] && ! valid_room_code(room) )
    {
        if( err && err_size )
            snprintf(err, err_size, "'%s' is not a room code (six letters and digits, such as ABC234)", room);
        return false;
    }
    rc = vnet_resolve_host(relay, VNET_FAMILY_ANY, &a);
    if( rc == VNET_EINVAL )
    {
        if( err && err_size )  snprintf(err, err_size, "-relay %s: expected HOST:PORT", relay);
        return false;
    }
    if( rc < 0 )
    {
        if( err && err_size )
            snprintf(err, err_size, "cannot resolve relay host '%s' (%s)", relay, vnet_strerror(rc));
        return false;
    }
    if( vnet_addr_to_string(&a, tmp, sizeof(tmp)) < 0 )
    {
        if( err && err_size )  snprintf(err, err_size, "-relay %s: bad address", relay);
        return false;
    }
    if( relay != relay_name )
        snprintf(relay_name, sizeof(relay_name), "%s", relay);
    snprintf(relay_numeric, sizeof(relay_numeric), "%s", tmp);
    room_request[0] = '\0';
    if( room && room[0] )
        copy_upper(room_request, sizeof(room_request), room);
    selected = true;
    if( state == IVN_OFF )  state = IVN_IDLE;
    return true;
#endif
}

// ---------------------------------------------------------------------------
// The context.

static void vn_reset_nodes(void)
{
    memset(nodeaddr, 0, sizeof(nodeaddr));
    memset(nodeused, 0, sizeof(nodeused));
    nodeused[0] = true;        // always connected to self
    pending_count = 0;
}

// Net node of a vnet address, or 255 when it has none.
static byte vn_find_node(const vnet_addr * a)
{
    int n;
    for( n=0; n<MAXNETNODES; n++ )
    {
        if( nodeused[n] && vnet_addr_equal(&nodeaddr[n], a) )
            return n;
    }
    return 255;
}

// Like i_tcp.c: only this range is dynamically allocated.
static byte vn_get_freenode(void)
{
    byte n;
    for( n=1; n<MAXNETNODES; n++ )
    {
        if( ! nodeused[n] )
            return n;
    }
    return 255;
}

static boolean is_player_address(const vnet_addr * a)
{
    // 10.0.0.1 .. 10.0.0.253.  10.0.0.254 and .255 are never a player.
    return a->family == VNET_AF_IPV4
        && a->bytes[0] == 10 && a->bytes[1] == 0 && a->bytes[2] == 0
        && a->bytes[3] >= 1 && a->bytes[3] <= 253;
}

static void vn_discard_context(void)
{
    if( ctx )
    {
        vnet_destroy(ctx);   // a relay context leaves its room
        ctx = NULL;
    }
    sock = -1;
}

// How long the game goes without calling the driver (what the relay's keepalive and silence limits need to
// be compared with): the longest gap between two polls and how many were over 100 ms, 1 s and 5 s.
static uint64_t  last_poll_ms = 0;
static unsigned  max_gap_ms = 0;
static int       max_gap_from = -1, max_gap_to = -1;
static unsigned  gaps_100 = 0, gaps_1000 = 0, gaps_5000 = 0;
static int       last_poll_gamestate = -1;

static void note_poll_gap(void)
{
    uint64_t now = vnet_time(ctx);

    if( last_poll_ms && now >= last_poll_ms )
    {
        unsigned gap = (unsigned) (now - last_poll_ms);
        if( gap >= 100 )   gaps_100++;
        if( gap >= 1000 )  gaps_1000++;
        if( gap >= 5000 )  gaps_5000++;
        if( gap > max_gap_ms )
        {
            max_gap_ms = gap;
            max_gap_from = last_poll_gamestate;
            max_gap_to = (int) gamestate;
        }
    }
    last_poll_ms = now;
    last_poll_gamestate = (int) gamestate;
}

static void vn_print_stats(void)
{
    vnet_stats s;
    if( ! ctx )  return;
    vnet_get_stats(ctx, &s);
    printf("vnet: closed (%s, room %s): sent %llu datagrams (impairment lost %llu, duplicated %llu, reordered %llu; "
           "refused by the backend %llu), received %llu; largest datagram sent %u bytes (packet type %d)\n",
           transport[0]? transport : "relay-udp", room_code[0]? room_code : "-",
           (unsigned long long) s.tx_datagrams, (unsigned long long) s.impair_lost,
           (unsigned long long) s.impair_duplicated, (unsigned long long) s.impair_reordered,
           (unsigned long long) s.tx_dropped, (unsigned long long) s.rx_datagrams,
           max_send_len, (int) max_send_type);
    printf("vnet: polls: longest gap %u ms (game state %d to %d); %u gaps of 100 ms or more, %u of 1 s, %u of 5 s\n",
           max_gap_ms, max_gap_from, max_gap_to, gaps_100, gaps_1000, gaps_5000);
    fflush(stdout);
    last_poll_ms = 0;  max_gap_ms = 0;  max_gap_from = max_gap_to = -1;
    gaps_100 = gaps_1000 = gaps_5000 = 0;
}

// I_NetCloseSocket
static void vn_close(void)
{
    if( ctx )
    {
        vn_print_stats();
        vn_discard_context();
    }
    vn_reset_nodes();
    room_code[0] = '\0';
    self_text[0] = '\0';
    transport[0] = '\0';
    max_members = 0;
    relay_rtt = -1;
    if( state != IVN_FAILED )
    {
        state = selected? IVN_IDLE : IVN_OFF;
        I_Web_NetStatus(NETSTAT_NONE, "");
    }
}

static void vn_shutdown(void)
{
    vn_discard_context();
}


// ---------------------------------------------------------------------------
// Ending the network game on a failure.

static void vn_end_game(void)
{
    int n;
    boolean was_netgame = netgame;

    if( ending )  return;
    ending = true;

    if( was_netgame )
    {
        // Nothing can be acknowledged any more.  Close the game's connections
        // now, before anything is sent: D_Quit_NetGame (reached from
        // "exitgame" and from I_Error) sends a reliable PT_CLIENTQUIT or
        // PT_SERVERSHUTDOWN, which HSendPacket saves for an ack before
        // I_NetSend fails, and D_CloseConnection then waits 5 s for it.
        // With the connections closed, and netgame false, that send never
        // happens and nothing waits.  This also closes the driver.
        Close_NetFile();
        for( n=1; n<MAXNETNODES; n++ )
            Net_CloseConnection(n, 1);
        D_CloseConnection();
        D_Quit_NetGame_Closed();   // what D_Quit_NetGame leaves: CL_ConnectToServer must see it
    }

    if( dedicated )
    {
        // A dedicated server without its room has nothing left to do.
        printf("vnet: a dedicated server cannot run without its room: exiting\n");
        fflush(stdout);
        I_Error("vnet: %s", error_text);   // does not return
    }

    if( was_netgame )
    {
        vn_say("vnet: ending the network game");
        // The rest of the game's way out: "exitgame" (CL_Reset, D_StartTitle;
        // its D_Quit_NetGame has nothing left to do, D_Quit_NetGame_Closed did its state).
        Command_ExitGame_f();
    }
    else
        vn_close();   // the driver was opened but no game started
}

static void vn_failed(int code, const char * text, boolean host_silent)
{
    const char * hint = "";

    if( code == VNET_ETIMEDOUT && ! host_silent )
        hint = was_ready? ": the relay went silent"
                        : ": the relay did not answer (is its UDP address right, and is it running?)";
    state = IVN_FAILED;
    error_code = code;
    snprintf(error_text, sizeof(error_text), "%s%s", text, hint);
    pending_count = 0;

    {
        char msg[640];   // error_text 200, relay_name 160, the room, the words
        if( host_silent )
            snprintf(msg, sizeof(msg), "vnet: cannot join room %s: %s", room_code, error_text);
        else
        if( ! was_ready )
        {
            if( joining )
                snprintf(msg, sizeof(msg), "vnet: cannot join room %s on relay %s: %s", room_request, relay_name, error_text);
            else
                snprintf(msg, sizeof(msg), "vnet: cannot create a room on relay %s: %s", relay_name, error_text);
        }
        else
            snprintf(msg, sizeof(msg), "vnet: the relay session ended: %s (relay %s, room %s)", error_text, relay_name, room_code);
        vn_say("%s", msg);
        // The page shows it (a failure ends the network game and the game goes on at the title screen)
        I_Web_NetStatus(NETSTAT_ENDED, msg + 6);   // without "vnet: "
    }

    if( opening )
        end_pending = true;   // not inside the caller's start-up: at the next call
    else
        vn_end_game();
}

static byte vn_sendto_node(const vnet_addr * to, const void * buf, unsigned len);

static void vn_became_ready(const vnet_status_info * st)
{
    char * colon;
    int i;

    state = IVN_READY;
    was_ready = true;
    snprintf(room_code, sizeof(room_code), "%s", st->room);
    snprintf(transport, sizeof(transport), "%s", st->transport? st->transport : "");
    max_members = st->max_members;
    vnet_addr_to_string(&st->self, self_text, sizeof(self_text));
    colon = strchr(self_text, ':');
    if( colon )  *colon = '\0';
    if( vnet_local_addr(ctx, sock, &nodeaddr[0]) < 0 )
        nodeaddr[0] = st->self;
    nodeused[0] = true;
    open_time = vnet_time(ctx);

    if( joining )
        vn_say("vnet: joined room %s (you are %s; the room takes %d players)", room_code, self_text, max_members);
    else
        vn_say("vnet: room code %s (you are %s; the room takes %d players)", room_code, self_text, max_members);
    // Which transport vnet chose (relay-udp natively; relay-wt or relay-ws in the browser): the tests read it.
    vn_say("vnet: transport %s", transport);
    {
        char note[160];
        snprintf(note, sizeof(note), "%s room %s (%s)", joining? "In" : "Hosting", room_code,
                 strcmp(transport, "relay-wt") == 0? "WebTransport" : strcmp(transport, "relay-ws") == 0? "WebSocket" : transport);
        I_Web_NetStatus(NETSTAT_READY, note);
    }

    // What the game sent while the room was being entered, in order.
    for( i=0; i<pending_count; i++ )
        vn_sendto_node(&pending[i].to, pending[i].data, pending[i].len);
    pending_count = 0;
}

// Pump the context and look at its state.  Called by every driver function.
void I_VNet_Poll(void)
{
    vnet_status_info st;
    int s;

    if( end_pending && ! opening )
    {
        end_pending = false;
        vn_end_game();
        return;
    }
    if( ! ctx || ending )  return;

    note_poll_gap();
    vnet_poll(ctx);
    s = vnet_status(ctx, &st);
    relay_rtt = st.relay_rtt_ms;

    if( s == VNET_STATUS_FAILED )
    {
        if( state != IVN_FAILED )
            vn_failed(st.error, vnet_strerror(st.error), false);
        return;
    }
    if( s == VNET_STATUS_READY && state == IVN_CONNECTING )
        vn_became_ready(&st);

    if( state == IVN_READY && joining && ! host_heard
        && (vnet_time(ctx) - open_time) > HOST_ANSWER_LIMIT_MS )
    {
        vn_failed(VNET_ETIMEDOUT,
                  "the host did not answer within 20 s (is the room code right, and is the host running a game?)", true);
    }
}


// ---------------------------------------------------------------------------
// The driver table.

// I_NetSend helper: one datagram to an address.  Returns a network_error_e.
static byte vn_sendto_node(const vnet_addr * to, const void * buf, unsigned len)
{
    int rc = vnet_sendto(ctx, sock, buf, len, to);

    if( rc >= 0 )
        return NE_success;
    switch( rc )
    {
     case VNET_EAGAIN:    // the backend was full, or a transient OS error:
     case VNET_EIO:       // a dropped datagram; the game's resends cover it
        return NE_refused_again;
     case VNET_EMSGSIZE:
        if( ! reported_oversize )
        {
            reported_oversize = true;
            vn_say("vnet: a packet of %u bytes (type %d) does not fit in a vnet datagram (%d bytes)",
                   len, (int) netbuffer->packettype, VNET_MAX_DATAGRAM);
        }
        return NE_fail;
     case VNET_ENOTCONN:
        return NE_network_unreachable;
     default:
        return NE_fail;
    }
}

// Function for I_NetSend().
// Send doomcom->datalength bytes of doomcom->data to node doomcom->remotenode.
static byte vn_send(void)
{
    int nnode = doomcom->remotenode;
    unsigned len = doomcom->datalength;

    I_VNet_Poll();
    if( ! ctx || state == IVN_FAILED || state == IVN_IDLE )
    {
        net_error = NE_network_unreachable;
        return net_error;
    }
    if( nnode < 0 || nnode >= MAX_CON_NETNODE || ! nodeused[nnode] )
    {
        net_error = NE_node_unconnected;
        return net_error;
    }

    if( len > max_send_len )
    {
        max_send_len = len;
        max_send_type = netbuffer->packettype;
    }

    if( state == IVN_CONNECTING )
    {
        // Still entering the room: hold the datagram, in order, and send it
        // when the room has been entered (the first PT_ASKINFO of a joiner
        // goes out before the relay has answered).
        if( len > VNET_MAX_DATAGRAM )
        {
            net_error = vn_sendto_node(&nodeaddr[nnode], doomcom->data, len);   // reports it
            return net_error;
        }
        if( pending_count == PENDING_MAX )
        {
            if( ! reported_pending_full )
            {
                reported_pending_full = true;
                vn_say("vnet: %d datagrams are waiting for the room: the oldest is dropped (the game resends)",
                       PENDING_MAX);
            }
            memmove(&pending[0], &pending[1], sizeof(pending[0]) * (PENDING_MAX - 1));
            pending_count--;
        }
        pending[pending_count].to = nodeaddr[nnode];
        pending[pending_count].len = len;
        memcpy(pending[pending_count].data, doomcom->data, len);
        pending_count++;
        return NE_success;
    }

    net_error = vn_sendto_node(&nodeaddr[nnode], doomcom->data, len);
    return net_error;
}

// Function for I_NetGet().
// Fill doomcom with the next datagram; return NE_success, or NE_empty with
// doomcom->remotenode = -1.
static byte vn_get(void)
{
    vnet_addr from;
    int n, tries;
    byte nnode;

    I_VNet_Poll();
    doomcom->remotenode = -1;
    if( ! ctx || state != IVN_READY )
    {
        net_error = NE_empty;
        return net_error;
    }

    for( tries=0; tries<64; tries++ )
    {
        n = vnet_recvfrom(ctx, sock, doomcom->data, sizeof(doomcom->data), &from);
        if( n == VNET_EAGAIN || n == VNET_EIO || n == VNET_EBADF )
            break;               // nothing more now
        if( n < 0 )
            continue;            // too large for the buffer: consumed

        // 10.0.0.254 and .255 are never a player.
        if( ! is_player_address(&from) )
            continue;

        nnode = vn_find_node(&from);
        if( nnode == 255 )
        {
            // A packet from an unknown address gets a new node, as with UDP.
            nnode = vn_get_freenode();
            if( nnode >= MAXNETNODES )
            {
                net_error = NE_nodes_exhausted;
                return net_error;
            }
            nodeaddr[nnode] = from;
            nodeused[nnode] = true;
        }
        if( nnode != 0 )
            host_heard = true;
        doomcom->remotenode = nnode;
        doomcom->datalength = n;
        return NE_success;
    }
    net_error = NE_empty;
    return net_error;
}

// Function for I_NetFreeNode().
static void vn_free_node(byte nnode)
{
    // Node 0 is self and is never freed; above MAXNETNODES are the fixed nodes.
    if( nnode == 0 || nnode >= MAXNETNODES )
        return;
    nodeused[nnode] = false;
    memset(&nodeaddr[nnode], 0, sizeof(nodeaddr[nnode]));
}

// Function for I_NetMakeNode().
// The address of a room member: "room-host" (the server, 10.0.0.1), or
// "10.0.0.N", each with an optional ":PORT" (default: the server port).
// Return the node number, or NE_fail (> MAXNETNODES).
static byte vn_make_node(char * hostname)
{
    char buf[80];
    vnet_addr a;
    byte nnode;
    const char * p = hostname;
    size_t n;

    I_VNet_Poll();
    if( ! ctx || state == IVN_FAILED )
        return NE_fail;

    while( *p == ' ' )  p++;
    n = strlen(p);
    while( n > 0 && (p[n-1] == ' ' || p[n-1] == ':') )  n--;
    if( n == 0 || n >= sizeof(buf) - 8 )
        goto bad_address;
    memcpy(buf, p, n);
    buf[n] = '\0';
    if( ! strchr(buf, ':') )
        snprintf(buf + n, sizeof(buf) - n, ":%d", (int) server_sock_port);

    if( vnet_resolve(ctx, buf, &a) < 0 || ! is_player_address(&a) || a.port == 0 )
        goto bad_address;

    nnode = vn_find_node(&a);
    if( nnode != 255 )
        return nnode;
    nnode = vn_get_freenode();
    if( nnode >= MAXNETNODES )
        return NE_nodes_exhausted;
    nodeaddr[nnode] = a;
    nodeused[nnode] = true;
    return nnode;

bad_address:
    vn_say("vnet: '%s' is not an address in a room (use room-host or 10.0.0.N)", hostname);
    return NE_fail;
}

// Function for I_NetOpenSocket().
// Creates the vnet context: a server creates a room, a client joins the room
// it was given.  Does not wait for the room: see I_VNet_Poll.
static boolean open_socket(void)
{
    vnet_config cfg;
    int err = 0;
    uint16_t port;
    const char * impair;

    I_NetSend        = vn_send;
    I_NetGet         = vn_get;
    I_NetCloseSocket = vn_close;
    I_NetFreeNode    = vn_free_node;
    I_NetMakeNode    = vn_make_node;
    I_NetCanSend     = NULL;      // vnet_sendto never blocks; a refused datagram is a drop

    if( ctx && state != IVN_FAILED )
        return true;              // already open
    vn_discard_context();
    vn_reset_nodes();
    ending = false;           // never stale: a failure of this context must end this game
    end_pending = false;

    if( ! relay_numeric[0] )
    {
        vn_say("vnet: no relay selected");
        return false;
    }
    joining = ! server;
    if( joining && ! room_request[0] )
    {
        vn_say("vnet: no room to join: give -connect CODE");
        return false;
    }

    vnet_config_init(&cfg);
    cfg.backend = VNET_BACKEND_RELAY_AUTO;
#ifdef __EMSCRIPTEN__
    // The page's relay is the WebSocket URL; WebTransport is derived from a wss:// one.  On a test page
    // the environment can name the WebTransport address and the certificate hash of a development relay.
    cfg.relay = relay_numeric;
    {
        const char * wt = getenv("DL_RELAY_WT");
        const char * cert = getenv("DL_RELAY_CERT");
        if( wt && wt[0] )  cfg.relay_wt = wt;
        if( cert && cert[0] )  cfg.relay_cert_sha256 = cert;
    }
#else
    cfg.relay_udp = relay_numeric;
#endif
    cfg.room = joining? room_request : NULL;
    cfg.rx_queue_len = 512;       // a long frame (a level load) must not drop datagrams
    cfg.log = vn_log;

    ctx = vnet_create(&cfg, &err);
    if( ! ctx )
    {
        snprintf(error_text, sizeof(error_text), "%s", vnet_strerror(err));
        error_code = err;
        state = IVN_FAILED;
        vn_say("vnet: cannot start the vnet context for relay %s: %s", relay_name, error_text);
        return false;
    }
    port = joining? ( client_port? client_port : server_sock_port ) : server_sock_port;
    sock = vnet_open(ctx, port);
    if( sock < 0 )
    {
        snprintf(error_text, sizeof(error_text), "cannot open port %d: %s", (int) port, vnet_strerror(sock));
        error_code = sock;
        vn_discard_context();
        state = IVN_FAILED;
        vn_say("vnet: %s", error_text);
        return false;
    }
    my_port = port;

    state = IVN_CONNECTING;
    I_Web_NetStatus(NETSTAT_CONNECTING, joining? "Joining a room on the relay..." : "Creating a room on the relay...");
    was_ready = false;
    host_heard = false;
    reported_oversize = false;
    reported_pending_full = false;
    error_code = 0;
    error_text[0] = '\0';
    open_time = vnet_time(ctx);

    impair = getenv("VNET_IMPAIR");
    vn_say("vnet: %s through relay %s (vnet %s, port %d)%s%s",
           joining? "joining a room" : "creating a room", relay_name, vnet_version(), (int) port,
           (impair && impair[0])? ", impairment " : "", (impair && impair[0])? impair : "");

    net_packetheader_length = 28;   // ip + udp, for the statistics
    doomcom->extratics = 1;         // as the UDP driver: the internet is very high ping

    opening = true;
    I_VNet_Poll();
    opening = false;
    return true;
}


// ---------------------------------------------------------------------------
// Arguments.

void I_Init_VNet_Network(void)
{
    char err[200];
    const char * code = "";
    const char * relay = NULL;
    boolean want_connect;

    if( args_done )  return;   // once
    args_done = true;

    if( M_CheckParm("-udpport") )
    {
        if( ! M_IsNextParm() )
            vn_fatal_arg("syntax : -udpport <portnum>");
        server_sock_port = atoi(M_GetNextParm());
    }
    if( M_CheckParm("-clientport") )
    {
        if( ! M_IsNextParm() )
            vn_fatal_arg("syntax : -clientport <portnum>");
        client_port = atoi(M_GetNextParm());
    }

    // -connect CODE: join that room and connect to its server.
    want_connect = ( M_CheckParm("-connect") != 0 && ! netgame );
    if( want_connect )
    {
        if( ! M_IsNextParm() )
            vn_fatal_arg("-connect needs a room code with -relay: -relay HOST:PORT -connect CODE "
                         "(searching the LAN for a server is not possible through a relay)");
        code = M_GetNextParm();
        if( ! valid_room_code(code) )
            vn_fatal_arg("'%s' is not a room code (six letters and digits, such as ABC234)", code);
    }

    if( M_CheckParm("-relay") )
    {
#ifdef __EMSCRIPTEN__
        // Only a page that has a relay (config.js, or ?relay= on a test page) offers a network game: the page
        // says so with DL_RELAY and passes the relay itself.
        {
            const char * offered = getenv("DL_RELAY");
            if( ! offered || ! offered[0] )
                vn_fatal_arg("-relay: this page has no relay configured (the \"relay\" entry of config.js), so it offers no network game");
        }
        check_page_knobs();
        if( ! M_IsNextParm() )
            vn_fatal_arg("-relay needs the relay's WebSocket URL (ws://HOST:PORT/vnet or wss://HOST/vnet)");
#else
        if( ! M_IsNextParm() )
            vn_fatal_arg("-relay needs HOST:PORT (the relay's UDP address)");
#endif
        relay = M_GetNextParm();
        if( ! I_VNet_Configure(relay, code, err, sizeof(err)) )
            vn_fatal_arg("%s", err);
    }
    else if( want_connect )
    {
        // selected by I_VNet_Configure() before: the relay is set, the room is the -connect one
        if( ! I_VNet_Configure(relay_name, code, err, sizeof(err)) )
            vn_fatal_arg("%s", err);
    }

    I_NetOpenSocket = open_socket;
    I_AddExitFunc(vn_shutdown);

    if( want_connect )
        COM_BufAddText("connect \"room-host\"\n");
    else if( ! netgame )
        vn_say("vnet: relay %s selected; use -server, -dedicated or -connect CODE to play", relay_name);
}

// Called by D_Startup_NetGame once the packet length defaults are set.
void I_VNet_Set_Packet_Length(void)
{
    if( ! selected )  return;
    if( hardware_MAXPACKETLENGTH > VNET_MAX_DATAGRAM )
        hardware_MAXPACKETLENGTH = VNET_MAX_DATAGRAM;
}


// ---------------------------------------------------------------------------
// For the lobby and the menus.

ivn_state_t  I_VNet_State(void)           { return state; }
const char * I_VNet_Room_Code(void)       { return room_code; }
const char * I_VNet_Self_Address(void)    { return self_text; }
int          I_VNet_Max_Members(void)     { return max_members; }
const char * I_VNet_Error_Text(void)      { return error_text; }
int          I_VNet_Error_Code(void)      { return error_code; }
const char * I_VNet_Transport(void)       { return transport; }
int          I_VNet_Relay_Rtt_Ms(void)    { return relay_rtt; }

#endif // USE_VNET
