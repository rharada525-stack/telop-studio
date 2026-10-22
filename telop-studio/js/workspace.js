// 表示中の作業だけを切り替える。編集データ・再生位置・入力欄は作り直さない。
export function initWorkspace() {
  const tabs = [...document.querySelectorAll('.workspace-nav [role="tab"]')];
  function activate(tab, focus = false) {
    for (const item of tabs) {
      const selected = item === tab;
      item.setAttribute('aria-selected', String(selected));
      item.tabIndex = selected ? 0 : -1;
      document.getElementById(item.getAttribute('aria-controls')).hidden = !selected;
    }
    if (focus) tab.focus();
  }
  for (const [i, tab] of tabs.entries()) {
    tab.addEventListener('click', () => activate(tab));
    tab.addEventListener('keydown', event => {
      let next;
      if (event.key === 'ArrowRight') next = (i + 1) % tabs.length;
      if (event.key === 'ArrowLeft') next = (i + tabs.length - 1) % tabs.length;
      if (event.key === 'Home') next = 0;
      if (event.key === 'End') next = tabs.length - 1;
      if (next === undefined) return;
      event.preventDefault();
      activate(tabs[next], true);
    });
  }
  for (const [progress, tab] of [['anaProgress', 'tabAnalyze'], ['expProgress', 'tabExport']]) {
    const element = document.getElementById(progress);
    const sync = () => document.getElementById(tab).classList.toggle('running', !element.hidden);
    new MutationObserver(sync).observe(element, { attributes: true, attributeFilter: ['hidden'] });
    sync();
  }
  return {
    show(id) {
      const tab = tabs.find(item => item.getAttribute('aria-controls') === id);
      if (tab) activate(tab);
    },
  };
}
