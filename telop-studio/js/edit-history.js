// 編集内容だけの履歴。素材・保存先・ブラウザのモデルには触れない。
export function createEditHistory(limit = 50) {
  let past = [], future = [], present = null, group = null;
  const equal = (a, b) => JSON.stringify(a) === JSON.stringify(b);
  return {
    get canUndo() { return past.length > 0; },
    get canRedo() { return future.length > 0; },
    reset(value) { past = []; future = []; present = structuredClone(value); group = null; },
    endGroup() { group = null; },
    commit(value, nextGroup = null) {
      if (equal(present, value)) return false;
      if (present !== null && !(nextGroup && group === nextGroup)) past.push(present);
      present = structuredClone(value);
      // 入力欄自身のCtrl+Zなどで元の値に戻った場合は、空の取り消しを残さない。
      const reverted = past.length && equal(past.at(-1), present);
      if (reverted) past.pop();
      if (past.length > limit) past.splice(0, past.length - limit);
      future = [];
      group = reverted ? null : nextGroup;
      return true;
    },
    undo() {
      if (!past.length) return null;
      future.push(present);
      present = past.pop();
      group = null;
      return structuredClone(present);
    },
    redo() {
      if (!future.length) return null;
      past.push(present);
      present = future.pop();
      group = null;
      return structuredClone(present);
    },
  };
}

export function resetSubtitles(snapshot, defaultDesign) {
  const result = structuredClone(snapshot);
  result.lines = result.lines.map(line => ({ ...line, fx: '', fxText: '', fxPos: 'auto', screen: 'auto', cut: false }));
  result.settings.speakers = result.settings.speakers.map(speaker => ({ ...speaker, design: structuredClone(defaultDesign) }));
  result.settings.designSet = 'standard';
  result.settings.fxMap = {};
  result.settings.autoHighlight = true;
  return result;
}
