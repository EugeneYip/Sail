#!/usr/bin/env python3
"""Frame statistics + numeric sky-banding test. No deps: zlib + manual unfilter.

  python3 .tmp/imgstat.py shots/sky-a-noon.png [...]

Banding test: in a smooth sky gradient, 8-bit quantisation without dither makes
long runs of one identical luma value separated by 1-LSB steps. With 1-LSB
triangular dither, neighbouring pixels disagree constantly. So per column we
measure the longest run of an identical value and the fraction of neighbours
that are identical. A run longer than ~10 rows over a gradient that spans
several levels is a visible Mach band -- RUBRIC.md calls that an auto-fail.
"""
import sys, zlib, struct

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


def analyse(path):
    w, h, nch, px = read_png(path)
    lum = bytearray(w*h)
    for i in range(w*h):
        o = i*nch
        lum[i] = int(0.2126*px[o] + 0.7152*px[o+1] + 0.0722*px[o+2])

    hist = [0]*256
    for v in lum: hist[v] += 1
    tot = w*h
    def pct(p):
        want = tot*p; acc = 0
        for v in range(256):
            acc += hist[v]
            if acc >= want: return v
        return 255
    clip = sum(1 for i in range(0, w*h, 7) if px[i*nch] > 252 and px[i*nch+1] > 252 and px[i*nch+2] > 252)
    nclip = len(range(0, w*h, 7))

    print(f'== {path}  {w}x{h}')
    print(f'   luma  p1={pct(0.01):3d} p10={pct(0.10):3d} p50={pct(0.50):3d} '
          f'p90={pct(0.90):3d} p99={pct(0.99):3d}  min={min(lum)} max={max(lum)}')
    print(f'   white-clipped {100*clip/nclip:.2f}%   below-8 {100*sum(hist[:8])/tot:.2f}%   '
          f'below-24 {100*sum(hist[:24])/tot:.2f}%   above-248 {100*sum(hist[248:])/tot:.2f}%')

    for name, (a, b) in {'sky_top': (0.00, 0.16), 'sky_mid': (0.16, 0.30),
                         'horizon': (0.30, 0.40), 'sea_far': (0.40, 0.56),
                         'sea_near': (0.78, 1.00)}.items():
        rs = gs = bs = n = 0
        for y in range(int(a*h), int(b*h), 2):
            for x in range(0, w, 5):
                o = (y*w+x)*nch
                rs += px[o]; gs += px[o+1]; bs += px[o+2]; n += 1
        r, g, bl = rs/n, gs/n, bs/n
        mx, mn = max(r, g, bl), min(r, g, bl)
        sat = 0 if mx == 0 else (mx-mn)/mx
        print(f'   {name:9s} rgb=({r:5.1f},{g:5.1f},{bl:5.1f}) sat={sat:.3f}')

    # ---- banding: vertical traces through the sky ----
    worst_run, worst_at, runs, samecnt, pairs = 0, '', [], 0, 0
    for x in [int(w*f) for f in (0.06, 0.2, 0.35, 0.62, 0.8, 0.94)]:
        y0, y1 = 2, int(h*0.28)
        run, cur, mrun = 1, lum[y0*w+x], 1
        for y in range(y0+1, y1):
            v = lum[y*w+x]
            pairs += 1
            if v == cur:
                run += 1; samecnt += 1
            else:
                mrun = max(mrun, run); run = 1; cur = v
        mrun = max(mrun, run)
        span = max(lum[y*w+x] for y in range(y0, y1)) - min(lum[y*w+x] for y in range(y0, y1))
        runs.append((x, mrun, span))
        if mrun > worst_run:
            worst_run, worst_at = mrun, f'x={x}'
    verdict = 'BANDING RISK' if worst_run >= 10 else 'clean'
    print(f'   sky banding: longest identical run {worst_run}px ({worst_at}), '
          f'neighbour-identical {100*samecnt/max(1,pairs):.0f}%  -> {verdict}')
    print('               per column (x, maxRun, lumaSpan): ' +
          ' '.join(f'({a},{b},{c})' for a, b, c in runs))


for p in sys.argv[1:]:
    analyse(p)
