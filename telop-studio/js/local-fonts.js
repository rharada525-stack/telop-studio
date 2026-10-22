// PCフォントの一覧・描画用データはこのページ内だけに保持する。
export function fontWeight(font) {
  const style = String(font.style || '').toLowerCase().replace(/[ -]/g, '');
  const short = { r: 400, l: 300, m: 500, db: 600, b: 700, eb: 800, h: 900 };
  if (short[style]) return short[style];
  const name = `${font.style || ''} ${font.postscriptName || ''}`.toLowerCase().replace(/[ -]/g, '');
  for (const [re, weight] of [[/thin/, 100], [/extralight|ultralight/, 200], [/light/, 300], [/black|heavy/, 900], [/extrabold|ultrabold/, 800], [/semibold|demibold/, 600], [/bold/, 700], [/medium/, 500]]) if (re.test(name)) return weight;
  return 400;
}

export function createLocalFontStore({ query, register }) {
  let fonts = [], nextId = 1;
  const aliases = new Map(), loadedFamilies = new Set(), pending = new Map();
  const families = () => [...new Set(fonts.map(f => f.family).filter(Boolean))].sort((a, b) => a.localeCompare(b, 'ja'));
  const match = (family, weight = 900) => fonts.filter(f => f.family === family).sort((a, b) => {
    const score = f => (/italic|oblique/i.test(f.style || '') ? 2000 : 0) + Math.abs(fontWeight(f) - Number(weight));
    return score(a) - score(b);
  })[0];
  return {
    families,
    async read() { const result = await query(); fonts = result; return families(); },
    premiereName(family, weight) { return match(family, weight)?.postscriptName || ''; },
    describe(family, weight) {
      const face = match(family, weight);
      return face ? { family: face.family, weight: fontWeight(face), postscriptName: face.postscriptName } : null;
    },
    cssFamily(family) { return loadedFamilies.has(family) ? aliases.get(family) : family; },
    async load(family, weight) {
      const face = match(family, weight);
      if (!face) return; // 一覧の許可前は通常のCSSによるローカルフォント指定を使う。
      const key = face.postscriptName || face.fullName, alias = aliases.get(family) || `TelopLocal${nextId++}`;
      aliases.set(family, alias);
      if (!pending.has(key)) {
        const job = register(alias, face, fontWeight(face)).then(() => { loadedFamilies.add(family); }).catch(error => { pending.delete(key); throw error; });
        pending.set(key, job);
      }
      await pending.get(key);
    },
  };
}

export const localFonts = createLocalFontStore({
  query: () => {
    if (!globalThis.queryLocalFonts) throw new Error('このブラウザでは一覧を取得できません。フォント名を直接入力してください。');
    return globalThis.queryLocalFonts();
  },
  register: async (alias, data, weight) => {
    const face = new FontFace(alias, await (await data.blob()).arrayBuffer(), { weight: String(weight) });
    await face.load();
    document.fonts.add(face);
  },
});
