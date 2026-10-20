"""テロップ描画エンジン。

styles.json のスタイル定義 + テキストから、任意の時刻のテロップ画像(RGBA)を返す。
- 多重フチ（内側→外側の累積幅）、グラデーション塗り、ドロップシャドウ/グロー
- 座布団（角丸・パラレログラム）、ワイプ
- ブロック単位のイン/アウト/待機アニメ、1文字ずつのアニメ
"""
import json
import math
import os
import random

import numpy as np
from PIL import Image, ImageDraw, ImageFont, ImageFilter

FONT_DIRS = [r"C:\Windows\Fonts", os.path.expandvars(r"%LOCALAPPDATA%\Microsoft\Windows\Fonts")]
_fonts = {}


def get_font(name, size):
    key = (name, size)
    if key not in _fonts:
        for d in FONT_DIRS:
            p = os.path.join(d, name)
            if os.path.exists(p):
                _fonts[key] = ImageFont.truetype(p, size)
                break
        else:
            raise FileNotFoundError(f"font not found: {name}")
    return _fonts[key]


def rgba(c):
    c = c.lstrip("#")
    if len(c) == 6:
        c += "ff"
    return tuple(int(c[i:i + 2], 16) for i in (0, 2, 4, 6))


# ---------------------------------------------------------------- easing
def clamp(x, a=0.0, b=1.0):
    return max(a, min(b, x))


def ease_out_cubic(p):
    return 1 - (1 - p) ** 3


def ease_in_cubic(p):
    return p ** 3


def ease_in_quad(p):
    return p * p


def ease_out_expo(p):
    return 1.0 if p >= 1 else 1 - 2 ** (-10 * p)


def ease_out_back(p, k=1.70158):
    p -= 1
    return 1 + (k + 1) * p ** 3 + k * p ** 2


def ease_in_back(p, k=1.70158):
    return (k + 1) * p ** 3 - k * p ** 2


def ease_out_elastic(p):
    if p <= 0:
        return 0.0
    if p >= 1:
        return 1.0
    return 2 ** (-10 * p) * math.sin((p * 10 - 0.75) * (2 * math.pi / 3)) + 1


def ease_out_bounce(p):
    n1, d1 = 7.5625, 2.75
    if p < 1 / d1:
        return n1 * p * p
    if p < 2 / d1:
        p -= 1.5 / d1
        return n1 * p * p + 0.75
    if p < 2.5 / d1:
        p -= 2.25 / d1
        return n1 * p * p + 0.9375
    p -= 2.625 / d1
    return n1 * p * p + 0.984375


# ---------------------------------------------------------------- image helpers
def vgrad(h, colors, y0, y1):
    """高さ h の縦グラデーション (h, 4)。y0→y1 の範囲で colors を補間。"""
    cols = np.array([rgba(c) for c in colors], float)
    if len(cols) == 1:
        return np.repeat(cols, h, axis=0)
    p = np.clip((np.arange(h) - y0) / max(1.0, y1 - y0), 0, 1) * (len(cols) - 1)
    i = np.minimum(p.astype(int), len(cols) - 2)
    f = (p - i)[:, None]
    return cols[i] * (1 - f) + cols[i + 1] * f


def paint_layer(mask, paint, y0=0, y1=None):
    """L マスクを色（文字列）またはグラデーション（色リスト）で塗った RGBA を返す。"""
    m = np.asarray(mask, float) / 255.0
    h, w = m.shape
    colors = [paint] if isinstance(paint, str) else paint
    col = vgrad(h, colors, y0, h if y1 is None else y1)[:, None, :]
    out = np.empty((h, w, 4))
    out[..., :3] = col[..., :3]
    out[..., 3] = m * col[..., 3]
    return Image.fromarray(np.clip(out, 0, 255).astype(np.uint8), "RGBA")


def paste(canvas, im, x, y):
    """はみ出しを許す alpha_composite。"""
    x, y = int(round(x)), int(round(y))
    W, H = canvas.size
    w, h = im.size
    x0, y0, x1, y1 = max(0, x), max(0, y), min(W, x + w), min(H, y + h)
    if x1 <= x0 or y1 <= y0:
        return
    canvas.alpha_composite(im.crop((x0 - x, y0 - y, x1 - x, y1 - y)), (x0, y0))


def with_opacity(im, a):
    if a >= 0.999:
        return im
    im = im.copy()
    im.putalpha(im.getchannel("A").point(lambda v: int(v * max(0.0, a))))
    return im


