"""Ricalca il fotogramma del wallpaper di Miyabi in line-art SVG (stile banyue.svg).

Uso: python tools/trace-miyabi.py tools/miyabi-frame.jpg www/miyabi.svg [anteprima.png]

Il fotogramma mostra la katana quasi rinfoderata: è lo stato finale del timer.
I contorni dentro HILT_MASK (mano destra, tsuka, tsuba, habaki) finiscono nel gruppo
mobile #miyabiSword insieme alla lama, generata qui perché nel fotogramma non si vede.
Per sguainare, app.js trasla il gruppo di (data-draw-x, data-draw-y) * frazione;
la lama è ritagliata all'imbocco del fodero (mano sinistra).
"""
import math
import sys

import cv2
import numpy as np

SCALE = 2                       # si lavora a 2x per avere tratti più morbidi
CROP = (0, 0, 1100, 720)        # x, y, w, h nel fotogramma 1280x720 (esclude il watermark)
# La scena è orizzontale: nell'SVG viene ruotata di 90° in senso orario (elsa in alto,
# fodero in basso) con un gruppo esterno, così tutte le coordinate restano quelle del fotogramma
AXIS_DEG = 5.5                  # inclinazione dell'asse della katana
KOIGUCHI = (503, 538)           # imbocco del fodero (bordo sinistro della mano sinistra)
HABAKI_FRONT = (499, 538)       # fronte dell'habaki, centro lama
DRAW_DIST = 380                 # corsa a timer pieno (px del fotogramma)
BLADE_HW = 17                   # semi-larghezza della lama
MIN_LEN = 14                    # scarta tratti più corti (px a 2x)

# Silhouette del gruppo mobile nel fotogramma (kashira con anello, tsuka, mano destra, tsuba, habaki)
HILT_MASK = [
    (0, 452), (60, 448), (130, 470), (262, 486), (300, 486), (345, 490), (395, 484),
    (440, 482), (470, 490), (504, 508), (504, 568), (492, 600), (486, 642), (412, 644),
    (398, 608), (372, 606), (340, 608), (300, 606), (262, 600), (250, 584), (150, 586),
    (60, 604), (0, 606),
]

U = (math.cos(math.radians(AXIS_DEG)), math.sin(math.radians(AXIS_DEG)))
N = (-U[1], U[0])


def to_out(x, y):
    """Coordinate del fotogramma -> coordinate SVG (ritaglio + scala)."""
    return ((x - CROP[0]) * SCALE, (y - CROP[1]) * SCALE)


def trace_edges(big):
    smooth = cv2.bilateralFilter(big, 7, 40, 7)
    lab = cv2.cvtColor(smooth, cv2.COLOR_BGR2LAB)
    edges = cv2.Canny(lab[:, :, 0], 30, 90)
    # anche i bordi di solo colore (occhi rossi sui capelli scuri, fiamma ciano sul cielo)
    edges |= cv2.Canny(lab[:, :, 1], 12, 30)
    edges |= cv2.Canny(lab[:, :, 2], 12, 30)
    return edges


def polylines(edges):
    """Contorni a passata singola: findContours ripercorre all'indietro i bordi larghi 1 px."""
    contours, _ = cv2.findContours(edges, cv2.RETR_LIST, cv2.CHAIN_APPROX_NONE)
    visited = np.zeros(edges.shape, dtype=bool)
    out = []
    for c in contours:
        cur = []
        for x, y in c[:, 0, :]:
            if visited[y, x]:
                if len(cur) > 1:
                    out.append(cur)
                cur = []
                continue
            visited[y, x] = True
            cur.append((x, y))
        if len(cur) > 1:
            out.append(cur)
    result = []
    for pl in out:
        arr = np.array(pl, dtype=np.int32).reshape(-1, 1, 2)
        if cv2.arcLength(arr, False) < MIN_LEN:
            continue
        result.append(cv2.approxPolyDP(arr, 0.8, False)[:, 0, :].tolist())
    return result


def blade_paths():
    """Lama nel sistema del gruppo mobile in posizione di riposo (dietro l'imbocco)."""
    ox, oy = HABAKI_FRONT
    length = DRAW_DIST + 40

    def pt(s, d):
        return to_out(ox + s * U[0] + d * N[0], oy + s * U[1] + d * N[1])

    steps = np.linspace(0, length, 60)
    spine = [pt(s, -BLADE_HW + 0.004 * s) for s in steps]
    edge = [pt(s, BLADE_HW - 0.006 * s) for s in steps]
    shinogi = [pt(s, -BLADE_HW + 0.32 * 2 * BLADE_HW) for s in steps]
    hamon = [pt(s, BLADE_HW - 6 - 2.0 * (1 + math.sin(s / 7)) - 1.0 * (1 + math.sin(s / 2.7)))
             for s in np.linspace(2, length, 260)]
    return [spine, edge, shinogi, hamon], [pt(0, -BLADE_HW - 1), pt(length, -BLADE_HW - 1),
                                           pt(length, BLADE_HW + 1), pt(0, BLADE_HW + 1)]


def fmt(points):
    return 'M ' + ' '.join(f'{round(x, 1):g},{round(y, 1):g}' for x, y in points)


def path_el(points, width):
    return (f'    <path d="{fmt(points)}" stroke="#FFFFFF" fill="none" stroke-width="{width}" '
            'stroke-linejoin="round" stroke-linecap="round"/>')


