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

  // 音声: 音声トラックが複数ある（iPhone の空間オーディオなど）ときは、読める最初の1本を使う
  const soundTraks = mp4.moov.traks.filter((t) => t.mdia.hdlr.handler === "soun" && t.samples && t.samples.length);
  let audio = null;
  const unsupported = [];
  for (const trak of soundTraks) {
    const a = await describeAudio(file, trak);
    if (a) { audio = a; break; }
    unsupported.push(trak.mdia.minf.stbl.stsd.entries[0]?.type || "?");
  }
  return {
    file,
    duration: info.duration / info.timescale,
    video: { config: vconfig, rotation, samples: vsamples, keyframes: vsamples.filter((s) => s.sync) },
    audio,
    audioError: audio ? null : soundTraks.length ? `音声の形式（${unsupported.join("・")}）に対応していません。` : "音声の入っていない動画です。",
  };
}

// ---------------------------------------------------------------- audio track description
// QuickTime（iPhone の MOV など）は音声の設定が「wave」箱の中にあり mp4box が読めないので、stsd を自分で読む
const PCM_TYPES = { sowt: 1, twos: 1, in24: 1, in32: 1, fl32: 1, fl64: 1, lpcm: 1, raw: 1, NONE: 1 };

async function describeAudio(file, trak) {
  const stsd = trak.mdia.minf.stbl.stsd;
  const type = (stsd.entries[0]?.type || "").trim();
  const bytes = new Uint8Array(await file.slice(stsd.start, stsd.start + stsd.size).arrayBuffer());
  const sd = parseSoundDescription(bytes);
  if (!sd) return null;
  const sampleRate = sd.sampleRate || trak.mdia.mdhd.timescale;
  const duration = trak.mdia.mdhd.duration / trak.mdia.mdhd.timescale;

  if (PCM_TYPES[type] !== undefined) {
    const pcm = pcmFormat(type, sd);
    if (!pcm) return null;
    // 非圧縮音声は1フレーム=1サンプルで数が多いので、ファイル上で連続している塊にまとめておく
    const runs = [];
    const bpf = pcm.bytes * sd.channels;
    let frames = 0;
    for (const s of trak.samples) {
      const last = runs[runs.length - 1];
      if (last && last.offset + last.size === s.offset && last.size < 4 << 20) last.size += s.size;
      else runs.push({ offset: s.offset, size: s.size, frame: frames });
      frames += s.size / bpf;
    }
    return { pcm, runs, channels: sd.channels, sampleRate, duration };
  }

  let config;
  if (type === "mp4a") {
    const esds = findBox(bytes, "esds", 16);
    const dec = esds && parseEsds(bytes.subarray(esds.start + 12, esds.end));
    if (dec && (dec.oti === 0x69 || dec.oti === 0x6b)) {
      config = { codec: "mp3", sampleRate, numberOfChannels: sd.channels };
    } else {
      // AudioSpecificConfig が見つからなければ AAC-LC として作る（iPhone はほぼ AAC-LC）
      const asc = dec?.asc?.length ? dec.asc : makeAacLcConfig(sampleRate, sd.channels);
      let aot = asc[0] >> 3;
      if (aot === 31) aot = 32 + (((asc[0] & 7) << 3) | (asc[1] >> 5));
      config = { codec: `mp4a.40.${aot}`, sampleRate, numberOfChannels: sd.channels, description: asc };
    }
  } else if (type === "Opus" || type === "opus") {
    config = { codec: "opus", sampleRate: 48000, numberOfChannels: sd.channels };
  } else if (type === "fLaC") {
    config = { codec: "flac", sampleRate, numberOfChannels: sd.channels };
  } else {
    return null; // alac・apac（空間オーディオ）など
  }
  if (!(await AudioDecoder.isConfigSupported(config)).supported) return null;
  return { config, samples: trak.samples.map(slim), duration };
}