def xform(im, sx, sy=None, rot=0.0):
    """拡大縮小 + 回転（rot は時計回りが正）。プリマルチプライドで処理してフチの黒ずみを防ぐ。"""
    sy = sx if sy is None else sy
    scale = abs(sx - 1) > 1e-3 or abs(sy - 1) > 1e-3
    rotate = abs(rot) > 0.01
    if not (scale or rotate):
        return im
    im = im.convert("RGBa")
    if scale:
        w, h = im.size
        im = im.resize((max(1, round(w * sx)), max(1, round(h * sy))), Image.BICUBIC)
    if rotate:
        im = im.rotate(-rot, Image.BICUBIC, expand=True)
    return im.convert("RGBA")


# ---------------------------------------------------------------- text markup
def parse_markup(text):
    """'あいう{えお}\\nかき' → [[('あ',False),...,('え',True),...], [...]]"""
    lines, cur, acc = [], [], False
    for ch in text:
        if ch == "{":
            acc = True
        elif ch == "}":
            acc = False
        elif ch == "\n":
            lines.append(cur)
            cur = []
        else:
            cur.append((ch, acc))
    lines.append(cur)
    return lines


# ---------------------------------------------------------------- plate (座布団)
def render_plate(pl, box):
    """座布団を描いて (RGBA, 左上x, 左上y) をテキスト座標で返す。"""
    x0, y0, x1, y1 = box
    H = y1 - y0
    k = pl.get("skew", 0) * H / 2
    sw = pl.get("stroke", {}).get("w", 0)
    sh = pl.get("shadow")
    mg = sw + 6 + (abs(sh["dx"]) + abs(sh["dy"]) + 3 * sh["blur"] if sh else 0)
    ox, oy = x0 - mg - k, y0 - mg
    W, Hh = int(x1 - x0 + 2 * mg + 2 * k) + 2, int(H + 2 * mg) + 2
    S = 4  # スーパーサンプリング

    def shape(expand, band=None):
        im = Image.new("L", (W * S, Hh * S), 0)
        d = ImageDraw.Draw(im)
        ax0, ay0 = (x0 - ox - expand) * S, (y0 - oy - expand) * S
        ax1, ay1 = (x1 - ox + expand) * S, (y1 - oy + expand) * S
        kk = k * S
        if pl.get("type") == "slant":
            if band:  # 下端の帯
                hh = band * S
                t = (ay1 - ay0 - hh) / (ay1 - ay0)
                d.polygon([(ax0 + kk - 2 * kk * t, ay1 - hh), (ax1 + kk - 2 * kk * t, ay1 - hh),
                           (ax1 - kk, ay1), (ax0 - kk, ay1)], fill=255)
            else:
                d.polygon([(ax0 + kk, ay0), (ax1 + kk, ay0), (ax1 - kk, ay1), (ax0 - kk, ay1)], fill=255)
        else:
            r = min(pl.get("radius", 0) * S + expand * S, (ay1 - ay0) / 2)
            d.rounded_rectangle([ax0, ay0, ax1, ay1], radius=r, fill=255)
        return im.resize((W, Hh), Image.LANCZOS)

    out = Image.new("RGBA", (W, Hh), (0, 0, 0, 0))
    outer = shape(sw)
    if sh:
        m = Image.new("L", (W, Hh), 0)
        m.paste(outer, (sh["dx"], sh["dy"]))
        out.alpha_composite(paint_layer(m.filter(ImageFilter.GaussianBlur(sh["blur"])), sh["color"]))
    if sw:
        out.alpha_composite(paint_layer(outer, pl["stroke"]["color"]))
    out.alpha_composite(paint_layer(shape(0), pl["fill"], y0 - oy, y1 - oy))
    if pl.get("bar"):
        out.alpha_composite(paint_layer(shape(0, band=pl["bar"]["h"]), pl["bar"]["color"]))
    return out, ox, oy


# ---------------------------------------------------------------- block
CHAR_DUR = {"pop": 0.26, "type": 0.14, "drop": 0.42}


def char_state(kind, u, size):
    """1文字アニメ: (scale, dy, opacity, rot)。u は文字ごとの経過秒。"""
    if u < 0:
        return None
    if kind == "pop":
        p = clamp(u / CHAR_DUR["pop"])
        return max(0.02, ease_out_back(p, 2.8)), (1 - ease_out_cubic(p)) * 0.25 * size, clamp(p * 5), 0
    if kind == "type":
        p = clamp(u / CHAR_DUR["type"])
        return 1, (1 - ease_out_cubic(p)) * 0.18 * size, p, 0
    if kind == "drop":
        p = clamp(u / CHAR_DUR["drop"])
        return 1, -(1 - ease_out_bounce(p)) * 0.9 * size, clamp(p * 6), (1 - p) * -12
    return 1, 0, 1, 0


