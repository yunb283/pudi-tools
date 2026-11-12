// 两个 GIF 页共用缩略图、选帧和操作菜单；帧数据与播放范围由各页管理。
export function createGifFrameStrip({
  prefix, getFrame, getDetails, activeCount, hiddenCount, isLocked, pauseThumbnails,
  onNavigate, onPreview, onEdit, onSave,
}) {
  const $ = (id) => document.getElementById(id);
  const framePanel = $(`${prefix}-frames`);
  const page = framePanel.closest('.page');
  const template = $('gif-frame-strip-template').content.cloneNode(true);
  for (const el of template.querySelectorAll('[data-part]')) el.id = `${prefix}-${el.dataset.part}`;
  for (const el of template.querySelectorAll('[data-command]')) el.dataset.command = `${prefix}-${el.dataset.command}`;
  framePanel.append(template);
  const strip = $(`${prefix}-strip`);
  const frameMenu = $(`${prefix}-frame-menu`);
  const framesCount = $(`${prefix}-frames-count`);
  const emptyFrames = $(`${prefix}-frames-empty`);
  const firstFrameBtn = $(`${prefix}-frames-first`);
  const lastFrameBtn = $(`${prefix}-frames-last`);
  const hideFramesBtn = $(`${prefix}-frames-hide`);
  const restoreFramesBtn = $(`${prefix}-frames-restore`);
  const deleteFramesBtn = $(`${prefix}-frames-delete`);
  const saveFramesBtn = $(`${prefix}-frames-save`);

  const cards = new Map();
  const visibleCards = new Set();
  const selectedFrames = new Set();
  let selectionAnchor = null;
  const thumbSource = document.createElement('canvas');
  const thumbCtx = thumbSource.getContext('2d');
  let thumbRaf = 0;
  let currentCard = null;
  let stripDrag = null;
  let suppressStripClick = false;
  let menuAnchor = null;
  const thumbObserver = new IntersectionObserver((entries) => {
    for (const { target, isIntersecting } of entries) {
      const card = cards.get(Number(target.dataset.source));
      if (card?.button !== target) continue;
      if (isIntersecting) visibleCards.add(card);
      else {
        visibleCards.delete(card);
        card.image.replaceChildren();
      }
    }
    scheduleThumbnails();
  }, { root: strip, rootMargin: '0px 120px' });

  function scheduleThumbnails() {
    if (thumbRaf || isLocked() || pauseThumbnails()) return;
    if ([...visibleCards].some((card) => !card.image.firstChild)) {
      thumbRaf = requestAnimationFrame(drawThumbnails);
    }
  }

  function drawThumbnails() {
    thumbRaf = 0;
    if (isLocked() || pauseThumbnails()) return;
    const until = performance.now() + 6;
    // 只合成视口附近的缩略图，复用预览的缓存，大文件打开时无需先合成每一帧。
    for (const card of visibleCards) {
      if (card.image.firstChild) continue;
      const { width, height, data } = getFrame(card.source);
      if (thumbSource.width !== width) thumbSource.width = width;
      if (thumbSource.height !== height) thumbSource.height = height;
      const scale = Math.min(108 / width, 72 / height);
      thumbCtx.putImageData(new ImageData(data, width, height), 0, 0);
      const thumb = document.createElement('canvas');
      thumb.width = Math.max(1, Math.round(width * scale));
      thumb.height = Math.max(1, Math.round(height * scale));
      thumb.getContext('2d').drawImage(thumbSource, 0, 0, thumb.width, thumb.height);
      card.image.append(thumb);
      if (performance.now() >= until) break;
    }
    scheduleThumbnails();
  }

  function setCurrent(src) {
    const next = cards.get(src)?.button;
    if (currentCard === next) return;
    currentCard?.removeAttribute('aria-current');
    currentCard = next;
    currentCard?.setAttribute('aria-current', 'true');
  }

  function syncStripActions() {
    const count = selectedFrames.size;
    const selectedHidden = [...selectedFrames].filter((src) => getDetails(src).hidden).length;
    firstFrameBtn.disabled = lastFrameBtn.disabled = isLocked() || !activeCount();
    hideFramesBtn.disabled = isLocked() || count === selectedHidden;
    restoreFramesBtn.disabled = isLocked() || selectedHidden === 0;
    deleteFramesBtn.disabled = saveFramesBtn.disabled = isLocked() || count === 0;
    framesCount.textContent = `${activeCount()} 帧播放 · 已选 ${count} 帧` +
      (hiddenCount() ? ` · ${hiddenCount()} 帧隐藏` : '');
  }

  function syncFrameCards() {
    for (const [src, card] of cards) {
      const { hidden, skipped, delay } = getDetails(src);
      const label = hidden ? '已隐藏' : skipped ? '抽帧跳过' : '';
      card.button.classList.toggle('excluded', !!label);
      card.button.classList.toggle('is-hidden', hidden);
      card.delay.textContent = `${delay} ms`;
      card.hiddenBadge.hidden = !hidden;
      card.hiddenBadge.textContent = hidden ? label : '';
      card.state.textContent = hidden ? '' : label;
      card.state.hidden = hidden || !label;
      card.button.title = `源第 ${src + 1} 帧 · ${delay} ms${label ? ' · ' + label : ''}`;
      card.button.setAttribute('aria-label', card.button.title);
    }
    emptyFrames.hidden = cards.size !== 0;
    strip.hidden = cards.size === 0;
    syncStripSelection();
  }

  function syncStripSelection() {
    for (const [src, { button }] of cards) {
      const value = String(selectedFrames.has(src));
      if (button.getAttribute('aria-pressed') !== value) button.setAttribute('aria-pressed', value);
    }
    syncStripActions();
  }

  function reset(count = 0, open = count > 0) {
    closeFrameMenu();
    endStripDrag();
    suppressStripClick = false;
    if (thumbRaf) cancelAnimationFrame(thumbRaf);
    thumbRaf = 0;
    thumbObserver.disconnect();
    cards.clear();
    visibleCards.clear();
    selectedFrames.clear();
    currentCard = null;
    selectionAnchor = null;
    thumbSource.width = thumbSource.height = 1;
    strip.replaceChildren();
    strip.scrollLeft = 0;
    framePanel.hidden = !open;
    const fragment = document.createDocumentFragment();
    for (let source = 0; source < count; source++) {
      const button = document.createElement('button');
      button.type = 'button';
      button.className = 'gv-frame';
      button.dataset.source = String(source);
      button.innerHTML = '<span class="gv-frame-image" aria-hidden="true">' +
        '<span class="gv-frame-pixels"></span><span class="gv-frame-hidden" hidden></span></span>' +
        '<span class="gv-frame-caption"><span></span><span></span></span>' +
        '<span class="gv-frame-state"></span>';
      const [preview, caption, state] = button.children;
      const [image, hiddenBadge] = preview.children;
      const [number, delay] = caption.children;
      number.textContent = String(source + 1);
      cards.set(source, { source, button, image, hiddenBadge, delay, state });
      fragment.append(button);
    }
    strip.append(fragment);
    for (const { button } of cards.values()) thumbObserver.observe(button);
  }

  function remove(sources) {
    for (const src of sources) {
      const card = cards.get(src);
      if (!card) continue;
      thumbObserver.unobserve(card.button);
      visibleCards.delete(card);
      cards.delete(src);
      selectedFrames.delete(src);
      if (selectionAnchor === src) selectionAnchor = null;
      card.button.remove();
    }
  }

  function invalidateThumbnails() {
    for (const card of visibleCards) card.image.replaceChildren();
    scheduleThumbnails();
  }

  function endStripDrag() {
    stripDrag = null;
    strip.classList.remove('dragging');
  }

  strip.addEventListener('wheel', (e) => {
    // 竖向滚轮转成横向滚动，触控板的横向手势和 Shift + 滚轮交给浏览器。
    if (e.ctrlKey || e.shiftKey || Math.abs(e.deltaY) <= Math.abs(e.deltaX) ||
        strip.scrollWidth <= strip.clientWidth) return;
    const unit = e.deltaMode === WheelEvent.DOM_DELTA_LINE ? 16
      : e.deltaMode === WheelEvent.DOM_DELTA_PAGE ? strip.clientWidth : 1;
    e.preventDefault();
    strip.scrollLeft += e.deltaY * unit;
  }, { passive: false });

  strip.addEventListener('pointerdown', (e) => {
    if (e.pointerType !== 'mouse' || e.button !== 0) return;
    suppressStripClick = false;
    const contentBottom = strip.getBoundingClientRect().top + strip.clientTop + strip.clientHeight;
    if (e.clientY >= contentBottom || strip.scrollWidth <= strip.clientWidth) return;
    stripDrag = { id: e.pointerId, x: e.clientX, scrollLeft: strip.scrollLeft };
  });
  window.addEventListener('pointermove', (e) => {
    if (stripDrag?.id !== e.pointerId) return;
    if (!(e.buttons & 1)) {
      endStripDrag();
      return;
    }
    const dx = e.clientX - stripDrag.x;
    if (!suppressStripClick) {
      if (Math.abs(dx) < 5) return;
      strip.setPointerCapture(e.pointerId);
      strip.classList.add('dragging');
      suppressStripClick = true;
    }
    e.preventDefault();
    strip.scrollLeft = stripDrag.scrollLeft - dx;
  }, { passive: false });
  for (const event of ['pointerup', 'pointercancel', 'lostpointercapture']) {
    window.addEventListener(event, (e) => {
      if (stripDrag?.id === e.pointerId) endStripDrag();
    });
  }
  window.addEventListener('blur', () => {
    endStripDrag();
    closeFrameMenu();
  });

  function selectOnlyFrame(src) {
    selectedFrames.clear();
    selectedFrames.add(src);
    selectionAnchor = src;
  }

  function jumpStripFrame(direction, focusCard = false) {
    if (!activeCount() || isLocked()) return;
    const src = onNavigate(direction);
    if (src === undefined) return;
    selectOnlyFrame(src);
    syncStripSelection();
    if (focusCard) currentCard?.focus({ preventScroll: true });
    currentCard?.scrollIntoView({ block: 'nearest', inline: 'nearest' });
  }

  function previewSelectedFrame(src) {
    onPreview(src);
    syncStripSelection();
  }

  strip.addEventListener('click', (e) => {
    if (suppressStripClick && e.detail > 0) {
      suppressStripClick = false;
      return;
    }
    const button = e.target.closest('.gv-frame');
    if (!button || isLocked()) return;
    const src = Number(button.dataset.source);
    const additive = e.ctrlKey || e.metaKey;
    if (e.shiftKey && selectionAnchor !== null) {
      if (!additive) selectedFrames.clear();
      const lo = Math.min(src, selectionAnchor);
      const hi = Math.max(src, selectionAnchor);
      for (const index of cards.keys()) {
        if (index >= lo && index <= hi) selectedFrames.add(index);
      }
    } else if (additive) {
      if (selectedFrames.has(src)) selectedFrames.delete(src);
      else selectedFrames.add(src);
      selectionAnchor = src;
    } else selectOnlyFrame(src);
    previewSelectedFrame(src);
  });

  strip.addEventListener('keydown', (e) => {
    if (isLocked() || !(e.ctrlKey || e.metaKey) || e.key.toLowerCase() !== 'a') return;
    e.preventDefault();
    for (const src of cards.keys()) selectedFrames.add(src);
    syncStripSelection();
  });

  function closeFrameMenu(restoreFocus = false) {
    if (frameMenu.hidden) return;
    frameMenu.hidden = true;
    if (restoreFocus) menuAnchor?.focus({ preventScroll: true });
    menuAnchor = null;
  }

  strip.addEventListener('contextmenu', (e) => {
    const button = e.target.closest('.gv-frame');
    if (!button || isLocked()) return;
    e.preventDefault();
    const src = Number(button.dataset.source);
    if (!selectedFrames.has(src)) selectOnlyFrame(src);
    previewSelectedFrame(src);
    menuAnchor = button;
    for (const item of frameMenu.querySelectorAll('[data-command]')) {
      item.hidden = $(item.dataset.command).disabled;
    }
    frameMenu.hidden = false;
    const anchor = button.getBoundingClientRect();
    const x = e.clientX || anchor.left;
    const y = e.clientY || anchor.bottom;
    frameMenu.style.left = `${Math.max(4, Math.min(x, innerWidth - frameMenu.offsetWidth - 4))}px`;
    frameMenu.style.top = `${Math.max(4, Math.min(y, innerHeight - frameMenu.offsetHeight - 4))}px`;
    frameMenu.querySelector('[data-command]:not([hidden])')?.focus({ preventScroll: true });
  });

  function runFrameCommand(item) {
    closeFrameMenu(true);
    $(item.dataset.command).click();
  }

  frameMenu.addEventListener('click', (e) => {
    const item = e.target.closest('[data-command]');
    if (item) runFrameCommand(item);
  });
  frameMenu.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' || e.key === 'Tab') {
      if (e.key === 'Escape') e.preventDefault();
      closeFrameMenu(true);
      return;
    }
    const items = [...frameMenu.querySelectorAll('[data-command]:not([hidden])')];
    const current = items.indexOf(document.activeElement);
    if (e.key === 'Enter' && current >= 0) {
      e.preventDefault();
      runFrameCommand(items[current]);
    } else if (e.key === 'ArrowUp' || e.key === 'ArrowDown') {
      e.preventDefault();
      const next = (current + (e.key === 'ArrowUp' ? -1 : 1) + items.length) % items.length;
      items[next]?.focus({ preventScroll: true });
    }
  });
  document.addEventListener('pointerdown', (e) => {
    if (!frameMenu.contains(e.target)) closeFrameMenu();
  });
  strip.addEventListener('scroll', () => closeFrameMenu());
  window.addEventListener('resize', () => closeFrameMenu());

  document.addEventListener('keydown', (e) => {
    if (page.classList.contains('hidden') || !frameMenu.hidden || !activeCount() || isLocked()) return;
    if (e.defaultPrevented || e.ctrlKey || e.metaKey || e.altKey ||
      e.target.closest?.('input, select, textarea, [contenteditable]')) return;
    if (e.key !== 'ArrowLeft' && e.key !== 'ArrowRight') return;
    e.preventDefault();
    jumpStripFrame(e.key === 'ArrowLeft' ? 'prev' : 'next', strip.contains(e.target));
  });

  firstFrameBtn.addEventListener('click', () => jumpStripFrame('first'));
  lastFrameBtn.addEventListener('click', () => jumpStripFrame('last'));
  hideFramesBtn.addEventListener('click', () => onEdit('hide', [...selectedFrames]));
  restoreFramesBtn.addEventListener('click', () => onEdit('restore', [...selectedFrames]));
  deleteFramesBtn.addEventListener('click', () => onEdit('delete', [...selectedFrames]));
  saveFramesBtn.addEventListener('click', () => onSave([...selectedFrames].sort((a, b) => a - b)));

  return {
    reset, remove, setCurrent, scheduleThumbnails, invalidateThumbnails,
    refresh: syncFrameCards, refreshActions: syncStripActions,
  };
}
