// ─── state ───────────────────────────────────────────────────────────────────

const state = {
  session: null,     // { code, userId, userName }
  snapshot: null,    // RoomSnapshot from server
  es: null,          // EventSource
  countdown: null,   // setInterval id while topic is active
  myVote: null,      // value the current user picked this round
  inviteCode: null,  // room code from URL when no session exists (invite link flow)
};

// ─── session persistence ─────────────────────────────────────────────────────

function saveSession(s) {
  sessionStorage.setItem('poker:session:' + s.code, JSON.stringify(s));
  state.session = s;
}

function loadSession(code) {
  const raw = sessionStorage.getItem('poker:session:' + code);
  return raw ? JSON.parse(raw) : null;
}

function clearSession(code) {
  sessionStorage.removeItem('poker:session:' + code);
  state.session = null;
  state.snapshot = null;
  state.myVote = null;
}

// ─── localStorage log ─────────────────────────────────────────────────────────

function logKey(code) {
  return 'poker:log:' + code;
}

function appendLog(code, entry) {
  const key = logKey(code);
  const log = JSON.parse(localStorage.getItem(key) ?? '[]');
  log.push(entry);
  localStorage.setItem(key, JSON.stringify(log));
}

function getLog(code) {
  return JSON.parse(localStorage.getItem(logKey(code)) ?? '[]');
}

// ─── API helpers ──────────────────────────────────────────────────────────────

async function api(method, path, body, headers = {}) {
  const res = await fetch(path, {
    method,
    headers: { 'Content-Type': 'application/json', ...headers },
    body: body ? JSON.stringify(body) : undefined,
  });
  if (!res.ok) {
    const err = await res.json().catch(() => ({ message: res.statusText }));
    throw new Error(err.message ?? res.statusText);
  }
  return res.json();
}

// ─── room actions ─────────────────────────────────────────────────────────────

async function createRoom(adminName) {
  const data = await api('POST', '/rooms', { adminName });
  saveSession({ code: data.code, userId: data.userId, userName: data.userName });
  localStorage.setItem('poker:last-room', JSON.stringify({ code: data.code, userName: data.userName }));
  state.snapshot = await api('GET', `/rooms/${data.code}`);
  enterRoom(data.code);
}

async function joinRoom(code, name) {
  const data = await api('POST', `/rooms/${code}/join`, { name });
  saveSession({ code, userId: data.userId, userName: data.userName });
  localStorage.setItem('poker:last-room', JSON.stringify({ code, userName: data.userName }));
  state.snapshot = data.snapshot;
  enterRoom(code);
}

async function submitTopic(title) {
  const { code, userId } = state.session;
  await api('POST', `/rooms/${code}/topics`, { title }, { 'x-user-id': userId });
}

async function castVote(value) {
  const { code, userId } = state.session;
  state.myVote = value;
  render();
  await api('POST', `/rooms/${code}/votes`, { value }, { 'x-user-id': userId });
}

// ─── SSE ──────────────────────────────────────────────────────────────────────

