// MP4/MOV を「必要な部分だけ少しずつ」読んで WebCodecs でデコードする。
// ファイル全体をメモリに載せないので、数GBの素材でもメモリ使用量はほぼ一定。
// mp4box.js（index.html で読み込み済みの window.MP4Box / window.DataStream）で目次（moov）だけを解析する。

const CHUNK = 4 << 20; // 目次を探すときに一度に読む量

// 目次だけを解析して、映像・音声のサンプル表（位置と大きさ）を返す。MP4/MOV 以外なら null
export async function openMedia(file) {
  const MP4Box = window.MP4Box;
  if (!MP4Box) return null;
  const mp4 = MP4Box.createFile(false);
  let info = null, failed = false;
  mp4.onReady = (i) => (info = i);
  mp4.onError = () => (failed = true);
  let pos = 0;
  // スマホの動画は目次がファイルの最後にあることが多い。mp4box が「次はここを読んで」と返す位置へ飛ぶ
  for (let guard = 0; !info && !failed && pos < file.size && guard < 2000; guard++) {
    const buf = await file.slice(pos, pos + CHUNK).arrayBuffer();
    buf.fileStart = pos;
    const next = mp4.appendBuffer(buf);
    pos = next > pos ? next : pos + buf.byteLength;
  }
  mp4.flush();
  if (!info || !info.videoTracks.length) return null;

  const vt = info.videoTracks[0];
  const vtrak = mp4.getTrackById(vt.id);
  const vconfig = {
    codec: vt.codec.startsWith("vp08") ? "vp8" : vt.codec,
    codedWidth: vt.video.width,
    codedHeight: vt.video.height,
    description: boxDescription(vtrak),
  };
  if (!(await VideoDecoder.isConfigSupported(vconfig)).supported)
    throw new Error(`この動画形式（${vt.codec}）はこのパソコンでは読めません。H.264 の MP4 に変換してください。`);
  // スマホの縦動画は「横で撮って回転情報を付ける」ことが多い
  const [a, b] = vt.matrix || [65536, 0];
  const rotation = ((Math.round((Math.atan2(b, a) * 180) / Math.PI) % 360) + 360) % 360;
  const vsamples = vtrak.samples.map(slim);

  let audio = null;
  const at = info.audioTracks[0];
  if (at) {
    const atrak = mp4.getTrackById(at.id);
    audio = {
      config: {
        codec: at.codec,
        sampleRate: at.audio.sample_rate,
        numberOfChannels: at.audio.channel_count,
        description: esdsDescription(atrak),
      },
      samples: atrak.samples.map(slim),
      duration: at.duration / at.timescale,
    };
    if (!(await AudioDecoder.isConfigSupported(audio.config)).supported) audio = null;
  }
  return {
    file,
    duration: info.duration / info.timescale,
    video: { config: vconfig, rotation, samples: vsamples, keyframes: vsamples.filter((s) => s.sync) },
    audio,
  };
}

// 中身（data）は持たず、位置と時刻だけ覚えておく
function slim(s, i) {
  return { i, offset: s.offset, size: s.size, t: s.cts / s.timescale, dur: s.duration / s.timescale, sync: s.is_sync };
}

function boxDescription(trak) {
  for (const entry of trak.mdia.minf.stbl.stsd.entries) {
    const box = entry.avcC || entry.hvcC || entry.vpcC || entry.av1C;
    if (box) {
      const stream = new window.DataStream(undefined, 0, window.DataStream.BIG_ENDIAN);
      box.write(stream);
      return new Uint8Array(stream.buffer, 8);
    }
  }
  return undefined;
}

function esdsDescription(trak) {
  const e = trak.mdia.minf.stbl.stsd.entries[0];
  const d = e && e.esds && e.esds.esd && e.esds.esd.descs[0] && e.esds.esd.descs[0].descs[0];
  return d && d.data ? new Uint8Array(d.data) : undefined;
}

// i 番目から、ファイル上で連続しているサンプルをまとめて読む（最大 maxBytes）
async function readRun(file, samples, i, maxBytes = 8 << 20, maxCount = 120) {
  let j = i + 1, end = samples[i].offset + samples[i].size;
  while (j < samples.length && j - i < maxCount && samples[j].offset === end && end - samples[i].offset < maxBytes) {
    end += samples[j].size;
    j++;
  }
  const buf = new Uint8Array(await file.slice(samples[i].offset, end).arrayBuffer());
  const out = [];
  for (let k = i; k < j; k++) {
    const o = samples[k].offset - samples[i].offset;
    out.push(buf.subarray(o, o + samples[k].size));
  }
  return out;
}

