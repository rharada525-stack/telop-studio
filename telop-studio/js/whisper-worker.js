// 文字起こし（Whisper）と話者の判別（pyannote）をブラウザ内で実行するワーカー。音声は外部に送信しない。
import {
  pipeline, AutoProcessor, AutoModelForAudioFrameClassification,
} from "https://cdn.jsdelivr.net/npm/@huggingface/transformers@3.8.1";

let asr = null;
let loadedKey = "";
let seg = null; // 話者判別モデル（約6MB）

const progress = (p) => self.postMessage({ type: "progress", p });

async function transcribe({ audio, model, device }) {
  const key = `${model}|${device}`;
  if (!asr || loadedKey !== key) {
    // 低スペックモードへ切り替えるとき、高精度モデルをメモリに残さない。
    if (asr) await asr.dispose();
    asr = null;
    loadedKey = "";
    self.postMessage({ type: "status", text: "AIモデルを準備中…（初回のみダウンロード）" });
    // fp16 エンコーダーは GPU によって文字起こしが終わらなくなることがあるため、base/small は fp32 を使う
    const dtype = device === "webgpu"
      ? { encoder_model: model.includes("turbo") ? "fp16" : "fp32", decoder_model_merged: "q4" }
      : "q8";
    asr = await pipeline("automatic-speech-recognition", model, { device, dtype, progress_callback: progress });
    loadedKey = key;
  }
  self.postMessage({ type: "status", text: "文字起こし中…" });
  const out = await asr(audio, {
    language: "japanese",
    task: "transcribe",
    chunk_length_s: 30,
    stride_length_s: 5,
    return_timestamps: true,
  });
  return out.chunks || [];
}

// 話者の区間 [{ id, start, end }]（秒）。同時に判別できるのは3人まで
async function diarize(audio) {
  if (!seg) {
    self.postMessage({ type: "status", text: "話者判別のAIを準備中…" });
    const id = "onnx-community/pyannote-segmentation-3.0";
    seg = {
      processor: await AutoProcessor.from_pretrained(id),
      model: await AutoModelForAudioFrameClassification.from_pretrained(id, { device: "wasm", dtype: "fp32", progress_callback: progress }),
    };
  }
  self.postMessage({ type: "status", text: "話者を判別中…" });
  const inputs = await seg.processor(audio);
  const { logits } = await seg.model(inputs);
  const result = seg.processor.post_process_speaker_diarization(logits, audio.length)[0];
  return result.map((r) => ({ id: r.id, start: r.start, end: r.end, confidence: r.confidence }));
}

self.onmessage = async (e) => {
  const m = e.data;
  try {
    if (m.type === "diarize") {
      self.postMessage({ type: "speakers", segments: await diarize(m.audio) });
      return;
    }
    const chunks = await transcribe(m);
    const segments = m.speakers ? await diarize(m.audio) : null;
    self.postMessage({ type: "done", chunks, segments });
  } catch (err) {
    self.postMessage({ type: "error", message: String((err && err.message) || err) });
  }
};