function enterRoom(code) {
  history.replaceState(null, '', '?room=' + code);
  state.es?.close();
  state.myVote = null;
  state.es = new EventSource(`/rooms/${code}/events?userId=${state.session.userId}`);

  state.es.addEventListener('hello', (e) => {
    state.snapshot = JSON.parse(e.data).snapshot;
    if (state.snapshot.currentTopic?.state === 'active') startCountdown();
    render();
  });

  state.es.addEventListener('user-joined', (e) => {
    const { user } = JSON.parse(e.data);
    if (!state.snapshot) return;
    state.snapshot.users.push(user);
    render();
  });

  state.es.addEventListener('user-left', (e) => {
    const { userId } = JSON.parse(e.data);
    if (!state.snapshot) return;
    state.snapshot.users = state.snapshot.users.filter((u) => u.id !== userId);
    if (state.snapshot.currentTopic?.state === 'active') {
      state.snapshot.currentTopic.votedUserIds =
        state.snapshot.currentTopic.votedUserIds?.filter((id) => id !== userId) ?? [];
    }
    render();
  });

  state.es.addEventListener('topic-created', (e) => {
    const { topic } = JSON.parse(e.data);
    state.myVote = null;
    state.snapshot.currentTopic = {
      id: topic.id,
      title: topic.title,
      state: 'active',
      createdAt: topic.createdAt,
      votedUserIds: [],
    };
    startCountdown();
    render();
  });

  state.es.addEventListener('vote-cast', (e) => {
    const { userId, total, expected } = JSON.parse(e.data);
    if (!state.snapshot?.currentTopic || state.snapshot.currentTopic.state !== 'active') return;
    const t = state.snapshot.currentTopic;
    if (!t.votedUserIds.includes(userId)) t.votedUserIds.push(userId);
    t._total = total;
    t._expected = expected;
    render();
  });

  state.es.addEventListener('revealed', (e) => {
    const evt = JSON.parse(e.data);
    stopCountdown();
    state.snapshot.currentTopic = {
      id: evt.topicId,
      title: evt.title,
      state: 'revealed',
      votes: evt.votes,
    };
    appendLog(state.session.code, {
      topicId: evt.topicId,
      title: evt.title,
      revealedAt: evt.at,
      reason: evt.reason,
      votes: evt.votes.map((v) => ({ userName: v.userName, value: v.value })),
    });
    render();
  });

  state.es.addEventListener('admin-changed', (e) => {
    const { adminUserId } = JSON.parse(e.data);
    if (state.snapshot) state.snapshot.adminUserId = adminUserId;
    render();
  });

  state.es.onerror = () => {
    // server went away — bounce to landing if session is stale
    setTimeout(async () => {
      try {
        await api('GET', `/rooms/${code}`);
      } catch {
        clearSession(code);
        state.es?.close();
        render();
      }
    }, 2000);
  };

  render();
}

// ─── countdown ────────────────────────────────────────────────────────────────

function startCountdown() {
  stopCountdown();
  state.countdown = setInterval(() => {
    const el = document.getElementById('countdown');
    if (!el) return;
    const t = state.snapshot?.currentTopic;
    if (!t || t.state !== 'active') { stopCountdown(); return; }
    const elapsed = (Date.now() - t.createdAt) / 1000;
    const remaining = Math.max(0, REVEAL_TIMEOUT_S - elapsed);
    el.textContent = remaining > 0 ? `${Math.ceil(remaining)}s` : '—';
    el.className = remaining <= 3
      ? 'text-red-500 font-bold text-lg'
      : 'text-slate-500 text-lg';
  }, 250);
}

function stopCountdown() {
  clearInterval(state.countdown);
  state.countdown = null;
}

// ─── render ───────────────────────────────────────────────────────────────────

const FIBONACCI = [0, 1, 2, 3, 5, 8, 13];
const REVEAL_TIMEOUT_S = 15;

function render() {
  const app = document.getElementById('app');
  if (!state.session) {
    app.innerHTML = renderLanding();
    bindLanding();
    return;
  }
  app.innerHTML = renderRoom();
  bindRoom();
}

