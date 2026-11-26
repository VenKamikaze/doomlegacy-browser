// SPDX-License-Identifier: GPL-2.0-or-later
//-----------------------------------------------------------------------------
//
// DESCRIPTION:
//   Network driver on vnet (ext/vnet): the game's driver table (i_net.h,
//   d_net.c) filled in with a relay room, in place of the UDP driver of
//   i_tcp.c.  Selected by the command line option "-relay HOST:PORT", or by
//   I_VNet_Configure().  Without it nothing here runs.
//
//   This header does not include vnet.h: the rest of the game does not see
//   vnet's types.
//
//   The driver table, doomcom and the game's own reliability (acks, resends,
//   timeouts in d_net.c) are used unchanged on top; vnet carries unreliable,
//   unordered datagrams like UDP.  The room creator is the server (it is
//   10.0.0.1), joiners connect to "room-host".
//
//   Lifetime of the context (what a lobby needs to know):
//     - I_VNet_Configure() only records the relay and the room to join (or
//       none, to create one).  It does not install the driver: that is done
//       by I_Init_VNet_Network() at start-up, when -relay is on the command
//       line (it sets I_NetOpenSocket; D_Startup_NetGame limits the packet
//       length).  A game started without -relay stays on the UDP driver at
//       1450 bytes whatever I_VNet_Configure() is told; a lobby needs more
//       (brief 05: see doco/browser/code-facts.md, section 13).  It also
//       refuses URLs and resolves the host name, which the browser build
//       cannot (brief 04).
//     - The game opens the driver with I_NetOpenSocket() (a server when it
//       starts the game, a client at "connect"): that creates the vnet
//       context.  It does not block: the context connects and enters the
//       room by itself while the game calls I_NetGet()/I_NetSend() (every
//       frame, in every state), which pump it.  I_VNet_Poll() can be
//       called in addition.
//     - I_VNet_State() then goes IVN_CONNECTING -> IVN_READY or IVN_FAILED.
//       FAILED is final for that context.  A failure ends the network game
//       (see I_VNet_Poll); there is no reconnect.
//     - I_NetCloseSocket() (the game closing its connection) destroys the
//       context.  A FAILED state and its error text stay readable until the
//       next open.
//
//-----------------------------------------------------------------------------

#ifndef I_VNET_H
#define I_VNET_H

#include <stddef.h>
#include "doomtype.h"

typedef enum {
    IVN_OFF = 0,       // the vnet driver is not selected (UDP or no network)
    IVN_IDLE,          // selected, no context yet (the game has not opened the driver)
    IVN_CONNECTING,    // a context exists and is entering its room
    IVN_READY,         // in a room: room code and virtual address are valid
    IVN_FAILED         // the context failed or the relay ended the session; final
} ivn_state_t;

// True if vnet is the network driver of this run: -relay was given, or
// I_VNet_Configure() succeeded.  (Also true in a build without vnet, where
// the option is then refused with a message.)
boolean  I_VNet_Requested(void);

// Record the relay and the room: with -relay on the command line this is
// all that selects vnet (see the header comment for what a later call does
// not do).
//   relay : the relay's UDP address "HOST:PORT" (a host name is resolved here,
//           once, and may block for the length of a DNS lookup)
//   room  : the room code to join, or NULL or "" to create a room
// Returns true; else false with a one-line reason in err (may be NULL).
boolean  I_VNet_Configure(const char * relay, const char * room, char * err, size_t err_size);

// Called by I_Init_TCP_Network (i_tcp.c) when I_VNet_Requested(): reads
// -relay, -udpport, -clientport and -connect CODE, sets I_NetOpenSocket, and
// for -connect queues the "connect" command.  Bad arguments end the program
// with a message (I_Error).
void     I_Init_VNet_Network(void);

// Called by D_Startup_NetGame (d_net.c) after the packet length defaults are
// set: limits hardware_MAXPACKETLENGTH to what a vnet datagram carries.
void     I_VNet_Set_Packet_Length(void);

// Pump the context (vnet_poll), notice the room being entered or the session
// failing.  Called by I_NetGet, I_NetSend and I_NetMakeNode; safe to call
// any time and as often as wanted.  On the first FAILED state it reports the
// error and ends the network game (exit to the title screen, as
// "exitgame"; a dedicated server exits), once.
void     I_VNet_Poll(void);

ivn_state_t  I_VNet_State(void);

// The room code once READY ("ABC234"), else "".
const char * I_VNet_Room_Code(void);

// This machine's virtual address once READY ("10.0.0.1", the room creator;
// joiners get 10.0.0.2 and up), else "".
const char * I_VNet_Self_Address(void);

// The room's member limit (from the relay, default 8) once READY, else 0.
// The relay refuses a member beyond it with "the room is full"; the game's
// own sv_maxplayers (32 by default) is a limit on players, and the server
// refuses the join with a message.  Whichever is smaller applies first.
int      I_VNet_Max_Members(void);

// The last failure as text ("no room with that code", ...), "" if none.
// I_VNet_Error_Code() is vnet's VNET_E* code (negative), 0 if none.
const char * I_VNet_Error_Text(void);
int      I_VNet_Error_Code(void);

// "relay-udp" etc. once READY, else "".
const char * I_VNet_Transport(void);

// Latest round trip to the relay in ms, -1 if not known.
int      I_VNet_Relay_Rtt_Ms(void);

#endif
