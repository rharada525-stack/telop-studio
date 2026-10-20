"""効果音シンセサイザー（著作権フリー・全てコードで合成）。48kHz / 16bit / ステレオ。"""
import math
import wave

import numpy as np

SR = 48000
rng = np.random.default_rng(42)


def t_axis(dur):
    return np.arange(int(SR * dur)) / SR


def sweep(f0, f1, dur, curve=1.0):
    """f0→f1 の周波数スイープ正弦波。"""
    t = t_axis(dur)
    f = f0 + (f1 - f0) * (t / dur) ** curve
    return np.sin(2 * np.pi * np.cumsum(f) / SR)


def env_exp(dur, tau, attack=0.002):
    t = t_axis(dur)
    return np.minimum(1, t / attack) * np.exp(-t / tau)


def lowpass(x, fc):
    """1次ローパス（ゼロ位相で2回）。"""
    a = math.exp(-2 * math.pi * fc / SR)
    for _ in range(2):
        y = np.empty_like(x)
        acc = 0.0
        for i, v in enumerate(x):
            acc = (1 - a) * v + a * acc
            y[i] = acc
        x = y[::-1]
    return x


def fft_band(x, lo, hi):
    X = np.fft.rfft(x)
    f = np.fft.rfftfreq(len(x), 1 / SR)
    X[(f < lo) | (f > hi)] = 0
    return np.fft.irfft(X, len(x))


def svf_sweep(x, f0, f1, q=2.5, curve=1.0):
    """周波数が動くバンドパス（ステート変数フィルタ）。"""
    n = len(x)
    fc = f0 + (f1 - f0) * (np.arange(n) / n) ** curve
    F = 2 * np.sin(np.pi * fc / SR)
    lp = bp = 0.0
    y = np.empty(n)
    damp = 1 / q
    for i in range(n):
        hp = x[i] - lp - damp * bp
        bp += F[i] * hp
        lp += F[i] * bp
        y[i] = bp
    return y


def reverb(x, dur=0.8, mix=0.18, bright=5000):
    ir = rng.standard_normal(int(SR * dur)) * np.exp(-t_axis(dur) / (dur / 5))
    ir = fft_band(ir, 150, bright)
    ir /= np.sqrt(np.sum(ir ** 2))
    n = len(x) + len(ir)
    wet = np.fft.irfft(np.fft.rfft(x, n) * np.fft.rfft(ir, n), n)
    out = np.zeros(n)
    out[:len(x)] += x
    return out + mix * wet


def pad(x, dur):
    out = np.zeros(int(SR * dur))
    out[:min(len(x), len(out))] = x[:len(out)]
    return out


def norm(x, peak_db=-3.0):
    return x / (np.max(np.abs(x)) + 1e-9) * 10 ** (peak_db / 20)


# ---------------------------------------------------------------- sounds
def don():
    """ドンッ（重低音インパクト）"""
    d = 1.2
    sub = sweep(150, 42, d, 0.25) * env_exp(d, 0.38)
    mid = sweep(380, 90, d, 0.3) * env_exp(d, 0.06)
    click = lowpass(rng.standard_normal(int(SR * d)), 3000) * env_exp(d, 0.012)
    x = sub * 1.0 + mid * 0.45 + click * 0.9
    x = np.tanh(x * 2.2)
    return norm(reverb(x, 1.0, 0.12, 2500), -1.5)


def pop():
    """ポンッ"""
    d = 0.22
    x = sweep(420, 980, d, 0.15) * env_exp(d, 0.05, 0.001)
    x += 0.3 * sweep(840, 1960, d, 0.15) * env_exp(d, 0.03, 0.001)
    return norm(reverb(x, 0.3, 0.1), -4)


def whoosh():
    """シュッ（左→右に抜ける風切り）"""
    d = 0.5
    n = rng.standard_normal(int(SR * d))
    x = svf_sweep(n, 500, 4200, q=1.6, curve=1.4)
    t = t_axis(d)
    e = np.where(t < 0.2, (t / 0.2) ** 2, np.exp(-(t - 0.2) / 0.07))
    x = norm(x * e, -5)
    pan = np.clip(t / d, 0, 1)
    return np.stack([x * np.cos(pan * np.pi / 2) * 1.3, x * np.sin(pan * np.pi / 2) * 1.3], 1)