function renderLanding() {
  if (state.inviteCode) {
    return `
      <div class="pt-16 text-center space-y-2">
        <h1 class="text-3xl font-bold tracking-tight">Planning Poker</h1>
        <p class="text-slate-500 text-sm">You've been invited to join a room</p>
      </div>
      <div class="mt-8 max-w-sm mx-auto bg-white rounded-2xl shadow-sm border border-slate-200 p-6 space-y-4">
        <div class="flex items-center gap-3">
          <span class="text-xs text-slate-400 uppercase tracking-wider">Room</span>
          <span class="font-mono font-bold text-2xl tracking-widest text-blue-600">${escHtml(state.inviteCode)}</span>
        </div>
        <input id="join-name" type="text" maxlength="30" placeholder="Your name" autofocus
          class="w-full border border-slate-300 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-blue-400" />
        <button id="join-btn"
          class="w-full bg-blue-600 hover:bg-blue-700 text-white font-medium rounded-lg px-4 py-2 text-sm transition-colors">
          Join room
        </button>
        <p id="join-err" class="text-red-500 text-xs hidden"></p>
        <button id="back-btn" class="w-full text-xs text-slate-400 hover:text-slate-600 transition-colors pt-1">
          Create a different room instead
        </button>
      </div>`;
  }

  const last = JSON.parse(localStorage.getItem('poker:last-room') ?? 'null');
  return `
    <div class="pt-16 text-center space-y-2">
      <h1 class="text-3xl font-bold tracking-tight">Planning Poker</h1>
      <p class="text-slate-500 text-sm">Async sprint estimation with your team</p>
    </div>
    ${last ? `
    <div class="mt-6 flex justify-center">
      <button id="rejoin-btn"
        class="flex items-center gap-3 bg-white border border-slate-200 hover:border-blue-400 rounded-2xl shadow-sm px-5 py-3 text-sm transition-colors group">
        <span class="font-mono font-bold text-blue-600 text-base tracking-widest">${escHtml(last.code)}</span>
        <span class="text-slate-500">Rejoin as <strong>${escHtml(last.userName)}</strong></span>
        <span class="text-slate-300 group-hover:text-blue-400 transition-colors">→</span>
      </button>
    </div>` : ''}
    <div class="mt-6 grid gap-6 sm:grid-cols-2">
      <div class="bg-white rounded-2xl shadow-sm border border-slate-200 p-6 space-y-4">
        <h2 class="font-semibold text-lg">Create a room</h2>
        <input id="create-name" type="text" maxlength="30" placeholder="Your name"
          class="w-full border border-slate-300 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-blue-400" />
        <button id="create-btn"
          class="w-full bg-blue-600 hover:bg-blue-700 text-white font-medium rounded-lg px-4 py-2 text-sm transition-colors">
          Create room
        </button>
        <p id="create-err" class="text-red-500 text-xs hidden"></p>
      </div>
      <div class="bg-white rounded-2xl shadow-sm border border-slate-200 p-6 space-y-4">
        <h2 class="font-semibold text-lg">Join a room</h2>
        <input id="join-code" type="text" maxlength="4" placeholder="4-digit code"
          class="w-full border border-slate-300 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-blue-400" />
        <input id="join-name" type="text" maxlength="30" placeholder="Your name"
          class="w-full border border-slate-300 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-blue-400" />
        <button id="join-btn"
          class="w-full bg-slate-800 hover:bg-slate-900 text-white font-medium rounded-lg px-4 py-2 text-sm transition-colors">
          Join room
        </button>
        <p id="join-err" class="text-red-500 text-xs hidden"></p>
      </div>
    </div>`;
}

