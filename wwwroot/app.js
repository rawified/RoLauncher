"use strict";

/* =========================================================
   Host bridge (C# <-> page). Falls back to plain fetch when
   opened in a normal browser (Roblox APIs will mostly be
   CORS-blocked there, but the UI still renders).
   ========================================================= */
const host = (() => {
  const wv = window.chrome && window.chrome.webview;
  const pending = new Map();
  let seq = 0;
  if (wv) {
    wv.addEventListener("message", (e) => {
      const m = e.data;
      if (m && m.evt) return onHostEvent(m);
      const p = pending.get(m.id);
      if (!p) return;
      pending.delete(m.id);
      m.ok ? p.resolve(m.data) : p.reject(new Error(m.error));
    });
  }
  function call(type, args = {}) {
    if (!wv) {
      if (type === "fetch") {
        return fetch(args.url, { method: args.method || "GET", headers: { "Content-Type": "application/json" }, body: args.body ? JSON.stringify(args.body) : undefined })
          .then((r) => { if (!r.ok) throw new Error("HTTP " + r.status); return r.json(); });
      }
      if (type === "launch") { location.href = `roblox://experiences/start?placeId=${args.placeId}`; return Promise.resolve(true); }
      if (type === "open") { window.open(args.url); return Promise.resolve(true); }
      return Promise.resolve(null);
    }
    const id = ++seq;
    return new Promise((resolve, reject) => {
      pending.set(id, { resolve, reject });
      wv.postMessage({ id, type, ...args });
    });
  }
  return {
    get: (url) => call("fetch", { url }),
    post: (url, body) => call("fetch", { url, method: "POST", body }),
    patch: (url, body) => call("fetch", { url, method: "PATCH", body }),
    launch: (placeId, jobId, opts = {}) => call("launch", { placeId: String(placeId), jobId, ...opts }),
    leaveGame: (sid) => call("leaveGame", sid ? { sid } : {}),
    gameView: (sid, action) => call("gameView", { sid, action }),
    sessions: () => call("sessions"),
    accounts: () => call("accounts"),
    addAccount: () => call("addAccount"),
    switchAccount: (accountId) => call("switchAccount", { accountId: String(accountId) }),
    removeAccount: (accountId, signOut) => call("removeAccount", { accountId: String(accountId), signOut: !!signOut }),
    multiInstance: (enabled) => call("multiInstance", { enabled }),
    discordConfig: (enabled, clientId) => call("discordConfig", { enabled, clientId }),
    closeBehavior: (mode) => call("closeBehavior", { mode }),
    discordActivity: (activity) => call("discordActivity", { activity }),
    account: () => call("account"),
    login: () => call("login"),
    logout: () => call("logout"),
    available: !!wv,
    open: (url) => call("open", { url }),
    win: (action) => call("window", { action }),
    appInfo: () => call("appInfo"),
    checkUpdate: () => call("checkUpdate"),
    installUpdate: (url) => call("installUpdate", { url }),
  };
})();

function onHostEvent(m) {
  if (m.evt === "windowState") document.body.classList.toggle("maximized", m.state === "Maximized");
  if (m.evt === "game") onGameEvent(m);
  if (m.evt === "discord") onDiscordStatus(m.status, m.detail);
  if (m.evt === "updateProgress") onUpdateProgress(m.progress);
  if (m.evt === "closeBehavior") { S.settings.closeBehavior = m.mode; store.save(); } // "Remember my choice" on the close prompt
}

/* =========================================================
   Persistent state
   ========================================================= */
const DEFAULT_PLACES = [126884695634066, 920587237, 9391468976, 4924922222, 2753915549, 286090429, 189707, 1962086868, 142823291, 6516141723];
const ACCENTS = ["#3b82f6", "#8b5cf6", "#22c55e", "#f43f5e", "#f59e0b", "#06b6d4"];

const store = {
  key: "rolauncher.v1",
  data: null,
  load() {
    try { this.data = JSON.parse(localStorage.getItem(this.key)) || {}; } catch { this.data = {}; }
    const settings = Object.assign({ stars: true, minimize: true, embed: true, closeOnLeave: true, closeBehavior: "ask", autoUpdate: true, accent: ACCENTS[0] }, this.data.settings);
    settings.discord = Object.assign({ enabled: false, clientId: "", browsing: true, join: true }, settings.discord);
    this.data = Object.assign({ user: null, recent: [], favorites: [], friends: [], playtime: {}, seeded: false }, this.data, { settings });
    return this;
  },
  save() { localStorage.setItem(this.key, JSON.stringify(this.data)); },
};
store.load();
const S = store.data;

/* =========================================================
   Roblox API helpers (with in-memory caching)
   ========================================================= */
const cache = { games: new Map(), icons: new Map(), banners: new Map(), heads: new Map() };
const chunk = (arr, n) => Array.from({ length: Math.ceil(arr.length / n) }, (_, i) => arr.slice(i * n, i * n + n));
const uniq = (a) => [...new Set(a.map(Number))].filter(Boolean);

const api = {
  async placeToUniverse(placeId) {
    const r = await host.get(`https://apis.roblox.com/universes/v1/places/${placeId}/universe`);
    return r && r.universeId;
  },

  /** Returns Map<universeId, game> with name, players, votes, icon, rootPlaceId, creator… */
  async games(universeIds) {
    const ids = uniq(universeIds);
    const missing = ids.filter((id) => !cache.games.has(id));
    for (const part of chunk(missing, 50)) {
      const q = part.join(",");
      const [info, votes, icons] = await Promise.all([
        host.get(`https://games.roblox.com/v1/games?universeIds=${q}`).catch(() => ({ data: [] })),
        host.get(`https://games.roblox.com/v1/games/votes?universeIds=${q}`).catch(() => ({ data: [] })),
        host.get(`https://thumbnails.roblox.com/v1/games/icons?universeIds=${q}&size=256x256&format=Png&isCircular=false`).catch(() => ({ data: [] })),
      ]);
      const vmap = new Map((votes.data || []).map((v) => [v.id, v]));
      const imap = new Map((icons.data || []).map((i) => [i.targetId, i.imageUrl]));
      for (const g of info.data || []) {
        const v = vmap.get(g.id) || {};
        const total = (v.upVotes || 0) + (v.downVotes || 0);
        cache.games.set(g.id, {
          id: g.id,
          rootPlaceId: g.rootPlaceId,
          name: g.name,
          description: g.description || "",
          creator: g.creator ? g.creator.name : "",
          playing: g.playing || 0,
          visits: g.visits || 0,
          favorites: g.favoritedCount || 0,
          maxPlayers: g.maxPlayers,
          updated: g.updated,
          genre: g.genre,
          rating: total ? Math.round((v.upVotes / total) * 100) : null,
          icon: imap.get(g.id) || "",
        });
      }
    }
    return new Map(ids.filter((id) => cache.games.has(id)).map((id) => [id, cache.games.get(id)]));
  },

  async banner(universeId) {
    if (cache.banners.has(universeId)) return cache.banners.get(universeId);
    const r = await host.get(`https://thumbnails.roblox.com/v1/games/multiget/thumbnails?universeIds=${universeId}&size=768x432&format=Png&countPerUniverse=1`).catch(() => null);
    const url = r && r.data && r.data[0] && r.data[0].thumbnails[0] ? r.data[0].thumbnails[0].imageUrl : "";
    cache.banners.set(universeId, url);
    return url;
  },

  async headshots(userIds) {
    const ids = uniq(userIds).filter((id) => !cache.heads.has(id));
    for (const part of chunk(ids, 100)) {
      const r = await host.get(`https://thumbnails.roblox.com/v1/users/avatar-headshot?userIds=${part.join(",")}&size=150x150&format=Png&isCircular=false`).catch(() => ({ data: [] }));
      for (const d of r.data || []) cache.heads.set(d.targetId, d.imageUrl);
    }
    return cache.heads;
  },

  async userByName(name) {
    const r = await host.post("https://users.roblox.com/v1/usernames/users", { usernames: [name], excludeBannedUsers: true });
    const u = r && r.data && r.data[0];
    return u ? { id: u.id, name: u.name, displayName: u.displayName } : null;
  },

  async users(ids) {
    if (!ids.length) return [];
    const r = await host.post("https://users.roblox.com/v1/users", { userIds: ids, excludeBannedUsers: false });
    return r.data || [];
  },

  async presence(ids) {
    if (!ids.length) return [];
    const r = await host.post("https://presence.roblox.com/v1/presence/users", { userIds: ids }).catch(() => ({ userPresences: [] }));
    return r.userPresences || [];
  },

  async sorts() {
    const sid = crypto.randomUUID();
    const r = await host.get(`https://apis.roblox.com/explore-api/v1/get-sorts?sessionId=${sid}&device=computer&country=all`);
    return (r.sorts || []).filter((s) => s.contentType === "Games" && s.games && s.games.length);
  },

  async search(q) {
    const sid = crypto.randomUUID();
    const r = await host.get(`https://apis.roblox.com/search-api/omni-search?searchQuery=${encodeURIComponent(q)}&sessionId=${sid}&pageType=all`);
    const ids = [];
    for (const grp of r.searchResults || []) {
      if (grp.contentGroupType !== "Game") continue;
      for (const c of grp.contents || []) if (c.universeId) ids.push(c.universeId);
    }
    return ids;
  },
};

/* =========================================================
   Helpers
   ========================================================= */
const $ = (s, r = document) => r.querySelector(s);
const $$ = (s, r = document) => [...r.querySelectorAll(s)];
const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const PLACEHOLDER = "data:image/svg+xml;utf8," + encodeURIComponent('<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 10 10"><rect width="10" height="10" fill="#212229"/></svg>');
function fmt(n) {
  if (n == null) return "–";
  if (n >= 1e9) return (n / 1e9).toFixed(1).replace(/\.0$/, "") + "B";
  if (n >= 1e6) return (n / 1e6).toFixed(1).replace(/\.0$/, "") + "M";
  if (n >= 1e3) return (n / 1e3).toFixed(1).replace(/\.0$/, "") + "K";
  return String(n);
}
let toastTimer;
function toast(msg, err = false) {
  const t = $("#toast");
  t.textContent = msg;
  t.classList.toggle("err", err);
  t.classList.add("show");
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => t.classList.remove("show"), 2800);
}

/* =========================================================
   Game cards
   ========================================================= */
function skeletons(el, n = 7) {
  el.innerHTML = Array.from({ length: n }, () => `<div class="card skeleton"><div class="thumb"></div><div class="name" style="margin-top:8px"></div><div class="meta" style="margin-top:6px"></div></div>`).join("");
}

function cardHTML(g) {
  const fav = S.favorites.includes(g.id);
  return `<div class="card" data-uid="${g.id}">
    <div class="thumb">
      <img src="${esc(g.icon) || PLACEHOLDER}" loading="lazy" alt="" />
      <div class="overlay"><button class="play-fab" data-act="play" title="Play"><svg viewBox="0 0 24 24"><use href="#i-play"/></svg></button></div>
      <button class="fav ${fav ? "on" : ""}" data-act="fav" title="Favorite"><svg viewBox="0 0 24 24"><use href="#i-heart"/></svg></button>
    </div>
    <div class="name" title="${esc(g.name)}">${esc(g.name)}</div>
    <div class="meta">
      <span><svg viewBox="0 0 24 24"><use href="#i-person"/></svg>${fmt(g.playing)}</span>
      ${g.rating != null ? `<span class="up"><svg viewBox="0 0 24 24"><use href="#i-thumb"/></svg>${g.rating}%</span>` : ""}
      ${playTotal(g.id) >= 60000 ? `<span class="pt" title="Your playtime"><svg viewBox="0 0 24 24"><use href="#i-clock"/></svg>${fmtDur(playTotal(g.id))}</span>` : ""}
    </div>
  </div>`;
}

async function renderCards(el, universeIds, emptyMsg) {
  if (!universeIds.length) { el.innerHTML = `<div class="empty">${emptyMsg}</div>`; return; }
  skeletons(el, Math.min(universeIds.length, 8));
  try {
    const map = await api.games(universeIds);
    const list = universeIds.map((id) => map.get(Number(id))).filter(Boolean);
    el.innerHTML = list.length ? list.map(cardHTML).join("") : `<div class="empty">${emptyMsg}</div>`;
  } catch (e) {
    el.innerHTML = `<div class="empty">Couldn't reach Roblox (${esc(e.message)}).</div>`;
  }
}

// One delegated handler for every card on every page
document.addEventListener("click", (e) => {
  const card = e.target.closest(".card[data-uid]");
  if (!card) return;
  const uid = Number(card.dataset.uid);
  const act = e.target.closest("[data-act]");
  if (act && act.dataset.act === "play") { e.stopPropagation(); play(uid); return; }
  if (act && act.dataset.act === "fav") { e.stopPropagation(); toggleFav(uid); return; }
  openGame(uid);
});

/* =========================================================
   Actions
   ========================================================= */
async function play(universeId, jobId, accountId, extra) {
  const g = (await api.games([universeId])).get(Number(universeId));
  if (!g) return toast("Couldn't load that game.", true);
  closeModal();
  const entry = { g, sid: 0, accountId: accountId || accounts.activeId || 0, started: 0, playStart: 0, jobId: jobId || null, placeId: g.rootPlaceId, private: !!(extra && (extra.accessCode || extra.linkCode)) };
  launching = entry;
  showLaunching(g, "Starting Roblox");
  let r;
  try {
    r = await host.launch(g.rootPlaceId, jobId, {
      embed: S.settings.embed, closeOnLeave: S.settings.closeOnLeave, minimize: S.settings.minimize,
      accountId: entry.accountId ? String(entry.accountId) : undefined,
      meta: { g: { id: g.id, name: g.name, icon: g.icon, rootPlaceId: g.rootPlaceId, creator: g.creator }, private: entry.private }, // kept by the host so a reloaded page (interface switch) can pick the game back up
      ...(extra || {}), // { accessCode } or { linkCode } for private servers
    });
  } catch (e) {
    if (launching === entry) { launching = null; hideLaunching(); }
    return toast(e.message, true);
  }
  if (r && r.sid && !sessions.has(r.sid)) { entry.sid = r.sid; sessions.set(r.sid, entry); }
  S.recent = [{ id: g.id, t: Date.now() }, ...S.recent.filter((x) => x.id !== g.id)].slice(0, 60);
  store.save();
  updateCounters();
  renderSessions();
  if (currentPage === "launchpad") renderContinue();
  if (!host.available) setTimeout(hideLaunching, 3000);
}

/* =========================================================
   Game session (events come from the C# host)
   ========================================================= */
const sessions = new Map(); // sid -> { g, sid, accountId, started, playStart }
let launching = null;        // the game whose "Launching…" screen is showing

/* ---------- Playtime ---------- */
function playSessions(uid) { return S.playtime[uid] || []; }
function playTotal(uid) { return playSessions(uid).reduce((t, x) => t + (x.e - x.s), 0); }
function fmtDur(ms) {
  const m = Math.floor(ms / 60000);
  if (m < 1) return "<1m";
  const h = Math.floor(m / 60);
  return h ? `${h}h ${m % 60}m` : `${m}m`;
}
function startPlayClock(se) { if (!se.playStart) se.playStart = Date.now(); }
function stopPlayClock(se) {
  if (se.playStart) {
    const e = Date.now();
    if (e - se.playStart >= 5000) {
      const list = playSessions(se.g.id);
      list.push({ s: se.playStart, e });
      S.playtime[se.g.id] = list.slice(-300);
      store.save();
    }
  }
  se.playStart = 0;
}