class Glyph:
    pass


class Block:
    """1つのテロップ（テキスト + 任意の座布団）。キャンバス中心がアンカー。"""

    def __init__(self, st, text):
        self.st = st
        size = st["size"]
        f = get_font(st["font"], size)
        lines = parse_markup(text)
        trk_em = st.get("tracking", 0)

        def line_w(line, f, size):
            return sum(f.getlength(c) for c, _ in line) + trk_em * size * max(0, len(line) - 1)

        maxw = st.get("max_width")
        if maxw:
            w = max(line_w(l, f, size) for l in lines)
            if w > maxw:
                size = int(size * maxw / w)
                f = get_font(st["font"], size)
        self.size = size
        trk = trk_em * size
        lh = size * st.get("line_spacing", 1.15)
        strokes = st.get("strokes", [])
        shadows = st.get("shadows", [])
        maxsw = max([s["w"] for s in strokes], default=0)
        m = 4 + maxsw + max([abs(s["dx"]) + abs(s["dy"]) + 3 * s["blur"] for s in shadows], default=0)

        text_w = max(line_w(l, f, size) for l in lines)
        cap, desc = 0.88 * size, 0.12 * size  # CJK の見た目上の上端/下端（ベースライン基準）
        text_h = lh * (len(lines) - 1) + cap + desc

        self.glyphs = []
        for li, line in enumerate(lines):
            by = cap + li * lh
            pen = (text_w - line_w(line, f, size)) / 2
            for ch, acc in line:
                adv = f.getlength(ch) + trk
                if not ch.isspace():
                    self.glyphs.append(self._glyph(f, ch, acc, pen, by, m, maxsw, strokes, shadows, cap, desc))
                pen += adv

        # 座布団
        self.plate = None
        if st.get("plate"):
            px, py = st["plate"].get("pad", [30, 15])
            box = (-px, -py, text_w + px, text_h + py)
            img, ox, oy = render_plate(st["plate"], box)
            self.plate = (img, ox, oy)
            self.content = box
        else:
            self.content = (0, 0, text_w, text_h)
        ax = (self.content[0] + self.content[2]) / 2
        ay = (self.content[1] + self.content[3]) / 2

        # アンカー中心の対称キャンバスを作る（回転・拡大の基準を中心にするため）
        rects = [(g.x, g.y, g.x + g.w, g.y + g.h) for g in self.glyphs]
        if self.plate:
            img, ox, oy = self.plate
            rects.append((ox, oy, ox + img.width, oy + img.height))
        mg = 0.35 * size if st.get("char") else 4
        hw = max(max(ax - r[0], r[2] - ax) for r in rects) + mg
        hh = max(max(ay - r[1], r[3] - ay) for r in rects) + mg
        self.canvas_size = (int(2 * hw) + 1, int(2 * hh) + 1)
        self.off = (hw - ax, hh - ay)
        c0, c1, c2, c3 = self.content
        self.content_w = c2 - c0
        self.content_h = c3 - c1

        # 静止状態のテキスト（全フチ→全塗りの順で重ねる）
        self.text_img = Image.new("RGBA", self.canvas_size, (0, 0, 0, 0))
        n_pass = len(self.glyphs[0].layers) if self.glyphs else 0
        for k in range(n_pass):
            for g in self.glyphs:
                paste(self.text_img, g.layers[k], g.x + self.off[0], g.y + self.off[1])

    def _glyph(self, f, ch, acc, pen, by, m, maxsw, strokes, shadows, cap, desc):
        l, t, r, b = f.getbbox(ch, anchor="ls", stroke_width=maxsw)
        g = Glyph()
        g.w, g.h = r - l + 2 * m, b - t + 2 * m
        origin = (m - l, m - t)
        g.x, g.y = pen + l - m, by + t - m

        def mask(sw):
            im = Image.new("L", (g.w, g.h), 0)
            ImageDraw.Draw(im).text(origin, ch, font=f, fill=255, anchor="ls",
                                    stroke_width=sw, stroke_fill=255)
            return im

        layers = []
        outer = mask(maxsw)
        for sh in shadows:
            sm = Image.new("L", (g.w, g.h), 0)
            sm.paste(outer, (sh["dx"], sh["dy"]))
            if sh["blur"]:
                sm = sm.filter(ImageFilter.GaussianBlur(sh["blur"]))
            layers.append(paint_layer(sm, sh["color"]))
        for s in reversed(strokes):
            layers.append(paint_layer(mask(s["w"]) if s["w"] != maxsw else outer, s["color"]))
        fill = self.st.get("accent", self.st["fill"]) if acc else self.st["fill"]
        layers.append(paint_layer(mask(0), fill, origin[1] - cap, origin[1] + desc))
        g.layers = layers
        return g

    def char_end(self):
        st = self.st
        if not st.get("char"):
            return 0
        return st.get("char_delay", 0) + st.get("stagger", 0.03) * len(self.glyphs) + CHAR_DUR[st["char"]]

    def compose(self, t):
        """時刻 t（ブロック開始からの秒）のキャンバス画像。ブロック単位の変形は含まない。"""
        st = self.st
        canvas = Image.new("RGBA", self.canvas_size, (0, 0, 0, 0))
        ox, oy = self.off
        if self.plate:
            img, px, py = self.plate
            if st.get("plate_anim") == "wipe":
                p = ease_out_cubic(clamp(t / 0.32))
                img = img.crop((0, 0, max(1, int(img.width * p)), img.height)) if p > 0 else None
            if img is not None:
                paste(canvas, img, px + ox, py + oy)

        kind = st.get("char")
        if not kind or t >= self.char_end():
            paste(canvas, self.text_img, 0, 0)
            return canvas
        delay, stg = st.get("char_delay", 0), st.get("stagger", 0.03)
        states = [char_state(kind, t - delay - i * stg, self.size) for i in range(len(self.glyphs))]
        for k in range(len(self.glyphs[0].layers)):
            for g, s in zip(self.glyphs, states):
                if s is None or s[2] <= 0:
                    continue
                sc, dy, a, rot = s
                im = with_opacity(xform(g.layers[k], sc, rot=rot), a)
                cx, cy = g.x + ox + g.w / 2, g.y + oy + g.h / 2 + dy
                paste(canvas, im, cx - im.width / 2, cy - im.height / 2)
        return canvas