function bindLanding() {
  // Invite-link flow: only name required
  if (state.inviteCode) {
    const nameInput = document.getElementById('join-name');
    const joinBtn = document.getElementById('join-btn');
    const err = document.getElementById('join-err');
    nameInput?.focus();
    joinBtn?.addEventListener('click', async () => {
      const name = nameInput.value.trim();
      if (!name) { showErr(err, 'Enter your name'); return; }
      try { await joinRoom(state.inviteCode, name); }
      catch (e) {
        showErr(err, e.message);
        // Room gone — clear invite and drop to normal landing
        if (e.message?.includes('not found') || e.message?.includes('404')) {
          state.inviteCode = null;
          history.replaceState(null, '', location.pathname);
          render();
        }
      }
    });
    nameInput?.addEventListener('keydown', (e) => { if (e.key === 'Enter') joinBtn.click(); });
    document.getElementById('back-btn')?.addEventListener('click', () => {
      state.inviteCode = null;
      history.replaceState(null, '', location.pathname);
      render();
    });
    return;
  }

  document.getElementById('rejoin-btn')?.addEventListener('click', async () => {
    const last = JSON.parse(localStorage.getItem('poker:last-room') ?? 'null');
    if (!last) return;
    try {
      await joinRoom(last.code, last.userName);
    } catch (e) {
      // Room is gone (server restarted) — clear the stale entry and show an error
      localStorage.removeItem('poker:last-room');
      render();
      showErr(document.getElementById('join-err'), `Room ${last.code} no longer exists`);
    }
  });

  document.getElementById('create-btn').addEventListener('click', async () => {
    const name = document.getElementById('create-name').value.trim();
    const err = document.getElementById('create-err');
    if (!name) { showErr(err, 'Enter your name'); return; }
    try { await createRoom(name); }
    catch (e) { showErr(err, e.message); }
  });
  document.getElementById('join-btn').addEventListener('click', async () => {
    const code = document.getElementById('join-code').value.trim();
    const name = document.getElementById('join-name').value.trim();
    const err = document.getElementById('join-err');
    if (!code || code.length !== 4) { showErr(err, 'Enter a valid 4-digit code'); return; }
    if (!name) { showErr(err, 'Enter your name'); return; }
    try { await joinRoom(code, name); }
    catch (e) { showErr(err, e.message); }
  });
  ['create-name'].forEach((id) => {
    document.getElementById(id)?.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') document.getElementById('create-btn').click();
    });
  });
  ['join-code', 'join-name'].forEach((id) => {
    document.getElementById(id)?.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') document.getElementById('join-btn').click();
    });
  });
}

function renderRoom() {
  const { session, snapshot } = state;
  if (!snapshot) return '<p class="text-center text-slate-400 mt-16">Connecting…</p>';

  const isAdmin = session.userId === snapshot.adminUserId;
  const topic = snapshot.currentTopic;
  const log = getLog(session.code);

  return `
    <div class="space-y-4">
      <!-- header -->
      <div class="bg-white rounded-2xl border border-slate-200 shadow-sm px-5 py-3 space-y-2">
        <div class="flex items-center justify-between">
          <div>
            <span class="text-xs text-slate-400 uppercase tracking-wider">Room</span>
            <span class="ml-2 font-mono font-bold text-xl tracking-widest text-blue-600">${session.code}</span>
          </div>
          <div class="flex items-center gap-2">
            ${isAdmin ? '<span class="text-xs bg-blue-100 text-blue-700 rounded-full px-2 py-0.5 font-medium">Admin</span>' : ''}
            <span class="text-sm text-slate-500">${session.userName}</span>
            <button id="leave-btn" class="text-xs text-slate-400 hover:text-red-500 ml-1 transition-colors">Leave</button>
          </div>
        </div>
        <div class="flex items-center gap-2 bg-slate-50 rounded-lg px-3 py-1.5 text-xs text-slate-500 font-mono">
          <span class="flex-1 truncate" id="share-url">${location.href}</span>
          <button id="copy-btn" class="shrink-0 text-slate-400 hover:text-blue-600 transition-colors" title="Copy link">
            <svg id="copy-icon" xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
              <rect x="9" y="9" width="13" height="13" rx="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/>
            </svg>
            <svg id="check-icon" xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round" class="hidden text-green-500">
              <polyline points="20 6 9 17 4 12"/>
            </svg>
          </button>
        </div>
      </div>

      <!-- participants -->
      <div class="bg-white rounded-2xl border border-slate-200 shadow-sm px-5 py-4">
        <p class="text-xs text-slate-400 uppercase tracking-wider mb-3">Participants (${snapshot.users.length})</p>
        <div class="flex flex-wrap gap-2">
          ${snapshot.users.map((u) => `
            <span class="flex items-center gap-1 bg-slate-100 rounded-full px-3 py-1 text-sm">
              ${u.id === snapshot.adminUserId ? '<span class="text-blue-500">★</span>' : ''}
              ${escHtml(u.name)}
              ${topic?.state === 'active' && topic.votedUserIds?.includes(u.id)
                ? '<span class="w-2 h-2 rounded-full bg-green-400 inline-block"></span>'
                : ''}
            </span>`).join('')}
        </div>
      </div>

      <!-- admin: create topic -->
      ${isAdmin && (!topic || topic.state === 'revealed') ? `
      <div class="bg-white rounded-2xl border border-slate-200 shadow-sm px-5 py-4 space-y-3">
        <p class="text-sm font-medium">${topic ? 'Next topic' : 'Start a topic'}</p>
        <div class="flex gap-2">
          <input id="topic-input" type="text" maxlength="120" placeholder="e.g. Story: User login"
            class="flex-1 border border-slate-300 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-blue-400" />
          <button id="topic-btn"
            class="bg-blue-600 hover:bg-blue-700 text-white font-medium rounded-lg px-4 py-2 text-sm transition-colors whitespace-nowrap">
            Start vote
          </button>
        </div>
        <p id="topic-err" class="text-red-500 text-xs hidden"></p>
      </div>` : ''}

      <!-- topic + voting -->
      ${topic ? renderTopic(topic, snapshot, session) : `
        <div class="bg-white rounded-2xl border border-slate-200 shadow-sm px-5 py-8 text-center text-slate-400 text-sm">
          Waiting for admin to start a topic…
        </div>`}

      <!-- history -->
      ${log.length > 0 ? renderHistory(log) : ''}
    </div>`;
}