def kira():
    """キラーン（きらめき）"""
    d = 1.6
    x = np.zeros(int(SR * d))
    t = t_axis(d)
    notes = [2093, 2637, 3136, 4186, 5274]
    for i, f in enumerate(notes):
        st = int(SR * 0.035 * i)
        tt = t[: len(t) - st]
        tone = (np.sin(2 * np.pi * f * tt) + 0.25 * np.sin(2 * np.pi * f * 2.01 * tt))
        x[st:] += tone * np.exp(-tt / 0.35) * (1 + 0.35 * np.sin(2 * np.pi * 14 * tt))
    shimmer = fft_band(rng.standard_normal(len(x)), 6000, 14000) * env_exp(d, 0.25, 0.03) * 0.25
    x = x + shimmer
    return norm(reverb(x, 1.4, 0.35, 12000), -6)


def pikon():
    """ピコン！"""
    d = 0.32
    t = t_axis(d)
    f = np.where(t < 0.07, 1318.5, 1760.0)
    ph = np.cumsum(2 * np.pi * f / SR)
    x = np.sin(ph) + 0.18 * np.sin(3 * ph)
    e = np.where(t < 0.07, 1.0, np.exp(-(t - 0.07) / 0.07)) * np.minimum(1, t / 0.002)
    return norm(reverb(x * e, 0.4, 0.12), -6)


def question():
    """えっ!?（ポワン↑ と上がる疑問音）"""
    d = 0.45
    t = t_axis(d)
    f = 330 + 520 * (t / d) ** 1.6 + 18 * np.sin(2 * np.pi * 9 * t)
    ph = np.cumsum(2 * np.pi * f / SR)
    x = np.sin(ph) + 0.3 * np.sin(2 * ph) + 0.1 * np.sin(3 * ph)
    e = np.minimum(1, t / 0.01) * np.where(t > d - 0.12, (d - t) / 0.12, 1)
    return norm(reverb(x * e, 0.4, 0.15), -5)


def jan():
    """ジャン！（ブラス風コード + シンバル）"""
    d = 1.8
    t = t_axis(d)
    x = np.zeros(len(t))
    for f in (130.81, 261.63, 329.63, 392.0, 523.25, 659.25):
        for det in (-0.25, 0.25):
            ph = (f * (1 + det / 100) * t) % 1.0
            x += 2 * ph - 1  # ノコギリ波
    amp = np.minimum(1, t / 0.006) * np.exp(-t / 0.55)
    x = x * amp
    # フィルタを開いて閉じるブラスっぽさ（帯域を時間で分割して近似）
    bright = lowpass(x, 3500) * np.exp(-t / 0.25) + lowpass(x, 900) * (1 - np.exp(-t / 0.25))
    cym = fft_band(rng.standard_normal(len(t)), 4000, 16000) * env_exp(d, 0.45, 0.001)
    hit = sweep(120, 50, d, 0.3) * env_exp(d, 0.18)
    y = norm(bright) + 0.35 * norm(cym) + 0.6 * hit
    return norm(reverb(np.tanh(y * 1.3), 1.5, 0.25, 7000), -1.5)


def drumroll():
    """ドゥルルル…（クレッシェンドするスネアロール）1.7秒"""
    d = 1.7
    x = np.zeros(int(SR * d) + SR)
    hit_d = 0.09
    ht = t_axis(hit_d)
    i, t = 0, 0.0
    while t < d:
        rate = 22 + 10 * (t / d)
        vel = 0.25 + 0.75 * (t / d) ** 1.5
        vel *= 0.8 + 0.2 * rng.random()
        n = fft_band(rng.standard_normal(len(ht)), 1500, 9000) * np.exp(-ht / 0.03)
        body = np.sin(2 * np.pi * 190 * ht) * np.exp(-ht / 0.02)
        s = int(SR * t)
        x[s:s + len(ht)] += vel * (n + 0.6 * body)
        t += 1 / rate
        i += 1
    return norm(reverb(x[: int(SR * d)], 0.6, 0.15), -4)


SOUNDS = {
    "don": (don, 1.0),
    "pop": (pop, 0.7),
    "whoosh": (whoosh, 0.75),
    "kira": (kira, 0.6),
    "pikon": (pikon, 0.6),
    "question": (question, 0.65),
    "jan": (jan, 0.95),
    "drumroll": (drumroll, 0.6),
}


def to_stereo(x):
    return x if x.ndim == 2 else np.stack([x, x], 1)


def render(name):
    fn, gain = SOUNDS[name]
    return to_stereo(fn()) * gain


def write_wav(path, x):
    x = np.clip(to_stereo(x), -1, 1)
    data = (x * 32767).astype("<i2").tobytes()
    with wave.open(path, "wb") as w:
        w.setnchannels(2)
        w.setsampwidth(2)
        w.setframerate(SR)
        w.writeframes(data)
