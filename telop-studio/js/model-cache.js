// Transformers.js 3.8.1 の既定の Cache Storage。
// 同じサイトのほかのツールのキャッシュや編集用ストレージには触れない。
export const MODEL_CACHE = 'transformers-cache';
export function isToolModel(request) {
  const url = new URL(typeof request === 'string' ? request : request.url);
  return url.protocol === 'https:' && ['huggingface.co', 'hf.co'].includes(url.hostname) &&
    // _timestamped は 1語ごとの時刻を出せる版（自動カットの発話保護に使う）
    /^\/onnx-community\/((whisper-base|whisper-small|whisper-large-v3-turbo)(_timestamped)?|pyannote-segmentation-3\.0)\/resolve\//.test(url.pathname);
}

export async function modelCacheEntries(storage) {
  if (!storage || !(await storage.keys()).includes(MODEL_CACHE)) return [];
  const cache = await storage.open(MODEL_CACHE);
  return (await cache.keys()).filter(isToolModel);
}

// 1語ごとの時刻を出せない旧版（_timestamped なし）。今は使わないので、起動時に自動で消す
export const isOldModel = (request) => isToolModel(request) &&
  /^\/onnx-community\/whisper-(base|small|large-v3-turbo)\/resolve\//.test(new URL(typeof request === 'string' ? request : request.url).pathname);

export async function deleteModelCache(storage, filter = () => true) {
  const entries = (await modelCacheEntries(storage)).filter(filter);
  if (!entries.length) return 0;
  const cache = await storage.open(MODEL_CACHE);
  let count = 0;
  for (const request of entries) if (await cache.delete(request)) count++;
  return count;
}

export const deleteOldModels = (storage) => deleteModelCache(storage, isOldModel);
