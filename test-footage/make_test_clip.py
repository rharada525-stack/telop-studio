"""Windows の音声合成で「しゃべっている仮素材」を作る（無言の間をわざと入れてある）。"""
import os, subprocess, sys, wave, tempfile
import numpy as np
from PIL import Image, ImageDraw, ImageFont
import imageio_ffmpeg

HERE = os.path.dirname(os.path.abspath(__file__))
LINES = [("どうも、こんにちは。", 1.4), ("今日はですね、", 0.9),
         ("コンビニコーヒーを、もっと美味しく飲む方法を紹介します。", 1.6),
         ("まず一つ目。", 1.0), ("氷は先に揺らしておくと、味が薄まりません。", 1.3),
         ("えーと、二つ目は、フタを開けるのは飲む直前にすること。", 1.2),
         ("香りが全然違うんです。", 1.5), ("ぜひ試してみてください。", 1.0)]
SR = 48000
tmp = tempfile.mkdtemp()
ps = ["Add-Type -AssemblyName System.Speech", "$s=New-Object System.Speech.Synthesis.SpeechSynthesizer",
      "$s.SelectVoice('Microsoft Haruka Desktop')", "$s.Rate=1",
      "$f=New-Object System.Speech.AudioFormat.SpeechAudioFormatInfo(48000,[System.Speech.AudioFormat.AudioBitsPerSample]::Sixteen,[System.Speech.AudioFormat.AudioChannel]::Mono)"]
for i, (t, _) in enumerate(LINES):
    ps += [f"$s.SetOutputToWaveFile('{tmp}\{i}.wav',$f)", f"$s.Speak('{t}')"]
ps.append("$s.Dispose()")
subprocess.run(["powershell", "-NoProfile", "-Command", ";".join(ps)], check=True)

audio = [np.zeros(int(SR * 0.8))]
for i, (_, gap) in enumerate(LINES):
    with wave.open(f"{tmp}\{i}.wav") as w:
        audio.append(np.frombuffer(w.readframes(w.getnframes()), "<i2") / 32768)
    audio.append(np.zeros(int(SR * gap)))
a = np.concatenate(audio)
a += np.random.default_rng(0).normal(0, 0.002, len(a))  # 部屋の空気感（完全な無音にしない）
wav = os.path.join(tmp, "all.wav")
with wave.open(wav, "wb") as w:
    w.setnchannels(1); w.setsampwidth(2); w.setframerate(SR)
    w.writeframes((np.clip(a, -1, 1) * 32767).astype("<i2").tobytes())
dur = len(a) / SR

W, H, fps = 1080, 1920, 30
font = ImageFont.truetype(r"C:\Windows\Fonts\arial.ttf", 90)
jp = ImageFont.truetype(os.path.expandvars(r"%LOCALAPPDATA%\Microsoft\Windows\Fonts\NotoSansJP-Bold.otf"), 54)
base = Image.new("RGB", (W, H))
d = ImageDraw.Draw(base)
for y in range(H):
    c = int(40 + 50 * y / H)
    d.line([(0, y), (W, y)], fill=(c, c + 10, c + 25))
d.ellipse([340, 520, 740, 920], fill=(230, 200, 170))          # 頭
d.rounded_rectangle([200, 940, 880, 1700], 160, fill=(60, 110, 170))  # 体
d.text((W / 2, 1780), "テスト用の仮素材（音声合成）", font=jp, anchor="mm", fill=(255, 255, 255))
out = os.path.join(HERE, "talk_test.mp4")
p = subprocess.Popen([imageio_ffmpeg.get_ffmpeg_exe(), "-y", "-loglevel", "error", "-f", "rawvideo", "-pix_fmt", "rgb24",
                      "-s", f"{W}x{H}", "-r", str(fps), "-i", "-", "-i", wav, "-c:v", "libx264", "-pix_fmt", "yuv420p",
                      "-crf", "23", "-c:a", "aac", "-b:a", "160k", "-shortest", out], stdin=subprocess.PIPE)
for f in range(int(dur * fps)):
    im = base.copy()
    ImageDraw.Draw(im).text((W / 2, 300), f"{f / fps:05.2f}s", font=font, anchor="mm", fill=(255, 230, 80))
    p.stdin.write(im.tobytes())
p.stdin.close(); p.wait()
print(out, f"{dur:.1f}s")
