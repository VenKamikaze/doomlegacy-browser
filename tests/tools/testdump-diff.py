#!/usr/bin/env python3
# SPDX-License-Identifier: GPL-2.0-or-later
"""Compare two -testdump files record for record.

  testdump-diff.py A B [--common]   exit 0 if equal, 1 if not, 2 on bad input
  testdump-diff.py --info A         print the record count and the last tic

The record is seven little-endian u32: tic, total, random, players, mobjs,
world, specials (src/test_dump.c). Without --common the files must have the same
number of records. With --common only the tics both have are compared (used for
a client that joined late: its file starts at the join tic).
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


def main(argv):
    if len(argv) == 3 and argv[1] == "--info":
        r = load(argv[2])
        print(f"{len(r)} records" + (f", tics {r[0][0]}..{r[-1][0]}" if r else ""))
        return 0
    common = "--common" in argv
    args = [a for a in argv[1:] if a != "--common"]
    if len(args) != 2:
        print(__doc__, file=sys.stderr)
        return 2
    a, b = load(args[0]), load(args[1])
    if common:
        ta = {r[0]: r for r in a}
        tb = {r[0]: r for r in b}
        tics = sorted(set(ta) & set(tb))
        pairs = [(ta[t], tb[t]) for t in tics]
        if not pairs:
            print("no tics in common")
            return 1
    else:
        pairs = list(zip(a, b))
    for ra, rb in pairs:
        if ra != rb:
            diff = [NAMES[i] for i in range(7) if ra[i] != rb[i]]
            print(f"first difference at tic {ra[0]} (other file: tic {rb[0]}): " + ", ".join(diff))
            for i in range(7):
                if ra[i] != rb[i]:
                    print(f"  {NAMES[i]}: {ra[i]:08x} != {rb[i]:08x}")
            return 1
    if not common and len(a) != len(b):
        print(f"records equal for {len(pairs)} tics, but the files have {len(a)} and {len(b)} records")
        return 1
    print(f"identical: {len(pairs)} records" + (f", tics {pairs[0][0][0]}..{pairs[-1][0][0]}" if pairs else ""))
    return 0


sys.exit(main(sys.argv))
