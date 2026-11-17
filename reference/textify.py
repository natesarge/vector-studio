"""
textify.py - vectorize a design AND replace its lettering with real fonts.

    python textify.py jobs/no_smoke.json          # build one design
    python textify.py jobs/*.json                 # build several
    python textify.py jobs/no_smoke.json --grid   # save a coordinate grid image
                                                  #  to help you fill in "region"

A job file (JSON) says which image to use, the vectorize settings, the fonts,
and for each line of text: what it says, where it sits, and how to lay it out.
See jobs/*.json for working examples and README.md for every option.
"""
import argparse, glob, json, math, os, sys
import cv2, numpy as np
from fontTools.ttLib import TTFont
from fontTools.pens.svgPathPen import SVGPathPen
from fontTools.pens.boundsPen import BoundsPen
import vectorize

HERE = os.path.dirname(os.path.abspath(__file__))


def load_font(path):
    f = TTFont(path); gs = f.getGlyphSet(); cmap = f.getBestCmap()
    bp = BoundsPen(gs); gs[cmap[ord("H")]].draw(bp)
    return f, gs, cmap, bp.bounds[3]                       # cap height (font units)

def glyphs(text, font):
    f, gs, cmap, caph = font
    out = []
    for ch in text:
        g = cmap.get(ord(ch)) or cmap[ord("?")]
        pen = SVGPathPen(gs); gs[g].draw(pen)
        bp = BoundsPen(gs); gs[g].draw(bp)
        out.append((pen.getCommands(), f["hmtx"][g][0], bp.bounds))
    return out, caph

def ink_width(gl):
    first = gl[0][2][0] if gl[0][2] else 0
    last = gl[-1][2]
    return sum(a for _, a, _ in gl[:-1]) + (last[2] if last else gl[-1][1]) - first

def positions(gl, s, track):
    """pen x for each glyph (px), first glyph's ink starting at 0"""
    x = -(gl[0][2][0] if gl[0][2] else 0) * s; pos = []
    for _, a, _ in gl:
        pos.append(x); x += a * s + track
    return pos


