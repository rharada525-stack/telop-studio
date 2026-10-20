"""仮背景（静止画）の生成。実写真に差し替えるときは同名の PNG を assets/bg に置くだけでよい。"""
import math
import random

import numpy as np
from PIL import Image, ImageDraw, ImageFilter

from telop import rgba, vgrad


def gradient(W, H, colors):
    g = vgrad(H, colors, 0, H)[:, None, :].repeat(W, 1)
    return Image.fromarray(g.astype(np.uint8), "RGBA")


def bokeh(img, seed, colors, n=40, rmin=30, rmax=140, blur=6, alpha=(40, 120)):
    rnd = random.Random(seed)
    W, H = img.size
    layer = Image.new("RGBA", img.size, (0, 0, 0, 0))
    d = ImageDraw.Draw(layer)
    for _ in range(n):
        r = rnd.uniform(rmin, rmax)
        x, y = rnd.uniform(-50, W + 50), rnd.uniform(-50, H + 50)
        c = rgba(rnd.choice(colors))[:3] + (int(rnd.uniform(*alpha)),)
        d.ellipse([x - r, y - r, x + r, y + r], fill=c)
    img.alpha_composite(layer.filter(ImageFilter.GaussianBlur(blur)))
    return img


def vignette(img, strength=0.55):
    W, H = img.size
    y, x = np.mgrid[0:H, 0:W]
    r = np.hypot((x - W / 2) / (W / 2), (y - H / 2) / (H / 2)) / math.sqrt(2)
    a = (np.clip(r - 0.35, 0, 1) / 0.65) ** 1.6 * strength
    layer = np.zeros((H, W, 4), np.uint8)
    layer[..., 3] = (a * 255).astype(np.uint8)
    img.alpha_composite(Image.fromarray(layer, "RGBA"))
    return img


def grain(img, amount=6, seed=1):
    a = np.asarray(img).astype(np.int16)
    n = np.random.default_rng(seed).integers(-amount, amount + 1, a.shape[:2])[..., None]
    a[..., :3] = np.clip(a[..., :3] + n, 0, 255)
    return Image.fromarray(a.astype(np.uint8), "RGBA")


def sunburst(img, center, color, rays=24, alpha=60):
    W, H = img.size
    layer = Image.new("RGBA", img.size, (0, 0, 0, 0))
    d = ImageDraw.Draw(layer)
    R = math.hypot(W, H)
    cx, cy = center
    c = rgba(color)[:3] + (alpha,)
    for i in range(rays):
        a0 = 2 * math.pi * i / rays
        a1 = a0 + math.pi / rays
        d.polygon([(cx, cy), (cx + R * math.cos(a0), cy + R * math.sin(a0)),
                   (cx + R * math.cos(a1), cy + R * math.sin(a1))], fill=c)
    img.alpha_composite(layer.filter(ImageFilter.GaussianBlur(2)))
    return img


def make_all(W, H):
    warm = ["#ffd9a0", "#ffb870", "#fff0d0", "#ff9a5a"]
    out = {}

    im = gradient(W, H, ["#2a170d", "#5a3420", "#a8693c"])
    im = bokeh(im, 1, warm, n=34, rmin=60, rmax=190, blur=14, alpha=(30, 90))
    im = bokeh(im, 2, warm, n=50, rmin=15, rmax=50, blur=4, alpha=(60, 150))
    out["bg_cafe"] = grain(vignette(im))

    im = gradient(W, H, ["#13242e", "#24495a", "#5d8c96"])
    im = bokeh(im, 3, ["#d8f4ff", "#9fd8ea", "#ffffff"], n=40, rmin=50, rmax=170, blur=12, alpha=(25, 80))
    im = bokeh(im, 4, ["#ffffff", "#bfe9f7"], n=45, rmin=10, rmax=40, blur=3, alpha=(50, 130))
    out["bg_point"] = grain(vignette(im))

    im = gradient(W, H, ["#2b1a10", "#6b3f22", "#c08550"])
    im = bokeh(im, 5, ["#fff1d6", "#ffd09a"], n=36, rmin=50, rmax=170, blur=12, alpha=(25, 80))
    im = bokeh(im, 6, ["#ffffff", "#ffe6c2"], n=45, rmin=10, rmax=40, blur=3, alpha=(50, 130))
    out["bg_point2"] = grain(vignette(im))

    im = gradient(W, H, ["#3a0a00", "#a3320a", "#3a0a00"])
    im = sunburst(im, (W / 2, 880), "#ffcf4a", rays=28, alpha=55)
    im = bokeh(im, 7, ["#ffe08a", "#ffffff"], n=40, rmin=8, rmax=30, blur=3, alpha=(60, 160))
    out["bg_reveal"] = grain(vignette(im, 0.7))

    im = gradient(W, H, ["#ffdfe6", "#ffc3a8", "#ffa07a"])
    im = bokeh(im, 8, ["#ffffff", "#fff3e0"], n=50, rmin=30, rmax=150, blur=10, alpha=(50, 120))
    out["bg_end"] = grain(vignette(im, 0.3))
    return {k: v.convert("RGB") for k, v in out.items()}
