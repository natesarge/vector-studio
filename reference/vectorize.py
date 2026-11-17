"""
vectorize.py - turn an AI-generated logo / patch / sticker image into clean,
flat-color vector art (SVG + PDF + transparent PNG).

Basic use (or just drag images onto vectorize.bat):
    python vectorize.py my_patch.png
    python vectorize.py *.png --colors 6 --out output

Every setting is optional; see "python vectorize.py --help".
"""
import argparse, os, shutil, subprocess, sys
import cv2, numpy as np, vtracer
from PIL import Image
from sklearn.cluster import KMeans


# ---------------------------------------------------------------- helpers
def hex_to_bgr(h):
    h = h.strip().lstrip("#")
    return np.array([int(h[4:6], 16), int(h[2:4], 16), int(h[0:2], 16)], np.uint8)

def to_lab(bgr_rows):
    """BGR uint8 rows -> real CIE Lab (L 0-100), for color distances."""
    lab = cv2.cvtColor(np.asarray(bgr_rows, np.uint8).reshape(-1, 1, 3), cv2.COLOR_BGR2LAB)
    return lab.reshape(-1, 3).astype(float) * [100 / 255, 1, 1] - [0, 128, 128]

def export(svg, pdf, png, width_px):
    """SVG -> PDF + PNG. Uses CairoSVG if available, else Inkscape's command line."""
    try:
        import cairosvg
        cairosvg.svg2pdf(url=svg, write_to=pdf)
        cairosvg.svg2png(url=svg, write_to=png, output_width=width_px)
        return
    except Exception:
        pass
    ink = shutil.which("inkscape") or r"C:\Program Files\Inkscape\bin\inkscape.exe"
    if os.path.exists(ink) or shutil.which("inkscape"):
        subprocess.run([ink, svg, "--export-type=pdf", f"--export-filename={pdf}", "--export-text-to-path"], check=False)
        subprocess.run([ink, svg, "--export-type=png", f"--export-filename={png}", f"--export-width={width_px}"], check=False)
    else:
        print("  (PDF/PNG skipped: install Inkscape or 'pip install cairosvg')")


# ---------------------------------------------------------------- shape cleanup
def background_mask(big, scale):
    """Flood-fill the background (and its soft drop shadow) in from the corners."""
    h, w = big.shape[:2]
    edge = cv2.bilateralFilter(big, 9, 30, 9)
    ffm = np.zeros((h + 2, w + 2), np.uint8)
    for p in [(0, 0), (w - 1, 0), (0, h - 1), (w - 1, h - 1)]:
        if ffm[p[1] + 1, p[0] + 1] == 0:
            cv2.floodFill(edge, ffm, p, 0, (3,) * 3, (3,) * 3, 4 | cv2.FLOODFILL_MASK_ONLY | (255 << 8))
    mask = (ffm[1:-1, 1:-1] == 0).astype(np.uint8)
    _, cc, st, _ = cv2.connectedComponentsWithStats(mask)
    mask = (cc == 1 + st[1:, cv2.CC_STAT_AREA].argmax()).astype(np.uint8)   # biggest object
    ff = np.pad(mask, 1).copy(); cv2.floodFill(ff, None, (0, 0), 2)
    mask = (ff[1:-1, 1:-1] != 2).astype(np.uint8)                           # fill holes
    mask = cv2.erode(mask, np.ones((scale + 1,) * 2, np.uint8))             # drop edge halo
    return cv2.GaussianBlur(mask.astype(np.float32), (0, 0), 3 * scale) > 0.5

