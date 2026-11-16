// Generic Tinder-style deck. Knows nothing about fashion: it renders items with `render`,
// reports swipes with `onSwipe`, and asks `need()` for more items when the queue runs low.
//   right / → = like,  left / ← = nope,  up / ↑ = super (order)
const THRESH_X = 110, THRESH_Y = 120, VISIBLE = 3;
const DIRS = { right: 'like', left: 'nope', up: 'super' };

export class Deck {
  constructor(el, { render, onSwipe, need, minQueue = 3, emptyHtml = '' }) {
    Object.assign(this, { el, render, onSwipe, need, minQueue, emptyHtml });
    this.queue = [];
    this.loading = false;
    this.busy = false;
    el.classList.add('deck');
    this.keyHandler = (e) => {
      if (e.target.closest('input, textarea, dialog[open]')) return;
      const dir = { ArrowRight: 'right', ArrowLeft: 'left', ArrowUp: 'up' }[e.key];
      if (dir) { e.preventDefault(); this.swipe(dir); }
    };
    addEventListener('keydown', this.keyHandler);
  }

  add(items) { this.queue.push(...items); this.paint(); }
  get top() { return this.queue[0]; }

  async refill() {
    if (this.loading || !this.need || this.queue.length >= this.minQueue) return;
    this.loading = true; this.paint();
    try {
      const more = await this.need();
      if (more?.length) this.queue.push(...more);
    } catch (e) {
      console.error(e);
      this.error = e.message || String(e);
    } finally { this.loading = false; this.paint(); }
  }

  paint() {
    const shown = this.queue.slice(0, VISIBLE);
    // drop cards that left the queue
    [...this.el.querySelectorAll('.card')].forEach((c) => { if (!shown.includes(c._item) && !c.classList.contains('flying')) c.remove(); });
    shown.forEach((item, i) => {
      let card = [...this.el.querySelectorAll('.card')].find((c) => c._item === item);
      if (!card) {
        card = document.createElement('article');
        card.className = 'card';
        card._item = item;
        card.append(this.render(item));
        card.insertAdjacentHTML('beforeend', '<div class="stamp stamp-like">LIKE</div><div class="stamp stamp-nope">NOPE</div><div class="stamp stamp-super">ORDER</div>');
        this.el.prepend(card);
      }
      card.style.zIndex = String(VISIBLE - i);
      card.style.setProperty('--depth', i);
      card.classList.toggle('top', i === 0);
      if (i === 0 && !card._topAt) card._topAt = Date.now(); // for time-on-card (dwell) tracking
      if (i === 0 && !card._bound) this.bind(card);
    });
    let status = this.el.querySelector('.deck-status');
    if (!shown.length) {
      if (!status) { status = document.createElement('div'); status.className = 'deck-status'; this.el.append(status); }
      status.innerHTML = this.error
        ? `<p class="err">Couldn't load more designs.</p><p class="muted small">${escapeHtml(this.error)}</p><button class="btn" data-retry>Try again</button>`
        : this.loading ? '<div class="spinner"></div><p class="muted">Designing for you…</p>' : this.emptyHtml;
      status.querySelector('[data-retry]')?.addEventListener('click', () => { this.error = null; this.refill(); });
    } else status?.remove();
  }

  bind(card) {
    card._bound = true;
    let sx = 0, sy = 0, dx = 0, dy = 0, dragging = false;
    const move = (e) => {
      if (!dragging) return;
      dx = e.clientX - sx; dy = e.clientY - sy;
      card.style.transform = `translate(${dx}px, ${dy}px) rotate(${dx / 14}deg)`;
      card.style.setProperty('--p-like', clamp(dx / THRESH_X));
      card.style.setProperty('--p-nope', clamp(-dx / THRESH_X));
      card.style.setProperty('--p-super', clamp(-dy / THRESH_Y) * (Math.abs(dx) < THRESH_X ? 1 : 0));
    };
    const up = () => {
      if (!dragging) return;
      dragging = false;
      card.classList.remove('dragging');
      const dir = dx > THRESH_X ? 'right' : dx < -THRESH_X ? 'left' : dy < -THRESH_Y && Math.abs(dx) < THRESH_X ? 'up' : null;
      if (dir) this.swipe(dir, { dx, dy });
      else { card.style.transform = ''; ['--p-like', '--p-nope', '--p-super'].forEach((v) => card.style.setProperty(v, 0)); }
    };
    card.addEventListener('pointerdown', (e) => {
      if (e.target.closest('button, a') || this.busy) return;
      dragging = true; sx = e.clientX; sy = e.clientY; dx = dy = 0;
      card.setPointerCapture(e.pointerId);
      card.classList.add('dragging');
    });
    card.addEventListener('pointermove', move);
    card.addEventListener('pointerup', up);
    card.addEventListener('pointercancel', up);
  }

  async swipe(direction, from = {}) {
    const card = this.el.querySelector('.card.top');
    const item = this.queue[0];
    if (!card || !item || this.busy) return;
    this.busy = true;
    const w = innerWidth;
    const to = { right: [w * 1.2, from.dy || 40], left: [-w * 1.2, from.dy || 40], up: [from.dx || 0, -innerHeight] }[direction];
    card.classList.add('flying');
    card.style.setProperty(`--p-${DIRS[direction]}`, 1);
    card.style.transform = `translate(${to[0]}px, ${to[1]}px) rotate(${direction === 'up' ? 0 : to[0] / 40}deg)`;
    this.queue.shift();
    setTimeout(() => card.remove(), 350);
    setTimeout(() => (this.busy = false), 280);
    this.paint();
    // swipe handlers run strictly in order (each one builds on the previous profile) without blocking the UI
    this.chain = (this.chain || Promise.resolve())
      .then(() => this.onSwipe(item, DIRS[direction], { viewedMs: Date.now() - (card._topAt || Date.now()) }))
      .catch((e) => console.error('[deck] onSwipe failed', e))
      .then(() => this.refill());
    return this.chain;
  }

  destroy() { removeEventListener('keydown', this.keyHandler); this.el.innerHTML = ''; }
}

const clamp = (v) => Math.max(0, Math.min(1, v));
export const escapeHtml = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