def build(job_path, grid=False):
    job = json.load(open(job_path))
    base = os.path.dirname(os.path.abspath(job_path))
    rel = lambda p: p if os.path.isabs(p) else os.path.normpath(os.path.join(base, p))
    image = rel(job["image"])

    if grid:                                               # coordinate helper
        im = cv2.imread(image)
        for x in range(0, im.shape[1], 50):
            cv2.line(im, (x, 0), (x, im.shape[0]), (255, 0, 255) if x % 100 == 0 else (255, 200, 0), 1)
            if x % 100 == 0: cv2.putText(im, str(x), (x + 2, 14), 0, 0.45, (0, 0, 255), 1)
        for y in range(0, im.shape[0], 50):
            cv2.line(im, (0, y), (im.shape[1], y), (255, 0, 255) if y % 100 == 0 else (255, 200, 0), 1)
            if y % 100 == 0: cv2.putText(im, str(y), (2, y + 14), 0, 0.45, (0, 0, 255), 1)
        outp = os.path.splitext(image)[0] + "_grid.png"; cv2.imwrite(outp, im)
        print("grid saved:", outp); return

    fonts = {k: load_font(rel(v)) for k, v in job["fonts"].items()}
    lines = job.get("text", [])
    fits = []

    def hook(labels, big, scale):
        h, w = labels.shape
        for ln in lines:
            reg = np.zeros((h, w), np.uint8)
            if "box" in ln:
                x0, y0, x1, y1 = ln["box"]; poly = [(x0, y0), (x1, y0), (x1, y1), (x0, y1)]
            else:
                poly = ln["region"]
            cv2.fillPoly(reg, [(np.array(poly) * scale).astype(np.int32)], 1); reg = reg.astype(bool)
            want = vectorize.hex_to_bgr(ln["find_color"]).astype(float)
            ids = np.unique(labels[reg])
            meds = {i: np.median(big[reg & (labels == i)], 0) for i in ids}
            tl = min(ids, key=lambda i: np.linalg.norm(meds[i] - want))      # the lettering's color
            tm = reg & (labels == tl)
            ys, xs = np.nonzero(tm)
            grow = cv2.dilate(tm.astype(np.uint8), np.ones((4 * scale + 1,) * 2)).astype(bool) & reg
            fill = np.bincount(labels[reg & ~grow]).argmax()                  # surrounding color
            labels[grow & (labels == tl)] = fill                              # erase old letters
            med = np.median(big[tm], 0).astype(np.uint8)
            if job.get("palette") and not ln.get("color"):                    # snap to brand color
                br = np.array([vectorize.hex_to_bgr(c) for c in job["palette"]])
                med = br[np.linalg.norm(vectorize.to_lab(br) - vectorize.to_lab([med]), axis=1).argmin()]
            color = ln.get("color") or "#%02X%02X%02X" % tuple(med[::-1].astype(int))
            fits.append((ln, color, xs.astype(float), ys.astype(float)))
        return labels

    def post(svg):
        out = []
        for ln, color, xs, ys in fits:
            gl, caph = glyphs(ln["text"], fonts[ln["font"]])
            size = ln.get("size", 1.0); sp = ln.get("spacing", 0.0)
            dx, dy, rot = ln.get("dx", 0) * S, ln.get("dy", 0) * S, ln.get("rotate", 0)
            paths = []
            if ln.get("layout", "straight") == "straight":
                m, b = np.polyfit(xs, ys, 1)
                if ln.get("level"): m = 0.0
                x0, x1 = np.percentile(xs, 0.2), np.percentile(xs, 99.8)
                s = (x1 - x0) / ink_width(gl) * size
                track = sp * caph * s
                total = ink_width(gl) * s + track * (len(gl) - 1)
                cxm = (x0 + x1) / 2; start = cxm - total / 2
                for (d, adv, bb), p in zip(gl, positions(gl, s, track)):
                    if not d: continue
                    e = start + p; f = m * e + b + caph * s / 2
                    paths.append(f'<path fill="{color}" transform="matrix({s} {m*s} 0 {-s} {e} {f})" d="{d}"/>')
                cx, cy = cxm, m * cxm + b
            else:  # arc: fit a circle through the middle of the text band
                bins = np.round(xs / 12); mx, my = [], []
                for bv in np.unique(bins):
                    yy = ys[bins == bv]
                    if len(yy) > 20: mx.append(bv * 12); my.append((yy.min() + yy.max()) / 2)
                mx, my = np.array(mx), np.array(my)
                A = np.c_[2 * mx, 2 * my, np.ones_like(mx)]
                ccx, ccy, _ = np.linalg.lstsq(A, mx ** 2 + my ** 2, rcond=None)[0]
                rr = np.hypot(xs - ccx, ys - ccy)
                R = (np.percentile(rr, 99.5) + np.percentile(rr, 0.5)) / 2 + ln.get("radius", 0) * S
                ang = np.arctan2(ys - ccy, xs - ccx); top = ccy > ys.mean()
                a0, a1 = np.percentile(ang, 0.2), np.percentile(ang, 99.8)
                s = R * (a1 - a0) / ink_width(gl) * size
                H = caph * s; track = sp * H
                total = ink_width(gl) * s + track * (len(gl) - 1)
                amid = (a0 + a1) / 2
                for (d, adv, bb), p in zip(gl, positions(gl, s, track)):
                    if not d: continue
                    mid = p + adv * s / 2 - total / 2
                    phi = amid + mid / R if top else amid - mid / R
                    r_ = phi + math.pi / 2 if top else phi - math.pi / 2
                    cs, sn = math.cos(r_), math.sin(r_)
                    Px, Py = ccx + R * math.cos(phi), ccy + R * math.sin(phi)
                    ox, oy = -adv * s / 2, H / 2
                    e = Px + cs * ox - sn * oy; f = Py + sn * ox + cs * oy
                    paths.append(f'<path fill="{color}" transform="matrix({cs*s} {sn*s} {sn*s} {-cs*s} {e} {f})" d="{d}"/>')
                cx, cy = ccx + R * math.cos(amid), ccy + R * math.sin(amid)
            out.append(f'<g transform="translate({dx} {dy}) rotate({rot} {cx} {cy})">' + "".join(paths) + "</g>")
        t = open(svg).read().replace("</svg>", '<g id="text">' + "".join(out) + "</g></svg>")
        open(svg, "w").write(t)

    v = job.get("vectorize", {})
    pal = job.get("palette")
    # S = working scale (source px -> svg units), so dx/dy/radius are in source-image px
    im = cv2.imread(image); global S
    S = v.get("scale") or max(1, round(2000 / im.shape[1]))
    vectorize.run(image, rel(job.get("out", "../output")), v.get("colors", 8), v.get("smooth"), S,
                  v.get("speckle"), v.get("merge", 14), v.get("border", True), v.get("border_extra", 7),
                  v.get("border_color"), v.get("snap", True), pal, hook=hook, post=post)

S = 1
if __name__ == "__main__":
    a = argparse.ArgumentParser(description="vectorize + replace lettering with real fonts")
    a.add_argument("jobs", nargs="+"); a.add_argument("--grid", action="store_true")
    o = a.parse_args()
    for pat in o.jobs:
        for j in glob.glob(pat) or [pat]:
            build(j, o.grid)