def snap_shape(mask, scale):
    """Replace a wobbly outline with a perfect circle/ellipse or rounded rectangle."""
    h, w = mask.shape
    cnts, _ = cv2.findContours(mask.astype(np.uint8), cv2.RETR_EXTERNAL, cv2.CHAIN_APPROX_NONE)
    c = max(cnts, key=cv2.contourArea)
    iou = lambda m: (m & mask).sum() / (m | mask).sum()
    em = np.zeros((h, w), np.uint8); cv2.ellipse(em, cv2.fitEllipse(c), 1, -1)
    if iou(em.astype(bool)) > 0.97:
        return em.astype(bool), "circle/ellipse"
    (cx, cy), (rw, rh), ang = cv2.minAreaRect(c)
    if ang > 45: rw, rh, ang = rh, rw, ang - 90
    best, bm = 0, None
    for frac in np.linspace(0.02, 0.3, 15):                     # try corner radii
        r = frac * min(rw, rh)
        m = np.zeros((h, w), np.uint8)
        x0, y0, x1, y1 = cx - rw / 2, cy - rh / 2, cx + rw / 2, cy + rh / 2
        cv2.rectangle(m, (int(x0 + r), int(y0)), (int(x1 - r), int(y1)), 1, -1)
        cv2.rectangle(m, (int(x0), int(y0 + r)), (int(x1), int(y1 - r)), 1, -1)
        for px, py in [(x0 + r, y0 + r), (x1 - r, y0 + r), (x0 + r, y1 - r), (x1 - r, y1 - r)]:
            cv2.circle(m, (int(px), int(py)), int(r), 1, -1)
        m = cv2.warpAffine(m, cv2.getRotationMatrix2D((cx, cy), -ang, 1),
                           (w, h), flags=cv2.INTER_NEAREST).astype(bool)
        if iou(m) > best: best, bm = iou(m), m
    if best > 0.96:
        return bm, "rounded rectangle"
    return cv2.GaussianBlur(mask.astype(np.float32), (0, 0), 8 * scale) > 0.5, "free shape"

def find_border(labels, mask, scale):
    """Width (px) of the outer border band: where the color mix changes most."""
    h, w = labels.shape
    dist = cv2.distanceTransform(mask.astype(np.uint8), cv2.DIST_L2, 5)
    D = int(min(h, w) * 0.15); di = dist.astype(int); sel = mask & (di < D)
    comp = np.zeros((D, labels.max() + 1))
    np.add.at(comp, (di[sel], labels[sel]), 1)
    comp /= np.maximum(comp.sum(1, keepdims=True), 1)
    k = 5 * scale
    score = [np.abs(comp[d - k:d].mean(0) - comp[d:d + k].mean(0)).sum() for d in range(3 * scale + k, D - k)]
    return 3 * scale + k + int(np.argmax(score)), dist


# ---------------------------------------------------------------- main pipeline
def run(path, out="output", colors=8, smooth=None, scale=None, speckle=None, merge=14,
        border=True, border_extra=7, border_color=None, snap=True, palette=None,
        hook=None, post=None, verbose=True):
    name = os.path.splitext(os.path.basename(path))[0]
    os.makedirs(out, exist_ok=True)
    im = Image.open(path).convert("RGBA")
    rgb = np.array(Image.alpha_composite(Image.new("RGBA", im.size, "white"), im).convert("RGB"))[:, :, ::-1]

    # work at ~2000 px wide; defaults scale with the image
    scale = scale or max(1, round(2000 / rgb.shape[1]))
    smooth = smooth or max(2.0, rgb.shape[1] / 150)
    speckle = speckle or int(rgb.shape[1] * scale / 50)

    # 1. enlarge, then smooth away stitching / fabric / noise while keeping edges
    big = cv2.resize(rgb, None, fx=scale, fy=scale, interpolation=cv2.INTER_CUBIC)
    sm = cv2.pyrMeanShiftFiltering(big, sp=int(smooth * 6), sr=28)
    sm = cv2.bilateralFilter(sm, 9, 40, 9)

    # 2. reduce to N flat colors, merging near-identical shades
    lab = cv2.cvtColor(sm, cv2.COLOR_BGR2LAB).reshape(-1, 3).astype(np.float32)
    km = KMeans(n_clusters=colors, n_init=4, random_state=0).fit(lab[::7])
    labels = km.predict(lab).reshape(sm.shape[:2])
    cen = km.cluster_centers_ * [100 / 255, 1, 1]
    cnt = np.bincount(labels.ravel(), minlength=colors); remap = np.arange(colors)
    for i in np.argsort(-cnt):
        for j in np.argsort(-cnt):
            if j == i: break
            if remap[j] == j and np.linalg.norm(cen[i] - cen[j]) < merge:
                remap[i] = j; break
    labels = remap[labels]

    # 3. smooth the edges between color regions
    r = smooth * scale
    labels = np.stack([cv2.GaussianBlur((labels == i).astype(np.float32), (0, 0), r / 2)
                       for i in range(colors)]).argmax(0)

    # 4. cut out the design (remove background + shadow), clean the outline
    mask = background_mask(big, scale); mask_raw = mask.copy(); shape = "as traced"
    if snap: mask, shape = snap_shape(mask, scale)

    if hook: labels = hook(labels, big, scale)       # used by textify.py

    # 5. redraw the outer border as one solid band
    bl = -1; ncol = colors; bcol = None
    if border:
        W, dist_raw = find_border(labels, mask_raw, scale)
        band = mask_raw & (dist_raw < W) & (dist_raw > W * 0.15)
        bp = big[band].astype(float); lum = bp @ [0.114, 0.587, 0.299]
        bcol = hex_to_bgr(border_color) if border_color else np.median(bp[lum >= np.percentile(lum, 50)], 0)
        bl = ncol = colors; ncol += 1
        dist = cv2.distanceTransform(mask.astype(np.uint8), cv2.DIST_L2, 5)
        Wd = W + border_extra * scale
        inner = cv2.GaussianBlur((dist >= Wd).astype(np.float32), (0, 0), 2 * scale) > 0.5
        labels[mask & ~inner] = bl

    # 6. final colors: each region's real median color, optionally snapped to a brand palette
    pal = np.array([np.median(big[labels == i], 0) if (labels == i).any() else [0, 0, 0]
                    for i in range(ncol)]).astype(np.uint8)
    if bl >= 0: pal[bl] = np.asarray(bcol).astype(np.uint8)
    if palette:
        brand = np.array([hex_to_bgr(c) for c in palette])
        bl_lab, pl_lab = to_lab(brand), to_lab(pal)
        for i in range(ncol):
            if bl >= 0 and i == bl and border_color: continue
            pal[i] = brand[np.linalg.norm(bl_lab - pl_lab[i], axis=1).argmin()]
    if bl >= 0: labels[~mask] = bl                  # hidden pixels = edge color (no fringe)
    flat = np.dstack([pal[labels][:, :, ::-1], np.where(mask, 255, 0).astype(np.uint8)])
    tmp = os.path.join(out, f"{name}__flat.png"); Image.fromarray(flat).save(tmp)

    # 7. trace to vector, add extras, export
    svg = os.path.join(out, f"{name}.svg")
    vtracer.convert_image_to_svg_py(tmp, svg, colormode="color", hierarchical="stacked", mode="spline",
        filter_speckle=speckle, color_precision=8, layer_difference=4, corner_threshold=60,
        length_threshold=4.0, splice_threshold=45, path_precision=3)
    os.remove(tmp)
    if post: post(svg)
    export(svg, os.path.join(out, f"{name}.pdf"), os.path.join(out, f"{name}.png"), rgb.shape[1] * 4)

    used = sorted({"#%02X%02X%02X" % tuple(c[::-1]) for c in pal[np.unique(labels[mask])]})
    if verbose:
        print(f"{name}: shape={shape}, colors used: {', '.join(used)}")
    return svg


