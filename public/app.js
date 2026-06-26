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
  $('inviteLink').textContent = inviteUrl(gameId);
  show('show-code');
}

function goJoin() {
  $('joinError').textContent = '';
  $('joinCodeInput').value = '';
  show('join');
  setTimeout(() => $('joinCodeInput').focus(), 50);
}

// Read a game code from a /join/<code> invite link, if present.
function inviteCodeFromPath() {
  const m = location.pathname.match(/^\/join\/([A-Za-z0-9]+)\/?$/);
  return m ? m[1].toUpperCase() : null;
}

// Someone followed an invite link: validate the code and send them to enter
// their name. Falls back gracefully if the game is gone or unreachable.
async function enterFromInvite(code) {
  // Drop the /join/<code> path so a later reload returns to a clean URL.
  history.replaceState(null, '', '/');

  // Already in this exact game on this device? Just resume the session.
  if (code === LS.gameId && LS.playerId) {
    gameId = LS.gameId;
    playerId = LS.playerId;
    setGameTag(gameId);
    startPolling();
    return;
  }

  const r = await api('GET', `/api/games/${encodeURIComponent(code)}/state`);
  if (r.status === 404) { toast('That game no longer exists.'); show('home'); return; }
  if (!r.ok) { toast('Could not reach the server.'); show('home'); return; }

  gameId = LS.gameId = code;
  playerId = LS.playerId = null;
  goName();
}

