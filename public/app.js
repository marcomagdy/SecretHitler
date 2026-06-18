'use strict';

// --- Persisted session ----------------------------------------------------

const LS = {
  get gameId() { return localStorage.getItem('sh_gameId') || null; },
  set gameId(v) { v ? localStorage.setItem('sh_gameId', v) : localStorage.removeItem('sh_gameId'); },
  get playerId() { return localStorage.getItem('sh_playerId') || null; },
  set playerId(v) { v ? localStorage.setItem('sh_playerId', v) : localStorage.removeItem('sh_playerId'); },
  get name() { return localStorage.getItem('sh_name') || ''; },
  set name(v) { v ? localStorage.setItem('sh_name', v) : localStorage.removeItem('sh_name'); },
};

let gameId = LS.gameId;
let playerId = LS.playerId;
let pollTimer = null;
let currentScreen = null;
let busy = false; // true while a role submission is in flight

const $ = (id) => document.getElementById(id);

const ROLE_LABEL = { liberal: 'Liberal', fascist: 'Fascist', hitler: 'Hitler' };

// --- Helpers --------------------------------------------------------------

function show(id) {
  if (currentScreen === id) return false;
  document.querySelectorAll('.screen').forEach((s) => s.classList.toggle('active', s.id === id));
  currentScreen = id;
  return true;
}

function toast(msg, ms = 2600) {
  const t = $('toast');
  t.textContent = msg;
  t.classList.remove('hidden');
  clearTimeout(toast._t);
  toast._t = setTimeout(() => t.classList.add('hidden'), ms);
}