# ---------------------------------------------------------------- block-level animation
def block_state(st, t, d):
    """ブロック全体の (scale, rot, dx, dy, opacity)。"""
    s, rot, dx, dy, op = 1.0, 0.0, 0.0, 0.0, 1.0
    k = st.get("in", "none")
    if k == "slam":  # 画面手前から叩きつける + 着地の揺れ
        p = clamp(t / 0.28)
        if p < 0.55:
            s = 2.6 + (0.9 - 2.6) * ease_in_quad(p / 0.55)
        else:
            s = 0.9 + 0.1 * ease_out_back((p - 0.55) / 0.45, 3)
        op = clamp(p / 0.18)
        u = t - 0.15
        if 0 < u < 0.4:
            amp = (1 - u / 0.4) * 16
            dx, dy = amp * math.sin(u * 95), amp * math.cos(u * 71)
    elif k == "pop":
        p = clamp(t / 0.3)
        s = max(0.02, ease_out_back(p, 2.2))
        op = clamp(p * 5)
    elif k == "drop":
        p = clamp(t / 0.55)
        dy = -(1 - ease_out_bounce(p)) * 260
        op = clamp(p * 6)
    elif k == "elastic":
        p = clamp(t / 0.75)
        s = max(0.02, ease_out_elastic(p))
        rot = math.sin(t * 26) * 9 * (1 - p)
    elif k == "slide_left":
        p = clamp(t / 0.35)
        dx = -(1 - ease_out_expo(p)) * 900
        op = clamp(p * 3)
    elif k == "fade_up":
        p = clamp(t / 0.25)
        dy = (1 - ease_out_cubic(p)) * 40
        op = p

    idle = st.get("idle", "none")
    if idle == "pulse":
        s *= 1 + 0.028 * math.sin(2 * math.pi * t / 0.9)
    elif idle == "float":
        dy += math.sin(2 * math.pi * t / 1.4) * 7
        rot += math.sin(2 * math.pi * t / 2.1) * 1.8

    od = st.get("out_d", 0.18)
    q = clamp((t - (d - od)) / od) if od > 0 else 0
    if q > 0:
        k = st.get("out", "fade")
        if k == "fade":
            op *= 1 - q
        elif k == "zoom_out":
            s *= 1 + 0.35 * ease_in_cubic(q)
            op *= 1 - q
        elif k in ("pop_out", "shrink"):
            s *= max(0.02, 1 - ease_in_back(q, 2.2))
            op *= 1 - q * q
        elif k == "slide_out_left":
            dx -= ease_in_cubic(q) * 1200
    return s, rot, dx, dy, op


