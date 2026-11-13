// 批量重命名页：移植自 RenameBox（MIT），适配 pudi-tools 的页签架构与主题。
// 所有 DOM id / class / radio name 都加 rn- 前缀，避免和本工具其它页冲突。
// 规则引擎见 ./rename-engine.js（纯函数）。

import { isTauri } from './platform.js';
import { computeNewName, passesFilter, splitName } from './rename-engine.js';
import { ripple, placePill, popOnce, prefersReduced } from './ui-motion.js';

// 本页所有元素都带 rn- 前缀，这里统一加上，外部调用用短名即可
const $ = (id) => document.getElementById('rn-' + id);
const radioVal = (name) => document.querySelector(`input[name="rn-${name}"]:checked`)?.value;

const invoke = isTauri ? window.__TAURI__.core.invoke : null;

export function initRenamePage() {
  // page-rename 是全局页签容器，被 main.js 以 getElementById('page-rename') 引用，不带 rn- 前缀
  const page = document.getElementById('page-rename');
  const rulePanel = $('rule-body');

  // ---------- 内层规则页签（整体/替换/…/选项） ----------
  const tabsRow = $('tabs');
  const tabInd = $('tab-ind');
  const tabs = [...tabsRow.querySelectorAll('.rn-tab')];
  const groups = new Map(
    [...document.querySelectorAll('.rn-group')].map((g) => [g.dataset.group, g])
  );
  const groupNames = {
    overall: '整体', replace: '替换', add: '添加', remove: '删除',
    seq: '序号', template: '模板', options: '选项',
  };
  const ruleTitle = $('rule-title');

  function syncTabIndicator() {
    const el = tabsRow.querySelector('.rn-tab.active');
    if (!el) return;
    placePill(tabInd, el);
    tabInd.classList.add('on');
  }

  function showTab(which) {
    for (const t of tabs) {
      const on = t.dataset.group === which;
      t.classList.toggle('active', on);
      if (on) t.focus({ preventScroll: true });
    }
    for (const [key, g] of groups) g.hidden = key !== which;
    ruleTitle.textContent = groupNames[which] || which;
    syncTabIndicator();
  }

  for (const t of tabs) {
    t.addEventListener('click', (ev) => {
      showTab(t.dataset.group);
      ripple(t, ev);
    });
  }
  requestAnimationFrame(syncTabIndicator);
  new ResizeObserver(syncTabIndicator).observe(tabsRow);

  // ---------- 本地模态（替代 window.prompt / confirm） ----------
  function rnPrompt(title, message = '', placeholder = '', defaultValue = '') {
    return new Promise((resolve) => {
      $('modalTitle').textContent = title;
      const textEl = $('modalText');
      const input = $('modalInput');
      const cancel = $('modalCancel');
      if (message) { textEl.hidden = false; textEl.textContent = message; }
      else textEl.hidden = true;
      if (placeholder !== '' || defaultValue !== '') {
        input.hidden = false;
        input.value = defaultValue;
        input.placeholder = placeholder;
        input.focus();
        input.select();
      } else input.hidden = true;
      cancel.hidden = false;
      $('modalScrim').hidden = false;

      const cleanup = () => {
        $('modalScrim').hidden = true;
        input.hidden = true;
        textEl.hidden = true;
        cancel.hidden = true;
        input.onkeydown = null;
        $('modalOk').onclick = null;
        cancel.onclick = null;
        $('modalScrim').onclick = null;
      };
      const submit = () => {
        const val = input.hidden ? '' : input.value.trim();
        cleanup();
        resolve(val);
      };
      const cancel_ = () => { cleanup(); resolve(null); };
      input.onkeydown = (e) => {
        if (e.key === 'Enter') { e.preventDefault(); submit(); }
        else if (e.key === 'Escape') { e.preventDefault(); cancel_(); }
      };
      $('modalOk').onclick = submit;
      cancel.onclick = cancel_;
      $('modalScrim').onclick = (e) => { if (e.target === $('modalScrim')) cancel_(); };
    });
  }

  function rnConfirm(message) {
    return new Promise((resolve) => {
      $('modalTitle').textContent = '确认';
      const textEl = $('modalText');
      const input = $('modalInput');
      const cancel = $('modalCancel');
      textEl.hidden = false;
      textEl.textContent = message;
      input.hidden = true;
      cancel.hidden = false;
      $('modalScrim').hidden = false;
      const cleanup = () => {
        $('modalScrim').hidden = true;
        input.hidden = true;
        textEl.hidden = true;
        cancel.hidden = true;
        $('modalOk').onclick = null;
        cancel.onclick = null;
        $('modalScrim').onclick = null;
      };
      const yes = () => { cleanup(); resolve(true); };
      const no = () => { cleanup(); resolve(false); };
      $('modalOk').onclick = yes;
      cancel.onclick = no;
      $('modalScrim').onclick = (e) => { if (e.target === $('modalScrim')) no(); };
    });
  }

  function toast(msg, isErr) {
    const el = $('toast');
    el.textContent = msg;
    el.classList.toggle('err', !!isErr);
    el.classList.add('on');
    clearTimeout(toast._t);
    toast._t = setTimeout(() => el.classList.remove('on'), isErr ? 4200 : 2400);
  }

  // ---------- 规则状态（收集 / 回填 / 圆点 / 控件显隐） ----------
  function collectRules() {
    const extToSel = $('extTo').value;
    const incRaw = $('incStart').value.trim();
    const numRaw = $('numStart').value.trim();
    const padWidth = (raw, digits) => (digits > 0 ? digits : /^0\d+$/.test(raw) ? raw.length : 0);
    return {
      overall: {
        nameMode: radioVal('nameMode') || 'keep',
        incStart: parseInt(incRaw, 10) || 0,
        incDigits: padWidth(incRaw, parseInt($('incDigits').value, 10) || 0),
        numPrefix: $('numPrefix').value,
        numStart: parseInt(numRaw, 10) || 0,
        numDigits: padWidth(numRaw, parseInt($('numDigits').value, 10) || 0),
        convert: $('convert').value,
        extMode: radioVal('extMode') || 'keep',
        extTo: extToSel === '__custom' ? $('extToCustom').value : extToSel,
      },
      replace: {
        enabled: $('replaceOn').checked,
        find: $('replaceFind').value,
        to: $('replaceTo').value,
        useRegex: $('replaceRegex').checked,
        caseSensitive: $('replaceCase').checked,
        target: radioVal('replaceTarget') || 'both',
      },
      remove: {
        enabled: $('removeOn').checked,
        mode: radioVal('removeMode') || 'content',
        content: $('removeContent').value,
        useRegex: $('removeRegex').checked,
        caseSensitive: $('removeCase').checked,
        posFrom: parseInt($('posFrom').value, 10) || 1,
        posTo: parseInt($('posTo').value, 10) || 0,
      },
      add: {
        enabled: $('addOn').checked,
        prefix: $('addPrefix').value,
        suffix: $('addSuffix').value,
        target: radioVal('addTarget') || 'name',
      },
      seq: {
        enabled: $('seqOn').checked,
        start: parseInt($('seqStart').value, 10) || 0,
        step: parseInt($('seqStep').value, 10) || 1,
        digits: parseInt($('seqDigits').value, 10) || 0,
        padChar: $('seqPad').value,
        position: radioVal('seqPos') || 'before',
        sep: $('seqSep').value,
      },
      template: {
        enabled: $('tplOn').checked,
        text: $('tplText').value,
      },
      filter: {
        keyword: $('filterKw').value,
        exts: $('filterExt').value,
      },
      confirmExec: $('confirmExec').checked,
      skipConflict: $('skipConflict').checked,
    };
  }

  // 反向：把 rules 对象写回 DOM（应用一个预设）
  function applyRules(rules) {
    if (!rules) return;
    const r = rules.overall || {};
    const elSet = (sel, val) => { const el = $(sel); if (el) el.value = val; };
    const chk = (sel, v) => { const el = $(sel); if (el) el.checked = !!v; };
    const radioSet = (name, val) => {
      document.querySelectorAll(`input[name="rn-${name}"]`).forEach((rb) => {
        rb.checked = rb.value === val;
      });
    };
    radioSet('nameMode', r.nameMode || 'keep');
    elSet('incStart', r.incStart ?? 1);
    elSet('incDigits', r.incDigits ?? 0);
    elSet('numPrefix', r.numPrefix ?? '');
    elSet('numStart', r.numStart ?? 1);
    elSet('numDigits', r.numDigits ?? 0);
    elSet('convert', r.convert || 'none');
    radioSet('extMode', r.extMode || 'keep');
    const knownExts = ['mp4', 'pdf', 'txt', 'jpg', 'png', 'zip', 'rar', '7z'];
    if (r.extTo && !knownExts.includes(r.extTo)) {
      elSet('extTo', '__custom');
      elSet('extToCustom', r.extTo);
    } else {
      elSet('extTo', r.extTo || 'mp4');
      elSet('extToCustom', '');
    }
    const rp = rules.replace || {};
    chk('replaceOn', rp.enabled);
    elSet('replaceFind', rp.find || '');
    elSet('replaceTo', rp.to || '');
    chk('replaceRegex', rp.useRegex);
    chk('replaceCase', rp.caseSensitive);
    radioSet('replaceTarget', rp.target || 'both');
    const rm = rules.remove || {};
    chk('removeOn', rm.enabled);
    radioSet('removeMode', rm.mode || 'content');
    elSet('removeContent', rm.content || '');
    chk('removeRegex', rm.useRegex);
    chk('removeCase', rm.caseSensitive);
    elSet('posFrom', rm.posFrom ?? 1);
    elSet('posTo', rm.posTo ?? 0);
    const ad = rules.add || {};
    chk('addOn', ad.enabled);
    elSet('addPrefix', ad.prefix || '');
    elSet('addSuffix', ad.suffix || '');
    radioSet('addTarget', ad.target || 'name');
    const sq = rules.seq || {};
    chk('seqOn', sq.enabled);
    elSet('seqStart', sq.start ?? 1);
    elSet('seqStep', sq.step ?? 1);
    elSet('seqDigits', sq.digits ?? 2);
    elSet('seqPad', sq.padChar || '0');
    radioSet('seqPos', sq.position || 'before');
    elSet('seqSep', sq.sep ?? '_');
    const tp = rules.template || {};
    chk('tplOn', tp.enabled);
    elSet('tplText', tp.text || '');
    const fl = rules.filter || {};
    elSet('filterKw', fl.keyword || '');
    elSet('filterExt', fl.exts || '');
    chk('importRecursive', rules.importRecursive);
    chk('confirmExec', rules.confirmExec !== false);
    chk('skipConflict', rules.skipConflict !== false);
  }

  // 有生效规则的页签点亮小圆点
  function syncRuleDots(rules) {
    const active = {
      overall: rules.overall.nameMode !== 'keep' || rules.overall.convert !== 'none' || rules.overall.extMode !== 'keep',
      replace: rules.replace.enabled && !!rules.replace.find,
      add: rules.add.enabled && !!(rules.add.prefix || rules.add.suffix),
      remove: rules.remove.enabled && (rules.remove.mode === 'position' || !!rules.remove.content),
      seq: rules.seq.enabled,
      template: rules.template.enabled && !!rules.template.text,
      options: !!(rules.filter.keyword.trim() || rules.filter.exts.trim()),
    };
    for (const t of tabs) t.classList.toggle('on-rule', !!active[t.dataset.group]);
  }

  // 依赖其它控件的显隐
  function syncControls() {
    const nameMode = radioVal('nameMode');
    $('inc-row').hidden = nameMode !== 'increase';
    $('prefix-row').hidden = nameMode !== 'prefixNum';
    $('num-help').hidden = nameMode !== 'increase' && nameMode !== 'prefixNum';
    for (const id of ['incStart', 'incDigits']) $(id).disabled = nameMode !== 'increase';
    for (const id of ['numPrefix', 'numStart', 'numDigits']) $(id).disabled = nameMode !== 'prefixNum';
    $('ext-to-row').hidden = radioVal('extMode') !== 'to';
    $('extToCustom').hidden = $('extTo').value !== '__custom';

    $('replaceFind').disabled = $('replaceTo').disabled = $('replaceRegex').disabled =
      $('replaceCase').disabled = !$('replaceOn').checked;
    for (const id of ['addPrefix', 'addSuffix']) $(id).disabled = !$('addOn').checked;
    document.querySelectorAll('input[name="rn-addTarget"]').forEach((r) => (r.disabled = !$('addOn').checked));
    for (const id of ['removeContent', 'removeRegex', 'removeCase', 'posFrom', 'posTo']) $(id).disabled = !$('removeOn').checked;
    document.querySelectorAll('input[name="rn-removeMode"]').forEach((r) => (r.disabled = !$('removeOn').checked));
    $('remove-content').hidden = radioVal('removeMode') !== 'content';
    $('remove-position').hidden = radioVal('removeMode') !== 'position';
    for (const id of ['seqStart', 'seqStep', 'seqDigits', 'seqPad', 'seqSep']) $(id).disabled = !$('seqOn').checked;
    document.querySelectorAll('input[name="rn-seqPos"]').forEach((r) => (r.disabled = !$('seqOn').checked));
    $('tplText').disabled = !$('tplOn').checked;
  }

  // ---------- 文件条目 ----------
  let entries = [];
  const undoStack = [];
  const redoStack = [];
  const prevNames = new Map(); // path -> 上次预览的新名，用于只给真正变化的行加闪烁

  function dirOf(path) {
    const i = Math.max(path.lastIndexOf('/'), path.lastIndexOf('\\'));
    return i < 0 ? '' : path.slice(0, i);
  }
  function joinPath(dir, name) {
    if (!dir) return name;
    const sep = /[\\/]/.test(dir) && !dir.includes('/') ? '\\' : '/';
    return dir.replace(/[\\/]+$/, '') + sep + name;
  }
  function parentOf(dir) {
    const clean = dir.replace(/[\\/]+$/, '');
    const i = Math.max(clean.lastIndexOf('/'), clean.lastIndexOf('\\'));
    return i < 0 ? clean : clean.slice(i + 1);
  }
  function sizeText(n) {
    if (!n) return '0 B';
    const units = ['B', 'KB', 'MB', 'GB', 'TB'];
    const i = Math.min(units.length - 1, Math.floor(Math.log(n) / Math.log(1024)));
    return `${(n / Math.pow(1024, i)).toFixed(i ? 1 : 0)} ${units[i]}`;
  }
  function esc(s) {
    return String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
  }

  function addInfos(infos) {
    let added = 0;
    for (const it of infos) {
      if (entries.some((e) => e.path.toLowerCase() === it.path.toLowerCase())) continue;
      const dir = dirOf(it.path);
      entries.push({
        path: it.path,
        dir,
        parentName: parentOf(dir),
        name: it.name,
        size: it.size || 0,
        mtime: it.mtime || 0,
        ext: splitName(it.name).ext.toLowerCase(),
        isDir: !!it.is_dir,
        checked: true,
        pass: true,
        newName: it.name,
        status: 'same',
        conflict: false,
        warnings: [],
        random6: Math.floor(Math.random() * 900000) + 100000,
        random7: Math.floor(Math.random() * 9000000) + 1000000,
      });
      added++;
    }
    if (added) recompute();
    return added;
  }

  // 浏览器环境：从 File 列表构建 infos（没有修改时间，改名不可用）
  function buildInfosFromFiles(files) {
    return [...files].map((f) => ({
      path: f.name,
      name: f.name,
      size: f.size || 0,
      mtime: 0,
      is_dir: false,
    }));
  }

  async function importFiles() {
    if (!isTauri) {
      const input = getPickerInput(true, null);
      input.value = '';
      input.onchange = () => {
        if (input.files && input.files.length) {
          const n = addInfos(buildInfosFromFiles(input.files));
          toast(n ? `已导入 ${n} 个文件（浏览器预览模式，改名需在桌面端运行）` : '没有新增文件');
        }
        input.onchange = null;
      };
      input.click();
      return;
    }
    const paths = await invoke('pick_files', { multi: true, exts: null, title: '选择要改名的文件', label: null });
    if (!paths || !paths.length) return;
    const infos = await invoke('stat_paths', { paths });
    const n = addInfos(infos);
    toast(n ? `已导入 ${n} 个文件` : '没有新增文件（可能都已在工作列表中）');
  }

  async function importFolder() {
    if (!isTauri) {
      const input = getPickerInput(false, null);
      input.setAttribute('webkitdirectory', '');
      input.value = '';
      input.onchange = () => {
        if (input.files && input.files.length) {
          const n = addInfos(buildInfosFromFiles(input.files));
          toast(n ? `已导入 ${n} 个文件（浏览器预览模式，改名需在桌面端运行）` : '该文件夹下没有文件');
        }
        input.onchange = null;
        input.removeAttribute('webkitdirectory');
      };
      input.click();
      return;
    }
    const dir = await invoke('pick_dir');
    if (!dir) return;
    const recursive = $('importRecursive').checked;
    const infos = await invoke('list_dir', { dir, recursive });
    const n = addInfos(infos);
    toast(n ? `已从 ${parentOf(dir) || dir} 导入 ${n} 个文件` : '该文件夹下没有文件');
  }

  // 拖入：entries 是 [{name, path|null, file|null}]
  async function importPaths(dropped) {
    const recursive = $('importRecursive').checked;
    if (!isTauri) {
      const files = dropped.map((d) => d.file).filter(Boolean);
      if (!files.length) return;
      const n = addInfos(buildInfosFromFiles(files));
      toast(n ? `拖入 ${n} 个文件（浏览器预览模式，改名需在桌面端运行）` : '没有可导入的文件');
      return;
    }
    const paths = dropped.map((d) => d.path).filter(Boolean);
    if (!paths.length) return;
    const infos = await invoke('stat_paths', { paths });
    const dirs = infos.filter((i) => i.is_dir).map((i) => i.path);
    const files = infos.filter((i) => !i.is_dir);
    const folderFiles = [];
    for (const d of dirs) {
      try {
        folderFiles.push(...(await invoke('list_dir', { dir: d, recursive })));
      } catch { /* 目录读不到就跳过 */ }
    }
    const n = addInfos([...files, ...folderFiles]);
    toast(n ? `拖入 ${n} 个文件${dirs.length ? `（含 ${dirs.length} 个文件夹的内容）` : ''}` : '没有可导入的文件');
  }

  // 浏览器用的隐藏文件选择框（复用，按需切 webkitdirectory）
  let pickerInput = null;
  function getPickerInput(multi, accept) {
    if (!pickerInput) {
      pickerInput = document.createElement('input');
      pickerInput.type = 'file';
      pickerInput.style.position = 'fixed';
      pickerInput.style.left = '-9999px';
      pickerInput.style.top = '0';
      document.body.appendChild(pickerInput);
    }
    pickerInput.multiple = multi;
    pickerInput.accept = accept || '';
    return pickerInput;
  }

  // ---------- 排序 ----------
  const sortBy = $('sortBy');
  const sortDirBtn = $('sortDir');
  const nameCollator = new Intl.Collator('zh-CN', { numeric: true, sensitivity: 'base' });
  let sortDesc = false;

  function sortEntries() {
    const key = sortBy.value;
    sortDirBtn.disabled = key === 'none';
    sortDirBtn.textContent = sortDesc ? '↓' : '↑';
    if (key === 'none') return;
    const mul = sortDesc ? -1 : 1;
    entries.sort((a, b) => {
      let r = 0;
      if (key === 'name') r = nameCollator.compare(a.name, b.name);
      else if (key === 'mtime') r = a.mtime - b.mtime;
      else if (key === 'type') r = nameCollator.compare(a.ext, b.ext) || nameCollator.compare(a.name, b.name);
      else if (key === 'size') r = a.size - b.size;
      return r * mul;
    });
  }

  sortBy.addEventListener('change', () => recompute());
  sortDirBtn.addEventListener('click', () => {
    sortDesc = !sortDesc;
    recompute();
  });

  // ---------- 计算 + 渲染 ----------
  const tbody = $('tbody');
  const emptyHint = $('emptyHint');
  const statusEl = $('status');
  const listTitle = $('listTitle');
  const btnExec = $('btnExec');
  const btnUndo = $('btnUndo');

  let selected = -1;
  let busy = false;
  const view = { conflicts: 0, okCount: 0, warnCount: 0, filteredOut: 0, invalid: 0 };

  function recompute() {
    const rules = collectRules();
    syncControls();
    syncRuleDots(rules);
    sortEntries();

    let visible = 0;
    for (const e of entries) {
      e.pass = passesFilter(e, rules.filter);
      if (!e.pass) {
        e.status = 'filtered';
        e.newName = e.name;
        e.conflict = false;
        continue;
      }
      const r = computeNewName(e, visible, rules);
      e.newName = r.newName;
      e.status = r.status;
      e.warnings = r.warnings || [];
      if (e.checked && r.status === 'ok') visible++;
    }

    // 目标名占用：同目录两行撞同一个名字，或撞上「本次不动」的行
    const keyOf = (dir, name) => `${dir.toLowerCase()}\\${name.toLowerCase()}`;
    const wanted = new Map();
    const occupied = new Set();
    for (const e of entries) {
      const stays = !e.pass || !e.checked || e.status !== 'ok';
      if (stays) {
        occupied.add(keyOf(e.dir, e.name));
        continue;
      }
      const k = keyOf(e.dir, e.newName);
      wanted.set(k, (wanted.get(k) || 0) + 1);
    }
    for (const e of entries) {
      if (!e.pass || !e.checked || e.status !== 'ok') {
        e.conflict = false;
        continue;
      }
      const k = keyOf(e.dir, e.newName);
      e.conflict = (wanted.get(k) || 0) > 1 || occupied.has(k);
    }

    // 跳过冲突行时，其原名仍被占用；逐层传播，避免其余操作撞上这些文件。
    let changed;
    do {
      changed = false;
      for (const e of entries) if (e.conflict) occupied.add(keyOf(e.dir, e.name));
      for (const e of entries) {
        if (e.pass && e.checked && e.status === 'ok' && !e.conflict && occupied.has(keyOf(e.dir, e.newName))) {
          e.conflict = true;
          changed = true;
        }
      }
    } while (changed);

    view.conflicts = entries.filter((e) => e.conflict).length;
    view.okCount = entries.filter((e) => e.pass && e.checked && e.status === 'ok' && !e.conflict).length;
    view.invalid = entries.filter((e) => e.pass && e.checked && (e.status === 'empty' || e.status === 'illegal')).length;
    view.filteredOut = entries.filter((e) => !e.pass).length;
    view.blocked = view.conflicts > 0 && rules.skipConflict;

    render();
  }

  function render() {
    emptyHint.hidden = entries.length > 0;
    const participating = entries.filter((e) => e.pass).length;
    listTitle.textContent = entries.length
      ? `文件列表 · ${participating}/${entries.length} 项参与`
      : '文件列表';

    const rows = [];
    entries.forEach((e, i) => {
      const prev = prevNames.get(e.path);
      const changed = prev !== undefined && prev !== e.newName;
      prevNames.set(e.path, e.newName);

      let tag;
      if (e.isDir) tag = '<span class="rn-tag folder">文件夹</span>' + (
        !e.pass ? '<span class="rn-tag same">已过滤</span>' :
        !e.checked ? '<span class="rn-tag same">未选择</span>' :
        e.status === 'empty' || e.status === 'illegal' ? `<span class="rn-tag bad" title="${esc(e.warnings.join('、'))}">名称或规则无效</span>` :
        e.conflict ? '<span class="rn-tag bad">重名冲突</span>' :
        e.status === 'same' ? '<span class="rn-tag same">未变化</span>' :
        '<span class="rn-tag rename">待改名</span>'
      );
      else if (!e.pass) tag = '<span class="rn-tag same">已过滤</span>';
      else if (!e.checked) tag = '<span class="rn-tag same">未选择</span>';
      else if (e.status === 'empty') tag = '<span class="rn-tag bad">名称为空</span>';
      else if (e.status === 'illegal') tag = `<span class="rn-tag bad" title="${esc(e.warnings.join('、'))}">名称或规则无效</span>`;
      else if (e.conflict) tag = '<span class="rn-tag bad">重名冲突</span>';
      else if (e.status === 'same') tag = '<span class="rn-tag same">未变化</span>';
      else tag = '<span class="rn-tag rename">待改名</span>';

      const cls = [!e.checked || !e.pass ? 'off' : '', selected === i ? 'selected' : '']
        .filter(Boolean)
        .join(' ');

      rows.push(
        `<tr data-i="${i}" class="${cls}">` +
          `<td class="col-chk"><input type="checkbox" ${e.checked ? 'checked' : ''} ${e.pass ? '' : 'disabled'} /></td>` +
          `<td class="col-idx">${i + 1}</td>` +
          `<td class="rn-old-name">${esc(e.name)}</td>` +
          `<td title="${esc(e.warnings.join('、'))}" class="rn-new-name ${e.status === 'ok' && !e.conflict ? '' : 'unchanged'}${changed ? ' flash' : ''}">${esc(e.newName)}</td>` +
          `<td class="col-status">${tag}</td>` +
          `<td class="col-ext">${esc(splitName(e.newName).ext)}</td>` +
          `<td class="col-size">${sizeText(e.size)}</td>` +
          `<td class="col-path" title="${esc(e.path)}">${esc(e.dir)}</td>` +
        `</tr>`
      );
    });
    tbody.innerHTML = rows.join('');

    const parts = [];
    if (entries.length) parts.push(`待改名 ${view.okCount}`);
    if (view.conflicts) parts.push(`重名冲突 ${view.conflicts}`);
    if (view.invalid) parts.push(`无效 ${view.invalid}`);
    if (view.filteredOut) parts.push(`已过滤 ${view.filteredOut}`);
    statusEl.textContent = parts.join(' · ');
    statusEl.classList.toggle('warn', view.conflicts > 0 || view.invalid > 0);

    btnExec.disabled = busy || view.okCount === 0 || view.blocked || !isTauri;
    btnUndo.disabled = busy || undoStack.length === 0;
    btnUndo.textContent = undoStack.length ? `撤销(${undoStack.length})` : '撤销';
    const btnRedo = $('btnRedo');
    btnRedo.disabled = busy || redoStack.length === 0;
    btnRedo.textContent = redoStack.length ? `重做(${redoStack.length})` : '重做';
  }

  // ---------- 交互 ----------
  rulePanel.addEventListener('input', recompute);
  rulePanel.addEventListener('change', recompute);

  tbody.addEventListener('click', (ev) => {
    const tr = ev.target.closest('tr[data-i]');
    if (!tr) return;
    const i = +tr.dataset.i;
    if (ev.target.matches('input[type="checkbox"]')) {
      entries[i].checked = ev.target.checked;
      recompute();
      return;
    }
    selected = selected === i ? -1 : i;
    recompute();
  });

  $('btnSelectAll').addEventListener('click', () => {
    for (const e of entries) if (e.pass) e.checked = true;
    recompute();
  });
  $('btnInvert').addEventListener('click', () => {
    for (const e of entries) if (e.pass) e.checked = !e.checked;
    recompute();
  });
  $('btnClear').addEventListener('click', () => {
    entries = [];
    prevNames.clear();
    selected = -1;
    recompute();
  });
  $('btnImportFiles').addEventListener('click', importFiles);
  $('btnImportDir').addEventListener('click', importFolder);

  async function doRename(ops) {
    busy = true;
    btnExec.classList.add('busy');
    btnExec.style.setProperty('--p', '0%');
    render();
    try {
      const done = await invoke('rename_batch', { ops });
      btnExec.style.setProperty('--p', '100%');
      return done;
    } finally {
      busy = false;
      btnExec.classList.remove('busy');
    }
  }

  btnExec.addEventListener('click', async () => {
    if (!isTauri) return toast('浏览器预览模式不支持改名，请用桌面端运行', true);
    const rules = collectRules();
    const picked = entries.filter((e) => e.pass && e.checked && e.status === 'ok' && !e.conflict);
    if (!picked.length) return;
    if (rules.skipConflict && entries.some((e) => e.conflict)) {
      return toast('存在重名冲突，已拒绝执行。请调整规则或取消勾选冲突行', true);
    }
    if (rules.confirmExec) {
      const ok = await rnConfirm(
        `即将重命名 ${picked.length} 个文件，确认执行？\n执行后可用「撤销」按钮恢复。`
      );
      if (!ok) return;
    }
    const ops = picked.map((e) => ({ old: e.path, new: joinPath(e.dir, e.newName) }));
    try {
      const reverse = await doRename(ops);
      // 更新内存中的条目，让列表继续可编辑
      const byOld = new Map(ops.map((o, i) => [o.old.toLowerCase(), { new: o.new, name: picked[i].newName }]));
      for (const e of entries) {
        const hit = byOld.get(e.path.toLowerCase());
        if (!hit) continue;
        e.path = hit.new;
        e.name = hit.name;
        e.newName = hit.name;
        e.status = 'same';
        e.conflict = false;
      }
      undoStack.push({ reverse, forward: ops });
      redoStack.length = 0;
      persistUndo();
      toast(`已重命名 ${reverse.length} 个文件`);
    } catch (err) {
      toast(String(err), true);
    }
    recompute();
  });

  $('btnUndo').addEventListener('click', async () => {
    const item = undoStack.pop();
    if (!item) return;
    busy = true;
    render();
    try {
      await invoke('rename_batch', { ops: item.reverse });
      const byCur = new Map(item.reverse.map((o) => [o.old.toLowerCase(), o.new]));
      for (const e of entries) {
        const back = byCur.get(e.path.toLowerCase());
        if (!back) continue;
        e.path = back;
        e.name = back.slice(Math.max(back.lastIndexOf('\\'), back.lastIndexOf('/')) + 1);
      }
      redoStack.push(item);
      toast('已撤销上一批改名');
    } catch (err) {
      toast(String(err), true);
    } finally {
      busy = false;
    }
    persistUndo();
    recompute();
  });

  $('btnRedo').addEventListener('click', async () => {
    const item = redoStack.pop();
    if (!item) return;
    busy = true;
    render();
    try {
      await invoke('rename_batch', { ops: item.forward });
      const byOld = new Map(item.forward.map((o) => [o.old.toLowerCase(), { new: o.new, name: o.new.slice(Math.max(o.new.lastIndexOf('\\'), o.new.lastIndexOf('/')) + 1) }]));
      for (const e of entries) {
        const hit = byOld.get(e.path.toLowerCase());
        if (!hit) continue;
        e.path = hit.new;
        e.name = hit.name;
        e.newName = hit.name;
        e.status = 'same';
        e.conflict = false;
      }
      undoStack.push(item);
      toast('已重做');
    } catch (err) {
      toast(String(err), true);
    } finally {
      busy = false;
    }
    persistUndo();
    recompute();
  });

  // ---------- 持久化：规则预设 + 撤销/重做 ----------
  const LS = {
    presets: 'rn.presets.v1',
    current: 'rn.currentRules.v1',
    active: 'rn.activePreset.v1',
    undo: 'rn.undo.v1',
    redo: 'rn.redo.v1',
  };
  const MAX_UNDO = 20;

  function safeLS(key, val) {
    try {
      if (val === undefined) return localStorage.getItem(key);
      if (val === null) localStorage.removeItem(key);
      else localStorage.setItem(key, val);
    } catch { /* 配额满 / 隐私模式 —— 静默忽略 */ }
  }
  function loadJSON(key, fallback) {
    const raw = safeLS(key);
    if (!raw) return fallback;
    try { return JSON.parse(raw); } catch { return fallback; }
  }
  function persistUndo() {
    safeLS(LS.undo, JSON.stringify(undoStack.slice(-MAX_UNDO)));
    safeLS(LS.redo, JSON.stringify(redoStack.slice(-MAX_UNDO)));
  }
  function persistCurrentRules() {
    safeLS(LS.current, JSON.stringify(collectRules()));
  }
  function loadPresets() {
    return loadJSON(LS.presets, {});
  }
  function savePresets(map) {
    safeLS(LS.presets, JSON.stringify(map));
  }
  function refreshPresetUI() {
    const map = loadPresets();
    const names = Object.keys(map).sort();
    const sel = $('presetList');
    const cur = sel.value;
    sel.innerHTML = '<option value="">— 当前 —</option>' +
      names.map((n) => `<option value="${esc(n)}">${esc(n)}</option>`).join('');
    if (cur && cur in map) sel.value = cur;
    const active = safeLS(LS.active);
    if (!cur && active && active in map) sel.value = active;
    $('presetDelete').disabled = !sel.value;
  }

  $('presetList').addEventListener('change', () => {
    const name = $('presetList').value;
    if (!name) {
      safeLS(LS.active, '');
      return;
    }
    const map = loadPresets();
    if (map[name]) {
      applyRules(map[name]);
      safeLS(LS.active, name);
      recompute();
    }
    $('presetDelete').disabled = false;
  });
  $('presetSave').addEventListener('click', () => {
    const name = $('presetList').value;
    if (!name) return toast('请先选一个预设名，或点「另存为…」', true);
    const map = loadPresets();
    map[name] = collectRules();
    savePresets(map);
    safeLS(LS.active, name);
    refreshPresetUI();
    toast(`已保存预设「${name}」`);
  });
  $('presetSaveAs').addEventListener('click', async () => {
    const name = await rnPrompt('保存为新预设', '', '预设名');
    if (name === null) return;
    const trim = name.trim();
    if (!trim) return toast('预设名不能为空', true);
    const map = loadPresets();
    map[trim] = collectRules();
    savePresets(map);
    safeLS(LS.active, trim);
    refreshPresetUI();
    $('presetList').value = trim;
    toast(`已保存预设「${trim}」`);
  });
  $('presetDelete').addEventListener('click', () => {
    const name = $('presetList').value;
    if (!name) return;
    const map = loadPresets();
    delete map[name];
    savePresets(map);
    safeLS(LS.active, '');
    refreshPresetUI();
    toast(`已删除预设「${name}」`);
  });

  rulePanel.addEventListener('input', persistCurrentRules);
  rulePanel.addEventListener('change', persistCurrentRules);

  // 打开时：恢复上次的规则（如果上次是某个预设，也同步选中）
  (function restoreSession() {
    try {
      const u = loadJSON(LS.undo, []);
      const r = loadJSON(LS.redo, []);
      if (Array.isArray(u)) undoStack.push(...u);
      if (Array.isArray(r)) redoStack.push(...r);
    } catch { /* 版本不匹配就放弃 */ }
    refreshPresetUI();
    const current = loadJSON(LS.current, null);
    if (current) {
      try { applyRules(current); } catch { /* 旧版本存储格式变化时忽略 */ }
    }
  })();

  // 初始：让控件禁用态与圆点先就位
  syncControls();
  showTab('overall');
  recompute();
  persistCurrentRules();

  return {
    importPaths,
    redraw() {
      if (!page.classList.contains('hidden')) render();
    },
  };
}