// stsd 箱（ヘッダー込み）から最初の音声サンプル記述を読む
function parseSoundDescription(b) {
  const dv = new DataView(b.buffer, b.byteOffset, b.byteLength);
  const e = 16; // stsd ヘッダー(8) + version/flags(4) + entry_count(4)
  if (b.length < e + 36) return null;
  const version = dv.getUint16(e + 16);
  const sd = {
    version,
    channels: dv.getUint16(e + 24),
    sampleSize: dv.getUint16(e + 26),
    sampleRate: dv.getUint32(e + 32) / 65536,
    bytesPerFrame: 0,
    flags: 0,
  };
  if (version === 1 && b.length >= e + 52) {
    sd.bytesPerFrame = dv.getUint32(e + 44);
  } else if (version === 2 && b.length >= e + 72) {
    sd.sampleRate = dv.getFloat64(e + 40);
    sd.channels = dv.getUint32(e + 48);
    sd.sampleSize = dv.getUint32(e + 56);
    sd.flags = dv.getUint32(e + 60);
    sd.bytesPerFrame = dv.getUint32(e + 64);
  }
  sd.enda = (() => {
    const box = findBox(b, "enda", e);
    return box ? dv.getUint16(box.start + 8) === 1 : null;
  })();
  return sd;
}

function pcmFormat(type, sd) {
  const le = sd.enda;
  switch (type) {
    case "sowt": return { bytes: 2, kind: "int", little: true };
    case "twos": return sd.sampleSize === 8 ? { bytes: 1, kind: "int", little: true } : { bytes: 2, kind: "int", little: false };
    case "in24": return { bytes: 3, kind: "int", little: le === true };
    case "in32": return { bytes: 4, kind: "int", little: le === true };
    case "fl32": return { bytes: 4, kind: "float", little: le === true };
    case "fl64": return { bytes: 8, kind: "float", little: le === true };
    case "raw": case "NONE": return { bytes: 1, kind: "uint", little: true };
    case "lpcm": {
      const bytes = Math.round(sd.sampleSize / 8) || (sd.bytesPerFrame && sd.bytesPerFrame / sd.channels);
      if (!bytes) return null;
      return { bytes, kind: sd.flags & 1 ? "float" : sd.flags & 4 ? "int" : "uint", little: !(sd.flags & 2) };
    }
    default: return null;
  }
}

// バイト列の中から 4文字の箱を探す（wave 箱の中にあっても見つかる）
function findBox(b, name, from = 0) {
  const n = [...name].map((c) => c.charCodeAt(0));
  for (let i = from + 4; i + 4 <= b.length; i++) {
    if (b[i] === n[0] && b[i + 1] === n[1] && b[i + 2] === n[2] && b[i + 3] === n[3]) {
      const size = (b[i - 4] << 24) | (b[i - 3] << 16) | (b[i - 2] << 8) | b[i - 1];
      if (size >= 8 && i - 4 + size <= b.length) return { start: i - 4, end: i - 4 + size };
    }
  }
  return null;
}

// esds の中身（記述子の並び）から DecoderConfig と AudioSpecificConfig を取り出す
function parseEsds(d) {
  let p = 0, oti = 0, asc = null;
  const len = () => {
    let n = 0;
    for (let k = 0; k < 4; k++) {
      const c = d[p++];
      n = (n << 7) | (c & 0x7f);
      if (!(c & 0x80)) break;
    }
    return n;
  };
  while (p < d.length) {
    const tag = d[p++];
    const n = len();
    if (tag === 3) {
      p += 2;
      const f = d[p++];
      if (f & 0x80) p += 2;
      if (f & 0x40) p += 1 + d[p];
      if (f & 0x20) p += 2;
    } else if (tag === 4) {
      oti = d[p];
      p += 13;
    } else if (tag === 5) {
      asc = d.slice(p, p + n);
      p += n;
    } else {
      p += n;
    }
  }
  return { oti, asc };
}

