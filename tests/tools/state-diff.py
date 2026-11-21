#!/usr/bin/env python3
# SPDX-License-Identifier: GPL-2.0-or-later
"""Compare two -teststate text files and print where they first differ.

  state-diff.py A B [N]    print up to N (default 8) differing lines, each as the
                           object name followed by only the fields that differ
                           ("name field: a -> b"). Exit 0 if equal, 1 if not.

The files hold one line per object ("mobj 12 type=.. x=.."); the lines are compared in
order. If the files have different numbers of objects, every later line differs, so only
the first few are shown; the first line that differs is the one to look at.
"""
import re
import sys

field = re.compile(r"(\w+)=(-?\d+)")


def main(argv):
    if len(argv) < 3:
        print(__doc__, file=sys.stderr)
        return 2
    a = open(argv[1], errors="replace").read().splitlines()
    b = open(argv[2], errors="replace").read().splitlines()
    limit = int(argv[3]) if len(argv) > 3 else 8
    shown = 0
    for i in range(max(len(a), len(b))):
        x = a[i] if i < len(a) else ""
        y = b[i] if i < len(b) else ""
        if x == y:
            continue
        name = " ".join((x or y).split(" ")[:2])
        fx, fy = dict(field.findall(x)), dict(field.findall(y))
        diffs = [f"{k}: {fx.get(k)} -> {fy.get(k)}" for k in dict.fromkeys(list(fx) + list(fy)) if fx.get(k) != fy.get(k)]
        if not x or not y:
            diffs = ["only in " + ("first" if x else "second") + " file"]
        print(f"line {i + 1}: {name}: " + ", ".join(diffs[:6]) + (" ..." if len(diffs) > 6 else ""))
        shown += 1
        if shown >= limit:
            break
    if shown == 0 and len(a) == len(b):
        print("state files are identical")
        return 0
    return 1


sys.exit(main(sys.argv))
