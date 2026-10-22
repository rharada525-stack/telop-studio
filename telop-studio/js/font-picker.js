import { localFonts } from './local-fonts.js';

// 入力中のフォント名で候補を隠さず、独立した検索欄から選ぶ。
export function attachFontPicker(parent, { input, getWeight = () => 900, onSelect, onRead = () => {} }) {
  const button = Object.assign(document.createElement('button'), { type: 'button', className: 'ghost small', textContent: 'PCのフォント' });
  const panel = Object.assign(document.createElement('div'), { className: 'pc-font-picker', hidden: true });
  const search = Object.assign(document.createElement('input'), { type: 'search', placeholder: 'PCのフォントを検索' });
  search.setAttribute('aria-label', 'PCのフォントを検索');
  const list = document.createElement('select'); list.setAttribute('aria-label', 'PCのフォント一覧');
  const status = document.createElement('small'); status.setAttribute('role', 'status');
  const render = () => {
    const all = localFonts.families(), word = search.value.trim().toLocaleLowerCase();
    const names = all.filter(name => name.toLocaleLowerCase().includes(word));
    list.replaceChildren(new Option('PCのフォントを選択', ''), ...names.map(name => new Option(name, name)));
    list.value = names.includes(input.value) ? input.value : '';
    list.disabled = !names.length;
    status.textContent = all.length ? `${all.length}種類を追加${word ? `・${names.length}件表示` : ''}` : 'PCのフォントが見つかりませんでした。';
  };
  button.onclick = async () => {
    panel.hidden = false; button.disabled = true; search.disabled = true; list.disabled = true;
    status.textContent = 'PCのフォントを読み込み中…ブラウザに確認が出たら許可してください。';
    let timeout;
    try {
      await Promise.race([localFonts.read(), new Promise((_, reject) => { timeout = setTimeout(() => reject(new Error('ブラウザのフォント利用許可を確認して、もう一度読み込んでください。')), 15000); })]);
      search.value = ''; render(); onRead(localFonts.families());
    }
    catch (error) { status.textContent = error.name === 'NotAllowedError' ? 'フォントの利用が許可されませんでした。ブラウザのサイト設定から許可できます。' : error.message; }
    finally { clearTimeout(timeout); button.disabled = false; search.disabled = false; list.disabled = list.options.length <= 1; }
  };
  search.oninput = render;
  let selection = 0;
  list.onchange = async () => {
    const family = list.value, request = ++selection; if (!family) return;
    status.textContent = `「${family}」を読み込み中…`;
    // 読み込み中に話者や入力欄が変わった場合、別の対象へ適用しない。
    const previous = input.value;
    try {
      await localFonts.load(family, getWeight());
      if (request !== selection || input.value !== previous) return;
      input.value = family; onSelect(family);
      status.textContent = `「${family}」を適用しました。`;
    } catch { status.textContent = `「${family}」を読み込めませんでした。別のフォントを選んでください。`; }
  };
  panel.append(search, list, status); parent.append(button, panel);
  if (localFonts.families().length) { panel.hidden = false; render(); }
  return () => { ++selection; if (!panel.hidden && localFonts.families().length) render(); };
}