function setGameTag(code) {
  const tag = $('gameTag');
  if (code) { tag.textContent = 'Game ' + code; tag.classList.remove('hidden'); }
  else tag.classList.add('hidden');
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

async function api(method, url, body) {
  const opts = { method, headers: {} };
  if (body !== undefined) {
    opts.headers['Content-Type'] = 'application/json';
    opts.body = JSON.stringify(body);
  }
  const res = await fetch(url, opts);
  let data = {};
  try { data = (await res.json()) || {}; } catch (_) { /* no body */ }
  return { ok: res.ok, status: res.status, data };
}

// --- Navigation actions ---------------------------------------------------

async function startGame() {
  const r = await api('POST', '/api/games');
  if (!r.ok) { toast('Could not start a game. Is the server running?'); return; }
  gameId = LS.gameId = r.data.gameId;
  playerId = LS.playerId = null;
  $('codeDisplay').textContent = gameId;
  show('show-code');
}

function goJoin() {
  $('joinError').textContent = '';
  $('joinCodeInput').value = '';
  show('join');
  setTimeout(() => $('joinCodeInput').focus(), 50);
}

async function submitJoinCode() {
  const code = $('joinCodeInput').value.trim().toUpperCase();
  if (code.length !== 5) { $('joinError').textContent = 'Enter the full 5-letter code.'; return; }

  const r = await api('GET', `/api/games/${encodeURIComponent(code)}/state`);
  if (r.status === 404) { $('joinError').textContent = 'No game found with that code.'; return; }
  if (!r.ok) { $('joinError').textContent = 'Could not reach the server.'; return; }

  gameId = LS.gameId = code;
  playerId = LS.playerId = null;
  goName();
}

function goName() {
  $('nameError').textContent = '';
  $('nameInput').value = LS.name || '';
  show('name');
  setTimeout(() => $('nameInput').focus(), 50);
}

async function submitName() {
  const name = $('nameInput').value.trim();
  if (!name) { $('nameError').textContent = 'Please enter your name.'; return; }

  const r = await api('POST', `/api/games/${encodeURIComponent(gameId)}/join`, { name });
  if (r.status === 404) { $('nameError').textContent = 'That game no longer exists.'; return; }
  if (!r.ok) { $('nameError').textContent = r.data.error || 'Could not join.'; return; }

  playerId = LS.playerId = r.data.playerId;
  LS.name = name;
  startPolling();
}

async function chooseRole(role) {
  if (busy) return;
  busy = true;
  setRoleButtonsDisabled(true);
  const r = await api('POST', `/api/games/${encodeURIComponent(gameId)}/role`, { playerId, role });
  busy = false;
  if (!r.ok) {
    setRoleButtonsDisabled(false);
    toast(r.data.error || 'Could not submit your role.');
    return;
  }
  poll(); // advance immediately; the interval keeps it fresh
}

async function newRound() {
  const r = await api('POST', `/api/games/${encodeURIComponent(gameId)}/new-round`, { playerId });
  if (!r.ok) { toast('Could not start a new round.'); return; }
  poll();
}

function leaveGame() {
  stopPolling();
  // Fire-and-forget: tell the server the player left before wiping local state.
  if (gameId && playerId) {
    api('DELETE', `/api/games/${encodeURIComponent(gameId)}/players/${encodeURIComponent(playerId)}`)
      .catch(() => {});
  }
  gameId = LS.gameId = null;
  playerId = LS.playerId = null;
  setGameTag(null);
  show('home');
}

async function copyCode() {
  const code = $('codeDisplay').textContent;
  try { await navigator.clipboard.writeText(code); toast('Code copied!'); }
  catch (_) { toast('Copy unavailable — the code is ' + code); }
}

// --- Polling & routing ----------------------------------------------------

function startPolling() {
  stopPolling();
  poll();
  pollTimer = setInterval(poll, 1500);
}

function stopPolling() {
  if (pollTimer) { clearInterval(pollTimer); pollTimer = null; }
}

async function poll() {
  if (!gameId || !playerId) return;
  let r;
  try {
    r = await api('GET',
      `/api/games/${encodeURIComponent(gameId)}/state?playerId=${encodeURIComponent(playerId)}`);
  } catch (_) {
    return; // transient network error — keep the session and retry next tick
  }
  if (r.status === 404) { toast('This game has ended.'); leaveGame(); return; }
  if (!r.ok) return;

  const state = r.data;
  if (!state.you) { toast('You are no longer in this game.'); leaveGame(); return; }

  setGameTag(state.gameId);
  route(state);
}

function route(state) {
  if (!state.you.role) {
    show('role');
    setRoleButtonsDisabled(busy);
    return;
  }
  if (!state.allChosen) { renderWaiting(state); return; }
  renderResults(state);
}

function setRoleButtonsDisabled(disabled) {
  document.querySelectorAll('#role .role-card').forEach((b) => { b.disabled = disabled; });
}

// --- Renderers ------------------------------------------------------------

function renderWaiting(state) {
  show('waiting');
  const total = state.players.length;
  const ready = state.players.filter((p) => p.ready).length;
  $('waitingProgress').textContent =
    `${ready} of ${total} ${total === 1 ? 'player has' : 'players have'} chosen`;

  const ul = $('waitingRoster');
  ul.innerHTML = '';
  state.players.forEach((p) => {
    const li = document.createElement('li');
    li.className = 'roster-item' + (p.ready ? ' ready' : '');
    li.innerHTML = '<span class="dot"></span><span class="pname"></span><span class="pstatus"></span>';
    li.querySelector('.pname').textContent = p.name;
    li.querySelector('.pstatus').textContent = p.ready ? 'ready' : 'choosing…';
    ul.appendChild(li);
  });
  $('waitingCode').textContent = state.gameId;
}

function renderResults(state) {
  show('results');
  const res = state.results;   // { liberal, fascist, hitler, playerCount }
  const exp = state.expected;  // { liberal, fascist, hitler } | null

  // Count chips
  const countsEl = $('resultsCounts');
  countsEl.innerHTML = '';
  ['liberal', 'fascist', 'hitler'].forEach((role) => {
    const mismatch = exp && res[role] !== exp[role];
    const chip = document.createElement('div');
    chip.className = `count-chip ${role}` + (mismatch ? ' mismatch' : '');
    chip.innerHTML = '<div class="count-num"></div><div class="count-label"></div>';
    chip.querySelector('.count-num').textContent = res[role];
    chip.querySelector('.count-label').textContent =
      ROLE_LABEL[role] + (res[role] === 1 ? '' : 's');
    countsEl.appendChild(chip);
  });

  // Status banner
  const banner = $('resultsBanner');
  const warnings = [];
  if (res.hitler !== 1) warnings.push(`There should be exactly one Hitler (found ${res.hitler}).`);

  if (exp) {
    const matches =
      res.liberal === exp.liberal && res.fascist === exp.fascist && res.hitler === exp.hitler;
    if (matches && warnings.length === 0) {
      banner.className = 'banner ok';
      banner.textContent = `✓ Matches the standard setup for ${res.playerCount} players.`;
    } else {
      banner.className = 'banner warn';
      banner.textContent =
        `⚠ Expected for ${res.playerCount} players: ${exp.liberal} Liberal, ` +
        `${exp.fascist} Fascist, 1 Hitler. ` + warnings.join(' ');
    }
  } else {
    banner.className = 'banner warn';
    banner.textContent =
      `No standard distribution for ${res.playerCount} ` +
      `${res.playerCount === 1 ? 'player' : 'players'} — double-check manually. ` +
      warnings.join(' ');
  }

  // Your own role
  const yr = $('resultsYourRole');
  yr.className = 'your-role ' + state.you.role;
  yr.textContent =
    'You are ' + (state.you.role === 'hitler' ? 'Hitler' : 'a ' + ROLE_LABEL[state.you.role]);

  // Private reveal
  renderReveal($('resultsReveal'), state.reveal);
  $('resultsCode').textContent = state.gameId;
}

function renderReveal(el, reveal) {
  el.innerHTML = '';
  el.className = 'reveal';
  if (!reveal) return;

  if (reveal.role === 'fascist') {
    el.classList.add('fascist');
    const tm = reveal.teammates || [];
    const hit = (reveal.hitler || []).map(escapeHtml).join(', ');
    let html = '<h3>Fascist team</h3>';
    html += tm.length
      ? `<p>Your fellow Fascists: <strong>${escapeHtml(tm.join(', '))}</strong></p>`
      : '<p>You are the <strong>only</strong> Fascist.</p>';
    html += hit
      ? `<p>Hitler is: <strong>${hit}</strong></p>`
      : '<p><em>No one selected Hitler.</em></p>';
    el.innerHTML = html;
  } else if (reveal.role === 'hitler') {
    el.classList.add('hitler');
    if (reveal.knowsFascists) {
      const f = (reveal.fascists || []).map(escapeHtml).join(', ');
      el.innerHTML =
        '<h3>You are Hitler</h3>' +
        `<p>Your Fascist is: <strong>${f || '<em>none selected</em>'}</strong></p>` +
        '<p class="muted">In a 5–6 player game, Hitler knows the Fascist.</p>';
    } else {
      el.innerHTML =
        '<h3>You are Hitler</h3>' +
        '<p class="muted">In a 7+ player game you do not know the Fascists. Lay low.</p>';
    }
  } else {
    el.classList.add('liberal');
    el.innerHTML =
      '<h3>You are a Liberal</h3>' +
      '<p class="muted">You don\'t know anyone\'s secret role. Trust carefully.</p>';
  }
}

// --- Wire up --------------------------------------------------------------

function init() {
  $('btnStart').addEventListener('click', startGame);
  $('btnJoinHome').addEventListener('click', goJoin);
  $('btnCopyCode').addEventListener('click', copyCode);
  $('btnCodeContinue').addEventListener('click', goName);
  $('btnJoinSubmit').addEventListener('click', submitJoinCode);
  $('btnJoinBack').addEventListener('click', () => show('home'));
  $('joinCodeInput').addEventListener('input', (e) => {
    e.target.value = e.target.value.toUpperCase().replace(/[^A-Z]/g, '').slice(0, 5);
  });
  $('joinCodeInput').addEventListener('keydown', (e) => { if (e.key === 'Enter') submitJoinCode(); });
  $('btnNameSubmit').addEventListener('click', submitName);
  $('nameInput').addEventListener('keydown', (e) => { if (e.key === 'Enter') submitName(); });
  document.querySelectorAll('#role .role-card').forEach((b) =>
    b.addEventListener('click', () => chooseRole(b.dataset.role)));
  $('btnNewRound').addEventListener('click', newRound);
  $('btnLeave').addEventListener('click', leaveGame);
  $('btnLeaveWaiting').addEventListener('click', leaveGame);

  // Resume an existing session on reload.
  if (gameId && playerId) { setGameTag(gameId); startPolling(); }
  else if (gameId) { goName(); }
  else show('home');
}

document.addEventListener('DOMContentLoaded', init);