function renderPlaytime(uid) {
  const el = $("#tab-playtime");
  const list = playSessions(uid);
  if (!list.length) {
    el.innerHTML = `<div class="empty">You haven't played this from RoLauncher yet. Your time is tracked automatically from the moment you join a server.</div>`;
    return;
  }
  const total = playTotal(uid);
  const longest = Math.max(...list.map((x) => x.e - x.s));
  const last = list[list.length - 1];
  const stats = [
    [fmtDur(total), "Total playtime"],
    [list.length, "Sessions"],
    [fmtDur(total / list.length), "Average session"],
    [fmtDur(longest), "Longest session"],
  ];
  const day0 = new Date(); day0.setHours(0, 0, 0, 0);
  const days = Array.from({ length: 14 }, (_, i) => {
    const d = new Date(day0); d.setDate(d.getDate() - 13 + i);
    return { d, ms: 0 };
  });
  for (const x of list) {
    for (const b of days) {
      const ds = b.d.getTime(), de = ds + 86400000;
      const ov = Math.min(x.e, de) - Math.max(x.s, ds);
      if (ov > 0) b.ms += ov;
    }
  }
  const max = Math.max(...days.map((b) => b.ms), 1);
  const dayName = (d) => d.toLocaleDateString(undefined, { weekday: "short", month: "short", day: "numeric" });
  el.innerHTML = `
    <div class="stats">${stats.map(([v, l]) => `<div class="stat"><b>${v}</b><span>${l}</span></div>`).join("")}</div>
    <div class="pt-chart">
      <h4>Playtime per day · last 14 days</h4>
      <div class="pt-bars">${days.map((b) => `<div class="pt-bar ${b.ms ? "" : "zero"}"><i style="height:${b.ms ? Math.max(3, (b.ms / max) * 100) : 0}%"></i><span class="tip">${dayName(b.d)} · ${b.ms ? fmtDur(b.ms) : "not played"}</span></div>`).join("")}</div>
      <div class="pt-labels">${days.map((b, i) => `<span>${i % 2 === 1 || i === 13 ? b.d.getDate() : ""}</span>`).join("")}</div>
    </div>
    <div class="pt-sessions">
      <h4>Recent sessions · last played ${new Date(last.e).toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" })}</h4>
      ${list.slice(-8).reverse().map((x) => `<div class="pt-row"><span>${new Date(x.s).toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" })}</span><b>${fmtDur(x.e - x.s)}</b></div>`).join("")}
    </div>`;
}

function setModalTab(tab) {
  $$("#mTabs .tab").forEach((t) => t.classList.toggle("on", t.dataset.tab === tab));
  $("#tab-overview").hidden = tab !== "overview";
  $("#tab-playtime").hidden = tab !== "playtime";
  if (tab === "playtime" && modalUid) renderPlaytime(modalUid);
}
$("#mTabs").addEventListener("click", (e) => { const t = e.target.closest("[data-tab]"); if (t) setModalTab(t.dataset.tab); });

function showLaunching(g, status) {
  $("#lIcon").src = g.icon || PLACEHOLDER;
  $("#lName").textContent = g.name;
  $("#lStatus").textContent = status;
  $("#launching").hidden = false;
}
function hideLaunching() { $("#launching").hidden = true; }

const clock = (t) => { const s = Math.floor((Date.now() - t) / 1000); return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`; };
const accountName = (id) => { const a = accounts.list.find((x) => x.id === id); return a ? a.displayName : ""; };

function newestSession() { let best = null; for (const se of sessions.values()) if (!best || se.sid > best.sid) best = se; return best; }

function renderSessions() {
  updatePresence();
  const top = newestSession();
  const running = [...sessions.values()].filter((x) => x.started);
  $("#tbGame").hidden = !top || !top.started;
  document.body.classList.toggle("in-game", !$("#tbGame").hidden);
  $("#crumb").hidden = !$("#tbGame").hidden;
  if (top && top.started) {
    $("#tbGameIcon").src = top.g.icon || PLACEHOLDER;
    $("#tbGameName").textContent = top.g.name + (accounts.list.length > 1 && top.accountId ? ` · ${accountName(top.accountId)}` : "");
    $("#tbGame").title = $("#tbGameName").textContent;
    $("#tbGameTime").textContent = clock(top.started);
    $("#tbGameMore").hidden = running.length < 2;
    $("#tbGameMore").textContent = `+${running.length - 1} more`;
  }
  // Minimize tucks an in-launcher game away; Continue playing brings it (or a separate game window) back.
  const hasWin = !!(top && top.started && top.windowed);
  $("#tbMin").hidden = !hasWin || !top.embedded || top.hidden;
  $("#tbContinue").hidden = !hasWin || (top.embedded && !top.hidden);
  document.body.classList.toggle("game-hidden", hasWin && !!top.embedded && !!top.hidden);
  const np = $("#nowPlaying");
  if (running.length) {
    np.innerHTML = `<div class="muted small" style="margin-bottom:6px">Now playing</div><div class="np-list">${running.map((se) => `
      <div class="np"><img src="${esc(se.g.icon) || PLACEHOLDER}" alt=""/>
        <div class="fi"><div class="fn">${esc(se.g.name)}</div><div class="muted small">${se.accountId ? esc(accountName(se.accountId)) + " · " : ""}<span data-clock="${se.sid}">${clock(se.started)}</span></div></div>
        <span class="live-dot"></span>
        <button class="np-leave" data-leave="${se.sid}" title="Leave game"><svg viewBox="0 0 24 24"><use href="#i-logout"/></svg></button>
      </div>`).join("")}</div>`;
  } else {
    const last = S.recent.find((r) => !r.seed);
    const g = last && cache.games.get(last.id);
    np.innerHTML = g ? `<div class="np"><img src="${esc(g.icon)}" alt=""/><div class="fi"><div class="muted small">Last launched</div><div class="fn">${esc(g.name)}</div></div></div>` : "";
  }
}
setInterval(() => {
  const top = newestSession();
  if (top && top.started) $("#tbGameTime").textContent = clock(top.started);
  $$("[data-clock]").forEach((el) => { const se = sessions.get(Number(el.dataset.clock)); if (se && se.started) el.textContent = clock(se.started); });
}, 1000);

/* =========================================================
   Discord Rich Presence
   ========================================================= */
// RoLauncher's Discord application. An Application ID is public (it is not a secret),
// so it is fine to ship. Never put the app's Client Secret or Bot Token in here.
const DISCORD_APP_ID = "1571876925452845178";
const discordId = () => S.settings.discord.clientId || DISCORD_APP_ID;
let presenceTimer = 0;
const DISCORD_STATUS_TEXT = {
  off: "Off",
  connecting: "Connecting to Discord…",
  connected: "Connected — your profile shows your status",
  error: "Not connected",
};

function onDiscordStatus(status, detail) {
  const el = $("#discordStatus");
  if (!el) return;
  el.className = "discord-status " + status;
  el.textContent = (DISCORD_STATUS_TEXT[status] || status) + (detail && status === "error" ? ` — ${detail}` : "");
}

function applyDiscordConfig() {
  const d = S.settings.discord;
  if (host.available) host.discordConfig(!!d.enabled, discordId()).then((r) => r && onDiscordStatus(r.status)).catch(() => {});
  updatePresence();
}

function updatePresence() {
  clearTimeout(presenceTimer);
  presenceTimer = setTimeout(sendPresence, 600);
}

const clip = (t, n = 120) => { t = String(t || "").trim(); return t.length > n ? t.slice(0, n - 1) + "…" : t.padEnd(2, " "); };

function sendPresence() {
  const d = S.settings.discord;
  if (!host.available || !d.enabled) return;
  const live = [...sessions.values()].filter((x) => x.started).sort((a, b) => b.sid - a.sid);
  let activity = null;
  if (live.length) {
    const se = live[0];
    const name = se.g.name.replace(/^\[[^\]]*\]\s*/, ""); // drop "[🎃]"-style tags at the start
    const buttons = [{ label: "View game", url: `https://www.roblox.com/games/${se.placeId || se.g.rootPlaceId}` }];
    if (d.join && se.jobId && !se.private)
      buttons.push({ label: "Join server", url: `https://www.roblox.com/games/start?placeId=${se.placeId || se.g.rootPlaceId}&gameInstanceId=${se.jobId}` });
    activity = {
      type: 0,
      details: clip(name, 128),
      state: clip(se.private ? "In a private server" : live.length > 1 ? `Playing ${live.length} games` : "In a public server", 128),
      timestamps: { start: Math.floor((se.started || Date.now()) / 1000) },
      assets: {
        large_image: se.g.icon && se.g.icon.startsWith("https://") ? se.g.icon : "logo",
        large_text: clip(se.g.name, 128),
        small_image: "logo",
        small_text: "via RoLauncher",
      },
      buttons,
    };
  } else if (d.browsing) {
    activity = {
      type: 0,
      details: "Browsing games",
      state: clip(TITLES[currentPage] ? `In ${TITLES[currentPage]}` : "In the launcher"),
      assets: { large_image: "logo", large_text: "RoLauncher" },
    };
  }
  host.discordActivity(activity).catch(() => {});
}

function onGameEvent(m) {
  let se = sessions.get(m.sid);
  if (!se && launching && !launching.sid) { se = launching; se.sid = m.sid; sessions.set(m.sid, se); }
  if (!se) return;
  const isLaunching = launching === se;
  const status = (t) => { if (isLaunching) $("#lStatus").textContent = t; };
  const doneLaunching = () => { if (isLaunching) { launching = null; hideLaunching(); } };
  switch (m.state) {
    case "starting": status("Starting Roblox"); break;
    case "process": se.started = Date.now(); status("Roblox is loading"); break;
    case "window": se.windowed = true; se.embedded = !!m.embedded; se.hidden = false; doneLaunching(); startPlayClock(se); break;
    case "joining": status("Joining server"); if (m.jobId) se.jobId = m.jobId; if (m.placeId) se.placeId = Number(m.placeId); break;
    case "joined": doneLaunching(); startPlayClock(se); break;
    case "left": toast(`You left ${se.g.name}`); break;
    case "failed":
      stopPlayClock(se); sessions.delete(m.sid); doneLaunching();
      toast(m.error || "Launch failed", true);
      break;
    case "ended":
      stopPlayClock(se); sessions.delete(m.sid); doneLaunching();
      if (!sessions.size) { toast(`Welcome back! Thanks for playing ${se.g.name}`); resumePendingUpdate(); }
      if (currentPage === "launchpad") renderContinue();
      refreshFriends();
      refreshRobux();
      break;
  }
  renderSessions();
}
$("#tbLeave").onclick = () => { const top = newestSession(); if (top) host.leaveGame(top.sid); };
async function setGameView(action, quiet = false) {
  const top = newestSession();
  if (!top) return;
  try {
    const r = await host.gameView(top.sid, action);
    top.embedded = r.embedded;
    top.hidden = r.embedded && r.hidden;
    renderSessions();
    if (action === "hide" && r.embedded && !quiet) toast("Game minimized — it keeps running. Press “Continue playing” to go back.");
  } catch (e) { toast(e.message, true); }
}
// True while an in-launcher game is showing and covering the pages.
function gameCovering() { const top = newestSession(); return !!(top && top.windowed && top.embedded && !top.hidden); }
$("#tbMin").onclick = () => setGameView("hide");
$("#tbContinue").onclick = () => setGameView("show");

// Games keep running when the page reloads (switching between Classic and Console),
// so ask the host which ones are open and pick them back up: top bar, timers, Continue playing.
async function restoreSessions() {
  if (!host.available) return;
  const list = await host.sessions().catch(() => []);
  for (const s of list || []) {
    if (sessions.has(s.sid)) continue;
    const meta = s.meta || {};
    const g = (meta.g && meta.g.id && cache.games.get(meta.g.id)) || meta.g || { id: 0, name: "Roblox", icon: "" };
    sessions.set(s.sid, {
      g, sid: s.sid, accountId: s.accountId || 0, started: s.started || 0, playStart: s.playStart || 0,
      jobId: s.jobId || null, placeId: s.placeId ? Number(s.placeId) : g.rootPlaceId, private: !!meta.private,
      windowed: !!s.windowed, embedded: !!s.embedded, hidden: !!s.hidden,
    });
  }
  if (sessions.size) renderSessions();
}
$("#lCancel").onclick = () => {
  if (launching && launching.sid) host.leaveGame(launching.sid);
  launching = null; hideLaunching();
};
document.addEventListener("click", (e) => { const b = e.target.closest("[data-leave]"); if (b) host.leaveGame(Number(b.dataset.leave)); });

function toggleFav(uid) {
  uid = Number(uid);
  const on = !S.favorites.includes(uid);
  S.favorites = on ? [uid, ...S.favorites] : S.favorites.filter((id) => id !== uid);
  store.save();
  $$(`.card[data-uid="${uid}"] .fav`).forEach((b) => b.classList.toggle("on", on));
  if (modalUid === uid) $("#mFav").classList.toggle("on", on);
  updateCounters();
  if (currentPage === "launchpad") renderFavorites();
  if (currentPage === "favorites") renderPage("favorites");
  toast(on ? "Added to favorites" : "Removed from favorites");
}

/* =========================================================
   Game modal
   ========================================================= */
let modalUid = null;
async function openGame(uid) {
  uid = Number(uid);
  const g = (await api.games([uid])).get(uid);
  if (!g) return;
  modalUid = uid;
  $("#mName").textContent = g.name;
  $("#mCreator").textContent = g.creator ? `By ${g.creator}` : "";
  $("#mIcon").src = g.icon || PLACEHOLDER;
  $("#mBanner").src = PLACEHOLDER;
  $("#mDesc").textContent = g.description;
  $("#mFav").classList.toggle("on", S.favorites.includes(uid));
  $("#mStats").innerHTML = [
    [fmt(g.playing), "Playing now"],
    [fmt(g.visits), "Visits"],
    [g.rating != null ? g.rating + "%" : "–", "Rating"],
    [fmt(g.favorites), "Favorites"],
  ].map(([v, l]) => `<div class="stat"><b>${v}</b><span>${l}</span></div>`).join("");
  const pa = $("#mPlayAs");
  pa.hidden = accounts.list.length < 2;
  pa.innerHTML = accounts.list.map((a) => `<option value="${a.id}" ${a.id === accounts.activeId ? "selected" : ""}>Play as ${esc(a.displayName)}</option>`).join("");
  setModalTab("overview");
  $("#modal").hidden = false;
  const b = await api.banner(uid);
  if (modalUid === uid && b) $("#mBanner").src = b;
}
function closeModal() { $("#modal").hidden = true; modalUid = null; }
$("#modalClose").onclick = closeModal;
$("#modal").addEventListener("click", (e) => { if (e.target.id === "modal") closeModal(); });
document.addEventListener("keydown", (e) => { if (e.key === "Escape") { closeModal(); closeItem(); } });
$("#mPlay").onclick = () => modalUid && play(modalUid, undefined, Number($("#mPlayAs").value) || 0);
$("#mFav").onclick = () => modalUid && toggleFav(modalUid);
$("#mWeb").onclick = async () => {
  const g = cache.games.get(modalUid);
  if (g) host.open(`https://www.roblox.com/games/${g.rootPlaceId}`);
};

/* =========================================================
   Navigation
   ========================================================= */
const TITLES = { profile: "Profiles", trade: "Trading", launchpad: "Launchpad", explore: "Explore", search: "Search", market: "Market", avatar: "Avatar", favorites: "Favorites", friends: "Friends", history: "Recent Games", settings: "Settings" };
let currentPage = "launchpad";
const hist = { back: [], fwd: [] };

function go(page, { record = true } = {}) {
  if (!TITLES[page]) return;
  if (gameCovering()) setGameView("hide", true); // going to a page while playing minimizes the game
  if (record && page !== currentPage) { hist.back.push(currentPage); hist.fwd = []; }
  currentPage = page;
  $$(".page").forEach((p) => p.classList.toggle("active", p.id === "page-" + page));
  $$(".rail-btn[data-page]").forEach((b) => b.classList.toggle("active", b.dataset.page === page));
  $("#crumb").textContent = TITLES[page];
  $("#navBack").disabled = !hist.back.length;
  $("#navFwd").disabled = !hist.fwd.length;
  $("#main").scrollTop = 0;
  renderPage(page);
  if (typeof updatePresence === "function") updatePresence();
}
$("#navBack").onclick = () => { if (!hist.back.length) return; hist.fwd.push(currentPage); go(hist.back.pop(), { record: false }); };
$("#navFwd").onclick = () => { if (!hist.fwd.length) return; hist.back.push(currentPage); go(hist.fwd.pop(), { record: false }); };
document.addEventListener("click", (e) => {
  const b = e.target.closest("[data-page],[data-goto]");
  if (b) go(b.dataset.page || b.dataset.goto);
  const s = e.target.closest("[data-scroll]");
  if (s) { const row = document.getElementById(s.dataset.scroll); row.scrollBy({ left: Number(s.dataset.dir) * row.clientWidth * 0.8 }); }
});
$("#tbSearch").onclick = () => { go("search"); setTimeout(() => $("#searchInput").focus(), 50); };
$("#tbFavCount").onclick = () => go("favorites");
$("#tbRecent").onclick = () => go("history");
$("#userChip").onclick = () => { if (gameCovering()) setGameView("hide", true); renderAccountMenu(); $("#acctMenu").hidden = !$("#acctMenu").hidden; };
$("#tbRefresh").onclick = () => { cache.games.clear(); cache.banners.clear(); sortsCache = null; renderPage(currentPage); loadSpotlight(); refreshFriends(); toast("Refreshed"); };
$("#railJoin").onclick = () => $("#quickInput").focus();
$$(".win-ctrls button").forEach((b) => (b.onclick = () => host.win(b.dataset.win)));

/* =========================================================
   Pages
   ========================================================= */
async function seedRecent() {
  if (S.seeded) return;
  const ids = (await Promise.all(DEFAULT_PLACES.map((p) => api.placeToUniverse(p).catch(() => null)))).filter(Boolean);
  if (!S.recent.length) S.recent = ids.slice(0, 6).map((id, i) => ({ id, t: Date.now() - i * 1000, seed: true }));
  if (!S.favorites.length) S.favorites = ids.slice(5);
  S.seeded = true;
  store.save();
  updateCounters();
}

function renderContinue() { return renderCards($("#rowContinue"), S.recent.map((r) => r.id), "Launch a game and it'll show up here."); }
function renderFavorites() { return renderCards($("#rowFavorites"), S.favorites, "No favorites yet — tap the ♥ on any game."); }

let sortsCache = null;
async function getSorts() {
  if (!sortsCache) sortsCache = api.sorts().catch((e) => { sortsCache = null; throw e; });
  return sortsCache;
}

async function renderTrending() {
  const el = $("#rowTrending");
  skeletons(el);
  try {
    const sorts = await getSorts();
    const s = sorts.find((x) => x.sortId === "top-trending") || sorts[0];
    await renderCards(el, s.games.filter((g) => !g.isSponsored).slice(0, 24).map((g) => g.universeId), "Nothing trending right now.");
  } catch (e) { el.innerHTML = `<div class="empty">Couldn't load trending games.</div>`; }
}

async function renderExplore() {
  const wrap = $("#exploreSorts");
  if (wrap.dataset.loaded) return;
  wrap.innerHTML = `<div class="card-row" id="exSk"></div>`;
  skeletons($("#exSk"));
  try {
    const sorts = await getSorts();
    wrap.innerHTML = sorts.map((s, i) => `
      <div class="sort-block">
        <div class="row-head"><h2>${esc(s.sortDisplayName)}</h2>
          <div class="row-tools">
            <button class="arrow" data-scroll="ex${i}" data-dir="-1"><svg viewBox="0 0 24 24"><use href="#i-chev-left"/></svg></button>
            <button class="arrow" data-scroll="ex${i}" data-dir="1"><svg viewBox="0 0 24 24"><use href="#i-chev-right"/></svg></button>
          </div></div>
        <div class="card-row" id="ex${i}"></div>
      </div>`).join("");
    wrap.dataset.loaded = "1";
    await Promise.all(sorts.map((s, i) => renderCards($("#ex" + i), s.games.filter((g) => !g.isSponsored).slice(0, 30).map((g) => g.universeId), "Empty")));
  } catch (e) {
    wrap.innerHTML = `<div class="empty">Couldn't load Explore (${esc(e.message)}).</div>`;
  }
}

function renderPage(page) {
  switch (page) {
    case "launchpad": renderContinue(); renderFavorites(); renderTrending(); break;
    case "explore": $("#exploreSorts").dataset.loaded = ""; renderExplore(); $("#exploreDot").classList.remove("on"); break;
    case "favorites": renderCards($("#favGrid"), S.favorites, "No favorites yet — tap the ♥ on any game."); break;
    case "history": renderCards($("#historyGrid"), S.recent.map((r) => r.id), "No games launched yet."); break;
    case "friends": renderFriends(); break;
    case "settings": renderSettings(); break;
    case "market": if (!market.loaded) loadMarket(true); break;
    case "avatar": openAvatarEditor(); break;
    case "profile": if (!profile.id) renderProfileHome(); break;
    case "trade": renderTrade(); break;
  }
}

/* Search */
$("#searchForm").addEventListener("submit", async (e) => {
  e.preventDefault();
  const q = $("#searchInput").value.trim();
  if (!q) return;
  const el = $("#searchResults");
  skeletons(el, 12);
  try {
    const ids = await api.search(q);
    await renderCards(el, ids.slice(0, 60), `No experiences found for “${esc(q)}”.`);
  } catch (err) { el.innerHTML = `<div class="empty">Search failed (${esc(err.message)}).</div>`; }
});

