"""2人の会話のテスト素材を作る（音声合成。話者Bは声の高さを下げて別人に聞こえるようにする）。"""
import os
import subprocess
import tempfile
import wave

import imageio_ffmpeg
import numpy as np
from PIL import Image, ImageDraw, ImageFont

HERE = os.path.dirname(os.path.abspath(__file__))
FF = imageio_ffmpeg.get_ffmpeg_exe()
SR = 48000
LINES = [
    ("A", "今日はゲストに来ていただきました。", 0.6),
    ("B", "よろしくお願いします。", 0.7),
    ("A", "さっそくですが、コーヒーはよく飲みますか？", 0.6),
    ("B", "毎朝コンビニで買っています。", 0.5),
    ("B", "特にアイスコーヒーが好きですね。", 0.8),
    ("A", "実は美味しく飲むコツがあるんですよ。", 0.6),
    ("B", "えっ、本当ですか？", 0.7),
    ("A", "氷を先に揺らしておくと、味が薄まらないんです。", 0.9),
]

tmp = tempfile.mkdtemp()
ps = ["Add-Type -AssemblyName System.Speech", "$s=New-Object System.Speech.Synthesis.SpeechSynthesizer",
      "$s.SelectVoice('Microsoft Haruka Desktop')",
      "$f=New-Object System.Speech.AudioFormat.SpeechAudioFormatInfo(48000,[System.Speech.AudioFormat.AudioBitsPerSample]::Sixteen,[System.Speech.AudioFormat.AudioChannel]::Mono)"]
for i, (_, t, _) in enumerate(LINES):
    ps += [f"$s.SetOutputToWaveFile('{tmp}\\{i}.wav',$f)", f"$s.Speak('{t}')"]
ps.append("$s.Dispose()")
subprocess.run(["powershell", "-NoProfile", "-Command", ";".join(ps)], check=True)


def read(p):
    with wave.open(p) as w:
        return np.frombuffer(w.readframes(w.getnframes()), "<i2").astype(np.float32) / 32768


parts, marks, t = [np.zeros(int(SR * 0.6))], [], 0.6
for i, (who, _, gap) in enumerate(LINES):
    src = f"{tmp}\\{i}.wav"
    if who == "B":
        # 声を低く・少しゆっくりにして別人っぽくする
        dst = f"{tmp}\\{i}_b.wav"
        subprocess.run([FF, "-y", "-loglevel", "error", "-i", src, "-af",
                        f"asetrate={SR}*0.78,aresample={SR},atempo=1.18", dst], check=True)
        src = dst
    a = read(src)
    marks.append((who, t, t + len(a) / SR))
    parts += [a, np.zeros(int(SR * gap))]
    t += len(a) / SR + gap
audio = np.concatenate(parts)
audio += np.random.default_rng(1).normal(0, 0.002, len(audio))
wav = f"{tmp}\\all.wav"
with wave.open(wav, "wb") as w:
    w.setnchannels(1); w.setsampwidth(2); w.setframerate(SR)
    w.writeframes((np.clip(audio, -1, 1) * 32767).astype("<i2").tobytes())

W, H, fps = 1920, 1080, 30
jp = ImageFont.truetype(os.path.expandvars(r"%LOCALAPPDATA%\Microsoft\Windows\Fonts\NotoSansJP-Bold.otf"), 48)
base = Image.new("RGB", (W, H), (40, 46, 58))
d = ImageDraw.Draw(base)
for x, col, name in ((560, (60, 110, 170), "A"), (1360, (170, 80, 70), "B")):
    d.ellipse([x - 130, 260, x + 130, 520], fill=(230, 200, 170))
    d.rounded_rectangle([x - 230, 540, x + 230, 1000], 120, fill=col)
    d.text((x, 200), f"話者{name}", font=jp, anchor="mm", fill=(255, 255, 255))
out = os.path.join(HERE, "_tmp", "dialogue_test.mp4")
os.makedirs(os.path.dirname(out), exist_ok=True)
p = subprocess.Popen([FF, "-y", "-loglevel", "error", "-f", "rawvideo", "-pix_fmt", "rgb24", "-s", f"{W}x{H}", "-r", str(fps),
                      "-i", "-", "-i", wav, "-c:v", "libx264", "-pix_fmt", "yuv420p", "-crf", "26", "-c:a", "aac", "-shortest", out],
                     stdin=subprocess.PIPE)
for f in range(int(len(audio) / SR * fps)):
    tt = f / fps
    im = base.copy()
    for who, a, b in marks:  # 話している人を光らせる
        if a <= tt <= b:
            x = 560 if who == "A" else 1360
            ImageDraw.Draw(im).ellipse([x - 140, 250, x + 140, 530], outline=(255, 230, 80), width=10)
    p.stdin.write(im.tobytes())
p.stdin.close()
p.wait()
print(out)
for m in marks:
    print(f"{m[0]} {m[1]:.2f}-{m[2]:.2f}")
