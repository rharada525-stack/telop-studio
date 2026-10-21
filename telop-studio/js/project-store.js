// 動画の組み合わせごとに、独立したセーブデータを保存する。
// 1回の setItem で更新し、容量不足時には直前の保存をそのまま残す。
const PREFIX = 'telop-studio:saves:v1:';

export const projectFiles = (p) => p.files || (p.file ? [p.file] : []);
export const sameFiles = (a, b) => a.length === b.length && a.every((f, i) => f.name === b[i].name && f.size === b[i].size);

export function validateProject(p) {
  if (!p || !Array.isArray(p.lines) || !p.settings || !projectFiles(p).length ||
    projectFiles(p).some(f => typeof f.name !== 'string' || !Number.isFinite(f.size)) ||
    p.lines.some(l => typeof l.text !== 'string' || !Array.isArray(l.src) || l.src.length !== 2 ||
      !l.src.every(Number.isFinite) || l.src[0] < 0 || l.src[1] < l.src[0])) {
    throw new Error('作業ファイルの形式を確認してください。');
  }
  return p;
}

export function createProjectStore(storage, { id = () => crypto.randomUUID(), now = () => new Date().toISOString() } = {}) {
  const read = (key) => {
    const raw = storage.getItem(PREFIX + key);
    if (!raw) return null;
    const group = JSON.parse(raw);
    if (group.version !== 1 || !Number.isInteger(group.nextNumber) || group.nextNumber < 1 || !Array.isArray(group.entries) || !group.entries.length ||
      !group.entries.some(e => e.id === group.activeId) || group.entries.some(e => !e.id || typeof e.name !== 'string')) {
      throw new Error('保存済みデータを読み込めません。JSONファイルに保存してから確認してください。');
    }
    group.entries.forEach(e => validateProject(e.project));
    return group;
  };
  const write = (key, group) => storage.setItem(PREFIX + key, JSON.stringify(group));
  const add = (group, project) => {
    validateProject(project);
    while (group.entries.some(e => e.name === `セーブデータ${group.nextNumber}`)) group.nextNumber++;
    const entry = { id: id(), name: `セーブデータ${group.nextNumber++}`, updatedAt: now(), project: structuredClone(project) };
    group.entries.push(entry);
    group.activeId = entry.id;
    return entry;
  };
  return {
    read,
    open(key, initial) {
      const existing = read(key);
      if (existing) return existing;
      const legacy = storage.getItem(key);
      const group = { version: 1, nextNumber: 1, activeId: null, entries: [] };
      add(group, legacy ? validateProject(JSON.parse(legacy)) : initial);
      write(key, group); // 古い自動保存は削除・上書きしない。
      return group;
    },
    create(key, project) {
      const group = read(key);
      if (!group) throw new Error('先に動画を読み込んでください。');
      const entry = add(group, project);
      write(key, group);
      return entry;
    },
    select(key, entryId) {
      const group = read(key);
      const entry = group?.entries.find(e => e.id === entryId);
      if (!entry) throw new Error('セーブデータが見つかりません。');
      group.activeId = entry.id;
      write(key, group);
      return entry;
    },
    save(key, entryId, project, name) {
      validateProject(project);
      const group = read(key);
      const entry = group?.entries.find(e => e.id === entryId);
      if (!entry) throw new Error('保存先を確認してください。');
      entry.project = structuredClone(project);
      entry.updatedAt = now();
      if (name !== undefined) entry.name = name.trim().slice(0, 60) || entry.name;
      write(key, group);
      return entry;
    },
  };
}
