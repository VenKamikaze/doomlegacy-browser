#!/usr/bin/env python3
# SPDX-License-Identifier: GPL-2.0-or-later
"""Print one line per sanitizer report found in the files given: its site key.

  ASan:   "<kind> <file>:<line> in <function>"   (from the SUMMARY line)
  UBSan:  "ubsan <file>:<line>:<col> <message>"  (from "file:line:col: runtime error: message")

File names are cut to the path below src/. Everything else is ignored.
"""
import re
import sys

summary = re.compile(r"SUMMARY: AddressSanitizer: (\S+) (\S+?):(\d+)(?::\d+)? in (\S+)")
ubsan = re.compile(r"(\S+?):(\d+):(\d+): runtime error: (.*)")


def short(path):
    i = path.rfind("/src/")
    return path[i + 5:] if i >= 0 else path.split("/")[-1]


for name in sys.argv[1:]:
    try:
        text = open(name, errors="replace").read()
    except OSError:
        continue
    for line in text.splitlines():
        m = summary.search(line)
        if m:
            print(f"{m.group(1)} {short(m.group(2))}:{m.group(3)} in {m.group(4)}")
            continue
        m = ubsan.search(line)
        if m:
            msg = re.sub(r"0x[0-9a-f]+", "ADDR", m.group(4))
            msg = re.sub(r"-?\d+", "N", msg)
            print(f"ubsan {short(m.group(1))}:{m.group(2)}:{m.group(3)} {msg}")