function renderCard({ voted, isMe, value, flipped, delay, noVote }) {
  const delayStyle = flipped && delay ? `style="--flip-delay: ${delay}s"` : '';
  return `
    <div class="playing-card ${flipped ? 'is-flipped' : ''}" ${delayStyle}>
      <div class="card-inner">
        <div class="card-back">
          ${voted && !flipped ? '<span style="font-size:1.1rem;color:#fff;text-shadow:0 1px 4px rgba(0,0,0,0.8)">✓</span>' : ''}
        </div>
        <div class="card-front ${noVote ? 'no-vote' : ''} ${isMe && flipped ? 'is-mine' : ''}">
          ${flipped ? (noVote ? '—' : value) : ''}
        </div>
      </div>
    </div>`;
}

function renderTopic(topic, snapshot, session) {
  if (topic.state === 'active') {
    const total = topic._total ?? topic.votedUserIds?.length ?? 0;
    const expected = topic._expected ?? snapshot.users.length;
    const hasVoted = topic.votedUserIds?.includes(session.userId);
    const myVote = state.myVote;

    return `
      <div class="bg-white rounded-2xl border border-slate-200 shadow-sm px-5 py-5 space-y-5">
        <div class="flex items-start justify-between gap-4">
          <div>
            <p class="text-xs text-slate-400 uppercase tracking-wider">Voting on</p>
            <p class="font-semibold text-base mt-0.5">${escHtml(topic.title)}</p>
          </div>
          <div class="text-right shrink-0">
            <span id="countdown" class="text-slate-500 text-lg"></span>
            <p class="text-xs text-slate-400">${total}/${expected} voted</p>
          </div>
        </div>

        <div class="flex flex-wrap gap-3">
          ${snapshot.users.map((u) => {
            const voted = topic.votedUserIds?.includes(u.id);
            return `
              <div class="flex flex-col items-center gap-2">
                ${renderCard({ voted, isMe: u.id === session.userId, flipped: false })}
                <span class="text-xs text-slate-500 max-w-[4rem] truncate text-center">${escHtml(u.name.split(' ')[0])}</span>
              </div>`;
          }).join('')}
        </div>

        ${!hasVoted ? `
        <div>
          <p class="text-xs text-slate-400 mb-3">Your estimate</p>
          <div class="flex flex-wrap gap-2">
            ${FIBONACCI.map((v) => `
              <button onclick="window._castVote(${JSON.stringify(v)})"
                class="playing-card rounded-[0.625rem] font-bold transition-all border-2
                ${myVote === v
                  ? 'bg-blue-600 text-white border-blue-600 scale-110 shadow-lg'
                  : 'bg-white text-slate-700 border-slate-200 hover:border-blue-400 hover:text-blue-600 shadow-sm'}"
                style="font-size: 1.1rem">
                ${v}
              </button>`).join('')}
          </div>
        </div>` : `
        <p class="text-sm text-green-600 font-medium">✓ Vote recorded — waiting for reveal…</p>`}
      </div>`;
  }

  // revealed
  const votes = topic.votes ?? [];
  const numeric = votes.map((v) => v.value).filter((v) => typeof v === 'number');
  const avg = numeric.length ? (numeric.reduce((a, b) => a + b, 0) / numeric.length).toFixed(1) : null;

  return `
    <div class="bg-white rounded-2xl border border-slate-200 shadow-sm px-5 py-5 space-y-5">
      <div>
        <p class="text-xs text-slate-400 uppercase tracking-wider">Revealed</p>
        <p class="font-semibold text-base mt-0.5">${escHtml(topic.title)}</p>
      </div>

      <div class="flex flex-wrap gap-3">
        ${snapshot.users.map((u, i) => {
          const v = votes.find((x) => x.userId === u.id);
          return `
            <div class="flex flex-col items-center gap-2">
              ${renderCard({ voted: !!v, isMe: u.id === session.userId, value: v?.value, flipped: true, delay: i * 0.07, noVote: !v })}
              <span class="text-xs text-slate-500 max-w-[4rem] truncate text-center">${escHtml(u.name.split(' ')[0])}</span>
            </div>`;
        }).join('')}
      </div>

      ${avg !== null ? `
      <div class="flex gap-4 text-sm text-slate-500">
        <span>Average: <strong class="text-slate-800">${avg}</strong></span>
        <span>Voters: <strong class="text-slate-800">${numeric.length}/${snapshot.users.length}</strong></span>
      </div>` : ''}
    </div>`;
}