def main():
    src, out_svg = sys.argv[1], sys.argv[2]
    preview = sys.argv[3] if len(sys.argv) > 3 else None
    img = cv2.imread(src)
    # Le costanti sono in coordinate 1280x720: qualunque risoluzione (anche 4K) viene
    # portata direttamente a 1280x720 * SCALE, così un fotogramma più grande dà più dettaglio
    fh, fw = img.shape[:2]
    interp = cv2.INTER_AREA if fw >= 1280 * SCALE else cv2.INTER_CUBIC
    img = cv2.resize(img, (1280 * SCALE, 720 * SCALE), interpolation=interp)
    x0, y0, w, h = CROP
    img = img[y0 * SCALE:(y0 + h) * SCALE, x0 * SCALE:(x0 + w) * SCALE]

    edges = trace_edges(img)
    mask = np.zeros(edges.shape, dtype=np.uint8)
    cv2.fillPoly(mask, [np.array([to_out(x, y) for x, y in HILT_MASK], dtype=np.int32)], 255)
    scene = polylines(cv2.bitwise_and(edges, cv2.bitwise_not(mask)))
    hilt = polylines(cv2.bitwise_and(edges, mask))
    blade, blade_fill = blade_paths()

    vw, vh = w * SCALE, h * SCALE
    draw = (-DRAW_DIST * U[0] * SCALE, -DRAW_DIST * U[1] * SCALE)
    # Ritaglio: semipiano a sinistra della retta per l'imbocco, perpendicolare all'asse
    kx, ky = to_out(*KOIGUCHI)
    far = 4000
    clip = [(kx - N[0] * far, ky - N[1] * far), (kx - N[0] * far - U[0] * far, ky - N[1] * far - U[1] * far),
            (kx + N[0] * far - U[0] * far, ky + N[1] * far - U[1] * far), (kx + N[0] * far, ky + N[1] * far)]
    pts = lambda p: ' '.join(f'{round(x, 1):g},{round(y, 1):g}' for x, y in p)
    hilt_fill = [to_out(x, y) for x, y in HILT_MASK]

    sw = 4
    svg = '\n'.join([
        f'<svg viewBox="0 0 {vh} {vw}" xmlns="http://www.w3.org/2000/svg" '
        f'data-draw-x="{draw[0]:.1f}" data-draw-y="{draw[1]:.1f}">',
        '  <defs>',
        f'    <linearGradient id="miyabiGradient" gradientUnits="userSpaceOnUse" x1="0" y1="{vh}" x2="{vw}" y2="0">',
        '      <stop offset="0%" stop-color="#B9A8FF"/>',
        '      <stop offset="100%" stop-color="#9FF3FF"/>',
        '    </linearGradient>',
        f'    <linearGradient id="miyabiBladeGradient" gradientUnits="userSpaceOnUse" x1="0" y1="0" x2="{vw}" y2="0">',
        '      <stop offset="0%" stop-color="#FFFFFF"/>',
        '      <stop offset="100%" stop-color="#9FEFFF"/>',
        '    </linearGradient>',
        f'    <clipPath id="miyabiBladeClip"><polygon points="{pts(clip)}"/></clipPath>',
        '  </defs>',
        f'  <g transform="translate({vh} 0) rotate(90)">',
        '  <g id="miyabiScene">',
        *[path_el(p, sw) for p in scene],
        '  </g>',
        '  <g clip-path="url(#miyabiBladeClip)">',
        '    <g id="miyabiSword">',
        f'    <polygon points="{pts(blade_fill)}" fill="#000000"/>',
        f'    <polygon points="{pts(hilt_fill)}" fill="#000000"/>',
        '    <g class="miyabi-blade">',
        *[path_el(p, sw) for p in blade],
        '    </g>',
        *[path_el(p, sw) for p in hilt],
        '    </g>',
        '  </g>',
        '  </g>',
        '</svg>',
        '',
    ])
    with open(out_svg, 'w', encoding='utf-8') as f:
        f.write(svg)
    print(f'scena={len(scene)} elsa={len(hilt)} byte={len(svg)}')

    if preview:
        # Anteprima: stato sguainato (1), metà (0.5), finale (0) affiancati
        frames = []
        for frac in (1.0, 0.5, 0.0):
            canvas = np.zeros((vh, vw, 3), dtype=np.uint8)
            for p in scene:
                cv2.polylines(canvas, [np.int32(p)], False, (255, 200, 170), 2, cv2.LINE_AA)
            dx, dy = draw[0] * frac, draw[1] * frac
            moved = np.zeros_like(canvas)
            cv2.fillPoly(moved, [np.int32([(x + dx, y + dy) for x, y in blade_fill])], (1, 1, 1))
            cv2.fillPoly(moved, [np.int32([(x + dx, y + dy) for x, y in hilt_fill])], (1, 1, 1))
            layer = np.zeros_like(canvas)
            for p in blade:
                cv2.polylines(layer, [np.int32([(x + dx, y + dy) for x, y in p])], False, (255, 250, 230), 2, cv2.LINE_AA)
            for p in hilt:
                cv2.polylines(layer, [np.int32([(x + dx, y + dy) for x, y in p])], False, (255, 200, 170), 2, cv2.LINE_AA)
            # clip all'imbocco
            yy, xx = np.mgrid[0:vh, 0:vw]
            inside = ((xx - kx) * U[0] + (yy - ky) * U[1]) < 0
            occl = (moved[:, :, 0] > 0) & inside
            canvas[occl] = 0
            canvas[inside] = np.maximum(canvas[inside], layer[inside])
            canvas = cv2.rotate(canvas, cv2.ROTATE_90_CLOCKWISE)
            frames.append(cv2.resize(canvas, (vh // 2, vw // 2), interpolation=cv2.INTER_AREA))
        cv2.imwrite(preview, np.hstack(frames))


if __name__ == '__main__':
    main()