function makeAacLcConfig(sampleRate, channels) {
  const rates = [96000, 88200, 64000, 48000, 44100, 32000, 24000, 22050, 16000, 12000, 11025, 8000, 7350];
  const fi = Math.max(0, rates.indexOf(sampleRate));
  return new Uint8Array([(2 << 3) | (fi >> 1), ((fi & 1) << 7) | (Math.min(channels, 7) << 3)]);
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
  if (media.audio.pcm) return decodePcm(media, onProgress);
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
        for (let c = 0; c < Math.min(nch, ad.numberOfChannels); c++) {
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

// 非圧縮（PCM）の音声：塊ごとに読んで、そのまま数値に直す
async function decodePcm(media, onProgress) {
  const { pcm, runs, channels: nch, sampleRate: sr } = media.audio;
  const total = runs.reduce((a, r) => a + r.size, 0) / (pcm.bytes * nch);
  const chans = Array.from({ length: nch }, () => new Float32Array(Math.max(1, Math.ceil(total))));
  const scale = pcm.kind === "float" ? 1 : 2 ** (8 * pcm.bytes - 1);
  let done = 0;
  for (const r of runs) {
    const bytes = new Uint8Array(await media.file.slice(r.offset, r.offset + r.size).arrayBuffer());
    const dv = new DataView(bytes.buffer);
    const frames = Math.floor(bytes.length / (pcm.bytes * nch));
    for (let f = 0; f < frames; f++) {
      for (let c = 0; c < nch; c++) {
        const o = (f * nch + c) * pcm.bytes;
        let v;
        if (pcm.kind === "float") v = pcm.bytes === 4 ? dv.getFloat32(o, pcm.little) : dv.getFloat64(o, pcm.little);
        else if (pcm.bytes === 1) v = pcm.kind === "uint" ? bytes[o] - 128 : dv.getInt8(o);
        else if (pcm.bytes === 2) v = dv.getInt16(o, pcm.little);
        else if (pcm.bytes === 3) {
          const [x, y, z] = pcm.little ? [bytes[o + 2], bytes[o + 1], bytes[o]] : [bytes[o], bytes[o + 1], bytes[o + 2]];
          v = ((x << 24) | (y << 16) | (z << 8)) >> 8;
        } else v = dv.getInt32(o, pcm.little);
        const i = r.frame + f;
        if (i < chans[c].length) chans[c][i] = v / scale;
      }
    }
    done += r.size;
    onProgress?.(done / (total * pcm.bytes * nch));
  }
  const buf = new AudioBuffer({ length: chans[0].length, numberOfChannels: nch, sampleRate: sr });
  chans.forEach((ch, c) => buf.copyToChannel(ch, c));
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
    this.flushing = null;
    this.gen = (this.gen || 0) + 1;
    if (this.decoder.state === "configured") this.decoder.reset();
    this.decoder.configure(this.v.config);
  }

  async pull() {
    const s = this.v.samples;
    while (!this.queue.length) {
      if (this.error) throw this.error;
      if (this.si < s.length) {
        if (this.decoder.decodeQueueSize < 12) {
          const run = await readRun(this.file, s, this.si, 16 << 20, 10);
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
      } else if (this.done) {
        return null;
      } else {
        // 最後まで送ったら flush。flush の完了を待ち続けると、受け取っていないフレームと
        // お互いに待ち合って止まることがあるので、出てきたフレームは先に返す
        if (!this.flushing) {
          const gen = this.gen; // 途中で start() し直したら、古い flush の結果は無視する
          const pending = this.decoder.state === "configured" ? this.decoder.flush() : Promise.resolve();
          const finish = () => { if (gen === this.gen) this.done = true; };
          this.flushing = pending.then(finish, finish);
        }
        await Promise.race([this.flushing, new Promise((r) => setTimeout(r, 20))]);
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