$("#clearHistory").onclick = () => { S.recent = []; store.save(); updateCounters(); renderPage("history"); };

/* Quick launch */
$("#quickForm").addEventListener("submit", async (e) => {
  e.preventDefault();
  const raw = $("#quickInput").value.trim();
  const m = raw.match(/games\/(\d+)/) || raw.match(/placeId=(\d+)/i) || raw.match(/^(\d+)$/);
  if (!m) return toast("Paste a Roblox game link or a numeric Place ID.", true);
  try {
    const uid = await api.placeToUniverse(m[1]);
    if (!uid) throw new Error("Unknown place");
    $("#quickInput").value = "";
    play(uid);
  } catch { toast("Couldn't find that place.", true); }
});

/* =========================================================
   Account
   ========================================================= */
let robux = null;

let accounts = { activeId: 0, list: [] };

async function loadAccounts() {
  if (!host.available) return;
  try {
    const a = await host.accounts();
    accounts = { activeId: a.activeId, list: a.accounts || [] };
    await api.headshots(accounts.list.map((x) => x.id));
  } catch { /* keep old */ }
  renderAccountBox();
  renderAccountMenu();
}

async function renderAccount() {
  const u = S.user;
  $("#userName").textContent = u ? u.displayName : "Sign in";
  $("#welcomeName").textContent = u ? u.displayName : "Guest";
  let img = "";
  if (u) { await api.headshots([u.id]); img = cache.heads.get(u.id) || ""; }
  for (const el of [$("#userAvatar"), $("#welcomeAvatar")]) { el.src = img || PLACEHOLDER; }
  renderAccountBox();
  renderAccountMenu();
}

function renderAccountBox() {
  const box = $("#accountBox");
  if (!accounts.list.length) {
    const u = S.user;
    box.innerHTML = `<img src="${esc(u ? cache.heads.get(u.id) || PLACEHOLDER : PLACEHOLDER)}" alt=""/>
      <div class="who"><b>${u ? esc(u.displayName) : "Not signed in"}</b><span class="muted">${u ? "Guest mode" : "Games will launch with whatever account the Roblox app uses."}</span></div>
      <button class="btn roblox" data-acct-add>Sign in with Roblox</button>`;
    box.className = "account-box";
    return;
  }
  box.className = "acct-list";
  box.innerHTML = accounts.list.map((a) => {
    const on = a.id === accounts.activeId;
    return `<div class="acct-item ${on ? "on" : ""}">
      <img src="${esc(cache.heads.get(a.id) || PLACEHOLDER)}" alt=""/>
      <div class="who"><b>${esc(a.displayName)}${on ? `<span class="active-tag">ACTIVE</span>` : ""}</b>
        <span class="muted small">@${esc(a.name)}${on && robux != null ? ` · ${robux.toLocaleString()} Robux` : ""}</span></div>
      ${on ? "" : `<button class="btn ghost" data-acct-switch="${a.id}">Switch</button>`}
      <button class="btn ghost" data-acct-profile="${a.id}">Profile</button>
      <button class="btn ghost" data-acct-remove="${a.id}" title="Forget this account on this PC">Remove</button>
    </div>`;
  }).join("") + `<div><button class="btn roblox" data-acct-add><svg viewBox="0 0 24 24"><use href="#i-plus"/></svg>Add another account</button></div>`;
}

function renderAccountMenu() {
  const m = $("#acctMenu");
  m.innerHTML = accounts.list.map((a) => `
      <button class="acct-row" data-acct-switch="${a.id}">
        <img src="${esc(cache.heads.get(a.id) || PLACEHOLDER)}" alt=""/>
        <div class="fi"><div class="fn">${esc(a.displayName)}</div><div class="fs">@${esc(a.name)}</div></div>
        ${a.id === accounts.activeId ? `<svg class="tick" viewBox="0 0 24 24"><use href="#i-check"/></svg>` : ""}
      </button>`).join("")
    + (accounts.list.length ? `<div class="acct-sep"></div>` : "")
    + (S.user ? `<button class="acct-row action" data-acct-profile="${S.user.id}"><svg viewBox="0 0 24 24"><use href="#i-id"/></svg>My profile</button>` : "")
    + `<button class="acct-row action" data-acct-add><svg viewBox="0 0 24 24"><use href="#i-plus"/></svg>${accounts.list.length ? "Add another account" : "Sign in with Roblox"}</button>
       <button class="acct-row action" data-goto="settings"><svg viewBox="0 0 24 24"><use href="#i-settings"/></svg>Manage accounts</button>`;
}

document.addEventListener("click", (e) => {
  const menu = $("#acctMenu");
  if (!menu.hidden && !e.target.closest("#acctMenu") && !e.target.closest("#userChip")) menu.hidden = true;
  const sw = e.target.closest("[data-acct-switch]");
  if (sw) { menu.hidden = true; return switchAccount(Number(sw.dataset.acctSwitch)); }
  const rm = e.target.closest("[data-acct-remove]");
  if (rm) return removeAccount(Number(rm.dataset.acctRemove));
  const pf = e.target.closest("[data-acct-profile]");
  if (pf) { menu.hidden = true; return openProfile(Number(pf.dataset.acctProfile)); }
  if (e.target.closest("[data-acct-add]")) { menu.hidden = true; return login(); }
  if (e.target.closest("#acctMenu [data-goto]")) menu.hidden = true;
});

async function login() {
  if (!host.available) return toast("Sign-in works in the desktop app.", true);
  toast("Sign in using the Roblox window…");
  try {
    const u = await host.addAccount();
    if (!u) { await loadAccounts(); return toast("Sign-in cancelled"); }
    await loadAccounts();
    await onSignedIn(u);
    toast(`Welcome aboard, ${u.displayName}! 🚀`);
  } catch (e) { toast(e.message, true); }
}

async function switchAccount(id) {
  if (id === accounts.activeId) return;
  try {
    const u = await host.switchAccount(id);
    await loadAccounts();
    await onSignedIn(u);
    toast(`Switched to ${u.displayName}`);
  } catch (e) { toast(e.message, true); }
}

async function removeAccount(id) {
  const a = accounts.list.find((x) => x.id === id);
  if (!a) return;
  const signOut = confirm(`Remove ${a.displayName} from RoLauncher?\n\nOK = remove and also sign this session out on Roblox.\nCancel = keep it.`);
  if (!signOut) return;
  try {
    await host.removeAccount(id, true);
    await loadAccounts();
    toast(`Removed ${a.displayName}`);
    if (accounts.activeId) { const u = await host.account(); if (u) return onSignedIn(u); }
    S.user = null; robux = null; store.save();
    av.loaded = false;
    refreshRobux(); renderAccount(); refreshFriends();
  } catch (e) { toast(e.message, true); }
}

async function onSignedIn(u) {
  const changed = !S.user || S.user.id !== u.id;
  S.user = { id: u.id, name: u.name, displayName: u.displayName, signedIn: true };
  store.save();
  if (changed) { av.loaded = false; if (currentPage === "avatar") openAvatarEditor(); }
  await renderAccount();
  refreshRobux();
  refreshFriends();
}

async function logout() {
  if (accounts.activeId) return removeAccount(accounts.activeId);
}

async function refreshRobux() {
  const u = S.user;
  if (!u || !u.signedIn) { robux = null; }
  else {
    try { robux = (await host.get(`https://economy.roblox.com/v1/users/${u.id}/currency`)).robux; } catch { robux = null; }
  }
  $("#tbRobux").hidden = robux == null;
  $("#robuxCount").textContent = robux == null ? "" : fmt(robux);
  $("#marketRobux").hidden = robux == null;
  $("#marketRobux span").textContent = robux == null ? "" : robux.toLocaleString();
  renderAccountBox();
}

/** On startup: load saved accounts and check the active session is still valid. */
async function checkSession() {
  if (!host.available) return;
  await loadAccounts();
  try {
    const u = await host.account();
    if (u) await onSignedIn(u);
    else {
      if (accounts.activeId) toast("Your Roblox session expired. Remove the account and add it again.", true);
      if (S.user && S.user.signedIn) { S.user = null; store.save(); renderAccount(); }
    }
  } catch { /* offline */ }
}

$("#accountForm").addEventListener("submit", async (e) => {
  e.preventDefault();
  const name = $("#accountInput").value.trim();
  if (!name) return;
  if (accounts.list.length) return toast("Guest mode is only for when no account is signed in.", true);
  try {
    const u = await api.userByName(name);
    if (!u) return toast("No Roblox user with that name.", true);
    S.user = u; store.save(); renderAccount();
    toast(`Showing ${u.displayName}'s avatar`);
  } catch (err) { toast(err.message, true); }
});
$("#tbRobux").onclick = () => go("market");

/* =========================================================
   Friends (stored locally; presence polled from Roblox)
   ========================================================= */
let friendData = [];
const PRESENCE = ["Offline", "Online", "In game", "In Studio", "Invisible"];
const PCLASS = ["", "online", "ingame", "studio", ""];

let robloxFriendIds = [];
async function refreshFriends() {
  robloxFriendIds = [];
  if (S.user && S.user.signedIn) {
    try {
      const r = await host.get(`https://friends.roblox.com/v1/users/${S.user.id}/friends`);
      robloxFriendIds = (r.data || []).map((f) => f.id).slice(0, 200);
    } catch { /* fall back to local list */ }
  }
  $("#friendsHint").textContent = S.user && S.user.signedIn
    ? `Showing your Roblox friends${S.friends.length ? " plus people you've added" : ""}.`
    : "Sign in to load your Roblox friends automatically, or add people by username.";
  const ids = uniq([...robloxFriendIds, ...S.friends]);
  if (!ids.length) { friendData = []; return drawFriends(); }
  try {
    const [users, pres] = await Promise.all([
      Promise.all(chunk(ids, 100).map(api.users)).then((a) => a.flat()),
      Promise.all(chunk(ids, 50).map(api.presence)).then((a) => a.flat()),
      api.headshots(ids),
    ]);
    const pmap = new Map(pres.map((p) => [p.userId, p]));
    friendData = users.map((u) => {
      const p = pmap.get(u.id) || {};
      return { id: u.id, name: u.name, displayName: u.displayName, type: p.userPresenceType || 0, location: p.lastLocation || "", placeId: p.placeId || p.rootPlaceId, universeId: p.universeId, jobId: p.gameId };
    }).sort((a, b) => (b.type ? 1 : 0) - (a.type ? 1 : 0) || b.type - a.type || a.displayName.localeCompare(b.displayName));
  } catch { /* keep old data */ }
  drawFriends();
}

function friendHTML(f, big) {
  const status = f.type === 2 && f.location ? f.location : PRESENCE[f.type] || "Offline";
  const canJoin = f.type === 2 && f.universeId;
  return `<div class="friend" data-fid="${f.id}">
    <div class="av"><img src="${esc(cache.heads.get(f.id) || PLACEHOLDER)}" alt=""/><i class="${PCLASS[f.type] || ""}"></i></div>
    <div class="fi"><div class="fn link-name" data-fact="profile">${esc(f.displayName)}</div><div class="fs ${f.type === 2 ? "ingame" : ""}">${esc(status)}${big ? ` · @${esc(f.name)}` : ""}</div></div>
    ${canJoin ? `<button class="fbtn join" data-fact="join" title="Join game"><svg viewBox="0 0 24 24"><use href="#i-play"/></svg></button>` : ""}
    <button class="fbtn" data-fact="profile" title="View profile"><svg viewBox="0 0 24 24"><use href="#i-id"/></svg></button>
    ${big && S.friends.includes(f.id) ? `<button class="fbtn" data-fact="remove" title="Remove"><svg viewBox="0 0 24 24"><use href="#i-x"/></svg></button>` : ""}
  </div>`;
}

function drawFriends() {
  const online = friendData.filter((f) => f.type > 0).length;
  $("#friendsOnline").textContent = `(${online} online)`;
  $("#sideFriends").innerHTML = friendData.length
    ? friendData.slice(0, 8).map((f) => friendHTML(f, false)).join("")
    : `<div class="friend-empty">No friends added yet. <button class="link" data-goto="friends">Add some →</button></div>`;
  if (currentPage === "friends") renderFriends();
}
function renderFriends() {
  $("#friendsPageList").innerHTML = friendData.length ? friendData.map((f) => friendHTML(f, true)).join("") : `<div class="empty">Your crew is empty. Add a friend above.</div>`;
}

document.addEventListener("click", (e) => {
  const b = e.target.closest("[data-fact]");
  if (!b) return;
  const f = friendData.find((x) => x.id === Number(b.closest("[data-fid]").dataset.fid));
  if (!f) return;
  if (b.dataset.fact === "profile") openProfile(f.id);
  if (b.dataset.fact === "join") play(f.universeId, f.jobId);
  if (b.dataset.fact === "remove") { S.friends = S.friends.filter((id) => id !== f.id); store.save(); friendData = friendData.filter((x) => x.id !== f.id); drawFriends(); }
});

$("#addFriendForm").addEventListener("submit", async (e) => {
  e.preventDefault();
  const name = $("#addFriendInput").value.trim();
  if (!name) return;
  try {
    const u = await api.userByName(name);
    if (!u) return toast("No Roblox user with that name.", true);
    if (S.friends.includes(u.id) || robloxFriendIds.includes(u.id)) return toast("Already in your list.");
    S.friends.push(u.id); store.save();
    $("#addFriendInput").value = "";
    toast(`Added ${u.displayName}`);
    refreshFriends();
  } catch (err) { toast(err.message, true); }
});

/* =========================================================
   Spotlight
   ========================================================= */
let spotUid = null;
async function loadSpotlight() {
  try {
    const sorts = await getSorts();
    const s = sorts.find((x) => x.sortId === "top-trending") || sorts[0];
    const pick = s.games.filter((g) => !g.isSponsored).slice(0, 8);
    const choice = pick[Math.floor(Math.random() * pick.length)];
    spotUid = choice.universeId;
    const [g, banner] = await Promise.all([api.games([spotUid]).then((m) => m.get(spotUid)), api.banner(spotUid)]);
    $("#spotImg").src = banner || g.icon;
    $("#spotName").textContent = g.name;
    $("#spotBy").textContent = g.creator ? `by ${g.creator}` : "";
    $("#spotRating").textContent = g.rating != null ? `${g.rating}%` : "";
  } catch { $("#spotName").textContent = "Offline"; }
}
$("#spotPlay").onclick = () => spotUid && play(spotUid);
$("#spotView").onclick = () => spotUid && openGame(spotUid);
$(".spot-img").onclick = () => spotUid && openGame(spotUid);

/* =========================================================
   Settings
   ========================================================= */
function applyAccent() { document.documentElement.style.setProperty("--accent", S.settings.accent); }
function renderSettings() {
  $("#accountInput").value = S.user ? S.user.name : "";
  $("#setStars").checked = S.settings.stars;
  $("#setMinimize").checked = S.settings.minimize;
  $("#setEmbed").checked = S.settings.embed;
  $("#setCloseOnLeave").checked = S.settings.closeOnLeave;
  $("#setCloseBehavior").value = S.settings.closeBehavior || "ask";
  $("#setMulti").checked = !!S.settings.multi;
  $("#setAutoUpdate").checked = S.settings.autoUpdate !== false;
  const dc = S.settings.discord;
  $("#setDiscord").checked = !!dc.enabled;
  $("#discordId").value = dc.clientId || "";
  $("#setDiscordBrowsing").checked = !!dc.browsing;
  $("#setDiscordJoin").checked = !!dc.join;
  $("#discordBox").classList.toggle("off", !dc.enabled);
  renderAccountBox();
  $("#accentRow").innerHTML = ACCENTS.map((c) => `<button style="background:${c}" data-accent="${c}" class="${c === S.settings.accent ? "on" : ""}"></button>`).join("");
}
$("#accentRow").addEventListener("click", (e) => {
  const b = e.target.closest("[data-accent]");
  if (!b) return;
  S.settings.accent = b.dataset.accent; store.save(); applyAccent(); renderSettings();
});
/* Interface switcher (Classic <-> Console) */
const CURRENT_UI = document.body.classList.contains("console") ? "console" : "classic";
function renderUiPick() { $$("#uiPick [data-ui]").forEach((b) => b.classList.toggle("on", b.dataset.ui === CURRENT_UI)); }
$("#uiPick").addEventListener("click", (e) => {
  const b = e.target.closest("[data-ui]");
  if (!b || b.dataset.ui === CURRENT_UI) return;
  localStorage.setItem("rolauncher.ui", b.dataset.ui);
  location.href = (b.dataset.ui === "console" ? "console.html" : "index.html") + "#settings";
});
renderUiPick();

$("#setStars").onchange = (e) => { S.settings.stars = e.target.checked; store.save(); };
$("#setMinimize").onchange = (e) => { S.settings.minimize = e.target.checked; store.save(); };
$("#setEmbed").onchange = (e) => { S.settings.embed = e.target.checked; store.save(); };
$("#setCloseOnLeave").onchange = (e) => { S.settings.closeOnLeave = e.target.checked; store.save(); };
$("#setCloseBehavior").onchange = (e) => {
  S.settings.closeBehavior = e.target.value;
  store.save();
  if (host.available) host.closeBehavior(e.target.value).catch(() => {});
};
$("#setDiscord").onchange = (e) => {
  S.settings.discord.enabled = e.target.checked;
  store.save();
  $("#discordBox").classList.toggle("off", !e.target.checked);
  applyDiscordConfig();
};
$("#discordForm").addEventListener("submit", (e) => {
  e.preventDefault();
  const id = $("#discordId").value.trim();
  if (id && !/^\d{15,25}$/.test(id)) return toast("That doesn't look like an Application ID (it's a long number).", true);
  S.settings.discord.clientId = id;
  store.save();
  applyDiscordConfig();
  toast(id ? "Using your own Discord application" : "Using RoLauncher's Discord application");
});
$("#setDiscordBrowsing").onchange = (e) => { S.settings.discord.browsing = e.target.checked; store.save(); updatePresence(); };
$("#setDiscordJoin").onchange = (e) => { S.settings.discord.join = e.target.checked; store.save(); updatePresence(); };
document.addEventListener("click", (e) => {
  const a = e.target.closest("a[data-ext]");
  if (a) { e.preventDefault(); host.open(a.href); }
});

$("#setMulti").onchange = async (e) => {
  const want = e.target.checked;
  try {
    const r = await host.multiInstance(want);
    S.settings.multi = !!(r && r.enabled);
    if (want && !S.settings.multi) toast((r && r.warning) || "Couldn't turn it on.", true);
    else toast(S.settings.multi ? "Multiple Roblox windows allowed" : "Back to one Roblox window at a time");
  } catch (err) { S.settings.multi = false; toast(err.message, true); }
  e.target.checked = S.settings.multi;
  store.save();
};