function renderHistory(log) {
  return `
    <details class="bg-white rounded-2xl border border-slate-200 shadow-sm px-5 py-4">
      <summary class="cursor-pointer text-sm font-medium text-slate-600 select-none flex items-center justify-between">
        <span>History (${log.length} topic${log.length !== 1 ? 's' : ''})</span>
        <button id="copy-md-btn" onclick="event.preventDefault()"
          class="text-xs text-slate-400 hover:text-blue-600 border border-slate-200 hover:border-blue-400 rounded-lg px-3 py-1 transition-colors">
          Copy as Markdown
        </button>
      </summary>
      <ol class="mt-3 space-y-3">
        ${[...log].reverse().map((entry, i) => `
          <li class="border-t border-slate-100 pt-3 ${i === 0 ? 'border-t-0 pt-0' : ''}">
            <p class="text-sm font-medium">${escHtml(entry.title)}</p>
            <p class="text-xs text-slate-400 mb-1">${new Date(entry.revealedAt).toLocaleTimeString()} · ${entry.reason === 'all-voted' ? 'all voted' : 'timeout'}</p>
            <div class="flex flex-wrap gap-1.5">
              ${entry.votes.map((v) => `
                <span class="text-xs bg-slate-100 rounded px-2 py-0.5">
                  ${escHtml(v.userName)}: <strong>${v.value}</strong>
                </span>`).join('')}
              ${entry.votes.length === 0 ? '<span class="text-xs text-slate-400">No votes</span>' : ''}
            </div>
          </li>`).join('')}
      </ol>
    </details>`;
}

