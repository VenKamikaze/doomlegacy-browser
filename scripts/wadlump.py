#!/usr/bin/env python3
# SPDX-License-Identifier: GPL-2.0-or-later
"""List or extract lumps of a Doom WAD file.

  scripts/wadlump.py list FILE.wad [PREFIX]     # name and size of each lump
  scripts/wadlump.py extract FILE.wad LUMP OUT  # write the first lump named LUMP to OUT

Run it with `python3 -I`. Exits 1 when the WAD is malformed or the lump is missing.
"""
import os
import struct
import sys


def directory(path):
    size = os.path.getsize(path)
    with open(path, 'rb') as f:
        head = f.read(12)
        if len(head) != 12:
            raise ValueError('too short for a WAD header')
        ident, count, offset = struct.unpack('<4sii', head)
        if ident not in (b'IWAD', b'PWAD'):
            raise ValueError('not a WAD (ident %r)' % ident)
        if count < 0 or offset < 12 or offset + 16 * count > size:
            raise ValueError('directory out of range')
        f.seek(offset)
        out = []
        for _ in range(count):
            pos, length, name = struct.unpack('<ii8s', f.read(16))
            if pos < 0 or length < 0 or pos + length > size:
                raise ValueError('lump out of range')
            out.append((name.split(b'\0', 1)[0].decode('ascii', 'replace'), pos, length))
        return ident.decode(), out


def main(argv):
    if len(argv) >= 3 and argv[1] == 'list':
        ident, lumps = directory(argv[2])
        prefix = argv[3].upper() if len(argv) > 3 else ''
        print('%s, %d lumps' % (ident, len(lumps)))
        for name, _, length in lumps:
            if name.upper().startswith(prefix):
                print('%-8s %d' % (name, length))
        return 0
    if len(argv) == 5 and argv[1] == 'extract':
        _, lumps = directory(argv[2])
        for name, pos, length in lumps:
            if name.upper() == argv[3].upper():
                with open(argv[2], 'rb') as f:
                    f.seek(pos)
                    data = f.read(length)
                with open(argv[4], 'wb') as o:
                    o.write(data)
                return 0
        print('no lump %s in %s' % (argv[3], argv[2]), file=sys.stderr)
        return 1
    print(__doc__.strip(), file=sys.stderr)
    return 2


if __name__ == '__main__':
    try:
        sys.exit(main(sys.argv))
    except (OSError, ValueError, struct.error) as e:
        print('wadlump: %s' % e, file=sys.stderr)
        sys.exit(1)