// ---------------------------------------------------------------- audio
// 音声トラックを少しずつデコードして AudioBuffer にする（映像部分は読まない）
export async function decodeAudioTrack(media, onProgress) {
  const { config, samples, duration } = media.audio;
  const sr = config.sampleRate, nch = config.numberOfChannels;
  const length = Math.ceil((duration + 1) * sr);
  const chans = Array.from({ length: nch }, () => new Float32Array(length));
  let maxEnd = 0, failure = null;
  const dec = new AudioDecoder({
    output: (ad) => {
      const start = Math.max(0, Math.round((ad.timestamp / 1e6) * sr));
      const n = Math.min(ad.numberOfFrames, length - start);
      if (n > 0) {
        for (let c = 0; c < nch; c++) {
          const tmp = new Float32Array(ad.numberOfFrames);
          ad.copyTo(tmp, { planeIndex: c, format: "f32-planar" });
          chans[c].set(tmp.subarray(0, n), start);
        }
        maxEnd = Math.max(maxEnd, start + n);
      }
      ad.close();
    },
    error: (e) => (failure = e),
  });
  dec.configure(config);
  let i = 0;
  while (i < samples.length) {
    if (failure) throw failure;
    const run = await readRun(media.file, samples, i, 2 << 20, 400);
    run.forEach((data, k) => {
      const s = samples[i + k];
      dec.decode(new EncodedAudioChunk({ type: "key", timestamp: Math.round(s.t * 1e6), duration: Math.round(s.dur * 1e6), data }));
    });
    i += run.length;
    if (dec.decodeQueueSize > 200) await new Promise((r) => dec.addEventListener("dequeue", r, { once: true }));
    onProgress?.(i / samples.length);
  }
  await dec.flush();
  dec.close();
  if (failure) throw failure;
  const buf = new AudioBuffer({ length: Math.max(1, maxEnd), numberOfChannels: nch, sampleRate: sr });
  chans.forEach((ch, c) => buf.copyToChannel(ch.subarray(0, buf.length), c));
  return buf;
}

// ---------------------------------------------------------------- video
// 時刻を前に進めながらフレームを取り出す。大きく先へ飛ぶときはキーフレームからデコードし直す
export class FrameReader {
  constructor(media) {
    this.file = media.file;
    this.v = media.video;
    this.queue = [];
    this.error = null;
    this.decoder = new VideoDecoder({ output: (f) => this.queue.push(f), error: (e) => (this.error = e) });
    this.start(0);
  }

  start(si) {
    for (const f of [this.cur, this.next, ...this.queue]) f?.close();
    this.queue = [];
    this.cur = this.next = null;
    this.si = si;
    this.done = false;
    if (this.decoder.state === "configured") this.decoder.reset();
    this.decoder.configure(this.v.config);
  }

  async pull() {
    const s = this.v.samples;
    while (!this.queue.length) {
      if (this.error) throw this.error;
      if (this.si < s.length) {
        if (this.decoder.decodeQueueSize < 12) {
          const run = await readRun(this.file, s, this.si, 16 << 20, 30);
          run.forEach((data, k) => {
            const x = s[this.si + k];
            this.decoder.decode(new EncodedVideoChunk({
              type: x.sync ? "key" : "delta", timestamp: Math.round(x.t * 1e6), duration: Math.round(x.dur * 1e6), data,
            }));
          });
          this.si += run.length;
        } else {
          await Promise.race([
            new Promise((r) => this.decoder.addEventListener("dequeue", r, { once: true })),
            new Promise((r) => setTimeout(r, 30)),
          ]);
        }
      } else if (!this.done) {
        await this.decoder.flush();
        this.done = true;
      } else {
        return null;
      }
    }
    return this.queue.shift();
  }

  // 時刻 t（元動画の秒）に表示されるフレーム
  async frameAt(t) {
    const curT = this.cur ? this.cur.timestamp / 1e6 : -Infinity;
    if (t < curT - 1e-3 || t - curT > 2) {
      // 2秒以上先（カットで飛ばす区間）や後ろに戻るときは、直前のキーフレームから始め直す
      const k = lastKeyframe(this.v.keyframes, t);
      const fedT = this.si > 0 ? this.v.samples[this.si - 1].t : -Infinity;
      if (t < curT - 1e-3 || k.t > fedT) this.start(k.i);
    }
    if (!this.cur) this.cur = await this.pull();
    if (this.next === null && !this.done) this.next = await this.pull();
    while (this.next && this.next.timestamp / 1e6 <= t + 1 / 240) {
      this.cur.close();
      this.cur = this.next;
      this.next = await this.pull();
    }
    return this.cur;
  }

  close() {
    for (const f of [this.cur, this.next, ...this.queue]) f?.close();
    if (this.decoder.state !== "closed") this.decoder.close();
  }
}

function lastKeyframe(keys, t) {
  let lo = 0, hi = keys.length - 1, ans = keys[0];
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (keys[mid].t <= t + 1e-3) { ans = keys[mid]; lo = mid + 1; } else hi = mid - 1;
  }
  return ans;
}