function buildMarkdown(log, code) {
  const date = new Date().toLocaleDateString(undefined, { dateStyle: 'long' });
  const lines = [`# Sprint Planning — Room ${code}`, `_Exported ${date}_`, ''];

  for (const entry of log) {
    const time = new Date(entry.revealedAt).toLocaleTimeString();
    const numeric = entry.votes.map((v) => v.value).filter((v) => typeof v === 'number');
    const avg = numeric.length
      ? (numeric.reduce((a, b) => a + b, 0) / numeric.length).toFixed(1)
      : null;

    lines.push(`## ${entry.title}`);
    lines.push(`_${time} · ${entry.reason === 'all-voted' ? 'all voted' : 'timed out'}_`);
    lines.push('');

    if (entry.votes.length === 0) {
      lines.push('_No votes recorded._');
    } else {
      lines.push('| Participant | Estimate |');
      lines.push('|-------------|----------|');
      for (const v of entry.votes) {
        lines.push(`| ${v.userName} | ${v.value} |`);
      }
      if (avg !== null) lines.push(`| **Average** | **${avg}** |`);
    }

    lines.push('');
  }

  return lines.join('\n');
}

function bindRoom() {
  document.getElementById('copy-md-btn')?.addEventListener('click', async () => {
    const { code } = state.session;
    const log = getLog(code);
    if (!log.length) return;
    await navigator.clipboard.writeText(buildMarkdown(log, code));
    const btn = document.getElementById('copy-md-btn');
    if (btn) { btn.textContent = 'Copied!'; setTimeout(() => { btn.textContent = 'Copy as Markdown'; }, 2000); }
  });

  document.getElementById('copy-btn')?.addEventListener('click', async () => {
    await navigator.clipboard.writeText(location.href);
    document.getElementById('copy-icon').classList.add('hidden');
    document.getElementById('check-icon').classList.remove('hidden');
    setTimeout(() => {
      document.getElementById('copy-icon')?.classList.remove('hidden');
      document.getElementById('check-icon')?.classList.add('hidden');
    }, 2000);
  });

  document.getElementById('leave-btn')?.addEventListener('click', () => {
    state.es?.close();
    const code = state.session?.code;
    clearSession(code);
    stopCountdown();
    history.replaceState(null, '', location.pathname);
    render();
  });

  const topicBtn = document.getElementById('topic-btn');
  const topicInput = document.getElementById('topic-input');
  if (topicBtn && topicInput) {
    topicBtn.addEventListener('click', async () => {
      const title = topicInput.value.trim();
      const err = document.getElementById('topic-err');
      if (!title) { showErr(err, 'Enter a topic title'); return; }
      try {
        topicBtn.disabled = true;
        await submitTopic(title);
        topicInput.value = '';
      } catch (e) {
        showErr(err, e.message);
        topicBtn.disabled = false;
      }
    });
    topicInput.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') topicBtn.click();
    });
  }
}

// ─── utils ────────────────────────────────────────────────────────────────────

window._castVote = (value) => castVote(value);

function escHtml(str) {
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function showErr(el, msg) {
  el.textContent = msg;
  el.classList.remove('hidden');
  setTimeout(() => el.classList.add('hidden'), 4000);
}

// ─── boot ─────────────────────────────────────────────────────────────────────

// Boot: read room code from URL hash and resume or pre-fill join
const roomCode = new URLSearchParams(location.search).get('room');
if (roomCode && roomCode.length === 4) {
  const saved = loadSession(roomCode);
  if (saved) {
    state.session = saved;
    api('GET', `/rooms/${roomCode}`)
      .then((snap) => { state.snapshot = snap; enterRoom(roomCode); })
      .catch(() => {
        clearSession(roomCode);
        history.replaceState(null, '', location.pathname);
        render();
      });
  } else {
    // No saved session — show focused invite join prompt
    state.inviteCode = roomCode;
    render();
  }
} else {
  render();
}
