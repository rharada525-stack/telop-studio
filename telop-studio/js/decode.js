// MP4/MOV を WebCodecs で直接デコードする（画面に出さなくても・別タブでも動く）
// mp4box.js（index.html で読み込み済みの window.MP4Box / window.DataStream）を使う

export async function openMp4(file) {
  const MP4Box = window.MP4Box;
  if (!MP4Box) return null;
  const buf = await file.arrayBuffer();
  buf.fileStart = 0;
  const mp4 = MP4Box.createFile();
  const ready = new Promise((resolve, reject) => {
    mp4.onReady = resolve;
    mp4.onError = reject;
  });
  mp4.appendBuffer(buf);
  mp4.flush();
  const info = await Promise.race([ready, new Promise((r) => setTimeout(() => r(null), 3000))]);
  const track = info && info.videoTracks[0];
  if (!track) return null;

  const samples = [];
  mp4.onSamples = (_id, _user, s) => samples.push(...s);
  mp4.setExtractionOptions(track.id, null, { nbSamples: Infinity });
  mp4.start();
  mp4.flush();

  const config = {
    codec: track.codec.startsWith("vp08") ? "vp8" : track.codec,
    codedWidth: track.video.width,
    codedHeight: track.video.height,
    description: description(mp4, track),
  };
  const support = await VideoDecoder.isConfigSupported(config);
  if (!support.supported) throw new Error(`この動画形式（${track.codec}）はこのパソコンでは読めません。H.264 の MP4 に変換してください。`);

  // スマホの縦動画は「横で撮って回転情報を付ける」ことが多い
  const [a, b] = track.matrix || [65536, 0];
  const rotation = ((Math.round((Math.atan2(b, a) * 180) / Math.PI) % 360) + 360) % 360;
  return { samples, config, rotation, timescale: track.timescale };
}

function description(mp4, track) {
  const trak = mp4.getTrackById(track.id);
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

// 時刻を前に進めながらフレームを取り出す（シーク不要）
export class FrameReader {
  constructor(src) {
    this.src = src;
    this.queue = [];
    this.si = 0;
    this.cur = null;
    this.next = null;
    this.done = false;
    this.error = null;
    this.decoder = new VideoDecoder({ output: (f) => this.queue.push(f), error: (e) => (this.error = e) });
    this.decoder.configure(src.config);
  }

  async pull() {
    const s = this.src.samples;
    while (!this.queue.length) {
      if (this.error) throw this.error;
      if (this.si < s.length) {
        while (this.si < s.length && this.decoder.decodeQueueSize < 12) {
          const x = s[this.si++];
          this.decoder.decode(new EncodedVideoChunk({
            type: x.is_sync ? "key" : "delta",
            timestamp: (1e6 * x.cts) / x.timescale,
            duration: (1e6 * x.duration) / x.timescale,
            data: x.data,
          }));
        }
        await new Promise((r) => setTimeout(r, 0));
        if (!this.queue.length && this.decoder.decodeQueueSize >= 12)
          await new Promise((r) => this.decoder.addEventListener("dequeue", r, { once: true }));
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
