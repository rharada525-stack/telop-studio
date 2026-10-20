"""台本(script.json) + デザイン(styles.json) → Premiere 用素材一式 + プレビュー動画。

使い方:
    python build.py                 # 全部作る
    python build.py --preview-only  # プレビュー動画だけ（テロップ MOV を作らない）
    python build.py --script other.json
"""
import argparse
import json
import os
import subprocess
import sys
import time

import numpy as np
from PIL import Image

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, os.path.join(HERE, "engine"))

import imageio_ffmpeg  # noqa: E402

import bg as bgmod  # noqa: E402
import sfx as sfxmod  # noqa: E402
from premiere_xml import XmlWriter, pack_lanes  # noqa: E402
from telop import load_styles, make_item, paste  # noqa: E402

FF = imageio_ffmpeg.get_ffmpeg_exe()


def ffmpeg_pipe(out, W, H, fps, alpha, audio=None):
    args = [FF, "-y", "-loglevel", "error", "-f", "rawvideo", "-pix_fmt", "rgba" if alpha else "rgb24",
            "-s", f"{W}x{H}", "-r", str(fps), "-i", "-"]
    if audio:
        args += ["-i", audio]
    if alpha:
        args += ["-c:v", "prores_ks", "-profile:v", "4444", "-pix_fmt", "yuva444p10le",
                 "-alpha_bits", "8", "-vendor", "apl0", "-qscale:v", "11"]
    else:
        args += ["-c:v", "libx264", "-pix_fmt", "yuv420p", "-crf", "18", "-preset", "medium"]
    if audio:
        args += ["-c:a", "aac", "-b:a", "192k", "-shortest"]
    args.append(out)
    return subprocess.Popen(args, stdin=subprocess.PIPE)


def cover(img, W, H):
    s = max(W / img.width, H / img.height)
    img = img.resize((round(img.width * s), round(img.height * s)), Image.LANCZOS)
    x, y = (img.width - W) // 2, (img.height - H) // 2
    return img.crop((x, y, x + W, y + H))


def zoomed(img, z):
    W, H = img.size
    return img.transform((W, H), Image.AFFINE,
                         (1 / z, 0, W / 2 - W / (2 * z), 0, 1 / z, H / 2 - H / (2 * z)), Image.BICUBIC)


