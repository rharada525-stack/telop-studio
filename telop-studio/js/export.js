// MP4 書き出し（WebCodecs + mp4-muxer）。すべてブラウザ内で処理する。
import { Muxer, ArrayBufferTarget } from "https://cdn.jsdelivr.net/npm/mp4-muxer@5.2.2/build/mp4-muxer.mjs";
import { FPS } from "./render.js";
import { totalDuration, outToSrc } from "./timeline.js";
import { FrameReader } from "./decode.js";

const SR = 48000;

// カット済みの音声（複数素材）+ 効果音をミックス
export async function mixAudio(clips, segs, sfxEvents, sfxBuffers, gains = { voice: 1, sfx: 1 }) {
  const total = totalDuration(segs);
  const off = new OfflineAudioContext(2, Math.ceil(total * SR), SR);
  // 最後にリミッターを通して、音割れしないようにする
  const limiter = new DynamicsCompressorNode(off, { threshold: -3, knee: 0, ratio: 20, attack: 0.002, release: 0.1 });
  limiter.connect(off.destination);
  const voiceBus = new GainNode(off, { gain: gains.voice });
  const sfxBus = new GainNode(off, { gain: gains.sfx });
  voiceBus.connect(limiter);
  sfxBus.connect(limiter);
  const fade = 0.006;
  for (const s of segs) {
    const c = clips[s.clip];
    const len = s.end - s.start;
    const src = off.createBufferSource();
    src.buffer = c.audio;
    const g = off.createGain();
    g.gain.setValueAtTime(0, s.out);
    g.gain.linearRampToValueAtTime(1, s.out + fade);
    g.gain.setValueAtTime(1, s.out + len - fade);
    g.gain.linearRampToValueAtTime(0, s.out + len);
    src.connect(g).connect(voiceBus);
    src.start(s.out, s.start - c.offset, len);
  }
  for (const e of sfxEvents) {
    const b = sfxBuffers[e.name];
    if (!b || e.t >= total) continue;
    const src = off.createBufferSource();
    src.buffer = b;
    src.connect(sfxBus);
    src.start(Math.max(0, e.t));
  }
  return off.startRendering();
}

async function pickVideoCodec(W, H) {
  for (const codec of ["avc1.640028", "avc1.4d0028", "avc1.640033"]) {
    const cfg = { codec, width: W, height: H, bitrate: 10_000_000, framerate: FPS };
    if ((await VideoEncoder.isConfigSupported(cfg)).supported) return cfg;
  }
  throw new Error("このブラウザは H.264 の書き出しに対応していません（Chrome か Edge を使ってください）");
}

async function pickAudioCodec() {
  const aac = { codec: "mp4a.40.2", sampleRate: SR, numberOfChannels: 2, bitrate: 192000 };
  if ((await AudioEncoder.isConfigSupported(aac)).supported) return { cfg: aac, mux: "aac" };
  return { cfg: { codec: "opus", sampleRate: SR, numberOfChannels: 2, bitrate: 160000 }, mux: "opus" };
}

const waitSeek = (video, t) =>
  new Promise((res) => {
    video.addEventListener("seeked", res, { once: true });
    video.currentTime = t;
  });