/* =========================================================
   Market (Roblox avatar shop)
   ========================================================= */
const MARKET_CATS = [
  ["All", ""],
  ["Hats", "thukPQUFe5EHxRrtsgq43u"],
  ["Hair", "d6a7M7r9MMrpf7z7VxW9ZS"],
  ["Faces", "b5rkQhGSfwhfTK177y6ERa"],
  ["Heads", "s5NLP7BS9PRLKvUVca4XKg"],
  ["Characters", "kfHzJwaNYM8s2CWRqYUhRa"],
  ["Shirts", "2a2rf9qyeTd8W5iegK2Prc"],
  ["Pants", "49cFNAJWuwiJJVUSADG6DR"],
  ["T-Shirts", "43H35nJKHzCQM63q3wPaJG"],
  ["Jackets", "kPZpEVNdProGcqMbj1jDKJ"],
  ["Back", "7yGywzp5JeDsNjhXWJqSw3"],
  ["Shoulder", "8i1sggNTrxoN799hpRrR1S"],
  ["Shoes", "uLRgNoJ1awZkhpVw9WyvKo"],
  ["Emotes", "ioNxAT977DFP2hMnAJbsbF"],
  ["Animations", "whf6kUVBwk2xdwKUmRYN6G"],
];
const market = { cat: "", sort: "0", q: "", cursor: null, loaded: false, busy: false, items: new Map() };

$("#marketCats").innerHTML = MARKET_CATS.map(([n, id]) => `<button class="chip ${id === "" ? "on" : ""}" data-cat="${id}">${n}</button>`).join("");
$("#marketCats").addEventListener("click", (e) => {
  const b = e.target.closest("[data-cat]");
  if (!b) return;
  market.cat = b.dataset.cat;
  $$("#marketCats .chip").forEach((c) => c.classList.toggle("on", c === b));
  loadMarket(true);
});
$("#marketForm").addEventListener("submit", (e) => { e.preventDefault(); market.q = $("#marketInput").value.trim(); loadMarket(true); });
$("#marketSort").onchange = (e) => { market.sort = e.target.value; loadMarket(true); };
$("#marketMore").onclick = () => loadMarket(false);

async function loadMarket(reset) {
  if (market.busy) return;
  market.busy = true;
  const grid = $("#marketGrid");
  if (reset) { market.cursor = null; skeletons(grid, 18); }
  const p = new URLSearchParams({ Limit: "30", SortType: market.sort });
  if (market.q) p.set("Keyword", market.q);
  if (market.cat) p.set("taxonomy", market.cat);
  if (!reset && market.cursor) p.set("Cursor", market.cursor);
  try {
    const r = await host.get(`https://catalog.roblox.com/v2/search/items/details?${p}`);
    const items = r.data || [];
    market.cursor = r.nextPageCursor;
    const assets = items.filter((i) => i.itemType === "Asset").map((i) => i.id);
    const bundles = items.filter((i) => i.itemType === "Bundle").map((i) => i.id);
    const thumbs = new Map();
    const [ta, tb] = await Promise.all([
      assets.length ? host.get(`https://thumbnails.roblox.com/v1/assets?assetIds=${assets.join(",")}&size=150x150&format=Png&returnPolicy=PlaceHolder`).catch(() => ({ data: [] })) : { data: [] },
      bundles.length ? host.get(`https://thumbnails.roblox.com/v1/bundles/thumbnails?bundleIds=${bundles.join(",")}&size=150x150&format=Png`).catch(() => ({ data: [] })) : { data: [] },
    ]);
    for (const t of ta.data || []) thumbs.set("Asset" + t.targetId, t.imageUrl);
    for (const t of tb.data || []) thumbs.set("Bundle" + t.targetId, t.imageUrl);
    const html = items.map((i) => itemHTML(i, thumbs.get(i.itemType + i.id))).join("");
    if (reset) grid.innerHTML = html || `<div class="empty">No items found.</div>`;
    else grid.insertAdjacentHTML("beforeend", html);
    for (const i of items) market.items.set(i.itemType + i.id, i);
    market.loaded = true;
    $("#marketMore").hidden = !market.cursor;
  } catch (e) {
    if (reset) grid.innerHTML = `<div class="empty">Couldn't load the Market (${esc(e.message)}).</div>`;
  } finally { market.busy = false; }
}

function itemHTML(i, img) {
  const kind = (i.taxonomy && i.taxonomy[0] && i.taxonomy[0].taxonomyName) || (i.itemType === "Bundle" ? "Bundle" : "Item");
  const offsale = i.price == null && !i.lowestPrice;
  const price = offsale ? `<div class="price off">Off sale</div>`
    : (i.lowestPrice ?? i.price) === 0 ? `<div class="price free">Free</div>`
    : `<div class="price"><svg viewBox="0 0 24 24"><use href="#i-robux"/></svg>${(i.lowestPrice ?? i.price).toLocaleString()}</div>`;
  return `<div class="item" data-item="${i.itemType}" data-iid="${i.id}" title="${esc(i.name)}">
    <div class="thumb"><img src="${esc(img) || PLACEHOLDER}" loading="lazy" alt=""/><span class="kind">${esc(kind)}</span></div>
    <div class="name">${esc(i.name)}</div>
    <div class="by">by ${esc(i.creatorName)}</div>
    ${price}
  </div>`;
}

$("#marketGrid").addEventListener("click", (e) => {
  const el = e.target.closest("[data-iid]");
  if (el) openItem(el.dataset.item, Number(el.dataset.iid));
});

/* =========================================================
   Item modal + buying
   ========================================================= */
const ROBUX_SVG = `<svg viewBox="0 0 24 24"><use href="#i-robux"/></svg>`;
const item = { cur: null, price: null, owned: false, det: null, token: 0 };

const signedIn = () => !!(S.user && S.user.signedIn);
const itemUrl = (i) => `https://www.roblox.com/${i.itemType === "Bundle" ? "bundles" : "catalog"}/${i.id}`;

async function openItem(type, id) {
  const i = market.items.get(type + id);
  if (!i) return;
  const token = ++item.token;
  Object.assign(item, { cur: i, price: null, owned: false, det: null });
  const kind = (i.taxonomy && i.taxonomy[0] && i.taxonomy[0].taxonomyName) || i.itemType;
  $("#iKind").textContent = kind;
  $("#iName").textContent = i.name;
  $("#iCreator").textContent = `By ${i.creatorName}${i.creatorHasVerifiedBadge ? " ✔" : ""}`;
  $("#iDesc").textContent = i.description || "";
  $("#iMeta").innerHTML = [
    i.favoriteCount != null ? `♥ ${fmt(i.favoriteCount)} favorites` : "",
    i.itemRestrictions && i.itemRestrictions.length ? `★ ${esc(i.itemRestrictions.join(", "))}` : "",
    i.totalQuantity ? `${fmt(i.unitsAvailableForConsumption || 0)} / ${fmt(i.totalQuantity)} left` : "",
  ].filter(Boolean).map((x) => `<span>${x}</span>`).join("");
  $("#iOwned").hidden = true;
  $("#iImg").src = PLACEHOLDER;
  $("#buyBox").innerHTML = `<button class="btn buy" disabled>Loading…</button>`;
  setPrice(i.price ?? null, i.price == null);
  $("#itemModal").hidden = false;

  const thumbUrl = i.itemType === "Bundle"
    ? `https://thumbnails.roblox.com/v1/bundles/thumbnails?bundleIds=${i.id}&size=420x420&format=Png`
    : `https://thumbnails.roblox.com/v1/assets?assetIds=${i.id}&size=420x420&format=Png&returnPolicy=PlaceHolder`;
  const [thumb, det, owned] = await Promise.all([
    host.get(thumbUrl).catch(() => null),
    i.collectibleItemId
      ? host.post("https://apis.roblox.com/marketplace-items/v1/items/details", { itemIds: [i.collectibleItemId] }).then((r) => r && r[0]).catch(() => null)
      : null,
    signedIn()
      ? host.get(`https://inventory.roblox.com/v1/users/${S.user.id}/items/${i.itemType}/${i.id}/is-owned`).catch(() => false)
      : false,
  ]);
  if (token !== item.token) return;
  const t = thumb && thumb.data && thumb.data[0];
  if (t && t.imageUrl) $("#iImg").src = t.imageUrl;
  item.det = det;
  item.owned = owned === true;
  $("#iOwned").hidden = !item.owned;

  // Price you pay when buying from the creator (resale-only listings are left to roblox.com).
  const creatorPrice = det ? det.price : i.price;
  const soldOut = det && det.assetStock > 0 && det.unitsAvailableForConsumption === 0;
  const forSale = creatorPrice != null && !soldOut && (!i.itemStatus || !i.itemStatus.includes("OffSale"));
  item.price = forSale ? creatorPrice : null;
  setPrice(item.price, !forSale, soldOut ? "Sold out" : i.hasResellers && !forSale ? "Resale only" : "Off sale");
  renderBuyBox();
}

function setPrice(price, off, offText = "Off sale") {
  const el = $("#iPrice");
  el.className = "item-price" + (off ? " off" : price === 0 ? " free" : "");
  el.innerHTML = off ? offText : price === 0 ? "Free" : `${ROBUX_SVG}${price.toLocaleString()}`;
}

function renderBuyBox(note = "", noteClass = "") {
  const box = $("#buyBox"), i = item.cur;
  const noteHTML = note ? `<div class="buy-note ${noteClass}">${esc(note)}</div>` : "";
  if (item.owned) {
    box.innerHTML = `<button class="btn ghost" id="bWear" ${i.itemType === "Asset" ? "" : "disabled"}>${i.itemType === "Asset" ? "Wear in Avatar editor" : "You own this bundle"}</button>${noteHTML}`;
    const w = $("#bWear");
    if (w && i.itemType === "Asset") w.onclick = () => { closeItem(); go("avatar"); avatarWearAfterLoad = i.id; };
    return;
  }
  if (item.price == null) {
    box.innerHTML = `<button class="btn ghost" id="bWeb">${i.hasResellers ? "See resellers on Roblox" : "Not for sale"}</button>${noteHTML}`;
    $("#bWeb").onclick = () => host.open(itemUrl(i));
    return;
  }
  if (!signedIn()) {
    box.innerHTML = `<button class="btn buy" id="bSign">Sign in to buy</button>${noteHTML}`;
    $("#bSign").onclick = () => { closeItem(); go("settings"); };
    return;
  }
  const cant = robux != null && robux < item.price;
  box.innerHTML = `<button class="btn buy" id="bBuy" ${cant ? "disabled" : ""}>${item.price === 0 ? "Get for free" : `Buy for ${item.price.toLocaleString()} Robux`}</button>
    ${cant ? `<div class="buy-note err">You need ${(item.price - robux).toLocaleString()} more Robux.</div>` : noteHTML}`;
  $("#bBuy").onclick = renderConfirm;
}

function renderConfirm() {
  const i = item.cur, after = robux != null ? robux - item.price : null;
  $("#buyBox").innerHTML = `<div class="confirm">
      <div class="row"><span>Item</span><b>${esc(i.name)}</b></div>
      <div class="row"><span>Price</span><b>${item.price === 0 ? "Free" : ROBUX_SVG + item.price.toLocaleString()}</b></div>
      ${after != null ? `<div class="row"><span>Balance after</span><b>${ROBUX_SVG}${after.toLocaleString()}</b></div>` : ""}
      <div class="btns"><button class="btn ghost" id="bCancel">Cancel</button><button class="btn buy" id="bConfirm">Confirm purchase</button></div>
    </div>`;
  $("#bCancel").onclick = () => renderBuyBox();
  $("#bConfirm").onclick = confirmPurchase;
}

async function confirmPurchase() {
  const i = item.cur;
  const btn = $("#bConfirm");
  btn.disabled = true; btn.textContent = "Purchasing…";
  try {
    await purchase(i);
    item.owned = true;
    $("#iOwned").hidden = false;
    renderBuyBox(`Purchased! ${i.name} is now in your inventory.`, "ok");
    toast(`🛍️ Bought ${i.name}`);
    refreshRobux();
  } catch (e) {
    renderBuyBox(e.message || "Purchase failed", "err");
  }
}

async function purchase(i) {
  if (i.collectibleItemId) {
    const det = item.det || (await host.post("https://apis.roblox.com/marketplace-items/v1/items/details", { itemIds: [i.collectibleItemId] }))[0];
    if (!det || !det.collectibleProductId) throw new Error("This item can't be bought here. Try roblox.com.");
    if (det.price !== item.price) throw new Error("The price changed. Reopen the item and try again.");
    const r = await host.post(`https://apis.roblox.com/marketplace-sales/v1/item/${i.collectibleItemId}/purchase-item`, {
      collectibleItemId: i.collectibleItemId,
      collectibleProductId: det.collectibleProductId,
      expectedCurrency: 1,
      expectedPrice: det.price,
      expectedPurchaserId: String(S.user.id),
      expectedPurchaserType: "User",
      expectedSellerId: det.creatorId,
      expectedSellerType: det.creatorType,
      idempotencyKey: crypto.randomUUID(),
    });
    if (!r || r.purchased !== true) throw new Error((r && (r.errorMessage || r.purchaseResult)) || "Purchase failed");
    return;
  }
  if (!i.productId) throw new Error("This item can't be bought here. Try roblox.com.");
  const r = await host.post(`https://economy.roblox.com/v1/purchases/products/${i.productId}`, {
    expectedCurrency: 1, expectedPrice: item.price, expectedSellerId: i.creatorTargetId,
  });
  if (!r || r.purchased !== true) throw new Error((r && (r.errorMsg || r.reason)) || "Purchase failed");
}

function closeItem() { $("#itemModal").hidden = true; item.token++; }
$("#itemClose").onclick = closeItem;
$("#itemModal").addEventListener("click", (e) => { if (e.target.id === "itemModal") closeItem(); });
$("#iWeb").onclick = () => item.cur && host.open(itemUrl(item.cur));

/* =========================================================
   Avatar editor
   Every change is drawn live with Roblox's own renderer (avatar/render) before you
   save. Body parts come from your inventory and from body/animation bundles.
   ========================================================= */
const AV_CATS = [
  ["Wearing", "wearing"], ["Outfits", "outfits"], "|",
  ["Hats", 8], ["Hair", 41], ["Face", 42], ["Neck", 43], ["Shoulder", 44], ["Front", 45], ["Back", 46], ["Waist", 47],
  ["Shirts", 11], ["Pants", 12], ["T-Shirts", 2],
  ["3D Shirts", 65], ["3D Pants", 66], ["3D T-Shirts", 64], ["Jackets", 67], ["Sweaters", 68], ["Shorts", 69], ["Dresses", 72], ["Shoes", 70], "|",
  ["Bodies", "b1"], ["Heads", 17], ["Dynamic Heads", 79], ["Faces", 18], ["Torsos", 27], ["Left Arms", 29], ["Right Arms", 28], ["Left Legs", 30], ["Right Legs", 31],
  ["Animation packs", "b2"], ["Emotes", 61],
];
const SINGLE_SLOT = new Set([2, 11, 12, 17, 18, 27, 28, 29, 30, 31, 48, 50, 51, 52, 53, 54, 55, 56, 79]);
const LAYERED = new Set([64, 65, 66, 67, 68, 69, 70, 71, 72]);
const BODY_TYPES = new Set([27, 28, 29, 30, 31]);
const SKINS = ["FFCC99", "EAB892", "D7A57C", "CC8E69", "A16E52", "7C5C46", "5A4C42", "F8F8F8", "FDEA8D", "E8BAC8", "A3A2A5", "1B2A35"];
const AV_PARTS = [["All", "all"], ["Head", "headColor3"], ["Torso", "torsoColor3"], ["Left arm", "leftArmColor3"], ["Right arm", "rightArmColor3"], ["Left leg", "leftLegColor3"], ["Right leg", "rightLegColor3"]];
// Roblox's own avatar editor limits (used when avatar-rules doesn't say).
const AV_SCALES = [
  ["height", "Height", 0.9, 1.05, 0.01], ["width", "Width", 0.7, 1, 0.01], ["head", "Head", 0.95, 1, 0.01],
  ["proportion", "Proportions", 0, 1, 0.01], ["bodyType", "Body type", 0, 1, 0.01],
];

const av = {
  loaded: false, saved: null, wearing: new Map(), colors: null, scales: null, type: "R15", cat: "wearing", cursor: null,
  thumbs: new Map(), bundleThumbs: new Map(), bundles: new Map(), busy: false, part: "all", stage: "colors",
  savedImg: "", hash: true, outfitPage: 1, rules: null,
};
let avatarWearAfterLoad = null;

const hex = (v) => String(v || "").replace("#", "").toUpperCase();
const sameJSON = (a, b) => JSON.stringify(a) === JSON.stringify(b);

async function openAvatarEditor() {
  const ok = signedIn();
  $("#avatarSignin").hidden = ok;
  $("#avatarLayout").hidden = !ok;
  if (!ok) return;
  if (!av.loaded) {
    $("#avCats").innerHTML = AV_CATS.map((c) => c === "|" ? `<span class="av-cat-sep"></span>`
      : `<button class="chip ${String(c[1]) === String(av.cat) ? "on" : ""}" data-avcat="${c[1]}">${c[0]}</button>`).join("");
    await Promise.all([loadAvRules(), loadAvatar()]);
  }
  if (avatarWearAfterLoad) {
    const id = avatarWearAfterLoad; avatarWearAfterLoad = null;
    const info = await assetInfo([id]);
    const a = info.get(id);
    if (a) toggleWear({ id, name: a.name, typeId: a.typeId });
    showAvCat("wearing");
  }
}

async function loadAvRules() {
  const r = await host.get("https://avatar.roblox.com/v1/avatar-rules").catch(() => null);
  av.rules = r;
  const pal = r && (r.bodyColorsPalette || r.basicBodyColorsPalette);
  const colors = pal && pal.length ? pal.map((c) => hex(c.hexColor)).filter(Boolean) : SKINS;
  $("#skinRow").innerHTML = colors.map((c) => `<button data-skin="${c}" style="background:#${c}" title="#${c}"></button>`).join("");
}

function scaleLimits(key, min, max, step) {
  const s = av.rules && av.rules.scales && av.rules.scales[key];
  return s && typeof s.min === "number" ? [s.min, s.max, s.increment || step] : [min, max, step];
}