def label(it):
    txt = (it.get("label", "") + " " + it.get("text", "")).strip().replace("{", "").replace("}", "")
    return f"[{it['style']}] {txt.splitlines()[0] if txt else ''}".strip()


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--script", default=os.path.join(HERE, "script.json"))
    ap.add_argument("--styles", default=os.path.join(HERE, "styles.json"))
    ap.add_argument("--out", default=os.path.join(HERE, "output"))
    ap.add_argument("--preview-only", action="store_true")
    args = ap.parse_args()

    with open(args.script, encoding="utf-8") as fp:
        sc = json.load(fp)
    styles = load_styles(args.styles)
    W, H, fps = sc["width"], sc["height"], sc["fps"]
    total = round(sc["duration"] * fps)
    out = args.out
    for d in ("bg", "sfx", "telops"):
        os.makedirs(os.path.join(out, d), exist_ok=True)
    fr = lambda sec: round(sec * fps)  # noqa: E731

    # ---- 背景（assets/bg/<名前>.png|jpg があればそれを使う）
    t0 = time.time()
    generated = bgmod.make_all(W, H)
    bgs = {}
    for s in sc["scenes"]:
        name = s["bg"]
        if name in bgs:
            continue
        user = [os.path.join(HERE, "assets", "bg", name + e) for e in (".png", ".jpg", ".jpeg")]
        user = [p for p in user if os.path.exists(p)]
        img = cover(Image.open(user[0]).convert("RGB"), W, H) if user else generated[name]
        img.save(os.path.join(out, "bg", name + ".png"))
        bgs[name] = img
    print(f"背景 {len(bgs)}枚  {time.time() - t0:.1f}s")

    # ---- テロップ
    items = []
    for i, it in enumerate(sc["items"]):
        st = styles[it["style"]]
        obj = make_item(it, styles, W, H, fps)
        items.append(dict(idx=i, it=it, st=st, obj=obj, start=fr(it["t"]), end=fr(it["t"] + it["d"]),
                          z=st.get("z", 5), name=f"{i:02d}_{it['style']}.mov"))
    print(f"テロップ {len(items)}個 準備完了")

    # ---- 効果音
    t0 = time.time()
    master = np.zeros((int(sc["duration"] * sfxmod.SR) + sfxmod.SR, 2))
    sfx_events, cache = [], {}
    for x in items:
        it, st = x["it"], x["st"]
        name = it.get("sfx", st.get("sfx")) if "sfx" in it else st.get("sfx")
        if not name:
            continue
        off = it.get("sfx_offset", st.get("sfx_offset", 0.0))
        if name not in cache:
            cache[name] = sfxmod.render(name)
            sfxmod.write_wav(os.path.join(out, "sfx", name + ".wav"), cache[name])
        snd = cache[name]
        s0 = int((it["t"] + off) * sfxmod.SR)
        n = min(len(snd), len(master) - s0)
        master[s0:s0 + n] += snd[:n]
        sfx_events.append(dict(name=f"SE {name}", path=os.path.join(out, "sfx", name + ".wav"),
                               start=fr(it["t"] + off), end=fr(it["t"] + off) + max(1, round(len(snd) / sfxmod.SR * fps)),
                               kind="audio"))
    peak = np.max(np.abs(master))
    if peak > 0.97:
        master *= 0.97 / peak
    mix_path = os.path.join(out, "sfx", "_mix.wav")
    sfxmod.write_wav(mix_path, master[: int(sc["duration"] * sfxmod.SR)])
    print(f"効果音 {len(cache)}種 / {len(sfx_events)}回  {time.time() - t0:.1f}s")

    # ---- テロップ MOV（アルファ付き ProRes 4444）
    if not args.preview_only:
        t0 = time.time()
        for x in items:
            p = ffmpeg_pipe(os.path.join(out, "telops", x["name"]), W, H, fps, alpha=True)
            d = (x["end"] - x["start"]) / fps
            for f in range(x["end"] - x["start"]):
                frame = Image.new("RGBA", (W, H), (0, 0, 0, 0))
                for img, px, py in x["obj"].frame(f / fps, d):
                    paste(frame, img, px, py)
                p.stdin.write(frame.tobytes())
            p.stdin.close()
            p.wait()
            print(f"  {x['name']}")
        print(f"テロップ MOV  {time.time() - t0:.1f}s")

    # ---- プレビュー動画
    t0 = time.time()
    preview = os.path.join(out, "preview.mp4")
    p = ffmpeg_pipe(preview, W, H, fps, alpha=False, audio=mix_path)
    order = sorted(items, key=lambda x: (x["z"], x["idx"]))
    snaps = {}
    snap_at = [fr(t) for t in (0.4, 1.4, 4.2, 6.5, 9.8, 13.5, 19.6, 21.6, 23.5, 25.5, 28.6, 30.4)]
    for f in range(total):
        scene = next(s for s in reversed(sc["scenes"]) if fr(s["t"]) <= f)
        z0, z1 = scene.get("zoom", [1, 1])
        sp = (f - fr(scene["t"])) / max(1, fr(scene["d"]) - 1)
        frame = zoomed(bgs[scene["bg"]], z0 + (z1 - z0) * sp).convert("RGBA")
        for x in order:
            if x["start"] <= f < x["end"]:
                for img, px, py in x["obj"].frame((f - x["start"]) / fps, (x["end"] - x["start"]) / fps):
                    paste(frame, img, px, py)
        rgb = frame.convert("RGB")
        if f in snap_at:
            snaps[f] = rgb.copy()
        p.stdin.write(rgb.tobytes())
    p.stdin.close()
    p.wait()
    print(f"プレビュー {preview}  {time.time() - t0:.1f}s")

    # コンタクトシート
    tw, th = W // 4, H // 4
    sheet = Image.new("RGB", (tw * 6, th * 2), (20, 20, 20))
    for i, f in enumerate(sorted(snaps)):
        sheet.paste(snaps[f].resize((tw, th), Image.LANCZOS), ((i % 6) * tw, (i // 6) * th))
    sheet.save(os.path.join(out, "contact_sheet.jpg"), quality=90)

    # ---- Premiere 用 XML
    if not args.preview_only:
        xw = XmlWriter(fps, W, H)
        bg_track = [dict(name=f"BG {s['bg']}", path=os.path.join(out, "bg", s["bg"] + ".png"),
                         start=fr(s["t"]), end=fr(s["t"] + s["d"]), kind="still", zoom=s.get("zoom"))
                    for s in sc["scenes"]]
        vtracks = [bg_track]
        for z in sorted({x["z"] for x in items}):
            clips = [dict(name=label(x["it"]), path=os.path.join(out, "telops", x["name"]),
                          start=x["start"], end=x["end"], kind="video") for x in items if x["z"] == z]
            vtracks += pack_lanes(clips)
        atracks = pack_lanes(sfx_events)
        markers = [(fr(s["t"]), s.get("marker", "")) for s in sc["scenes"]]
        xml = xw.sequence(sc.get("title", "Short"), total, vtracks, atracks, markers)
        xml_path = os.path.join(out, "ShortTemplate.xml")
        with open(xml_path, "w", encoding="utf-8") as fp:
            fp.write(xml)
        print(f"Premiere XML {xml_path}  (V{len(vtracks)} / A{len(atracks)})")


if __name__ == "__main__":
    main()
