#!/usr/bin/env python3
# SPDX-License-Identifier: GPL-2.0-or-later
"""Compare one record of a -testdump file with one record of another, ignoring the tic.

  dump-at.py A TIC_A B TIC_B     exit 0 if the six hashes are equal, 1 if not, 2 on bad input
  dump-at.py A TIC_A B first     TIC_B may be "first": the first record of B

Used to compare the state of a game at the tic it was saved (the saver's file) with the
state of the game that loaded the savegame, at its first record: the record the loaded game
writes before it has run a tic. The record is seven little-endian u32 (tic, total, random,
players, mobjs, world, specials, src/test_dump.c); the tic differs by design.
"""
import struct
import sys

NAMES = ("tic", "total", "random", "players", "mobjs", "world", "specials")
REC = 28


def load(path):
    data = open(path, "rb").read()
    if len(data) % REC:
        print(f"{path}: size {len(data)} is not a multiple of {REC}", file=sys.stderr)
        sys.exit(2)
    return [struct.unpack_from("<7I", data, i) for i in range(0, len(data), REC)]


def pick(recs, tic, path):
    if tic == "first":
        if not recs:
            print(f"{path}: no records")
            sys.exit(2)
        return recs[0]
    for r in recs:
        if r[0] == int(tic):
            return r
    print(f"{path}: no record for tic {tic}")
    sys.exit(2)


def main(argv):
    if len(argv) != 5:
        print(__doc__, file=sys.stderr)
        return 2
    ra = pick(load(argv[1]), argv[2], argv[1])
    rb = pick(load(argv[3]), argv[4], argv[3])
    diff = [NAMES[i] for i in range(1, 7) if ra[i] != rb[i]]
    if diff:
        print(f"records differ (tic {ra[0]} and tic {rb[0]}): " + ", ".join(diff))
        for i in range(1, 7):
            if ra[i] != rb[i]:
                print(f"  {NAMES[i]}: {ra[i]:08x} != {rb[i]:08x}")
        return 1
    print(f"identical (tic {ra[0]} and tic {rb[0]}): total {ra[1]:08x}")
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv))