async function assetInfo(ids) {
  // Learns each asset's type + name.
  const res = await Promise.all(ids.map((id) => host.get(`https://economy.roblox.com/v2/assets/${id}/details`).catch(() => null)));
  return new Map(res.filter(Boolean).map((d) => [d.AssetId, { name: d.Name, typeId: d.AssetTypeId }]));
}

function wornFrom(assets) {
  return new Map((assets || []).map((x) => [x.id, { id: x.id, name: x.name, typeId: x.assetType ? x.assetType.id : x.typeId, meta: x.meta }]));
}
function normColors(c) {
  const out = {};
  for (const [k, v] of Object.entries(c || {})) if (typeof v === "string") out[k.replace(/Color(Id)?3?$/, "Color3")] = hex(v);
  return out;
}

async function loadAvatar() {
  setAvBusy(true);
  try {
    const a = await host.get("https://avatar.roblox.com/v2/avatar/avatar");
    av.saved = a;
    av.hash = Object.values(a.bodyColor3s || {}).some((v) => String(v).startsWith("#"));
    av.wearing = wornFrom(a.assets);
    av.colors = normColors(a.bodyColor3s);
    av.scales = { ...a.scales };
    av.type = a.playerAvatarType;
    av.loaded = true;
    renderAvControls();
    await refreshRender(false);
    showAvCat(av.cat);
  } catch (e) {
    $("#avGrid").innerHTML = `<div class="empty">Couldn't load your avatar (${esc(e.message)}).</div>`;
  } finally { setAvBusy(false); }
}

function setAvBusy(b) { av.busy = b; $("#avBusy").hidden = !b; $("#avSave").disabled = b; $("#avSaveOutfit").disabled = b; }

function isDirty() {
  if (!av.saved) return false;
  const a = [...av.wearing.keys()].sort().join(","), b = av.saved.assets.map((x) => x.id).sort().join(",");
  return a !== b || av.type !== av.saved.playerAvatarType || !sameJSON(av.colors, normColors(av.saved.bodyColor3s)) || !sameScales();
}
function sameScales() {
  return AV_SCALES.every(([k]) => Math.abs((av.scales[k] ?? 0) - (av.saved.scales[k] ?? 0)) < 0.0001);
}

function renderAvControls() {
  $$("#avType button").forEach((b) => b.classList.toggle("on", b.dataset.type === av.type));
  // Body colors: which part is being painted, and its current color.
  $("#avParts").innerHTML = AV_PARTS.map(([n, k]) => {
    const c = k === "all" ? null : av.colors[k];
    return `<button data-part="${k}" class="${av.part === k ? "on" : ""}">${c ? `<i style="background:#${c}"></i>` : ""}${n}</button>`;
  }).join("");
  const keys = av.part === "all" ? AV_PARTS.slice(1).map((p) => p[1]) : [av.part];
  const vals = new Set(keys.map((k) => av.colors[k]));
  const cur = vals.size === 1 ? [...vals][0] : "";
  $$("#skinRow button").forEach((b) => b.classList.toggle("on", b.dataset.skin === cur));
  if (cur) $("#skinCustom").value = "#" + cur.toLowerCase();
  // Scales (R15 only).
  const r6 = av.type === "R6";
  $("#avScales").innerHTML = AV_SCALES.map(([k, label, mn, mx, st]) => {
    const [min, max, step] = scaleLimits(k, mn, mx, st);
    const v = av.scales[k] ?? min;
    return `<label class="av-scale ${r6 ? "off" : ""}"><span>${label}</span>
      <input type="range" data-scale="${k}" min="${min}" max="${max}" step="${step}" value="${v}" ${r6 ? "disabled" : ""}/><b>${Math.round(v * 100)}%</b></label>`;
  }).join("");
  $("#avScaleNote").textContent = r6 ? "Scaling only works on R15 avatars." : "";
  $$("#avStageTabs button").forEach((b) => b.classList.toggle("on", b.dataset.stage === av.stage));
  $("#avPaneColors").hidden = av.stage !== "colors";
  $("#avPaneScale").hidden = av.stage !== "scale";
  $("#avDirty").textContent = isDirty() ? "Unsaved changes — press Save avatar to wear them" : "";
}

// Any edit: update the controls and redraw the preview shortly after.
function avChanged() { renderAvControls(); schedulePreview(); }

/* ---------- Live preview ---------- */
let previewSeq = 0, previewTimer = null;
function schedulePreview() { clearTimeout(previewTimer); previewTimer = setTimeout(renderPreview, 350); }

function wearAssets() {
  let order = 1;
  return [...av.wearing.values()].map((w) => {
    const a = { id: w.id };
    if (w.meta) a.meta = w.meta;
    else if (LAYERED.has(w.typeId)) a.meta = { order: 100 + order++, version: 1 };
    return a;
  });
}
const colorsFor = (withHash) => Object.fromEntries(Object.entries(av.colors).map(([k, v]) => [k, (withHash ? "#" : "") + v]));

async function renderPreview() {
  const seq = ++previewSeq;
  const live = $("#avLive");
  live.classList.remove("warn");
  if (!isDirty()) { if (av.savedImg) $("#avRender").src = av.savedImg; live.hidden = true; return; }
  live.hidden = false; live.textContent = "Updating…";
  $("#avBusy").hidden = false;
  const body = {
    thumbnailConfig: { thumbnailId: 1, thumbnailType: "2d", size: "420x420" },
    avatarDefinition: {
      assets: wearAssets(),
      bodyColors: Object.fromEntries(Object.entries(av.colors).map(([k, v]) => [k.replace(/3$/, ""), "#" + v])),
      scales: { ...av.scales },
      playerAvatarType: { playerAvatarType: av.type },
    },
  };
  try {
    for (let tries = 0; tries < 20; tries++) {
      const r = await host.post("https://avatar.roblox.com/v1/avatar/render", body);
      if (seq !== previewSeq) return;
      if (r && r.state === "Completed" && r.imageUrl) {
        $("#avRender").src = r.imageUrl;
        live.textContent = "Preview · not saved";
        return;
      }
      if (r && (r.state === "Blocked" || r.state === "Error")) throw new Error(r.state);
      await new Promise((res) => setTimeout(res, tries < 4 ? 600 : 1200));
      if (seq !== previewSeq) return;
    }
    throw new Error("timeout");
  } catch {
    if (seq !== previewSeq) return;
    live.textContent = "Preview unavailable — save to see it";
    live.classList.add("warn");
  } finally {
    if (seq === previewSeq && !av.busy) $("#avBusy").hidden = true;
  }
}

async function refreshRender(redraw) {
  const id = S.user.id;
  if (redraw) await host.post("https://avatar.roblox.com/v1/avatar/redraw-thumbnail", {}).catch(() => {});
  const before = av.savedImg;
  for (let tries = 0; tries < 12; tries++) {
    const r = await host.get(`https://thumbnails.roblox.com/v1/users/avatar?userIds=${id}&size=420x420&format=Png&_=${Date.now()}`).catch(() => null);
    const d = r && r.data && r.data[0];
    if (d && d.state === "Completed" && d.imageUrl && (!redraw || d.imageUrl !== before || tries > 6)) {
      av.savedImg = d.imageUrl;
      if (!isDirty()) { $("#avRender").src = d.imageUrl; $("#avLive").hidden = true; }
      return;
    }
    await new Promise((res) => setTimeout(res, 1500));
  }
}

/* ---------- Categories ---------- */
$("#avCats").addEventListener("click", (e) => {
  const b = e.target.closest("[data-avcat]");
  if (b) showAvCat(b.dataset.avcat);
});

async function showAvCat(cat) {
  av.cat = cat;
  av.cursor = null;
  $$("#avCats .chip").forEach((c) => c.classList.toggle("on", c.dataset.avcat === String(cat)));
  const grid = $("#avGrid");
  $("#avMore").hidden = true;
  if (cat === "wearing") {
    const list = [...av.wearing.values()];
    await ensureThumbs(list.map((x) => x.id));
    if (av.cat !== "wearing") return;
    grid.innerHTML = list.length ? list.map(avItemHTML).join("") : `<div class="empty">You're not wearing anything. Pick items from the categories above.</div>`;
    return;
  }
  skeletons(grid, 12);
  if (cat === "outfits") return showOutfits(true);
  if (String(cat).startsWith("b")) return loadBundlePage(true);
  await loadInventoryPage(true);
}

async function loadInventoryPage(reset) {
  const grid = $("#avGrid");
  const type = Number(av.cat);
  try {
    const r = await host.get(`https://inventory.roblox.com/v2/users/${S.user.id}/inventory/${type}?limit=100&sortOrder=Desc${!reset && av.cursor ? `&cursor=${encodeURIComponent(av.cursor)}` : ""}`);
    if (String(type) !== String(av.cat)) return;
    av.cursor = r.nextPageCursor;
    const seen = new Set();
    const items = (r.data || []).filter((x) => !seen.has(x.assetId) && seen.add(x.assetId)).map((x) => ({ id: x.assetId, name: x.assetName, typeId: type }));
    await ensureThumbs(items.map((x) => x.id));
    let html = items.map(avItemHTML).join("");
    if (reset && BODY_TYPES.has(type)) html = defaultPartHTML(type) + html;
    if (reset) grid.innerHTML = html || `<div class="empty">You don't own anything in this category yet. Check the Market!</div>`;
    else grid.insertAdjacentHTML("beforeend", html);
    $("#avMore").hidden = !av.cursor;
  } catch (e) {
    grid.innerHTML = `<div class="empty">Couldn't load your inventory (${esc(e.message)}).</div>`;
  }
}

// A "no part" card so you can go back to the default blocky limb.
function defaultPartHTML(type) {
  const on = ![...av.wearing.values()].some((w) => w.typeId === type);
  return `<div class="av-item ${on ? "on" : ""}" data-avdefault="${type}" title="Use the default part">
    <div class="thumb" style="display:grid;place-items:center;color:var(--muted);font-weight:700">Default</div>
    <span class="check"><svg viewBox="0 0 24 24"><use href="#i-check"/></svg></span><div class="name">Default</div></div>`;
}

$("#avMore").onclick = () => av.cat === "outfits" ? showOutfits(false) : String(av.cat).startsWith("b") ? loadBundlePage(false) : loadInventoryPage(false);

async function ensureThumbs(ids) {
  const need = ids.filter((id) => !av.thumbs.has(id));
  for (const part of chunk(need, 100)) {
    const r = await host.get(`https://thumbnails.roblox.com/v1/assets?assetIds=${part.join(",")}&size=150x150&format=Png&returnPolicy=PlaceHolder`).catch(() => ({ data: [] }));
    for (const t of r.data || []) av.thumbs.set(t.targetId, t.imageUrl);
  }
}

function avItemHTML(x) {
  return `<div class="av-item ${av.wearing.has(x.id) ? "on" : ""}" data-avid="${x.id}" data-avtype="${x.typeId}" data-avname="${esc(x.name)}" title="${esc(x.name)}">
    <div class="thumb"><img src="${esc(av.thumbs.get(x.id) || PLACEHOLDER)}" loading="lazy" alt=""/></div>
    <span class="check"><svg viewBox="0 0 24 24"><use href="#i-check"/></svg></span>
    <div class="name">${esc(x.name)}</div>
  </div>`;
}

/* ---------- Bundles (bodies, animation packs) ---------- */
async function loadBundlePage(reset) {
  const grid = $("#avGrid");
  const cat = av.cat, type = Number(String(cat).slice(1));
  try {
    const r = await host.get(`https://catalog.roblox.com/v1/users/${S.user.id}/bundles/${type}?limit=100&sortOrder=Desc${!reset && av.cursor ? `&cursor=${encodeURIComponent(av.cursor)}` : ""}`);
    if (av.cat !== cat) return;
    av.cursor = r.nextPageCursor;
    const list = r.data || [];
    const need = list.map((b) => b.id).filter((id) => !av.bundleThumbs.has(id));
    for (const part of chunk(need, 50)) {
      const t = await host.get(`https://thumbnails.roblox.com/v1/bundles/thumbnails?bundleIds=${part.join(",")}&size=150x150&format=Png`).catch(() => ({ data: [] }));
      for (const x of t.data || []) av.bundleThumbs.set(x.targetId, x.imageUrl);
    }
    if (av.cat !== cat) return;
    let html = list.map((b) => `<div class="av-item ${bundleWorn(b.id) ? "on" : ""}" data-bundle="${b.id}" data-name="${esc(b.name)}" title="${esc(b.name)}">
        <div class="thumb"><img src="${esc(av.bundleThumbs.get(b.id) || PLACEHOLDER)}" loading="lazy" alt=""/></div>
        <span class="check"><svg viewBox="0 0 24 24"><use href="#i-check"/></svg></span>
        <div class="name">${esc(b.name)}</div></div>`).join("");
    if (reset && type === 1) html = `<div class="av-item" data-avdefault="body" title="Go back to the classic blocky body">
        <div class="thumb" style="display:grid;place-items:center;color:var(--muted);font-weight:700">Classic</div><div class="name">Classic body</div></div>` + html;
    if (reset) grid.innerHTML = html || `<div class="empty">You don't own any ${type === 1 ? "bodies" : "animation packs"} yet. Free ones are in the Market.</div>`;
    else grid.insertAdjacentHTML("beforeend", html);
    $("#avMore").hidden = !av.cursor;
  } catch (e) {
    grid.innerHTML = `<div class="empty">Couldn't load your bundles (${esc(e.message)}).</div>`;
  }
}

function bundleWorn(id) {
  const b = av.bundles.get(id);
  return !!(b && b.length && b.every((a) => av.wearing.has(a.id)));
}

async function bundleAssets(id) {
  if (av.bundles.has(id)) return av.bundles.get(id);
  const d = await host.get(`https://catalog.roblox.com/v1/bundles/${id}/details`);
  let assets = [];
  const outfit = (d.items || []).find((i) => i.type === "UserOutfit");
  if (outfit) {
    const o = await outfitDetails(outfit.id).catch(() => null);
    if (o) assets = o.assets;
  }
  if (!assets.length) {
    const ids = (d.items || []).filter((i) => i.type === "Asset").map((i) => i.id);
    const info = await assetInfo(ids);
    assets = ids.filter((i) => info.has(i)).map((i) => ({ id: i, name: info.get(i).name, typeId: info.get(i).typeId }));
  }
  av.bundles.set(id, assets);
  return assets;
}

async function wearBundle(id, name) {
  setAvBusy(true);
  try {
    const assets = await bundleAssets(id);
    if (!assets.length) throw new Error("This bundle has no items Roblox lets us read");
    if (bundleWorn(id)) {
      for (const a of assets) av.wearing.delete(a.id);
      toast(`Took off “${name}”`);
    } else {
      const types = new Set(assets.map((a) => a.typeId));
      if (types.has(79)) { types.add(17); types.add(18); }
      for (const [wid, w] of av.wearing) if (types.has(w.typeId)) av.wearing.delete(wid);
      for (const a of assets) av.wearing.set(a.id, a);
    }
  } catch (e) { toast(e.message, true); } finally { setAvBusy(false); }
  avChanged();
  $$("#avGrid [data-bundle]").forEach((n) => n.classList.toggle("on", bundleWorn(Number(n.dataset.bundle))));
}

/* ---------- Clicking items ---------- */
$("#avGrid").addEventListener("click", async (e) => {
  const tool = e.target.closest("[data-otool]");
  if (tool) { e.stopPropagation(); return outfitTool(tool.dataset.otool, Number(tool.closest("[data-outfit]").dataset.outfit), tool.closest("[data-outfit]").dataset.name); }
  if (e.target.closest("[data-newoutfit]")) return saveAsOutfit();
  const o = e.target.closest("[data-outfit]");
  if (o) return loadOutfit(Number(o.dataset.outfit), o.dataset.name);
  const b = e.target.closest("[data-bundle]");
  if (b) return wearBundle(Number(b.dataset.bundle), b.dataset.name);
  const d = e.target.closest("[data-avdefault]");
  if (d) {
    const types = d.dataset.avdefault === "body" ? new Set([...BODY_TYPES]) : new Set([Number(d.dataset.avdefault)]);
    for (const [id, w] of av.wearing) if (types.has(w.typeId)) av.wearing.delete(id);
    avChanged();
    return showAvCat(av.cat);
  }
  const el = e.target.closest("[data-avid]");
  if (!el) return;
  toggleWear({ id: Number(el.dataset.avid), name: el.dataset.avname, typeId: Number(el.dataset.avtype) });
  if (av.cat === "wearing") showAvCat("wearing");
  else {
    $$(`#avGrid [data-avid]`).forEach((n) => n.classList.toggle("on", av.wearing.has(Number(n.dataset.avid))));
    const def = $("#avGrid [data-avdefault]");
    if (def && def.dataset.avdefault !== "body") def.classList.toggle("on", ![...av.wearing.values()].some((w) => w.typeId === Number(def.dataset.avdefault)));
  }
});

function toggleWear(x) {
  if (av.wearing.has(x.id)) av.wearing.delete(x.id);
  else {
    if (SINGLE_SLOT.has(x.typeId)) for (const [id, w] of av.wearing) if (w.typeId === x.typeId) av.wearing.delete(id);
    av.wearing.set(x.id, x);
  }
  avChanged();
}

/* ---------- Body type, colors, scale ---------- */
$("#avType").addEventListener("click", (e) => {
  const b = e.target.closest("[data-type]");
  if (!b || b.dataset.type === av.type) return;
  av.type = b.dataset.type;
  avChanged();
});
$("#avStageTabs").addEventListener("click", (e) => {
  const b = e.target.closest("[data-stage]");
  if (!b) return;
  av.stage = b.dataset.stage;
  renderAvControls();
});
$("#avParts").addEventListener("click", (e) => {
  const b = e.target.closest("[data-part]");
  if (!b) return;
  av.part = b.dataset.part;
  renderAvControls();
});
function paint(color) {
  const keys = av.part === "all" ? AV_PARTS.slice(1).map((p) => p[1]) : [av.part];
  for (const k of keys) av.colors[k] = hex(color);
  avChanged();
}
$("#skinRow").addEventListener("click", (e) => {
  const b = e.target.closest("[data-skin]");
  if (b) paint(b.dataset.skin);
});
$("#skinCustom").addEventListener("change", (e) => paint(e.target.value));
$("#avScales").addEventListener("input", (e) => {
  const r = e.target.closest("[data-scale]");
  if (!r) return;
  av.scales[r.dataset.scale] = Number(r.value);
  r.parentElement.querySelector("b").textContent = Math.round(r.value * 100) + "%";
  $("#avDirty").textContent = isDirty() ? "Unsaved changes — press Save avatar to wear them" : "";
  schedulePreview();
});