# ---------------------------------------------------------------- items
class TextItem:
    def __init__(self, st, text, pos):
        self.st, self.pos = st, pos
        self.block = Block(st, text)

    def frame(self, t, d):
        img = self.block.compose(t)
        s, rot, dx, dy, op = block_state(self.st, t, d)
        img = with_opacity(xform(img, s, rot=rot + self.st.get("rotate", 0)), op)
        return [(img, self.pos[0] + dx - img.width / 2, self.pos[1] + dy - img.height / 2)]


class GroupItem:
    """ラベル + 本文（例: 「その1」+「氷は先に揺らす」）。"""

    def __init__(self, st, styles, label, text, pos):
        self.st, self.pos = st, pos
        self.label = Block(styles[st["label_style"]], label)
        self.body = Block(styles[st["body_style"]], text)
        gap = st.get("gap", 0)
        total = self.label.content_w + gap + self.body.content_w
        self.label_x = pos[0] - total / 2 + self.label.content_w / 2
        self.body_x = pos[0] + total / 2 - self.body.content_w / 2

    def frame(self, t, d):
        out = []
        bd = self.st.get("body_delay", 0)
        for blk, x, t0 in ((self.body, self.body_x, bd), (self.label, self.label_x, 0)):
            lt = t - t0
            if lt < 0:
                continue
            sub = dict(blk.st, out=self.st.get("out", "fade"), out_d=self.st.get("out_d", 0.18))
            img = blk.compose(lt)
            s, rot, dx, dy, op = block_state(sub, lt, d - t0)
            img = with_opacity(xform(img, s, rot=rot + blk.st.get("rotate", 0)), op)
            out.append((img, x + dx - img.width / 2, self.pos[1] + dy - img.height / 2))
        return out


class SpeedLines:
    """集中線。3パターンを2フレームごとに切り替えてチラつかせる。"""

    def __init__(self, st, W, H, fps, seed=7):
        self.st, self.fps = st, fps
        rnd = random.Random(seed)
        S = 2
        cx, cy = st.get("center", [W / 2, H / 2])
        col = rgba(st["color"])[:3] + (255,)
        self.variants = []
        for _ in range(3):
            im = Image.new("RGBA", (W * S, H * S), (0, 0, 0, 0))
            d = ImageDraw.Draw(im)
            R = math.hypot(W, H) * S
            for _ in range(120):
                th = rnd.uniform(0, 2 * math.pi)
                dth = rnd.uniform(0.003, 0.011)
                r0 = rnd.uniform(400, 640) * S
                pts = [(cx * S + r0 * math.cos(th), cy * S + r0 * math.sin(th)),
                       (cx * S + R * math.cos(th - dth), cy * S + R * math.sin(th - dth)),
                       (cx * S + R * math.cos(th + dth), cy * S + R * math.sin(th + dth))]
                d.polygon(pts, fill=col)
            self.variants.append(with_opacity(im.resize((W, H), Image.LANCZOS), st.get("alpha", 0.6)))

    def frame(self, t, d):
        img = self.variants[int(t * self.fps / 2) % 3]
        op = clamp(t / 0.08) * (1 - clamp((t - (d - 0.15)) / 0.15))
        return [(with_opacity(img, op), 0, 0)]


class Flash:
    def __init__(self, st, W, H):
        self.col, self.size = rgba(st["color"])[:3], (W, H)

    def frame(self, t, d):
        a = clamp(t / 0.05) if t < 0.05 else 1 - ease_out_cubic(clamp((t - 0.05) / (d - 0.05)))
        return [(Image.new("RGBA", self.size, self.col + (int(255 * a),)), 0, 0)]


# ---------------------------------------------------------------- loading
def load_styles(path):
    with open(path, encoding="utf-8") as fp:
        raw = {k: v for k, v in json.load(fp).items() if not k.startswith("_")}

    def resolve(name):
        st = raw[name]
        if "extends" in st:
            base = resolve(st["extends"])
            st = {**base, **{k: v for k, v in st.items() if k != "extends"}}
        return st

    return {k: resolve(k) for k in raw}


def make_item(it, styles, W, H, fps):
    st = styles[it["style"]]
    if st.get("effect") == "speedlines":
        return SpeedLines(st, W, H, fps)
    if st.get("effect") == "flash":
        return Flash(st, W, H)
    pos = it.get("pos", st.get("pos", [W / 2, H / 2]))
    if st.get("group"):
        return GroupItem(st, styles, it.get("label", ""), it["text"], pos)
    return TextItem(st, it["text"], pos)
