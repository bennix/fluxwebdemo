'use strict';

(() => {
  const canvas = document.getElementById('board');
  const ctx = canvas.getContext('2d');
  const statusEl = document.getElementById('status');
  const hintsEl = document.getElementById('hints');
  const riskText = document.getElementById('riskText');
  const riskBar = document.getElementById('riskBar');
  const verifyBtn = document.getElementById('verify');
  const resetBtn = document.getElementById('reset');
  const attackBtn = document.getElementById('attack');
  const resultEl = document.getElementById('result');
  const resultTitle = document.getElementById('resultTitle');
  const resultText = document.getElementById('resultText');
  const resultPath = document.getElementById('resultPath');

  const N = 3;
  const TILE = 128;
  const GAP = 10;
  const START = Math.floor((440 - (N * TILE + (N - 1) * GAP)) / 2);
  const DPR = Math.min(window.devicePixelRatio || 1, 2);
  canvas.width = 440 * DPR;
  canvas.height = 440 * DPR;
  ctx.scale(DPR, DPR);

  let challengeId = '';
  let tiles = [];
  let dragging = null;
  let grabDX = 0;
  let grabDY = 0;
  let dragStartSlot = null;
  let events = [];
  let t0 = performance.now();
  let solved = false;
  let verifying = false;
  let lastDragEndedAt = -Infinity;
  const verifyAfterDragDelayMs = 420;

  function slotPos(slot) {
    const col = slot % N;
    const row = Math.floor(slot / N);
    return { x: START + col * (TILE + GAP), y: START + row * (TILE + GAP) };
  }

  function point(e) {
    const rect = canvas.getBoundingClientRect();
    const scale = 440 / rect.width;
    return { x: (e.clientX - rect.left) * scale, y: (e.clientY - rect.top) * scale };
  }

  function record(type, x, y, extra = {}) {
    if (events.length >= 1200) return;
    events.push({
      type,
      x: Math.round(x * 10) / 10,
      y: Math.round(y * 10) / 10,
      t: Math.round(performance.now() - t0),
      ...extra
    });
  }

  function tileAt(x, y) {
    for (let i = tiles.length - 1; i >= 0; i -= 1) {
      const tile = tiles[i];
      if (x >= tile.curX && x <= tile.curX + TILE && y >= tile.curY && y <= tile.curY + TILE) return tile;
    }
    return null;
  }

  function nearestSlot(cx, cy) {
    let best = 0;
    let bestDist = Infinity;
    for (let slot = 0; slot < N * N; slot += 1) {
      const p = slotPos(slot);
      const dx = cx - (p.x + TILE / 2);
      const dy = cy - (p.y + TILE / 2);
      const dist = dx * dx + dy * dy;
      if (dist < bestDist) {
        best = slot;
        bestDist = dist;
      }
    }
    return best;
  }

  function mapping() {
    const out = new Array(N * N);
    for (const tile of tiles) out[tile.id] = tile.slot;
    return out;
  }

  function scoreLocal() {
    const moves = events.filter(e => e.type === 'move').length;
    const swaps = events.filter(e => e.type === 'swap').length;
    const score = Math.min(1, moves / 32 * .65 + swaps / 5 * .35);
    riskBar.style.width = `${Math.round(score * 100)}%`;
    riskText.textContent = score < .42 ? '轨迹样本不足' : '轨迹样本已形成';
  }

  function showResult(title, text, ok) {
    resultEl.classList.toggle('fail', !ok);
    resultEl.classList.add('show');
    resultTitle.textContent = title;
    resultText.textContent = text;
    resultPath.setAttribute('d', ok ? 'M5 13l4 4L19 7' : 'M7 7l10 10M17 7L7 17');
  }

  function loadImage(src) {
    return new Promise((resolve, reject) => {
      const img = new Image();
      img.onload = () => resolve(img);
      img.onerror = reject;
      img.src = src;
    });
  }

  async function loadChallenge() {
    solved = false;
    verifying = false;
    resultEl.classList.remove('show', 'fail');
    statusEl.textContent = '正在领取挑战...';
    events = [];
    t0 = performance.now();
    const response = await fetch('/api/challenge', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' });
    const challenge = await response.json();
    if (!response.ok) throw new Error(challenge.reason || 'challenge failed');
    challengeId = challenge.challenge_id;
    hintsEl.innerHTML = '';
    for (const hint of challenge.hint_images || []) {
      const img = document.createElement('img');
      img.alt = hint.label || 'ASCII hint';
      img.src = hint.image;
      hintsEl.appendChild(img);
    }
    tiles = await Promise.all(challenge.tiles.map(async item => {
      const p = slotPos(item.start_slot);
      return { id: item.id, slot: item.start_slot, curX: p.x, curY: p.y, img: await loadImage(item.image) };
    }));
    statusEl.textContent = '拖动碎片拼合字符，然后点击验证';
    scoreLocal();
  }

  function onDown(e) {
    if (solved || verifying) return;
    const p = point(e);
    const tile = tileAt(p.x, p.y);
    if (!tile) return;
    dragging = tile;
    dragStartSlot = tile.slot;
    grabDX = p.x - tile.curX;
    grabDY = p.y - tile.curY;
    tiles.splice(tiles.indexOf(tile), 1);
    tiles.push(tile);
    canvas.classList.add('grabbing');
    canvas.setPointerCapture(e.pointerId);
    record('down', p.x, p.y, { tile_id: tile.id, from_slot: tile.slot });
  }

  function onMove(e) {
    if (!dragging) return;
    const p = point(e);
    dragging.curX = p.x - grabDX;
    dragging.curY = p.y - grabDY;
    record('move', p.x, p.y);
    const target = nearestSlot(dragging.curX + TILE / 2, dragging.curY + TILE / 2);
    if (target !== dragging.slot) {
      record('swap', p.x, p.y, { tile_id: dragging.id, from_slot: dragging.slot, to_slot: target });
      const other = tiles.find(tile => tile !== dragging && tile.slot === target);
      if (other) {
        other.slot = dragging.slot;
        dragging.slot = target;
      }
    }
    scoreLocal();
  }

  function onUp(e) {
    if (!dragging) return;
    const p = point(e);
    const target = nearestSlot(dragging.curX + TILE / 2, dragging.curY + TILE / 2);
    if (target !== dragging.slot) {
      record('swap', p.x, p.y, { tile_id: dragging.id, from_slot: dragging.slot, to_slot: target });
      const other = tiles.find(tile => tile !== dragging && tile.slot === target);
      if (other) {
        other.slot = dragging.slot;
        dragging.slot = target;
      }
    }
    const finished = dragging;
    dragging = null;
    canvas.classList.remove('grabbing');
    record('up', p.x, p.y, { tile_id: finished.id, from_slot: dragStartSlot, to_slot: finished.slot });
    dragStartSlot = null;
    lastDragEndedAt = performance.now();
    statusEl.textContent = '碎片已放置 · 继续拼合或点击验证';
    scoreLocal();
  }

  async function submit(e) {
    if (solved || verifying || !challengeId) return;
    if (e && e.isTrusted === false) return;
    if (dragging || performance.now() - lastDragEndedAt < verifyAfterDragDelayMs) {
      statusEl.textContent = '碎片已放置 · 请松手后再点击验证';
      return;
    }
    verifying = true;
    record('verify_click', e?.clientX || 0, e?.clientY || 0, { target: 'check' });
    statusEl.textContent = '正在提交服务端验证...';
    const response = await fetch('/api/verify', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ challenge_id: challengeId, mapping: mapping(), events })
    });
    const verdict = await response.json();
    if (verdict.pass) {
      solved = true;
      showResult('验证通过', '服务端已确认拼合与轨迹', true);
      window.location.replace('/verified');
    } else {
      showResult('验证未通过', 'challenge 已失效，请重新挑战', false);
      window.location.replace('/failed');
    }
  }

  function simulateAttack() {
    showResult('自动攻击失败', '边界匹配只能得到候选排列\n页面不会绕过验证按钮直接提交', false);
    statusEl.textContent = '抗拼图生效：模拟攻击不会直接提交服务端验证';
    setTimeout(() => resultEl.classList.remove('show', 'fail'), 2400);
  }

  function draw() {
    const t = performance.now() / 1000;
    ctx.clearRect(0, 0, 440, 440);
    const grad = ctx.createRadialGradient(220, 220, 20, 220, 220, 270);
    grad.addColorStop(0, '#0d1d2b');
    grad.addColorStop(1, '#05070d');
    ctx.fillStyle = grad;
    ctx.fillRect(0, 0, 440, 440);
    ctx.save();
    ctx.globalAlpha = .24;
    for (let i = 0; i < 9; i += 1) {
      ctx.strokeStyle = i % 2 ? '#ff43dc' : '#28e6ff';
      ctx.lineWidth = 2;
      ctx.beginPath();
      const y = 54 + i * 42 + Math.sin(t * 1.6 + i) * 8;
      ctx.moveTo(8, y);
      ctx.bezierCurveTo(120, y - 40, 280, y + 40, 432, y - 12);
      ctx.stroke();
    }
    ctx.restore();
    for (let slot = 0; slot < N * N; slot += 1) {
      const p = slotPos(slot);
      ctx.strokeStyle = 'rgba(217,239,255,.16)';
      ctx.strokeRect(p.x, p.y, TILE, TILE);
    }
    for (const tile of tiles) {
      if (tile === dragging) continue;
      const p = slotPos(tile.slot);
      tile.curX += (p.x - tile.curX) * .22;
      tile.curY += (p.y - tile.curY) * .22;
      drawTile(tile, false, t);
    }
    if (dragging) drawTile(dragging, true, t);
    requestAnimationFrame(draw);
  }

  function drawTile(tile, active, t) {
    ctx.save();
    const lift = active ? -3 : Math.sin(t * 2 + tile.id) * .8;
    ctx.shadowColor = active ? 'rgba(40,230,255,.48)' : 'rgba(0,0,0,.45)';
    ctx.shadowBlur = active ? 24 : 12;
    ctx.drawImage(tile.img, tile.curX, tile.curY + lift, TILE, TILE);
    ctx.restore();
  }

  canvas.addEventListener('pointerdown', onDown);
  canvas.addEventListener('pointermove', onMove);
  canvas.addEventListener('pointerup', onUp);
  canvas.addEventListener('pointercancel', onUp);
  verifyBtn.addEventListener('click', submit);
  resetBtn.addEventListener('click', () => loadChallenge().catch(() => { statusEl.textContent = '挑战领取失败'; }));
  attackBtn.addEventListener('click', simulateAttack);

  loadChallenge().catch(() => { statusEl.textContent = '挑战领取失败'; });
  requestAnimationFrame(draw);
})();
