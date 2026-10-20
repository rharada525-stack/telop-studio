// 文字起こし（Whisper）をブラウザ内で実行するワーカー。音声は外部に送信しない。
import { pipeline } from "https://cdn.jsdelivr.net/npm/@huggingface/transformers@3.8.1";

let asr = null;
let loadedKey = "";

self.onmessage = async (e) => {
  const { audio, model, device } = e.data;
  try {
    const key = `${model}|${device}`;
    if (!asr || loadedKey !== key) {
      self.postMessage({ type: "status", text: "AIモデルを準備中…（初回のみダウンロード）" });
      // 半精度(fp16)に対応した GPU なら、エンコーダーを fp16 にしてダウンロード量を減らす
      let f16 = false;
      if (device === "webgpu") {
        try { f16 = !!(await navigator.gpu.requestAdapter())?.features.has("shader-f16"); } catch { /* 非対応 */ }
      }
      const dtype = device === "webgpu"
        ? { encoder_model: f16 || model.includes("turbo") ? "fp16" : "fp32", decoder_model_merged: "q4" }
        : "q8";
      asr = await pipeline("automatic-speech-recognition", model, {
        device,
        dtype,
        progress_callback: (p) => self.postMessage({ type: "progress", p }),
      });
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
    self.postMessage({ type: "done", chunks: out.chunks || [], text: out.text });
  } catch (err) {
    self.postMessage({ type: "error", message: String((err && err.message) || err) });
  }
};
