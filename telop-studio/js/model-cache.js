// Transformers.js 3.8.1 の既定の Cache Storage。
// 同じサイトのほかのツールのキャッシュや編集用ストレージには触れない。
export const MODEL_CACHE = 'transformers-cache';
export function isToolModel(request) {
  const url = new URL(typeof request === 'string' ? request : request.url);
  return url.protocol === 'https:' && ['huggingface.co', 'hf.co'].includes(url.hostname) &&
    /^\/onnx-community\/(whisper-base|whisper-small|whisper-large-v3-turbo|pyannote-segmentation-3\.0)\/resolve\//.test(url.pathname);
}

export async function modelCacheEntries(storage) {
  if (!storage || !(await storage.keys()).includes(MODEL_CACHE)) return [];
  const cache = await storage.open(MODEL_CACHE);
  return (await cache.keys()).filter(isToolModel);
}

export async function deleteModelCache(storage) {
  const entries = await modelCacheEntries(storage);
  if (!entries.length) return 0;
  const cache = await storage.open(MODEL_CACHE);
  let count = 0;
  for (const request of entries) if (await cache.delete(request)) count++;
  return count;
}
