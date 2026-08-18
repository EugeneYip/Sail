#!/usr/bin/env python3
"""Displayed-pixel statistics for a capture. No deps: zlib + manual PNG unfilter."""
import sys, zlib, struct, math

def read_png(path):
    d = open(path, 'rb').read()
    assert d[:8] == b'\x89PNG\r\n\x1a\n'
    i, idat, w, h, bd, ct = 8, b'', 0, 0, 0, 0
    while i < len(d):
        ln = struct.unpack('>I', d[i:i+4])[0]
        typ = d[i+4:i+8]
        body = d[i+8:i+8+ln]
        if typ == b'IHDR':
            w, h, bd, ct = struct.unpack('>IIBB', body[:10])
        elif typ == b'IDAT':
            idat += body
        elif typ == b'IEND':
            break
        i += 12 + ln
    assert bd == 8, bd
    nch = {0: 1, 2: 3, 4: 2, 6: 4}[ct]
    raw = zlib.decompress(idat)
    stride = w * nch
    out = bytearray(w * h * nch)
    prev = bytearray(stride)
    p = 0
    for y in range(h):
        f = raw[p]; p += 1
        line = bytearray(raw[p:p+stride]); p += stride
        if f == 1:
            for x in range(nch, stride): line[x] = (line[x] + line[x-nch]) & 255
        elif f == 2:
            for x in range(stride): line[x] = (line[x] + prev[x]) & 255
        elif f == 3:
            for x in range(stride):
                a = line[x-nch] if x >= nch else 0
                line[x] = (line[x] + ((a + prev[x]) >> 1)) & 255
        elif f == 4:
            for x in range(stride):
                a = line[x-nch] if x >= nch else 0
                b = prev[x]
                c = prev[x-nch] if x >= nch else 0
                pp = a + b - c
                pa, pb, pc = abs(pp-a), abs(pp-b), abs(pp-c)
                pr = a if (pa <= pb and pa <= pc) else (b if pb <= pc else c)
                line[x] = (line[x] + pr) & 255
        out[y*stride:(y+1)*stride] = line
        prev = line
    return w, h, nch, out

def s2l(v):
    v /= 255.0
    return v/12.92 if v <= 0.04045 else ((v+0.055)/1.055)**2.4

def stats(path):
    w, h, nch, px = read_png(path)
    def band(y0, y1, x0=0.0, x1=1.0):
        rs=gs=bs=0; n=0; mx=0; mn=255; clipped=0; dark=0
        for y in range(int(y0*h), int(y1*h)):
            for x in range(int(x0*w), int(x1*w), 3):
                o = (y*w+x)*nch
                r,g,b = px[o], px[o+1], px[o+2]
                rs+=r; gs+=g; bs+=b; n+=1
                l = 0.2126*r+0.7152*g+0.0722*b
                mx=max(mx,l); mn=min(mn,l)
                if r>250 and g>250 and b>250: clipped+=1
                if l < 8: dark+=1
        return dict(rgb=(round(rs/n,1), round(gs/n,1), round(bs/n,1)), lmin=round(mn,1),
                    lmax=round(mx,1), clip=round(clipped/n,4), black=round(dark/n,4))
    # saturation of the mean
    def sat(rgb):
        mx, mn = max(rgb), min(rgb)
        return 0 if mx == 0 else round((mx-mn)/mx, 3)
    res = {}
    for k, (a, b) in {'sky_top': (0.0, 0.18), 'sky_low': (0.18, 0.33),
                      'horizon': (0.33, 0.40), 'sea_far': (0.40, 0.55),
                      'sea_near': (0.75, 1.0), 'centre': (0.45, 0.80), 'all': (0.0, 1.0)}.items():
        s = band(a, b)
        s['sat'] = sat(s['rgb'])
        res[k] = s
    print(f'== {path}  {w}x{h}')
    for k, v in res.items():
        print(f'   {k:9s} rgb={v["rgb"]} sat={v["sat"]:.3f} lum[{v["lmin"]:.0f}..{v["lmax"]:.0f}] '
              f'clipWhite={v["clip"]*100:.2f}% nearBlack={v["black"]*100:.2f}%')

for p in sys.argv[1:]:
    stats(p)