$("#avReset").onclick = () => {
  if (!av.saved) return;
  const a = av.saved;
  av.wearing = wornFrom(a.assets);
  av.colors = normColors(a.bodyColor3s);
  av.scales = { ...a.scales };
  av.type = a.playerAvatarType;
  avChanged();
  showAvCat(av.cat);
};

$("#avSave").onclick = async () => {
  if (!isDirty()) return toast("Nothing to save");
  setAvBusy(true);
  try {
    const r = await host.post("https://avatar.roblox.com/v2/avatar/set-wearing-assets", { assets: wearAssets() });
    if (av.type !== av.saved.playerAvatarType)
      await host.post("https://avatar.roblox.com/v1/avatar/set-player-avatar-type", { playerAvatarType: av.type });
    if (!sameJSON(av.colors, normColors(av.saved.bodyColor3s)))
      await host.post("https://avatar.roblox.com/v2/avatar/set-body-colors", colorsFor(av.hash));
    if (!sameScales())
      await host.post("https://avatar.roblox.com/v1/avatar/set-scales", { ...av.saved.scales, ...av.scales });
    const bad = (r && r.invalidAssetIds) || [];
    toast(bad.length ? `Saved, but ${bad.length} item(s) couldn't be worn together` : "Avatar saved ✨", bad.length > 0);
    await loadAvatar();
    setAvBusy(true);
    await refreshRender(true);
    renderAccount();
  } catch (e) {
    toast(e.message, true);
  } finally { setAvBusy(false); }
};

/* ---------- Outfits ---------- */
async function showOutfits(reset) {
  const grid = $("#avGrid");
  if (reset) av.outfitPage = 1;
  let list = [], more = false;
  try {
    try {
      const r = await host.get(`https://avatar.roblox.com/v2/avatar/users/${S.user.id}/outfits?outfitType=Avatar&page=${av.outfitPage}&itemsPerPage=50&isEditable=true${av.cursor && !reset ? `&paginationToken=${encodeURIComponent(av.cursor)}` : ""}`);
      list = r.data || []; av.cursor = r.paginationToken || null; more = !!av.cursor;
    } catch {
      const r = await host.get(`https://avatar.roblox.com/v1/users/${S.user.id}/outfits?page=${av.outfitPage}&itemsPerPage=50&isEditable=true`);
      list = r.data || []; more = (r.total || 0) > av.outfitPage * 50;
    }
    if (av.cat !== "outfits") return;
    av.outfitPage++;
    const th = list.length ? await host.get(`https://thumbnails.roblox.com/v1/users/outfits?userOutfitIds=${list.map((o) => o.id).join(",")}&size=150x150&format=Png`).catch(() => ({ data: [] })) : { data: [] };
    const tm = new Map((th.data || []).map((t) => [t.targetId, t.imageUrl]));
    const html = list.map((o) => `<div class="av-item" data-outfit="${o.id}" data-name="${esc(o.name)}" title="Try on ${esc(o.name)}">
        <div class="av-tools">
          <button data-otool="update" title="Replace with the current look">⟳</button>
          <button data-otool="rename" title="Rename">✎</button>
          <button data-otool="delete" title="Delete">✕</button>
        </div>
        <div class="thumb"><img src="${esc(tm.get(o.id) || PLACEHOLDER)}" alt=""/></div><div class="name">${esc(o.name)}</div></div>`).join("");
    const add = `<div class="av-item new-outfit" data-newoutfit title="Save what you're wearing as a new outfit"><div class="thumb">+</div><div class="name">Save current look</div></div>`;
    if (reset) grid.innerHTML = add + html;
    else grid.insertAdjacentHTML("beforeend", html);
    $("#avMore").hidden = !more;
  } catch (e) { grid.innerHTML = `<div class="empty">Couldn't load outfits (${esc(e.message)}).</div>`; }
}

async function outfitDetails(id) {
  let d = null;
  for (const url of [`https://avatar.roblox.com/v3/outfits/${id}/details`, `https://avatar.roblox.com/v4/outfits/${id}/details`, `https://avatar.roblox.com/v1/outfits/${id}/details`]) {
    d = await host.get(url).catch(() => null);
    if (d) break;
  }
  if (!d) throw new Error("Couldn't read that outfit");
  const m = d.outfitModel || d;
  const colors = normColors(m.bodyColor3s || m.bodyColors);
  return {
    assets: [...wornFrom(m.assets).values()],
    colors: Object.keys(colors).length === 6 ? colors : null,
    scale: m.scale || m.scales || null,
    type: typeof m.playerAvatarType === "string" ? m.playerAvatarType : null,
  };
}

// Puts an outfit into the editor (live preview); Save avatar wears it for real.
async function loadOutfit(id, name) {
  setAvBusy(true);
  try {
    const o = await outfitDetails(id);
    av.wearing = new Map(o.assets.map((a) => [a.id, a]));
    if (o.colors) av.colors = o.colors;
    if (o.scale) for (const [k] of AV_SCALES) if (typeof o.scale[k] === "number") av.scales[k] = o.scale[k];
    if (o.type) av.type = o.type;
    toast(`Trying on “${name}” — press Save avatar to wear it`);
  } catch (e) { toast(e.message, true); } finally { setAvBusy(false); }
  avChanged();
}

function outfitBody(name) {
  return { name, bodyColor3s: colorsFor(true), assets: wearAssets(), scale: { ...av.saved.scales, ...av.scales }, playerAvatarType: av.type };
}

async function writeOutfit(id, name) {
  const base = outfitBody(name);
  const send = (b) => id ? host.patch(`https://avatar.roblox.com/v3/outfits/${id}`, b) : host.post("https://avatar.roblox.com/v3/outfits/create", b);
  let lastErr;
  for (const b of [{ ...base, outfitType: "Avatar" }, { ...base, outfitType: 1 }, base]) {
    try { return await send(b); } catch (e) { lastErr = e; }
  }
  // Newest API as a last resort.
  try {
    const def = { outfitDefinition: { updateOutfitModel: { ...base, bodyColors: base.bodyColor3s, outfitType: "Avatar" } } };
    return id ? await host.patch(`https://avatar.roblox.com/v4/outfits/${id}`, { updateTypes: [0, 1, 2, 3, 4], ...def })
              : await host.post("https://avatar.roblox.com/v4/outfits/create", def);
  } catch { throw lastErr; }
}

async function saveAsOutfit() {
  const name = await avDialog({ title: "Save as outfit", text: "Saves what's in the preview as an outfit on your Roblox account.", value: "My outfit", ok: "Save outfit" });
  if (!name) return;
  setAvBusy(true);
  try {
    await writeOutfit(null, name.trim().slice(0, 50));
    toast(`Saved outfit “${name}” to Roblox`);
    if (av.cat === "outfits") await showOutfits(true);
  } catch (e) { toast(`Couldn't save the outfit: ${e.message}`, true); } finally { setAvBusy(false); }
}
$("#avSaveOutfit").onclick = saveAsOutfit;

async function outfitTool(action, id, name) {
  try {
    if (action === "update") {
      if (!await avDialog({ title: `Update “${name}”?`, text: "Replaces this outfit with what's in the preview right now.", input: false, ok: "Update" })) return;
      setAvBusy(true);
      await writeOutfit(id, name);
      toast(`Updated “${name}”`);
    } else if (action === "rename") {
      const n = await avDialog({ title: "Rename outfit", value: name, ok: "Rename" });
      if (!n || n === name) return;
      setAvBusy(true);
      try { await host.patch(`https://avatar.roblox.com/v2/outfits/${id}`, { name: n.trim().slice(0, 50) }); }
      catch {
        // Older API needs the whole outfit; keep its contents, only change the name.
        const o = await outfitDetails(id);
        await host.patch(`https://avatar.roblox.com/v3/outfits/${id}`, { name: n.trim().slice(0, 50), assets: o.assets.map((a) => (a.meta ? { id: a.id, meta: a.meta } : { id: a.id })), bodyColor3s: o.colors ? Object.fromEntries(Object.entries(o.colors).map(([k, v]) => [k, "#" + v])) : colorsFor(true), scale: o.scale || av.scales, playerAvatarType: o.type || av.type });
      }
      toast("Outfit renamed");
    } else if (action === "delete") {
      if (!await avDialog({ title: `Delete “${name}”?`, text: "This removes the outfit from your Roblox account. It can't be undone.", input: false, ok: "Delete" })) return;
      setAvBusy(true);
      await host.post(`https://avatar.roblox.com/v1/outfits/${id}/delete`, {});
      toast("Outfit deleted");
    }
    if (av.cat === "outfits") await showOutfits(true);
  } catch (e) { toast(e.message, true); } finally { setAvBusy(false); }
}

// Small in-window dialog (text input or yes/no). Resolves to the text, true, or null.
function avDialog({ title, text = "", value = "", input = true, ok = "OK" }) {
  return new Promise((resolve) => {
    const m = $("#avDialog"), inp = $("#avDlgInput");
    $("#avDlgTitle").textContent = title;
    $("#avDlgText").textContent = text;
    $("#avDlgText").hidden = !text;
    $("#avDlgOk").textContent = ok;
    inp.hidden = !input; inp.value = value;
    m.hidden = false;
    if (input) setTimeout(() => { inp.focus(); inp.select(); }, 30);
    const done = (v) => { m.hidden = true; $("#avDlgOk").onclick = $("#avDlgCancel").onclick = inp.onkeydown = m.onclick = null; resolve(v); };
    $("#avDlgOk").onclick = () => done(input ? (inp.value.trim() || null) : true);
    $("#avDlgCancel").onclick = () => done(null);
    m.onclick = (e) => { if (e.target === m) done(null); };
    inp.onkeydown = (e) => { if (e.key === "Enter") $("#avDlgOk").click(); if (e.key === "Escape") done(null); };
  });
}
$("#resetAll").onclick = () => {
  if (!confirm("Reset recent games, favorites, friends and settings?")) return;
  localStorage.removeItem(store.key); location.reload();
};

function updateCounters() {
  $("#favCount").textContent = S.favorites.length;
  $("#recentCount").textContent = `${S.recent.filter((r) => !r.seed).length} recent`;
}

/* =========================================================
   Profile viewer
   ========================================================= */
const profile = { id: 0, token: 0 };

$("#profileForm").addEventListener("submit", async (e) => {
  e.preventDefault();
  const q = $("#profileInput").value.trim();
  if (!q) return;
  try {
    let id = /^\d+$/.test(q) ? Number(q) : 0;
    if (!id) { const u = await api.userByName(q.replace(/^@/, "")); if (!u) return toast("No Roblox user with that name.", true); id = u.id; }
    openProfile(id);
  } catch (err) { toast(err.message, true); }
});

function renderProfileHome() {
  const recent = (S.profileHistory || []);
  const mine = accounts.list.length ? accounts.list : S.user ? [S.user] : [];
  const chip = (u) => `<button class="pf-chip" data-profile="${u.id}"><img src="${esc(cache.heads.get(u.id) || PLACEHOLDER)}" alt=""/><span>${esc(u.displayName)}<br><span class="muted">@${esc(u.name)}</span></span></button>`;
  $("#profileView").innerHTML = `
    ${mine.length ? `<div class="pf-section"><h3>Your accounts</h3><div class="pf-recent">${mine.map(chip).join("")}</div></div>` : ""}
    ${recent.length ? `<div class="pf-section" style="margin-top:18px"><h3>Recently viewed</h3><div class="pf-recent">${recent.map(chip).join("")}</div></div>` : ""}
    ${!mine.length && !recent.length ? `<div class="empty">Search for a username to view their profile, avatar, groups, favorites and more.</div>` : ""}`;
  api.headshots([...mine, ...recent].map((u) => u.id)).then(() => {
    if (currentPage === "profile" && !profile.id) $$("#profileView [data-profile] img").forEach((img) => { const id = Number(img.closest("[data-profile]").dataset.profile); img.src = cache.heads.get(id) || PLACEHOLDER; });
  });
}

document.addEventListener("click", (e) => {
  const b = e.target.closest("[data-profile]");
  if (b) openProfile(Number(b.dataset.profile));
});

async function openProfile(id) {
  profile.id = id;
  if (currentPage !== "profile") go("profile");
  const token = ++profile.token;
  const view = $("#profileView");
  view.innerHTML = `<div class="profile"><div class="pf-head"><div class="pf-avatar"></div><div class="pf-main"><h1 class="muted">Loading…</h1></div></div></div>`;
  const get = (url) => host.get(url).catch(() => null);
  const [user, friends, followers, following, avatar, pres, rbadges, groups, history] = await Promise.all([
    get(`https://users.roblox.com/v1/users/${id}`),
    get(`https://friends.roblox.com/v1/users/${id}/friends/count`),
    get(`https://friends.roblox.com/v1/users/${id}/followers/count`),
    get(`https://friends.roblox.com/v1/users/${id}/followings/count`),
    get(`https://thumbnails.roblox.com/v1/users/avatar?userIds=${id}&size=420x420&format=Png`),
    api.presence([id]).catch(() => []),
    get(`https://accountinformation.roblox.com/v1/users/${id}/roblox-badges`),
    get(`https://groups.roblox.com/v2/users/${id}/groups/roles`),
    get(`https://users.roblox.com/v1/users/${id}/username-history?limit=10&sortOrder=Desc`),
  ]);
  if (token !== profile.token) return;
  if (!user) { view.innerHTML = `<div class="empty">Couldn't find that user.</div>`; return; }

  S.profileHistory = [{ id: user.id, name: user.name, displayName: user.displayName }, ...(S.profileHistory || []).filter((x) => x.id !== user.id)].slice(0, 12);
  store.save();

  const p = (pres && pres[0]) || {};
  const ptype = p.userPresenceType || 0;
  const status = ptype === 2 && p.lastLocation ? `Playing ${p.lastLocation}` : PRESENCE[ptype] || "Offline";
  const created = new Date(user.created);
  const ageDays = Math.floor((Date.now() - created) / 86400000);
  const age = ageDays > 365 ? `${(ageDays / 365).toFixed(1)} years` : `${ageDays} days`;
  const isMine = accounts.list.some((a) => a.id === id);
  const canJoin = ptype === 2 && p.universeId;
  const avatarUrl = avatar && avatar.data && avatar.data[0] && avatar.data[0].imageUrl;
  const groupList = (groups && groups.data) || [];
  const names = ((history && history.data) || []).map((h) => h.name);

  view.innerHTML = `<div class="profile">
    <div class="pf-head">
      <div class="pf-avatar"><img src="${esc(avatarUrl) || PLACEHOLDER}" alt=""/></div>
      <div class="pf-main">
        <h1>${esc(user.displayName)}${user.hasVerifiedBadge ? `<svg class="verified" viewBox="0 0 24 24"><use href="#i-check"/></svg>` : ""}</h1>
        <div class="muted">@${esc(user.name)} · ID ${user.id}${user.isBanned ? " · <b style='color:#fca5a5'>Banned</b>" : ""}</div>
        <div class="pf-status"><i class="${PCLASS[ptype] || ""}"></i>${esc(status)}</div>
        <div class="pf-counts">
          <div><b>${friends ? fmt(friends.count) : "–"}</b><span>Friends</span></div>
          <div><b>${followers ? fmt(followers.count) : "–"}</b><span>Followers</span></div>
          <div><b>${following ? fmt(following.count) : "–"}</b><span>Following</span></div>
          <div><b>${age}</b><span>Joined ${created.toLocaleDateString(undefined, { dateStyle: "medium" })}</span></div>
          <div class="pf-rap" title="Recent average price of all their limiteds"><b id="pfRap">…</b><span>RAP</span></div>
        </div>
        <p class="pf-bio">${esc(user.description || "")}</p>
        <div class="pf-actions">
          ${canJoin ? `<button class="btn play" id="pfJoin"><svg viewBox="0 0 24 24"><use href="#i-play"/></svg>Join game</button>` : ""}
          ${isMine && id !== accounts.activeId ? `<button class="btn primary" data-acct-switch="${id}"><svg viewBox="0 0 24 24"><use href="#i-swap"/></svg>Switch to this account</button>` : ""}
          ${!isMine && !S.friends.includes(id) && !robloxFriendIds.includes(id) ? `<button class="btn ghost" id="pfAdd"><svg viewBox="0 0 24 24"><use href="#i-user-plus"/></svg>Add to my friends list</button>` : ""}
          ${signedIn() && id !== S.user.id ? `<button class="btn ghost" id="pfTrade"><svg viewBox="0 0 24 24"><use href="#i-swap"/></svg>Trade</button>` : ""}
          <button class="btn ghost" id="pfWeb"><svg viewBox="0 0 24 24"><use href="#i-external"/></svg>Open on Roblox</button>
        </div>
      </div>
    </div>
    <div class="pf-section" id="pfWearSec" hidden><h3>Currently wearing <span class="muted" id="pfWearCount"></span></h3><div class="grid market-grid pf-wear" id="pfWear"></div></div>
    <div class="pf-section" id="pfLimSec" hidden><h3>Limiteds <span class="muted" id="pfLimCount"></span></h3><div class="trade-items pf-lims" id="pfLims"></div></div>
    ${names.length ? `<div class="pf-section"><h3>Past usernames</h3><div class="pf-chips">${names.map((n) => `<span class="pf-chip" style="padding-left:10px">${esc(n)}</span>`).join("")}</div></div>` : ""}
    ${rbadges && rbadges.length ? `<div class="pf-section"><h3>Roblox badges</h3><div class="pf-chips">${rbadges.map((b) => `<span class="pf-chip" title="${esc(b.description)}"><img src="${esc(b.imageUrl)}" alt=""/>${esc(b.name)}</span>`).join("")}</div></div>` : ""}
    <div class="pf-section" id="pfFavSec" hidden><h3>Favorite games</h3><div class="card-row" id="pfFavs"></div></div>
    <div class="pf-section" id="pfGamesSec" hidden><h3>Created games</h3><div class="card-row" id="pfGames"></div></div>
    ${groupList.length ? `<div class="pf-section"><h3>Groups <span class="muted">(${groupList.length})</span></h3><div class="pf-groups" id="pfGroups">${groupList.slice(0, 24).map((g) => `
      <div class="pf-group" data-group="${g.group.id}"><img data-gicon="${g.group.id}" src="${PLACEHOLDER}" alt=""/>
        <div class="fi"><div class="fn">${esc(g.group.name)}</div><div class="fs">${esc(g.role.name)} · ${fmt(g.group.memberCount)} members</div></div></div>`).join("")}</div></div>` : ""}
    <div class="pf-section" id="pfBadgeSec" hidden><h3>Recent badges</h3><div class="pf-chips" id="pfBadges"></div></div>
    <div class="pf-section" id="pfFriendSec" hidden><h3>Friends</h3><div class="pf-friends" id="pfFriends"></div></div>
  </div>`;

  if (canJoin) $("#pfJoin").onclick = () => play(p.universeId, p.gameId);
  if ($("#pfAdd")) $("#pfAdd").onclick = () => { S.friends.push(id); store.save(); refreshFriends(); $("#pfAdd").remove(); toast(`Added ${user.displayName}`); };
  $("#pfWeb").onclick = () => host.open(`https://www.roblox.com/users/${id}/profile`);
  if ($("#pfTrade")) $("#pfTrade").onclick = () => { go("trade"); openCompose({ id: user.id, name: user.name, displayName: user.displayName }); };
  loadProfileWearing(id, token);
  loadProfileRap(id, token);
  $$("#pfGroups [data-group]").forEach((el) => (el.onclick = () => host.open(`https://www.roblox.com/communities/${el.dataset.group}`)));

  // Slower / optional sections load after the header is up.
  const groupIds = groupList.slice(0, 24).map((g) => g.group.id);
  if (groupIds.length) get(`https://thumbnails.roblox.com/v1/groups/icons?groupIds=${groupIds.join(",")}&size=150x150&format=Png`).then((r) => {
    if (token !== profile.token || !r) return;
    for (const t of r.data || []) { const img = $(`[data-gicon="${t.targetId}"]`); if (img && t.imageUrl) img.src = t.imageUrl; }
  });
  get(`https://games.roblox.com/v2/users/${id}/favorite/games?limit=25&sortOrder=Desc`).then((r) => {
    const ids = ((r && r.data) || []).map((g) => g.id);
    if (token !== profile.token || !ids.length) return;
    $("#pfFavSec").hidden = false; renderCards($("#pfFavs"), ids, "");
  });
  get(`https://games.roblox.com/v2/users/${id}/games?limit=25&sortOrder=Desc&accessFilter=Public`).then((r) => {
    const ids = ((r && r.data) || []).map((g) => g.id);
    if (token !== profile.token || !ids.length) return;
    $("#pfGamesSec").hidden = false; renderCards($("#pfGames"), ids, "");
  });
  get(`https://badges.roblox.com/v1/users/${id}/badges?limit=10&sortOrder=Desc`).then(async (r) => {
    const list = (r && r.data) || [];
    if (token !== profile.token || !list.length) return;
    const th = await get(`https://thumbnails.roblox.com/v1/badges/icons?badgeIds=${list.map((b) => b.id).join(",")}&size=150x150&format=Png`);
    const tm = new Map(((th && th.data) || []).map((t) => [t.targetId, t.imageUrl]));
    if (token !== profile.token) return;
    $("#pfBadgeSec").hidden = false;
    $("#pfBadges").innerHTML = list.map((b) => `<span class="pf-chip" title="${esc(b.description || "")}"><img src="${esc(tm.get(b.id) || PLACEHOLDER)}" alt=""/>${esc(b.displayName || b.name)}</span>`).join("");
  });
  get(`https://friends.roblox.com/v1/users/${id}/friends`).then(async (r) => {
    const ids = ((r && r.data) || []).map((f) => f.id).slice(0, 30);
    if (token !== profile.token || !ids.length) return;
    const [users] = await Promise.all([api.users(ids).catch(() => []), api.headshots(ids)]);
    if (token !== profile.token) return;
    $("#pfFriendSec").hidden = false;
    $("#pfFriends").innerHTML = users.map((u) => `<div class="pf-friend" data-profile="${u.id}" title="@${esc(u.name)}"><img src="${esc(cache.heads.get(u.id) || PLACEHOLDER)}" alt=""/><div>${esc(u.displayName)}</div></div>`).join("");
  });
}