export async function exportMp4({ clips, segs, renderer, layout, audio, onProgress, signal }) {
  const { W, H } = renderer;
  const vcfg = await pickVideoCodec(W, H);
  const { cfg: acfg, mux } = await pickAudioCodec();
  const target = new ArrayBufferTarget();
  const muxer = new Muxer({
    target,
    video: { codec: "avc", width: W, height: H, frameRate: FPS },
    audio: { codec: mux, numberOfChannels: 2, sampleRate: SR },
    fastStart: "in-memory",
    firstTimestampBehavior: "offset",
  });
  let failure = null;
  const venc = new VideoEncoder({ output: (c, m) => muxer.addVideoChunk(c, m), error: (e) => (failure = e) });
  venc.configure(vcfg);
  const aenc = new AudioEncoder({ output: (c, m) => muxer.addAudioChunk(c, m), error: (e) => (failure = e) });
  aenc.configure(acfg);

  // 音声
  const step = 4800;
  for (let i = 0; i < audio.length; i += step) {
    const n = Math.min(step, audio.length - i);
    const data = new Float32Array(n * 2);
    data.set(audio.getChannelData(0).subarray(i, i + n), 0);
    data.set(audio.getChannelData(1).subarray(i, i + n), n);
    const ad = new AudioData({ format: "f32-planar", sampleRate: SR, numberOfFrames: n, numberOfChannels: 2, timestamp: Math.round((i / SR) * 1e6), data });
    aenc.encode(ad);
    ad.close();
  }

  // 映像
  const canvas = Object.assign(document.createElement("canvas"), { width: W, height: H });
  const ctx = canvas.getContext("2d");
  const total = totalDuration(segs);
  const encodeFrame = async (n) => {
    const vf = new VideoFrame(canvas, { timestamp: Math.round((n / FPS) * 1e6), duration: Math.round(1e6 / FPS) });
    venc.encode(vf, { keyFrame: n % (FPS * 2) === 0 });
    vf.close();
    if (venc.encodeQueueSize > 6) await new Promise((r) => venc.addEventListener("dequeue", r, { once: true }));
  };

  if (clips.every((c) => c.media)) {
    // MP4/MOV: 必要な部分だけ読んで直接デコード（速い・タブが裏でも止まらない・数GBでもOK）
    const readers = new Map(); // 素材ごとのデコーダー。次の素材に移ったら前のは閉じる
    try {
      const nFrames = Math.round(total * FPS);
      for (let n = 0; n < nFrames; n++) {
        if (signal?.aborted) throw new Error("中止しました");
        if (failure) throw failure;
        const ft = n / FPS;
        const { src, seg } = outToSrc(segs, ft);
        const ci = segs[seg].clip, c = clips[ci];
        if (!readers.has(ci)) {
          for (const [k, r] of readers) { r.close(); readers.delete(k); }
          readers.set(ci, new FrameReader(c.media));
        }
        const frame = await readers.get(ci).frameAt(Math.min(src - c.offset, c.duration - 0.001));
        renderer.draw(ctx, ft, frame, layout, c.media.video.rotation);
        await encodeFrame(n);
        if (n % 10 === 0) onProgress?.(n / nFrames);
      }
    } finally {
      for (const r of readers.values()) r.close();
    }
  } else {
    // MP4/MOV 以外（1本のみ）: 再生しながら取り込む（タブを開いたままにする必要がある）
    const video = clips[0].video;
    const wasMuted = video.muted;
    video.muted = true;
    let nextFrame = 0;
    try {
      for (const s of segs) {
        await waitSeek(video, s.start);
        const segEndOut = s.out + (s.end - s.start);
        await new Promise((resolve, reject) => {
          const onFrame = async (_now, meta) => {
            if (signal?.aborted) { video.pause(); return reject(new Error("中止しました")); }
            if (failure) { video.pause(); return reject(failure); }
            const outT = s.out + Math.max(0, meta.mediaTime - s.start);
            while (nextFrame / FPS <= Math.min(outT, segEndOut - 1e-3)) {
              renderer.draw(ctx, nextFrame / FPS, video, layout);
              await encodeFrame(nextFrame++);
            }
            onProgress?.(Math.min(1, outT / total));
            if (meta.mediaTime >= s.end - 0.5 / FPS || video.ended) { video.pause(); resolve(); }
            else video.requestVideoFrameCallback(onFrame);
          };
          video.requestVideoFrameCallback(onFrame);
          video.play().catch(reject);
        });
      }
    } finally {
      video.muted = wasMuted;
    }
  }
  await venc.flush();
  await aenc.flush();
  if (failure) throw failure;
  muxer.finalize();
  return new Blob([target.buffer], { type: "video/mp4" });
}
