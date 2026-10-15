#!/usr/bin/env python3
"""Write a tiny procedurally generated Standard MIDI File (format 0, 120 BPM,
4 bars of a C-minor arpeggio + bass). Original content created by
schwung-wasm for testing; released under CC0-1.0.
usage: gen_demo_mid.py <out.mid>"""
import struct, sys

def vlq(n):
    out = [n & 0x7F]
    n >>= 7
    while n:
        out.append(0x80 | (n & 0x7F)); n >>= 7
    return bytes(reversed(out))

PPQ = 96
ev = []  # (tick, bytes)
arp = [60, 63, 67, 72, 67, 63]
for i in range(32):  # 32 eighth notes = 4 bars
    t = i * PPQ // 2
    n = arp[i % len(arp)]
    ev.append((t, bytes([0x90, n, 96]))); ev.append((t + PPQ // 2 - 4, bytes([0x80, n, 0])))
for bar in range(4):
    t = bar * PPQ * 4
    n = [36, 36, 39, 43][bar]
    ev.append((t, bytes([0x90, n, 110]))); ev.append((t + PPQ * 3, bytes([0x80, n, 0])))
ev.sort(key=lambda e: (e[0], e[1][0] == 0x90))
trk = bytearray(b'\x00\xFF\x51\x03\x07\xA1\x20')  # tempo 500000 us/qn = 120 BPM
last = 0
for t, b in ev:
    trk += vlq(t - last) + b; last = t
trk += b'\x00\xFF\x2F\x00'
data = b'MThd' + struct.pack('>IHHH', 6, 0, 1, PPQ) + b'MTrk' + struct.pack('>I', len(trk)) + bytes(trk)
open(sys.argv[1], 'wb').write(data)