/** "Currently wearing" on a profile: the same item cards as the Market, opening the same item pop-up. */
async function loadProfileWearing(id, token) {
  const av = await host.get(`https://avatar.roblox.com/v1/users/${id}/avatar`).catch(() => null);
  const assets = (av && av.assets) || [];
  if (token !== profile.token || !assets.length) return;
  const [det, th] = await Promise.all([
    host.post("https://catalog.roblox.com/v1/catalog/items/details", { items: assets.map((a) => ({ itemType: "Asset", id: a.id })) }).catch(() => null),
    host.get(`https://thumbnails.roblox.com/v1/assets?assetIds=${assets.map((a) => a.id).join(",")}&size=150x150&format=Png&returnPolicy=PlaceHolder`).catch(() => null),
  ]);
  if (token !== profile.token) return;
  const dmap = new Map(((det && det.data) || []).map((d) => [d.id, d]));
  const tmap = new Map(((th && th.data) || []).map((t) => [t.targetId, t.imageUrl]));
  const pretty = (s) => String(s || "Item").replace(/([a-z])([A-Z])/g, "$1 $2");
  const items = assets.map((a) => {
    const d = Object.assign({ id: a.id, itemType: "Asset", name: a.name, creatorName: "Roblox" }, dmap.get(a.id) || {});
    d.itemType = "Asset";
    if (!d.taxonomy || !d.taxonomy.length) d.taxonomy = [{ taxonomyName: pretty(a.assetType && a.assetType.name) }];
    market.items.set("Asset" + d.id, d);
    return d;
  });
  $("#pfWearSec").hidden = false;
  $("#pfWearCount").textContent = `(${items.length})`;
  $("#pfWear").innerHTML = items.map((i) => itemHTML(i, tmap.get(i.id))).join("");
  $("#pfWear").onclick = (e) => { const el = e.target.closest("[data-iid]"); if (el) openItem(el.dataset.item, Number(el.dataset.iid)); };
}

/** RAP total in the profile header, plus their most valuable limiteds. */
async function loadProfileRap(id, token) {
  try {
    const list = await collectibles(id, () => token === profile.token);
    if (token !== profile.token) return;
    const total = rapOf(list);
    $("#pfRap").textContent = fmt(total);
    $("#pfRap").title = `${total.toLocaleString()} Robux · ${list.length} limited${list.length === 1 ? "" : "s"}`;
    if (!list.length) return;
    const top = [...list].sort((a, b) => (b.recentAveragePrice || 0) - (a.recentAveragePrice || 0)).slice(0, 12);
    await itemThumbs(top.map((i) => i.itemTarget));
    if (token !== profile.token) return;
    $("#pfLimSec").hidden = false;
    $("#pfLimCount").textContent = list.length > top.length ? `(top ${top.length} of ${list.length})` : `(${list.length})`;
    $("#pfLims").innerHTML = top.map((i) => tradeItemHTML(i)).join("");
  } catch (e) {
    if (token !== profile.token) return;
    $("#pfRap").textContent = "Private";
    $("#pfRap").title = "Their inventory is private, so their RAP can't be counted.";
  }
}

/* =========================================================
   Trading (limiteds) + RAP
   ========================================================= */
const trade = { tab: "Inbound", cursor: null, busy: false, token: 0, vtoken: 0, cur: null, c: null };
const TRADE_STATUS = {
  Open: "Open", Pending: "Pending", Completed: "Completed", Expired: "Expired", Declined: "Declined", Countered: "Countered",
  RejectedDueToError: "Failed", Processing: "Processing", InterventionRequired: "Under review", TwoStepVerificationRequired: "Needs 2-step verification",
};
const CANT_TRADE = {
  CallingUserIneligible: "Your account can't trade right now (Roblox needs Premium and trading enabled).",
  TargetUserIneligible: "This player can't trade right now (they may not have Premium).",
  CannotTradeWithSelf: "You can't trade with yourself.",
  CallingUserPrivacySettingsRestricted: "Your Roblox privacy settings don't allow trading with this player.",
  CallingUserAgeCheckRequired: "Roblox needs you to verify your age before trading.",
};
const MAX_TRADE_ITEMS = 4;
const rbx = (n) => `<span class="rbx">${ROBUX_SVG}${Number(n || 0).toLocaleString()}</span>`;
const itemThumbCache = new Map();
const thumbKey = (t) => (t && t.itemType === "Bundle" ? "Bundle" : "Asset") + (t ? t.targetId : "");
const thumbOf = (t) => itemThumbCache.get(thumbKey(t)) || PLACEHOLDER;

async function itemThumbs(targets) {
  const todo = targets.filter((t) => t && !itemThumbCache.has(thumbKey(t)));
  const assets = uniq(todo.filter((t) => t.itemType !== "Bundle").map((t) => t.targetId));
  const bundles = uniq(todo.filter((t) => t.itemType === "Bundle").map((t) => t.targetId));
  const put = (prefix) => (r) => { for (const t of (r && r.data) || []) itemThumbCache.set(prefix + t.targetId, t.imageUrl); };
  await Promise.all([
    ...chunk(assets, 100).map((p) => host.get(`https://thumbnails.roblox.com/v1/assets?assetIds=${p.join(",")}&size=150x150&format=Png&returnPolicy=PlaceHolder`).then(put("Asset")).catch(() => {})),
    ...chunk(bundles, 50).map((p) => host.get(`https://thumbnails.roblox.com/v1/bundles/thumbnails?bundleIds=${p.join(",")}&size=150x150&format=Png`).then(put("Bundle")).catch(() => {})),
  ]);
}

function tradeItemHTML(i, attrs = "", cls = "") {
  return `<div class="t-item ${cls}" ${attrs} title="${esc(i.itemName)}${i.serialNumber ? ` · #${i.serialNumber}` : ""}">
    <div class="t-thumb"><img src="${esc(thumbOf(i.itemTarget))}" alt=""/>${i.serialNumber ? `<span class="t-serial">#${i.serialNumber}</span>` : ""}${i.isOnHold ? `<span class="t-hold">On hold</span>` : ""}</div>
    <div class="t-name">${esc(i.itemName)}</div>
    <div class="t-rap">${rbx(i.recentAveragePrice)}</div>
  </div>`;
}
const rapOf = (items) => items.reduce((s, i) => s + (i.recentAveragePrice || 0), 0);
function totalHTML(items, robux) {
  return `<span>RAP ${rbx(rapOf(items))}</span>${robux ? `<span>+ ${rbx(robux)} Robux</span>` : ""}`;
}

/** Every collectible a user owns (needs their inventory to be public). */
async function collectibles(uid, alive = () => true) {
  const out = [];
  let cursor = "";
  for (let i = 0; i < 25 && alive(); i++) {
    const p = new URLSearchParams({ limit: "100", sortOrder: "Desc" });
    if (cursor) p.set("cursor", cursor);
    const r = await host.get(`https://inventory.roblox.com/v1/users/${uid}/assets/collectibles?${p}`);
    out.push(...((r && r.data) || []));
    cursor = r && r.nextPageCursor;
    if (!cursor) break;
  }
  return out.map((c) => ({ ...c, itemName: c.name, itemTarget: { itemType: "Asset", targetId: String(c.assetId) } }));
}

function renderTrade() {
  const ok = signedIn();
  $("#tradeSignin").hidden = ok;
  $("#tradeBody").hidden = !ok;
  $("#tradeNew").hidden = !ok;
  if (!ok) return;
  loadTrades(true);
  refreshTradeCount();
  const token = trade.token;
  collectibles(S.user.id).then((list) => {
    if (token !== trade.token) return;
    $("#tradeMyRap").hidden = false;
    $("#tradeMyRap").innerHTML = `<span class="muted small">Your RAP</span>${rbx(rapOf(list))}<span class="muted small">${list.length} limited${list.length === 1 ? "" : "s"}</span>`;
  }).catch(() => {});
}

async function refreshTradeCount() {
  if (!signedIn()) return;
  const r = await host.get("https://trades.roblox.com/v1/trades/Inbound/count").catch(() => null);
  const n = (r && r.count) || 0;
  $("#ttInbound").hidden = !n;
  $("#ttInbound").textContent = n;
  const dot = $("#tradeDot");
  if (dot) dot.classList.toggle("on", n > 0);
}

$("#tradeTabs").addEventListener("click", (e) => {
  const b = e.target.closest("[data-tt]");
  if (!b || b.dataset.tt === trade.tab) return;
  trade.tab = b.dataset.tt;
  $$("#tradeTabs [data-tt]").forEach((x) => x.classList.toggle("on", x === b));
  loadTrades(true);
});
$("#tradeMore").onclick = () => loadTrades(false);

async function loadTrades(reset) {
  if (!signedIn()) return;
  const token = reset ? ++trade.token : trade.token;
  if (!reset && trade.busy) return;
  trade.busy = true;
  const list = $("#tradeList");
  if (reset) { trade.cursor = null; list.innerHTML = `<div class="trade-row skeleton"></div>`.repeat(4); }
  try {
    const p = new URLSearchParams({ limit: "25", sortOrder: "Desc" });
    if (!reset && trade.cursor) p.set("cursor", trade.cursor);
    const r = await host.get(`https://trades.roblox.com/v1/trades/${trade.tab}?${p}`);
    if (token !== trade.token) return;
    const rows = (r && r.data) || [];
    trade.cursor = r && r.nextPageCursor;
    await api.headshots(rows.map((t) => t.user && t.user.id));
    if (token !== trade.token) return;
    const html = rows.map(tradeRowHTML).join("");
    const empty = { Inbound: "No trade offers waiting for you.", Outbound: "You haven't sent any open trades.", Completed: "No completed trades yet.", Inactive: "No declined or expired trades." }[trade.tab];
    if (reset) list.innerHTML = html || `<div class="empty">${empty}</div>`;
    else list.insertAdjacentHTML("beforeend", html);
    $("#tradeMore").hidden = !trade.cursor;
  } catch (e) {
    if (reset && token === trade.token) list.innerHTML = `<div class="empty">Couldn't load trades (${esc(e.message)}).</div>`;
  } finally { if (token === trade.token) trade.busy = false; }
}

function tradeRowHTML(t) {
  const u = t.user || {};
  const status = TRADE_STATUS[t.status] || t.status || "";
  const when = new Date(t.created).toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" });
  const exp = t.isActive && t.expiration ? ` · expires ${new Date(t.expiration).toLocaleDateString(undefined, { dateStyle: "medium" })}` : "";
  return `<button class="trade-row" data-trade="${t.id}">
    <img src="${esc(cache.heads.get(u.id) || PLACEHOLDER)}" alt=""/>
    <div class="fi"><div class="fn">${esc(u.displayName)} <span class="muted">@${esc(u.name)}</span></div><div class="fs">${esc(when)}${exp}</div></div>
    <span class="t-status s-${esc(String(t.status).toLowerCase())}">${esc(status)}</span>
    <svg viewBox="0 0 24 24"><use href="#i-chev-right"/></svg>
  </button>`;
}
$("#tradeList").addEventListener("click", (e) => {
  const r = e.target.closest("[data-trade]");
  if (r) openTrade(r.dataset.trade);
});

/** Trade details, split into my side and theirs. */
async function tradeDetails(id) {
  const t = await host.get(`https://trades.roblox.com/v2/trades/${id}`);
  const a = t.participantAOffer || {}, b = t.participantBOffer || {};
  const mineIsA = a.user && a.user.id === S.user.id;
  return { id, status: t.status, mine: mineIsA ? a : b, theirs: mineIsA ? b : a };
}

async function openTrade(id) {
  const m = $("#tradeModal");
  const token = ++trade.vtoken;
  $("#tvTitle").textContent = "Loading trade…";
  $("#tvSub").textContent = "";
  $("#tvHead").src = PLACEHOLDER;
  $("#tvGive").innerHTML = $("#tvGet").innerHTML = $("#tvGiveTotal").innerHTML = $("#tvGetTotal").innerHTML = $("#tvActions").innerHTML = "";
  m.hidden = false;
  try {
    const t = await tradeDetails(id);
    const mine = t.mine.items || [], theirs = t.theirs.items || [];
    await Promise.all([itemThumbs([...mine, ...theirs].map((i) => i.itemTarget)), api.headshots([t.theirs.user.id])]);
    if (token !== trade.vtoken) return;
    trade.cur = t;
    const u = t.theirs.user;
    $("#tvHead").src = cache.heads.get(u.id) || PLACEHOLDER;
    $("#tvTitle").textContent = `Trade with ${u.displayName}`;
    $("#tvSub").textContent = `@${u.name} · ${TRADE_STATUS[t.status] || t.status}`;
    $("#tvGive").innerHTML = mine.map((i) => tradeItemHTML(i)).join("") || `<div class="muted small">Nothing</div>`;
    $("#tvGet").innerHTML = theirs.map((i) => tradeItemHTML(i)).join("") || `<div class="muted small">Nothing</div>`;
    $("#tvGiveTotal").innerHTML = totalHTML(mine, t.mine.robux);
    $("#tvGetTotal").innerHTML = totalHTML(theirs, t.theirs.robux);
    const diff = rapOf(theirs) - rapOf(mine);
    const open = t.status === "Open";
    $("#tvActions").innerHTML = `<span class="t-diff ${diff >= 0 ? "up" : "down"}">${diff >= 0 ? "+" : "−"}${Math.abs(diff).toLocaleString()} RAP for you</span>`
      + `<button class="btn ghost" data-tv="profile">View profile</button>`
      + (open && trade.tab === "Inbound" ? `<button class="btn danger" data-tv="decline">Decline</button><button class="btn ghost" data-tv="counter">Counter</button><button class="btn primary" data-tv="accept">Accept</button>` : "")
      + (open && trade.tab === "Outbound" ? `<button class="btn danger" data-tv="decline">Cancel trade</button>` : "");
  } catch (e) {
    if (token === trade.vtoken) { $("#tvTitle").textContent = "Couldn't load this trade"; $("#tvSub").textContent = e.message; }
  }
}
$("#tradeClose").onclick = () => ($("#tradeModal").hidden = true);
$("#tradeModal").addEventListener("click", (e) => { if (e.target.id === "tradeModal") e.target.hidden = true; });

function tradeError(e) {
  const msg = e.message || String(e);
  if (/challenge|verif|two.?step|2sv/i.test(msg)) {
    toast("Roblox wants you to confirm this with 2-step verification — finishing it on roblox.com.", true);
    host.open("https://www.roblox.com/trades");
  } else toast(`Roblox said: ${msg}`, true);
}