async function submitJoinCode() {
  const code = $('joinCodeInput').value.trim().toUpperCase();
  if (code.length !== 6) { $('joinError').textContent = 'Enter the full 6-character code.'; return; }

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

// --- Election actions -----------------------------------------------------

async function beginPlay() {
  const r = await api('POST', `/api/games/${encodeURIComponent(gameId)}/begin-play`, { playerId });
  if (!r.ok) { toast('Could not begin elections.'); return; }
  poll();
}

async function nominate() {
  const presidentId = $('selPresident').value;
  const chancellorId = $('selChancellor').value;
  $('nominateError').textContent = '';
  if (!presidentId || !chancellorId) { $('nominateError').textContent = 'Pick a President and a Chancellor.'; return; }
  if (presidentId === chancellorId) { $('nominateError').textContent = 'President and Chancellor must be different.'; return; }
  if (busy) return;
  busy = true;
  const r = await api('POST', `/api/games/${encodeURIComponent(gameId)}/nominate`,
    { playerId, presidentId, chancellorId });
  busy = false;
  if (!r.ok) { $('nominateError').textContent = r.data.error || 'Could not open the vote.'; return; }
  poll();
}

async function castVote(choice) {
  if (busy) return;
  busy = true;
  setVoteButtonsDisabled(true);
  const r = await api('POST', `/api/games/${encodeURIComponent(gameId)}/vote`, { playerId, choice });
  busy = false;
  if (!r.ok) {
    setVoteButtonsDisabled(false);
    toast(r.data.error || 'Could not record your vote.');
    return;
  }
  poll();
}

async function advanceElection() {
  const r = await api('POST', `/api/games/${encodeURIComponent(gameId)}/election/advance`, { playerId });
  if (!r.ok) { toast('Could not advance.'); return; }
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

function inviteUrl(code) {
  return `${location.origin}/join/${encodeURIComponent(code)}`;
}

async function copyLink() {
  if (!gameId) return;
  const url = inviteUrl(gameId);
  try { await navigator.clipboard.writeText(url); toast('Invite link copied!'); }
  catch (_) { toast('Copy unavailable — ' + url); }
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
  if (state.phase === 'play') { renderPlay(state); return; }
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

// --- Election (play phase) renderers --------------------------------------

const VOTE_LABEL = { ja: 'Ja!', nein: 'Nein!' };

function showPlayPane(id) {
  ['playNominate', 'playVoting', 'playReveal'].forEach((p) =>
    $(p).classList.toggle('hidden', p !== id));
}

function renderTracker(el, n) {
  el.innerHTML = '<span class="tracker-label">Failed elections</span>';
  for (let i = 0; i < 3; i++) {
    const pip = document.createElement('span');
    pip.className = 'tracker-pip' + (i < n ? ' filled' : '');
    el.appendChild(pip);
  }
}

function renderPlay(state) {
  show('play');
  const e = state.election;
  if (!e) { showPlayPane('playNominate'); return; }
  if (!e.active) { renderNominate(state, e); return; }
  if (!e.allVoted) { renderVoting(state, e); return; }
  renderElectionReveal(state, e);
}

function renderNominate(state, e) {
  showPlayPane('playNominate');
  renderTracker($('electionTrackerNom'), e.electionTracker);
  $('lastGov').textContent = e.lastGovernment
    ? `Last government — President ${e.lastGovernment.presidentName}, ` +
      `Chancellor ${e.lastGovernment.chancellorName} (term-limited this round).`
    : 'No government has been elected yet.';

  // Only rebuild the dropdowns when the roster/eligibility actually changes,
  // so polling doesn't wipe the nominator's in-progress selection.
  const sig = JSON.stringify({ c: e.candidates, i: e.ineligibleChancellorIds, y: state.you.id });
  const pane = $('playNominate');
  if (pane.dataset.sig !== sig) {
    pane.dataset.sig = sig;
    buildPresidentSelect(e.candidates, state.you.id);
    buildChancellorSelect(e.candidates, e.ineligibleChancellorIds);
    syncChancellorDisabled();
  }
}

function buildPresidentSelect(candidates, youId) {
  const sel = $('selPresident');
  const prev = sel.value;
  sel.innerHTML = '';
  candidates.forEach((c) => {
    const o = document.createElement('option');
    o.value = c.id; o.textContent = c.name;
    sel.appendChild(o);
  });
  if (candidates.some((c) => c.id === prev)) sel.value = prev;
  else if (candidates.some((c) => c.id === youId)) sel.value = youId;
  else sel.value = candidates[0] ? candidates[0].id : '';
}

function buildChancellorSelect(candidates, ineligible) {
  const sel = $('selChancellor');
  const prev = sel.value;
  const inel = new Set(ineligible);
  sel.innerHTML = '';
  candidates.forEach((c) => {
    const o = document.createElement('option');
    o.value = c.id;
    o.textContent = c.name + (inel.has(c.id) ? ' — term-limited' : '');
    o.dataset.term = inel.has(c.id) ? '1' : '';
    sel.appendChild(o);
  });
  if (candidates.some((c) => c.id === prev) && !inel.has(prev)) sel.value = prev;
  else {
    const firstOk = candidates.find((c) => !inel.has(c.id));
    sel.value = firstOk ? firstOk.id : '';
  }
}

// The President can't also be the Chancellor — disable that option live.
function syncChancellorDisabled() {
  const pres = $('selPresident').value;
  const sel = $('selChancellor');
  let reselect = false;
  [...sel.options].forEach((o) => {
    o.disabled = o.dataset.term === '1' || o.value === pres;
    if (o.disabled && o.selected) reselect = true;
  });
  if (reselect) {
    const firstOk = [...sel.options].find((o) => !o.disabled);
    sel.value = firstOk ? firstOk.value : '';
  }
}

function setVoteButtonsDisabled(disabled) {
  document.querySelectorAll('#voteButtons .vote-btn').forEach((b) => { b.disabled = disabled; });
}

function renderVoting(state, e) {
  showPlayPane('playVoting');
  $('votePresident').textContent = e.presidentName;
  $('voteChancellor').textContent = e.chancellorName;

  document.querySelectorAll('#voteButtons .vote-btn').forEach((b) => {
    b.classList.toggle('selected', e.yourVote === b.dataset.choice);
    b.disabled = busy;
  });
  $('voteYour').textContent = e.youVoted
    ? `You voted ${VOTE_LABEL[e.yourVote]} — you can change it until everyone has voted.`
    : 'Cast your vote — votes stay hidden until everyone is in.';
  $('voteProgress').textContent = `${e.votedCount} of ${e.totalPlayers} voted`;

  const ul = $('voteRoster');
  ul.innerHTML = '';
  e.roster.forEach((p) => {
    const li = document.createElement('li');
    li.className = 'roster-item' + (p.voted ? ' ready' : '');
    li.innerHTML = '<span class="dot"></span><span class="pname"></span><span class="pstatus"></span>';
    li.querySelector('.pname').textContent = p.name;
    li.querySelector('.pstatus').textContent = p.voted ? 'voted' : 'thinking…';
    ul.appendChild(li);
  });
}

function renderElectionReveal(state, e) {
  showPlayPane('playReveal');
  const passed = e.result === 'passed';
  const rr = $('revealResult');
  rr.className = 'reveal-result ' + (passed ? 'passed' : 'failed');
  rr.textContent = passed ? 'Government ELECTED' : 'Government REJECTED';
  $('revealPresident').textContent = e.presidentName;
  $('revealChancellor').textContent = e.chancellorName;

  const t = $('revealTally');
  t.innerHTML = '';
  [['ja', 'Ja!'], ['nein', 'Nein!']].forEach(([k, label]) => {
    const chip = document.createElement('div');
    chip.className = 'count-chip vote-' + k;
    chip.innerHTML = '<div class="count-num"></div><div class="count-label"></div>';
    chip.querySelector('.count-num').textContent = e.tally[k];
    chip.querySelector('.count-label').textContent = label;
    t.appendChild(chip);
  });

  const ul = $('revealBallots');
  ul.innerHTML = '';
  e.ballots.forEach((b) => {
    const li = document.createElement('li');
    li.className = 'ballot ' + b.choice;
    li.innerHTML = '<span class="pname"></span><span class="bchoice"></span>';
    li.querySelector('.pname').textContent = b.name;
    li.querySelector('.bchoice').textContent = VOTE_LABEL[b.choice];
    ul.appendChild(li);
  });

  renderTracker($('electionTrackerReveal'), e.electionTracker);
}

// --- Wire up --------------------------------------------------------------

function init() {
  $('btnStart').addEventListener('click', startGame);
  $('btnJoinHome').addEventListener('click', goJoin);
  $('btnCopyCode').addEventListener('click', copyCode);
  $('btnCopyLink').addEventListener('click', copyLink);
  $('btnCopyLinkWaiting').addEventListener('click', copyLink);
  $('btnCodeContinue').addEventListener('click', goName);
  $('btnJoinSubmit').addEventListener('click', submitJoinCode);
  $('btnJoinBack').addEventListener('click', () => show('home'));
  $('joinCodeInput').addEventListener('input', (e) => {
    e.target.value = e.target.value.toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 6);
  });
  $('joinCodeInput').addEventListener('keydown', (e) => { if (e.key === 'Enter') submitJoinCode(); });
  $('btnNameSubmit').addEventListener('click', submitName);
  $('nameInput').addEventListener('keydown', (e) => { if (e.key === 'Enter') submitName(); });
  document.querySelectorAll('#role .role-card').forEach((b) =>
    b.addEventListener('click', () => chooseRole(b.dataset.role)));
  $('btnNewRound').addEventListener('click', newRound);
  $('btnLeave').addEventListener('click', leaveGame);
  $('btnLeaveWaiting').addEventListener('click', leaveGame);

  // Elections
  $('btnBeginPlay').addEventListener('click', beginPlay);
  $('btnNominate').addEventListener('click', nominate);
  $('selPresident').addEventListener('change', syncChancellorDisabled);
  document.querySelectorAll('#voteButtons .vote-btn').forEach((b) =>
    b.addEventListener('click', () => castVote(b.dataset.choice)));
  $('btnNextElection').addEventListener('click', advanceElection);
  $('btnRedeal').addEventListener('click', newRound);
  $('btnLeavePlay1').addEventListener('click', leaveGame);
  $('btnLeavePlay2').addEventListener('click', leaveGame);

  // Resume an existing session on reload, or honor a /join/<code> invite link.
  const invite = inviteCodeFromPath();
  if (invite) { enterFromInvite(invite); }
  else if (gameId && playerId) { setGameTag(gameId); startPolling(); }
  else if (gameId) { goName(); }
  else show('home');
}

document.addEventListener('DOMContentLoaded', init);