def cli():
    a = argparse.ArgumentParser(description="AI image -> clean flat vector (SVG/PDF/PNG)")
    a.add_argument("images", nargs="+")
    a.add_argument("--out", default="output", help="output folder (default: output)")
    a.add_argument("--colors", type=int, default=8, help="max colors to keep (default 8; count your design's colors + 1)")
    a.add_argument("--smooth", type=float, help="texture smoothing strength (default: auto; higher = smoother, loses small details)")
    a.add_argument("--speckle", type=int, help="drop specks smaller than this many px (default: auto)")
    a.add_argument("--merge", type=float, default=14, help="merge shades closer than this (default 14; raise to merge more)")
    a.add_argument("--palette", help='snap all colors to these hex codes, e.g. "#EFD8B1,#EE6A01,#143117"')
    a.add_argument("--no-palette", action="store_true", help="ignore palette.txt, keep the image's own colors")
    a.add_argument("--border-color", help="force the outer border color, e.g. #1C4062")
    a.add_argument("--border-extra", type=float, default=7, help="extra border width in source px (default 7)")
    a.add_argument("--no-border", action="store_true", help="don't redraw the outer border")
    a.add_argument("--no-snap", action="store_true", help="keep the traced outline (don't snap to circle/rounded rect)")
    o = a.parse_args()
    pal = [c for c in o.palette.split(",") if c.strip()] if o.palette else None
    pfile = os.path.join(os.path.dirname(os.path.abspath(__file__)), "palette.txt")
    if pal is None and not o.no_palette and os.path.exists(pfile):      # default brand colors
        pal = [l.split()[0] for l in open(pfile) if l.strip().startswith("#") and len(l.split()[0]) == 7]
        print(f"Snapping colors to {len(pal)} brand colors from palette.txt")
    for p in o.images:
        run(p, o.out, o.colors, o.smooth, None, o.speckle, o.merge, not o.no_border,
            o.border_extra, o.border_color, not o.no_snap, pal)

if __name__ == "__main__":
    cli()