$("#tvActions").addEventListener("click", async (e) => {
  const b = e.target.closest("[data-tv]");
  const t = trade.cur;
  if (!b || !t) return;
  const who = t.theirs.user.displayName;
  switch (b.dataset.tv) {
    case "profile": $("#tradeModal").hidden = true; openProfile(t.theirs.user.id); break;
    case "counter": $("#tradeModal").hidden = true; openCompose(t.theirs.user, t); break;
    case "accept": {
      const ok = await avDialog({ title: `Accept trade with ${who}?`, text: `You give ${rapOf(t.mine.items || []).toLocaleString()} RAP${t.mine.robux ? ` + ${t.mine.robux.toLocaleString()} Robux` : ""} and get ${rapOf(t.theirs.items || []).toLocaleString()} RAP${t.theirs.robux ? ` + ${t.theirs.robux.toLocaleString()} Robux` : ""}. Trades can't be undone.`, input: false, ok: "Accept trade" });
      if (!ok) return;
      b.disabled = true;
      try { await host.post(`https://trades.roblox.com/v1/trades/${t.id}/accept`, {}); toast("Trade accepted! Roblox is processing it."); $("#tradeModal").hidden = true; loadTrades(true); refreshTradeCount(); }
      catch (err) { b.disabled = false; tradeError(err); }
      break;
    }
    case "decline": {
      const cancel = trade.tab === "Outbound";
      const ok = await avDialog({ title: cancel ? "Cancel this trade?" : `Decline ${who}'s trade?`, input: false, ok: cancel ? "Cancel trade" : "Decline" });
      if (!ok) return;
      b.disabled = true;
      try { await host.post(`https://trades.roblox.com/v1/trades/${t.id}/decline`, {}); toast(cancel ? "Trade cancelled." : "Trade declined."); $("#tradeModal").hidden = true; loadTrades(true); refreshTradeCount(); }
      catch (err) { b.disabled = false; tradeError(err); }
      break;
    }
  }
});

/* ---- New trade / counter ---- */
$("#tradeNew").onclick = () => openCompose(null);

function openCompose(partner, counterOf = null) {
  if (!signedIn()) { toast("Sign in first (Settings).", true); return go("settings"); }
  trade.c = { partner: null, counter: counterOf, give: new Map(), get: new Map(), mine: [], theirs: [], token: 0 };
  $("#tcTitle").textContent = counterOf ? "Counter offer" : "New trade";
  $("#tcSub").textContent = "Pick who you want to trade with.";
  $("#tcHead").src = PLACEHOLDER;
  $("#tcUserForm").hidden = !!partner;
  $("#tcUser").value = "";
  $("#tcGrid").hidden = $("#tcOffer").hidden = true;
  $("#tcGiveRobux").value = $("#tcGetRobux").value = "";
  $("#tcMineFilter").value = $("#tcTheirsFilter").value = "";
  $("#tcNote").textContent = "";
  $("#tcSend").textContent = counterOf ? "Send counter" : "Send trade";
  updateOffer();
  $("#tradeCompose").hidden = false;
  if (partner) setPartner(partner);
  else setTimeout(() => $("#tcUser").focus(), 30);
}

$("#tcUserForm").addEventListener("submit", async (e) => {
  e.preventDefault();
  const q = $("#tcUser").value.trim().replace(/^@/, "");
  if (!q) return;
  try {
    const u = /^\d+$/.test(q) ? (await api.users([Number(q)]))[0] : await api.userByName(q);
    if (!u) return toast("No Roblox user with that name.", true);
    setPartner(u);
  } catch (err) { toast(err.message, true); }
});

async function setPartner(u) {
  const c = trade.c;
  if (u.id === S.user.id) return toast("You can't trade with yourself.", true);
  const token = ++c.token;
  c.partner = u;
  c.give.clear(); c.get.clear();
  api.headshots([u.id]).then(() => { if (token === c.token) $("#tcHead").src = cache.heads.get(u.id) || PLACEHOLDER; });
  $("#tcTitle").textContent = `${c.counter ? "Counter" : "Trade"} with ${u.displayName}`;
  $("#tcSub").textContent = `@${u.name} · loading items…`;
  $("#tcTheirsTitle").textContent = `${u.displayName}'s items`;
  $("#tcGrid").hidden = $("#tcOffer").hidden = false;
  $("#tcMine").innerHTML = $("#tcTheirs").innerHTML = `<div class="t-item skeleton"></div>`.repeat(6);
  updateOffer();
  try {
    const [can, mine, theirs] = await Promise.all([
      host.get(`https://trades.roblox.com/v2/users/${u.id}/can-trade-with`).catch(() => null),
      tradableItems(S.user.id),
      tradableItems(u.id),
    ]);
    if (token !== c.token) return;
    c.mine = mine; c.theirs = theirs;
    await itemThumbs([...mine, ...theirs].map((i) => i.itemTarget));
    if (token !== c.token) return;
    $("#tcSub").textContent = `@${u.name} · pick up to ${MAX_TRADE_ITEMS} items on each side`;
    if (can && can.canTrade === false) {
      $("#tcSub").textContent = CANT_TRADE[can.mutualTradeEligibility] || "Roblox says you can't trade with this player right now.";
      $("#tcSub").classList.add("warn");
    } else $("#tcSub").classList.remove("warn");
    if (c.counter) { // start from the offer being countered
      for (const i of c.counter.mine.items || []) c.give.set(i.collectibleItemInstanceId, i);
      for (const i of c.counter.theirs.items || []) c.get.set(i.collectibleItemInstanceId, i);
      $("#tcGiveRobux").value = c.counter.mine.robux || "";
      $("#tcGetRobux").value = c.counter.theirs.robux || "";
    }
    renderInv();
  } catch (e) {
    if (token === c.token) { $("#tcMine").innerHTML = $("#tcTheirs").innerHTML = ""; $("#tcSub").textContent = `Couldn't load items: ${e.message}`; }
  }
}

/** Tradable limiteds, one entry per copy (each copy has its own serial and instance id). */
async function tradableItems(uid) {
  const out = [];
  let cursor = "";
  for (let i = 0; i < 20; i++) {
    const p = new URLSearchParams({ sortBy: "CreationTime", limit: "50" });
    if (cursor) p.set("cursor", cursor);
    const r = await host.get(`https://trades.roblox.com/v2/users/${uid}/tradableItems?${p}`);
    for (const it of (r && r.items) || [])
      for (const ins of it.instances || [])
        out.push({ ...ins, itemTarget: ins.itemTarget || it.itemTarget, itemName: ins.itemName || it.itemName, recentAveragePrice: ins.recentAveragePrice ?? it.recentAveragePrice });
    cursor = r && r.nextPageCursor;
    if (!cursor) break;
  }
  return out.sort((a, b) => (b.recentAveragePrice || 0) - (a.recentAveragePrice || 0));
}

function renderInv() {
  const c = trade.c;
  const draw = (el, list, sel, side, filter) => {
    const f = filter.trim().toLowerCase();
    const shown = list.filter((i) => !f || (i.itemName || "").toLowerCase().includes(f));
    el.innerHTML = shown.map((i) => tradeItemHTML(i, `data-side="${side}" data-inst="${esc(i.collectibleItemInstanceId)}"`,
      (sel.has(i.collectibleItemInstanceId) ? "sel " : "") + (i.isOnHold ? "held" : ""))).join("")
      || `<div class="muted small t-empty">${list.length ? "Nothing matches." : side === "give" ? "You don't have any tradable limiteds." : "They don't have any tradable limiteds (or their inventory is private)."}</div>`;
  };
  draw($("#tcMine"), c.mine, c.give, "give", $("#tcMineFilter").value);
  draw($("#tcTheirs"), c.theirs, c.get, "get", $("#tcTheirsFilter").value);
  updateOffer();
}
$("#tcMineFilter").oninput = $("#tcTheirsFilter").oninput = () => renderInv();

$("#tcGrid").addEventListener("click", (e) => {
  const el = e.target.closest("[data-inst]");
  if (!el) return;
  const c = trade.c;
  const side = el.dataset.side, id = el.dataset.inst;
  const map = side === "give" ? c.give : c.get;
  const item = (side === "give" ? c.mine : c.theirs).find((i) => i.collectibleItemInstanceId === id);
  if (!item) return;
  if (map.has(id)) map.delete(id);
  else if (item.isOnHold) return toast("That item is on hold and can't be traded yet.", true);
  else if (map.size >= MAX_TRADE_ITEMS) return toast(`Roblox allows up to ${MAX_TRADE_ITEMS} items on each side.`, true);
  else map.set(id, item);
  renderInv();
});
$("#tcOffer").addEventListener("click", (e) => { // click an item in the offer to take it out
  const el = e.target.closest("[data-inst]");
  if (!el) return;
  (el.dataset.side === "give" ? trade.c.give : trade.c.get).delete(el.dataset.inst);
  renderInv();
});
$("#tcGiveRobux").oninput = $("#tcGetRobux").oninput = () => updateOffer();

const robuxIn = (el) => Math.max(0, Math.floor(Number(el.value) || 0));

function updateOffer() {
  const c = trade.c;
  if (!c) return;
  const give = [...c.give.values()], get = [...c.get.values()];
  const gr = robuxIn($("#tcGiveRobux")), tr = robuxIn($("#tcGetRobux"));
  const slot = (list, side) => list.map((i) => tradeItemHTML(i, `data-side="${side}" data-inst="${esc(i.collectibleItemInstanceId)}"`, "in-offer")).join("")
    + `<div class="t-slot"></div>`.repeat(Math.max(0, MAX_TRADE_ITEMS - list.length));
  $("#tcGive").innerHTML = slot(give, "give");
  $("#tcGet").innerHTML = slot(get, "get");
  $("#tcGiveTotal").innerHTML = totalHTML(give, gr);
  $("#tcGetTotal").innerHTML = totalHTML(get, tr);
  const diff = rapOf(get) - rapOf(give);
  let note = give.length && get.length ? `${diff >= 0 ? "+" : "−"}${Math.abs(diff).toLocaleString()} RAP for you` : "Pick at least one item on each side.";
  if (gr || tr) note += " · Roblox keeps 30% of any Robux in a trade";
  $("#tcNote").textContent = note;
  $("#tcSend").disabled = !c.partner || !give.length || !get.length;
}

$("#tcSend").onclick = async () => {
  const c = trade.c;
  if (!c || !c.partner) return;
  const give = [...c.give.keys()], get = [...c.get.keys()];
  const gr = robuxIn($("#tcGiveRobux")), tr = robuxIn($("#tcGetRobux"));
  const ok = await avDialog({
    title: `${c.counter ? "Send counter offer" : "Send trade"} to ${c.partner.displayName}?`,
    text: `You give ${rapOf([...c.give.values()]).toLocaleString()} RAP${gr ? ` + ${gr.toLocaleString()} Robux` : ""} and ask for ${rapOf([...c.get.values()]).toLocaleString()} RAP${tr ? ` + ${tr.toLocaleString()} Robux` : ""}. They can accept it straight away.`,
    input: false, ok: "Send",
  });
  if (!ok) return;
  const body = {
    senderOffer: { userId: S.user.id, robux: gr, collectibleItemInstanceIds: give },
    recipientOffer: { userId: c.partner.id, robux: tr, collectibleItemInstanceIds: get },
  };
  $("#tcSend").disabled = true;
  try {
    await host.post(c.counter ? `https://trades.roblox.com/v2/trades/${c.counter.id}/counter` : "https://trades.roblox.com/v2/trades/send", body);
    toast(c.counter ? "Counter offer sent!" : "Trade sent!");
    $("#tradeCompose").hidden = true;
    if (currentPage !== "trade") go("trade");
    trade.tab = "Outbound";
    $$("#tradeTabs [data-tt]").forEach((x) => x.classList.toggle("on", x.dataset.tt === "Outbound"));
    loadTrades(true);
    refreshTradeCount();
  } catch (e) { $("#tcSend").disabled = false; tradeError(e); }
};
$("#tcClose").onclick = $("#tcCancel").onclick = () => ($("#tradeCompose").hidden = true);

/* =========================================================
   Starfield
   ========================================================= */
(function stars() {
  const c = $("#stars"), ctx = c.getContext("2d");
  let w, h, pts = [];
  function resize() {
    const r = c.getBoundingClientRect(), d = devicePixelRatio || 1;
    w = r.width; h = r.height; c.width = w * d; c.height = h * d; ctx.setTransform(d, 0, 0, d, 0, 0);
    pts = Array.from({ length: Math.round((w * h) / 2200) }, () => ({ x: Math.random() * w, y: Math.random() * h, z: Math.random() * 0.9 + 0.1, p: Math.random() * Math.PI * 2 }));
  }
  new ResizeObserver(resize).observe(c);
  let t = 0;
  (function frame() {
    if (w && (S.settings.stars || t === 0) && currentPage === "launchpad") {
      ctx.clearRect(0, 0, w, h);
      for (const s of pts) {
        if (S.settings.stars) { s.x -= s.z * 0.25; if (s.x < 0) s.x += w; }
        const a = 0.35 + 0.65 * Math.abs(Math.sin(s.p + t * 0.02 * s.z));
        ctx.fillStyle = `rgba(255,255,255,${a * s.z})`;
        ctx.fillRect(s.x, s.y, s.z * 1.8, s.z * 1.8);
      }
      t++;
    }
    requestAnimationFrame(frame);
  })();
})();

/* =========================================================
   Updates (GitHub Releases)
   ========================================================= */
// When a new release is out, RoLauncher asks: "Update now" or "Later".
// It never interrupts a game: the question waits until you've finished playing.
// "Later" means "ask me again next time RoLauncher starts".
const upd = { info: null, release: null, busy: false, pending: false, declined: false };
const UPD_RECHECK = 6 * 3600 * 1000; // look again every 6 hours while the launcher stays open
const gameRunning = () => sessions.size > 0 || !!launching;

async function loadAppInfo() {
  if (!host.available) { $("#updVersion").textContent = "Version info is only available in the app."; return; }
  upd.info = await host.appInfo().catch(() => null);
  if (!upd.info) return;
  $("#updVersion").textContent = `You're on version ${upd.info.version}` + (upd.info.installed ? "." : " (not the installed copy — updating installs the new version for this PC).");
}

async function checkForUpdate(manual) {
  if (!host.available || upd.busy) return;
  const st = $("#updStatus");
  if (manual) st.textContent = "Checking…";
  try {
    const r = await host.checkUpdate();
    upd.release = r;
    if (!r.latest) { if (manual) st.textContent = "No releases published yet."; return; }
    if (!r.available) { if (manual) st.textContent = `You're up to date (${r.current}).`; return; }
    st.textContent = `Version ${r.latest} is available.`;
    if (manual) { upd.declined = false; return showUpdate(r); }
    askToUpdate(r);
  } catch (e) {
    if (manual) st.textContent = `Couldn't check: ${e.message}`;
  }
}

function askToUpdate(r) {
  if (upd.busy || upd.declined || !$("#updModal").hidden) return;
  if (gameRunning()) {
    upd.pending = true;
    $("#updStatus").textContent = `Version ${r.latest} is available — you'll be asked when you finish playing.`;
    return;
  }
  upd.pending = false;
  showUpdate(r);
}

function showUpdate(r) {
  $("#updTitle").textContent = `RoLauncher ${r.latest} is here`;
  const mb = r.size ? ` · ${(r.size / 1048576).toFixed(0)} MB download` : "";
  const when = r.published ? ` · released ${new Date(r.published).toLocaleDateString()}` : "";
  $("#updSub").textContent = `You have ${r.current}${when}${mb}. Update now?`;
  $("#updNotes").textContent = (r.notes || "").replace(/\r/g, "").trim();
  $("#updProgress").hidden = true;
  $("#updNow").disabled = $("#updLater").disabled = false;
  $("#updNow").textContent = "Update now";
  $("#updLater").textContent = "Later";
  $("#updModal").hidden = false;
}

// The last game closed: an update that was waiting can be offered now.
function resumePendingUpdate() {
  if (upd.pending && upd.release && upd.release.available) setTimeout(() => { if (!gameRunning()) askToUpdate(upd.release); }, 3000);
}

function onUpdateProgress(p) {
  $("#updProgress").hidden = false;
  $("#updBar").style.width = Math.round(p * 100) + "%";
  $("#updNow").textContent = p >= 1 ? "Restarting…" : `Downloading ${Math.round(p * 100)}%`;
}

$("#updNow").onclick = async () => {
  const r = upd.release;
  if (!r || !r.download || upd.busy) return;
  upd.busy = true;
  $("#updNow").disabled = $("#updLater").disabled = true;
  onUpdateProgress(0);
  try { await host.installUpdate(r.download); }
  catch (e) {
    upd.busy = false;
    $("#updNow").disabled = $("#updLater").disabled = false;
    $("#updNow").textContent = "Try again";
    toast(`Update failed: ${e.message}`, true);
  }
};
$("#updLater").onclick = () => {
  upd.declined = true; // don't ask again until RoLauncher starts next time
  $("#updModal").hidden = true;
  if (upd.release) $("#updStatus").textContent = `Version ${upd.release.latest} is available — press “Check for updates” to install it.`;
};
$("#updPage").onclick = (e) => { e.preventDefault(); if (upd.release && upd.release.page) host.open(upd.release.page); };
$("#updRepo").onclick = (e) => { e.preventDefault(); host.open(upd.info ? upd.info.repo : "https://github.com/rawified/RoLauncher"); };
$("#updCheck").onclick = () => checkForUpdate(true);
$("#setAutoUpdate").onchange = (e) => { S.settings.autoUpdate = e.target.checked; store.save(); };
setInterval(() => { if (S.settings.autoUpdate !== false) checkForUpdate(false); }, UPD_RECHECK);

/* =========================================================
   Boot
   ========================================================= */
(async function boot() {
  applyAccent();
  updateCounters();
  renderAccount();
  checkSession();
  restoreSessions();
  applyDiscordConfig();
  if (host.available) host.closeBehavior(S.settings.closeBehavior || "ask").catch(() => {});
  loadAppInfo();
  setTimeout(refreshTradeCount, 6000);
  setInterval(refreshTradeCount, 5 * 60 * 1000); // red dot on Trading when offers are waiting
  if (S.settings.autoUpdate !== false) setTimeout(() => checkForUpdate(false), 4000);
  if (S.settings.multi && host.available) host.multiInstance(true).then((r) => {
    if (!r || !r.enabled) { S.settings.multi = false; store.save(); toast("Multiple Roblox windows was turned off: close Roblox first, then turn it back on in Settings.", true); }
  }).catch(() => {});
  go("launchpad", { record: false });
  const start = location.hash.slice(1);
  if (TITLES[start] && start !== "launchpad") go(start);
  await seedRecent().catch(() => {});
  renderContinue();
  renderFavorites();
  loadSpotlight();
  refreshFriends();
  $("#exploreDot").classList.add("on");
  setInterval(refreshFriends, 30000);
})();
