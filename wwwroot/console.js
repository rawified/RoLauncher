"use strict";
/* =========================================================
   RoLauncher — Console interface
   Loaded after app.js on console.html. All data, accounts,
   launching and pages come from app.js; this file adds the
   console home screen, top tabs, keyboard control and dock.
   ========================================================= */
(() => {
  const ps = { list: [], sel: 0, bgFlip: 0, bgToken: 0, strips: false };

  // The console top bar is taller; tell the host so "play inside the launcher" lines up.
  if (window.chrome && window.chrome.webview) window.chrome.webview.postMessage({ id: 0, type: "layout", titleBar: 64 });

  /* ---------- Clock ---------- */
  const tickClock = () => { $("#psClock").textContent = new Date().toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" }); };
  tickClock();
  setInterval(tickClock, 15000);

  /* ---------- Tabs: follow app.js navigation ---------- */
  function syncTabs() {
    $$("#psTabs button").forEach((b) => b.classList.toggle("on", b.dataset.page === currentPage));
    document.body.classList.toggle("subpage", currentPage !== "launchpad");
    if (currentPage === "launchpad" && ps.list[ps.sel]) setBackground(ps.list[ps.sel].id);
  }
  const baseGo = go;
  go = function (page, opts) { baseGo(page, opts); syncTabs(); };
  syncTabs();

  // The classic launchpad rows are hidden here, so swap their renderers for the console home.
  renderContinue = () => refreshHome();
  renderFavorites = () => {};
  renderTrending = () => {};

  /* ---------- Background art (cross-fade between two layers) ---------- */
  async function setBackground(uid) {
    const token = ++ps.bgToken;
    const url = await api.banner(uid).catch(() => "");
    if (token !== ps.bgToken || !url) return;
    const layers = $$("#psBg > div");
    const next = layers[ps.bgFlip ^ 1];
    const img = new Image();
    img.onload = () => {
      if (token !== ps.bgToken) return;
      next.style.backgroundImage = `url("${url}")`;
      layers[ps.bgFlip].classList.remove("on");
      next.classList.add("on");
      ps.bgFlip ^= 1;
    };
    img.src = url;
  }

  /* ---------- Home: tiles ---------- */
  let homeToken = 0;
  async function refreshHome() {
    const token = ++homeToken;
    const keep = ps.list[ps.sel] && ps.list[ps.sel].id;
    const ids = uniq([...S.recent.map((r) => r.id), ...S.favorites]).slice(0, 20);
    let map;
    try { map = await api.games(ids); } catch { map = new Map(); }
    if (token !== homeToken) return; // a newer refresh is on its way
    ps.list = ids.map((id) => map.get(id)).filter(Boolean);
    const i = keep ? ps.list.findIndex((g) => g.id === keep) : -1;
    ps.sel = i >= 0 ? i : Math.min(ps.sel, Math.max(0, ps.list.length - 1));
    renderTiles();
  }

  const running = () => [...sessions.values()].filter((x) => x.started);

  function renderTiles() {
    const live = new Set(running().map((x) => x.g.id));
    $("#psTiles").innerHTML =
      `<button class="ps-tile special" data-goto="explore" title="Explore"><svg viewBox="0 0 24 24"><use href="#i-globe"/></svg></button>
       <button class="ps-tile special" data-goto="search" title="Search"><svg viewBox="0 0 24 24"><use href="#i-search"/></svg></button>
       <span class="ps-sep"></span>` +
      ps.list.map((g, i) => `<div class="ps-tile" data-i="${i}" title="${esc(g.name)}"><img src="${esc(g.icon) || PLACEHOLDER}" alt=""/>${live.has(g.id) ? `<span class="ps-badge" title="Running"></span>` : ""}</div>`).join("") +
      `<span class="ps-sep"></span>
       <button class="ps-tile special" data-goto="history" title="Library"><svg viewBox="0 0 24 24"><rect x="4" y="4" width="7" height="7" rx="1.5"/><rect x="13" y="4" width="7" height="7" rx="1.5"/><rect x="4" y="13" width="7" height="7" rx="1.5"/><rect x="13" y="13" width="7" height="7" rx="1.5"/></svg></button>`;
    if (!ps.list.length) {
      $("#psKicker").textContent = "Welcome";
      $("#psTitle").textContent = "Pick a game to get started";
      $("#psMeta").innerHTML = "";
      $("#psCards").innerHTML = "";
      return;
    }
    select(ps.sel, false);
  }

  function select(i, scroll = true) {
    if (!ps.list.length) return;
    ps.sel = Math.max(0, Math.min(ps.list.length - 1, i));
    $$("#psTiles .ps-tile[data-i]").forEach((t) => t.classList.toggle("sel", Number(t.dataset.i) === ps.sel));
    const old = $("#psTiles .ps-label");
    if (old) old.remove();
    const t = $(`#psTiles .ps-tile[data-i="${ps.sel}"]`);
    if (t) {
      t.insertAdjacentHTML("afterend", `<span class="ps-label">${esc(ps.list[ps.sel].name)}</span>`);
      if (scroll) t.scrollIntoView({ behavior: "smooth", inline: "center", block: "nearest" });
    }
    showSelected();
  }

  $("#psTiles").addEventListener("click", (e) => {
    const t = e.target.closest(".ps-tile[data-i]");
    if (!t) return;
    const i = Number(t.dataset.i);
    if (i === ps.sel) openGame(ps.list[i].id);
    else select(i);
  });
  $("#psTiles").addEventListener("dblclick", (e) => {
    const t = e.target.closest(".ps-tile[data-i]");
    if (t) playSelected();
  });

  /* ---------- Home: hero + cards ---------- */
  const ago = (t) => {
    const d = Math.floor((Date.now() - t) / 86400000);
    return d <= 0 ? "today" : d === 1 ? "yesterday" : `${d} days ago`;
  };

  function showSelected() {
    const g = ps.list[ps.sel];
    if (!g) return;
    const rec = S.recent.find((r) => r.id === g.id && !r.seed);
    const isFav = S.favorites.includes(g.id);
    const live = running().some((x) => x.g.id === g.id);
    $("#psKicker").textContent = live ? "● Playing now" : rec ? `Last played ${ago(rec.t)}` : isFav ? "Favorite" : "Recommended";
    $("#psTitle").textContent = g.name;
    const total = playTotal(g.id);
    $("#psMeta").innerHTML = [
      `<span><svg viewBox="0 0 24 24"><use href="#i-person"/></svg>${fmt(g.playing)} playing</span>`,
      g.rating != null ? `<span><svg viewBox="0 0 24 24"><use href="#i-thumb"/></svg>${g.rating}%</span>` : "",
      g.creator ? `<span>by ${esc(g.creator)}</span>` : "",
      total >= 60000 ? `<span><svg viewBox="0 0 24 24"><use href="#i-clock"/></svg>${fmtDur(total)} played</span>` : "",
    ].join("");
    $("#psFav").classList.toggle("on", isFav);
    const as = $("#psAs");
    as.hidden = accounts.list.length < 2;
    as.innerHTML = accounts.list.map((a) => `<option value="${a.id}" ${a.id === accounts.activeId ? "selected" : ""}>as ${esc(a.displayName)}</option>`).join("");
    renderInfoCards(g);
    if (currentPage === "launchpad") setBackground(g.id);
    queueRows(g);
  }

  function renderInfoCards(g) {
    // Playtime card with the last 7 days.
    const list = playSessions(g.id);
    const total = playTotal(g.id);
    const day0 = new Date(); day0.setHours(0, 0, 0, 0);
    const days = Array.from({ length: 7 }, (_, i) => {
      const ds = day0.getTime() - (6 - i) * 86400000, de = ds + 86400000;
      return list.reduce((t, x) => t + Math.max(0, Math.min(x.e, de) - Math.max(x.s, ds)), 0);
    });
    const max = Math.max(...days, 1);
    const last = list[list.length - 1];
    const playCard = `<div class="ps-card click" data-ps-info="playtime">
        <h4>Your playtime</h4>
        <div class="big">${total ? fmtDur(total) : "—"}</div>
        <div class="muted small">${list.length ? `${list.length} session${list.length > 1 ? "s" : ""} · last ${ago(last.e)}` : "Not played from RoLauncher yet"}</div>
        <div class="ps-week" title="Last 7 days">${days.map((ms) => `<i class="${ms ? "" : "zero"}" style="height:${ms ? Math.max(8, (ms / max) * 100) : 0}%"></i>`).join("")}</div>
      </div>`;

    // Friends in this game right now.
    const here = friendData.filter((f) => f.type === 2 && Number(f.universeId) === g.id);
    const friendsCard = `<div class="ps-card ${here.length ? "click" : ""}" data-ps-info="${here.length ? "friends" : ""}">
        <h4>Friends</h4>
        ${here.length
          ? `<div class="big">${here.length} playing</div><div class="ps-faces">${here.slice(0, 6).map((f) => `<img src="${esc(cache.heads.get(f.id) || PLACEHOLDER)}" title="${esc(f.displayName)}" alt=""/>`).join("")}</div>`
          : `<div class="big">${fmt(g.playing)}</div><div class="muted small">people playing now · none of your friends</div>`}
      </div>`;

    const aboutCard = `<div class="ps-card click" data-ps-info="about">
        <h4>About</h4>
        <p>${esc(g.description || "No description.")}</p>
      </div>`;

    $("#psCards").innerHTML = playCard + friendsCard + aboutCard;
  }

  $("#psCards").addEventListener("click", (e) => {
    const c = e.target.closest("[data-ps-info]");
    const g = ps.list[ps.sel];
    if (!c || !g || !c.dataset.psInfo) return;
    if (c.dataset.psInfo === "friends") return go("friends");
    openGame(g.id).then(() => { if (c.dataset.psInfo === "playtime") setModalTab("playtime"); });
  });

  function playSelected() {
    const g = ps.list[ps.sel];
    if (g) play(g.id, undefined, Number($("#psAs").value) || 0);
  }
  $("#psPlay").onclick = playSelected;
  $("#psMore").onclick = () => ps.list[ps.sel] && openGame(ps.list[ps.sel].id);
  $("#psFav").onclick = () => ps.list[ps.sel] && toggleFav(ps.list[ps.sel].id);

  /* ---------- News + Servers for the selected game ---------- */
  // Reloaded when the selection settles on a different game (not on every arrow press).
  const rows = { uid: 0, timer: 0, newsToken: 0, srvToken: 0, sortDesc: true, showFull: false };
  function queueRows(g, force = false) {
    if (!force && rows.uid === g.id) return;
    rows.uid = g.id;
    clearTimeout(rows.timer);
    rows.timer = setTimeout(() => { loadNews(g); loadServers(g); }, 350);
  }

  const daysFrom = (iso) => Math.round((new Date(iso) - Date.now()) / 86400000);
  const relDay = (iso) => {
    const d = daysFrom(iso);
    if (d === 0) return "today";
    if (d === 1) return "tomorrow";
    if (d === -1) return "yesterday";
    return d > 0 ? `in ${d} days` : `${-d} days ago`;
  };
  const when = (iso) => new Date(iso).toLocaleString([], { weekday: "short", month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" });

  // Roblox lists events oldest-first from `fromUtc`, so look at the last 2 weeks first
  // (live + upcoming), and only widen to ~4 months for quieter games.
  async function fetchEvents(uid) {
    const found = new Map();
    for (const days of [14, 120]) {
      const since = new Date(Date.now() - days * 86400000).toISOString();
      let cursor = "";
      for (let page = 0; page < 4; page++) {
        const r = await host.get(`https://apis.roblox.com/virtual-events/v1/universes/${uid}/virtual-events?limit=25&fromUtc=${encodeURIComponent(since)}${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ""}`).catch(() => null);
        for (const e of (r && r.data) || []) found.set(e.id, e);
        cursor = r && r.nextPageCursor;
        if (!cursor) break;
      }
      if (found.size >= 4) break;
    }
    return [...found.values()];
  }

  async function loadNews(g) {
    const token = ++rows.newsToken;
    const el = $("#psNews");
    el.innerHTML = Array.from({ length: 4 }, () => `<div class="ps-wide skel"></div>`).join("");
    $("#psNewsSub").textContent = "";
    const get = (u) => host.get(u).catch(() => null);
    const [evList, badges] = await Promise.all([
      fetchEvents(g.id),
      get(`https://badges.roblox.com/v1/universes/${g.id}/badges?limit=10&sortOrder=Desc`),
    ]);
    const ev = { data: evList };
    if (token !== rows.newsToken) return;

    const now = Date.now();
    const events = ((ev && ev.data) || [])
      .filter((e) => e.eventStatus !== "cancelled" && e.eventVisibility !== "private")
      .map((e) => {
        const start = new Date(e.eventTime.startUtc).getTime(), end = new Date(e.eventTime.endUtc).getTime();
        const state = now < start ? "upcoming" : now <= end ? "live" : "ended";
        return { kind: "event", e, start, end, state, media: e.thumbnails && e.thumbnails[0] && e.thumbnails[0].mediaId };
      })
      // live first, then upcoming (soonest first), then most recently ended
      .sort((a, b) => ({ live: 0, upcoming: 1, ended: 2 }[a.state] - { live: 0, upcoming: 1, ended: 2 }[b.state])
        || (a.state === "upcoming" ? a.start - b.start : b.start - a.start))
      .slice(0, 10);

    const items = [...events];
    if (g.updated) items.push({ kind: "update", t: g.updated });
    const newBadges = ((badges && badges.data) || [])
      .filter((b) => b.enabled && now - new Date(b.created).getTime() < 90 * 86400000)
      .slice(0, 4);
    for (const b of newBadges) items.push({ kind: "badge", b });

    if (!items.length) { el.innerHTML = `<div class="ps-empty">No news from this game's developers yet.</div>`; return; }
    const live = events.filter((x) => x.state === "live").length, soon = events.filter((x) => x.state === "upcoming").length;
    $("#psNewsSub").textContent = [live && `${live} live now`, soon && `${soon} coming up`].filter(Boolean).join(" · ");

    el.innerHTML = items.map((it, i) => {
      if (it.kind === "event") {
        const e = it.e;
        const chip = it.state === "live" ? `<span class="nchip live">LIVE · ends ${relDay(e.eventTime.endUtc)}</span>`
          : it.state === "upcoming" ? `<span class="nchip soon">UPCOMING · ${when(e.eventTime.startUtc)}</span>`
          : `<span class="nchip">ENDED · ${relDay(e.eventTime.endUtc)}</span>`;
        return `<div class="ps-wide news" tabindex="0" data-news="${i}" title="${esc(e.displayDescription || e.description || "")}">
          <img data-media="${it.media || ""}" alt=""/>${chip}
          <div class="cap">${esc(e.displayTitle || e.title)}<small>${esc((e.displayDescription || e.description || "").slice(0, 90))}</small></div></div>`;
      }
      if (it.kind === "update") {
        return `<div class="ps-wide news text" tabindex="0" data-news="${i}">
          <div class="ntext"><svg viewBox="0 0 24 24"><use href="#i-refresh"/></svg><b>Game updated</b><span>${relDay(it.t)} · ${new Date(it.t).toLocaleDateString([], { dateStyle: "medium" })}</span></div></div>`;
      }
      return `<div class="ps-wide news text" tabindex="0" data-news="${i}" title="${esc(it.b.displayDescription || it.b.description || "")}">
          <div class="ntext"><img data-badge="${it.b.id}" alt=""/><b>New badge: ${esc(it.b.displayName || it.b.name)}</b><span>Added ${relDay(it.b.created)} · ${fmt(it.b.statistics.awardedCount)} earned</span></div></div>`;
    }).join("");
    ps.news = items;

    // Images: event thumbnails are assets, badge icons have their own endpoint.
    const media = events.map((x) => x.media).filter(Boolean);
    if (media.length) get(`https://thumbnails.roblox.com/v1/assets?assetIds=${media.join(",")}&size=768x432&format=Png`).then((r) => {
      if (token !== rows.newsToken) return;
      for (const t of (r && r.data) || []) {
        if (t.imageUrl) newsImg.set(String(t.targetId), t.imageUrl);
        $$(`#psNews img[data-media="${t.targetId}"]`).forEach((img) => { if (t.imageUrl) img.src = t.imageUrl; });
      }
    });
    $$("#psNews img[data-media='']").forEach((img) => { img.src = cache.banners.get(g.id) || g.icon || PLACEHOLDER; });
    if (newBadges.length) get(`https://thumbnails.roblox.com/v1/badges/icons?badgeIds=${newBadges.map((b) => b.id).join(",")}&size=150x150&format=Png`).then((r) => {
      if (token !== rows.newsToken) return;
      for (const t of (r && r.data) || []) {
        if (t.imageUrl) newsImg.set("b" + t.targetId, t.imageUrl);
        const img = $(`#psNews img[data-badge="${t.targetId}"]`); if (img && t.imageUrl) img.src = t.imageUrl;
      }
    });
  }

  /* ---------- News popup ---------- */
  const newsImg = new Map(); // mediaId / "b"+badgeId -> image URL

  const span = (ms) => {
    const m = Math.max(0, Math.round(Math.abs(ms) / 60000));
    const d = Math.floor(m / 1440), h = Math.floor((m % 1440) / 60), mm = m % 60;
    return d ? `${d}d ${h}h` : h ? `${h}h ${mm}m` : `${mm}m`;
  };
  const fullDate = (t) => new Date(t).toLocaleString([], { weekday: "short", month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" });
  const fact = (v, l) => `<div><b>${v}</b><span>${l}</span></div>`;

  function openNews(i) {
    const it = ps.news && ps.news[i];
    const g = ps.list[ps.sel];
    if (!it || !g) return;
    if (it.kind === "update") return openGame(g.id);

    const media = $("#nMedia"), img = $("#nImg"), chip = $("#nChip");
    $("#nGame").innerHTML = `<img src="${esc(g.icon) || PLACEHOLDER}" alt=""/>${esc(g.name)}`;
    const actions = [];

    if (it.kind === "event") {
      const e = it.e, now = Date.now();
      media.className = "news-media";
      img.src = newsImg.get(String(it.media)) || cache.banners.get(g.id) || g.icon || PLACEHOLDER;
      chip.className = "nchip " + (it.state === "live" ? "live" : it.state === "upcoming" ? "soon" : "");
      chip.textContent = it.state === "live" ? "LIVE NOW" : it.state === "upcoming" ? "UPCOMING" : "ENDED";
      $("#nTitle").textContent = e.displayTitle || e.title;
      $("#nSub").textContent = e.displaySubtitle || e.subtitle || "";
      const status = it.state === "live" ? fact(span(it.end - now), "left")
        : it.state === "upcoming" ? fact(span(it.start - now), "until it starts")
        : fact(relDay(e.eventTime.endUtc), "ended");
      const cat = (e.eventCategories || []).map((c) => c.category || c).filter((c) => typeof c === "string");
      $("#nFacts").innerHTML = status + fact(fullDate(it.start), "Starts") + fact(fullDate(it.end), "Ends")
        + (cat.length ? fact(esc(cat[0].replace(/([a-z])([A-Z])/g, "$1 $2").replace(/^./, (c) => c.toUpperCase())), "Type") : "");
      $("#nDesc").textContent = e.displayDescription || e.description || "";
      actions.push(`<button class="ps-play" data-nact="play"><svg viewBox="0 0 24 24"><use href="#i-play"/></svg>${it.state === "live" ? "Join the event" : "Play"}</button>`);
      actions.push(`<button class="link" data-nact="web"><svg viewBox="0 0 24 24"><use href="#i-external"/></svg>View on roblox.com</button>`);
      ps.newsOpen = { url: `https://www.roblox.com/events/${e.id}`, uid: g.id };
    } else {
      const b = it.b, st = b.statistics || {};
      media.className = "news-media badge";
      img.src = newsImg.get("b" + b.id) || PLACEHOLDER;
      chip.className = "nchip soon";
      chip.textContent = "NEW BADGE";
      $("#nTitle").textContent = b.displayName || b.name;
      $("#nSub").textContent = `Added ${relDay(b.created)}`;
      const rate = st.winRatePercentage != null ? (st.winRatePercentage <= 1 ? st.winRatePercentage * 100 : st.winRatePercentage) : null;
      $("#nFacts").innerHTML = fact(fmt(st.awardedCount || 0), "Players earned it")
        + fact(fmt(st.pastDayAwardedCount || 0), "Earned yesterday")
        + (rate ? fact(`${rate < 1 && rate > 0 ? rate.toFixed(2) : Math.round(rate)}%`, "Win rate") : "")
        + fact(new Date(b.created).toLocaleDateString([], { dateStyle: "medium" }), "Added");
      $("#nDesc").textContent = b.displayDescription || b.description || "No description.";
      actions.push(`<span id="nOwned"></span>`);
      actions.push(`<button class="ps-play" data-nact="play"><svg viewBox="0 0 24 24"><use href="#i-play"/></svg>Play to earn it</button>`);
      actions.push(`<button class="link" data-nact="web"><svg viewBox="0 0 24 24"><use href="#i-external"/></svg>View on roblox.com</button>`);
      ps.newsOpen = { url: `https://www.roblox.com/badges/${b.id}`, uid: g.id };
      if (S.user && S.user.signedIn) {
        host.get(`https://badges.roblox.com/v1/users/${S.user.id}/badges/awarded-dates?badgeIds=${b.id}`).then((r) => {
          const got = r && r.data && r.data[0];
          const el = $("#nOwned");
          if (!got || !el || $("#newsModal").hidden) return;
          el.outerHTML = `<span class="news-owned"><svg viewBox="0 0 24 24"><use href="#i-check"/></svg>You earned this ${relDay(got.awardedDate)}</span>`;
          const playBtn = $('#nActions [data-nact="play"]');
          if (playBtn) playBtn.innerHTML = `<svg viewBox="0 0 24 24"><use href="#i-play"/></svg>Play`;
        }).catch(() => {});
      }
    }
    $("#nActions").innerHTML = actions.join("");
    $("#newsModal").hidden = false;
    $(".news-card").scrollTop = 0;
  }

  function closeNews() { $("#newsModal").hidden = true; }
  $("#newsClose").onclick = closeNews;
  $("#newsModal").addEventListener("click", (e) => { if (e.target.id === "newsModal") closeNews(); });
  document.addEventListener("keydown", (e) => { if (e.key === "Escape") closeNews(); });
  $("#nActions").addEventListener("click", (e) => {
    const b = e.target.closest("[data-nact]");
    if (!b || !ps.newsOpen) return;
    if (b.dataset.nact === "play") { closeNews(); play(ps.newsOpen.uid, undefined, Number($("#psAs").value) || 0); }
    if (b.dataset.nact === "web") host.open(ps.newsOpen.url);
  });

  $("#psNews").addEventListener("click", (e) => { const c = e.target.closest("[data-news]"); if (c) openNews(Number(c.dataset.news)); });
  $("#psNews").addEventListener("keydown", (e) => { const c = e.target.closest("[data-news]"); if (c && e.key === "Enter") { e.stopPropagation(); openNews(Number(c.dataset.news)); } });

  /* ---------- Servers: public + private ---------- */
  const srv = { mode: "public", expanded: false, cursor: null, count: 0, loadingMore: false, uid: 0, priv: null };

  const pingClass = (ping) => (ping == null ? "" : ping < 120 ? "good" : ping < 250 ? "ok" : "bad");
  const friendsByJob = () => {
    const m = new Map();
    for (const f of friendData) if (f.type === 2 && f.jobId) { if (!m.has(f.jobId)) m.set(f.jobId, []); m.get(f.jobId).push(f); }
    return m;
  };
  const faces = (fr) => fr.slice(0, 5).map((f) => `<img src="${esc(cache.heads.get(f.id) || PLACEHOLDER)}" title="${esc(f.displayName)}" alt=""/>`).join("");

  function setServerMode(mode) {
    srv.mode = mode;
    $$("#psSrvMode button").forEach((b) => b.classList.toggle("on", b.dataset.mode === mode));
    $$(".ps-row-head .pub-only").forEach((b) => (b.hidden = mode !== "public"));
    const g = ps.list[ps.sel];
    if (g) loadServers(g);
  }
  $("#psSrvMode").addEventListener("click", (e) => { const b = e.target.closest("[data-mode]"); if (b && b.dataset.mode !== srv.mode) setServerMode(b.dataset.mode); });

  function setExpanded(on) {
    srv.expanded = on;
    $("#psServers").classList.toggle("expanded", on);
    $("#psServersExpand").textContent = on ? "Show less" : "Show all";
    $("#psServersLeft").hidden = $("#psServersRight").hidden = on;
    updateMoreButton();
  }
  $("#psServersExpand").onclick = () => setExpanded(!srv.expanded);
  $("#psServersLeft").onclick = () => $("#psServers").scrollBy({ left: -$("#psServers").clientWidth * 0.8 });
  $("#psServersRight").onclick = () => $("#psServers").scrollBy({ left: $("#psServers").clientWidth * 0.8 });
  function updateMoreButton() { $("#psServersMore").hidden = !(srv.mode === "public" && srv.cursor && srv.expanded); }
  $("#psServersMore").onclick = () => loadMorePublic();
  // Collapsed: scrolling to the end of the row loads the next page by itself.
  $("#psServers").addEventListener("scroll", () => {
    const el = $("#psServers");
    if (!srv.expanded && srv.mode === "public" && srv.cursor && el.scrollLeft + el.clientWidth > el.scrollWidth - 400) loadMorePublic();
  });

  function loadServers(g) {
    srv.uid = g.id;
    if (srv.mode === "private") return loadPrivate(g);
    return loadPublic(g);
  }

  // ----- Public -----
  async function fetchPublicPage(g, cursor) {
    return host.get(`https://games.roblox.com/v1/games/${g.rootPlaceId}/servers/Public?sortOrder=${rows.sortDesc ? "Desc" : "Asc"}&limit=25&excludeFullGames=${rows.showFull ? "false" : "true"}${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ""}`);
  }

  async function loadPublic(g) {
    const token = ++rows.srvToken;
    const el = $("#psServers");
    el.scrollLeft = 0;
    el.innerHTML = Array.from({ length: 4 }, () => `<div class="ps-server skel"></div>`).join("");
    $("#psServersSub").textContent = "";
    srv.cursor = null; srv.count = 0;
    updateMoreButton();
    let r;
    try { r = await fetchPublicPage(g, null); }
    catch (e) { if (token === rows.srvToken) el.innerHTML = `<div class="ps-empty">Couldn't load servers (${esc(e.message)}).</div>`; return; }
    if (token !== rows.srvToken) return;
    const list = (r && r.data) || [];
    if (!list.length) { el.innerHTML = `<div class="ps-empty">${rows.showFull ? "No public servers running right now." : "No servers with free slots right now."} Press Play to start one.</div>`; return; }
    el.innerHTML = "";
    appendPublic(g, list, r.nextPageCursor, token);
  }

  async function loadMorePublic() {
    const g = ps.list[ps.sel];
    if (!g || srv.loadingMore || !srv.cursor || srv.mode !== "public") return;
    srv.loadingMore = true;
    const token = rows.srvToken;
    $("#psServersMore").textContent = "Loading…";
    try {
      const r = await fetchPublicPage(g, srv.cursor);
      if (token === rows.srvToken) appendPublic(g, (r && r.data) || [], r && r.nextPageCursor, token);
    } catch (e) { toast(`Couldn't load more servers: ${e.message}`, true); }
    finally { srv.loadingMore = false; $("#psServersMore").textContent = "Load more servers"; }
  }

  async function appendPublic(g, list, nextCursor, token) {
    const el = $("#psServers");
    const fj = friendsByJob();
    const start = srv.count;
    srv.count += list.length;
    srv.cursor = nextCursor || null;
    $("#psServersSub").textContent = `${srv.count}${srv.cursor ? "+" : ""} servers`;
    el.insertAdjacentHTML("beforeend", list.map((sv, k) => {
      const i = start + k;
      const full = sv.playing >= sv.maxPlayers;
      const fr = fj.get(sv.id) || [];
      const ping = sv.ping != null ? Math.round(sv.ping) : null;
      return `<div class="ps-server ${full ? "full" : ""} ${fr.length ? "friend" : ""}" data-job="${sv.id}">
        <div class="sv-top"><b>Server ${i + 1}</b>${fr.length ? `<span class="sv-friend">${fr.length} friend${fr.length > 1 ? "s" : ""}</span>` : ""}</div>
        <div class="sv-count"><span>${sv.playing}</span>/${sv.maxPlayers} players</div>
        <div class="sv-bar"><i style="width:${Math.round((sv.playing / sv.maxPlayers) * 100)}%"></i></div>
        <div class="sv-faces" data-faces="${i}">${faces(fr)}</div>
        <div class="sv-stats">${ping != null ? `<span class="sv-ping ${pingClass(ping)}" title="Server ping">${ping} ms</span>` : ""}${sv.fps ? `<span title="Server frame rate">${Math.round(sv.fps)} fps</span>` : ""}</div>
        <button class="sv-join" ${full ? "disabled" : ""}>${full ? "Full" : "Join"}</button>
      </div>`;
    }).join(""));
    updateMoreButton();

    // Player headshots: Roblox only returns player tokens to signed-in users.
    const reqs = [];
    list.forEach((sv, k) => {
      const fr = fj.get(sv.id) || [];
      (sv.playerTokens || []).slice(0, Math.max(0, 5 - fr.length)).forEach((tk, j) =>
        reqs.push({ requestId: `${start + k}:${j}`, token: tk, type: "AvatarHeadShot", size: "48x48", format: "png", isCircular: true }));
    });
    for (const part of chunk(reqs, 100)) {
      const t = await host.post("https://thumbnails.roblox.com/v1/batch", part).catch(() => null);
      if (token !== rows.srvToken) return;
      for (const d of (t && t.data) || []) {
        if (!d.imageUrl) continue;
        const box = $(`#psServers [data-faces="${d.requestId.split(":")[0]}"]`);
        if (box) box.insertAdjacentHTML("beforeend", `<img src="${esc(d.imageUrl)}" alt=""/>`);
      }
    }
  }

  // ----- Private -----
  async function loadPrivate(g) {
    const token = ++rows.srvToken;
    const el = $("#psServers");
    el.scrollLeft = 0;
    srv.cursor = null;
    updateMoreButton();
    const signed = S.user && S.user.signedIn;
    const actionCards = (priceLabel) => `
      <div class="ps-server action" data-priv="create"><svg viewBox="0 0 24 24"><use href="#i-plus"/></svg><b>Create private server</b><span>${esc(priceLabel)}</span></div>
      <div class="ps-server action" data-priv="link"><svg viewBox="0 0 24 24"><use href="#i-external"/></svg><b>Join with a link</b><span>Paste a private server invite</span></div>`;
    if (!signed) {
      el.innerHTML = actionCards("Sign in first") + `<div class="ps-empty">Sign in with your Roblox account (Settings) to see the private servers you own or were invited to.</div>`;
      $("#psServersSub").textContent = "";
      return;
    }
    el.innerHTML = actionCards("Checking price…") + Array.from({ length: 3 }, () => `<div class="ps-server skel"></div>`).join("");
    $("#psServersSub").textContent = "";

    const get = (u) => host.get(u).catch(() => null);
    const [config, enabled, mine, list] = await Promise.all([
      get(`https://develop.roblox.com/v1/universes/${g.id}/configuration/vip-servers`),
      get(`https://games.roblox.com/v1/private-servers/enabled-in-universe/${g.id}`),
      get(`https://games.roblox.com/v1/private-servers/my-private-servers?privateServersTab=MyPrivateServers&itemsPerPage=100`),
      (async () => {
        const all = [];
        let cursor = "";
        for (let page = 0; page < 4; page++) {
          const r = await get(`https://games.roblox.com/v1/games/${g.rootPlaceId}/private-servers?limit=100${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ""}`);
          all.push(...((r && r.data) || []));
          cursor = r && r.nextPageCursor;
          if (!cursor) break;
        }
        return all;
      })(),
    ]);
    if (token !== rows.srvToken) return;

    // What creating one costs. Roblox only shares the price with some accounts; otherwise we hand off to roblox.com.
    srv.priv = {
      enabled: config ? config.isEnabled : enabled ? enabled.privateServersEnabled : null,
      price: config && config.isEnabled ? config.price : null,
      mine: new Map(((mine && mine.data) || []).filter((m) => m.universeId === g.id).map((m) => [m.privateServerId, m])),
    };
    const pp = srv.priv;
    const priceText = pp.enabled === false ? "Not offered by this game"
      : pp.price === 0 ? "Free" : pp.price ? `${pp.price.toLocaleString()} Robux / month` : "Price shown on Roblox";

    // Servers you own that are switched off don't show up in the place list, so add them from "my servers".
    const listed = new Set(list.map((x) => x.vipServerId));
    const offline = [...pp.mine.values()].filter((m) => !listed.has(m.privateServerId));
    const cards = list.map((sv) => privateCard(sv, pp.mine.get(sv.vipServerId))).join("")
      + offline.map((m) => privateCard({ vipServerId: m.privateServerId, name: m.name, owner: { id: m.ownerId, displayName: m.ownerName }, playing: 0, maxPlayers: null }, m)).join("");
    el.innerHTML = actionCards(priceText) + (cards || `<div class="ps-empty">You don't have any private servers for this game yet.</div>`);
    const n = list.length + offline.length;
    $("#psServersSub").textContent = n ? `${n} private server${n > 1 ? "s" : ""}` : "";
  }

  function privateCard(sv, mine) {
    const yours = !!mine || (sv.owner && S.user && sv.owner.id === S.user.id);
    const inactive = mine && mine.active === false;
    const players = sv.playing || 0;
    const max = sv.maxPlayers;
    const renew = mine && mine.expirationDate
      ? `${mine.willRenew ? "Renews" : "Expires"} ${new Date(mine.expirationDate).toLocaleDateString([], { month: "short", day: "numeric" })}` : "";
    return `<div class="ps-server private ${inactive ? "full" : ""}" data-vip="${sv.vipServerId}" ${sv.accessCode ? `data-code="${esc(sv.accessCode)}"` : ""}>
      <div class="sv-top"><b title="${esc(sv.name || "")}">${esc(sv.name || "Private server")}</b>${yours ? `<span class="sv-friend mine">YOURS</span>` : ""}</div>
      <div class="sv-owner">by ${esc((sv.owner && (sv.owner.displayName || sv.owner.name)) || "someone")}</div>
      <div class="sv-count"><span>${players}</span>${max ? `/${max}` : ""} players</div>
      ${max ? `<div class="sv-bar"><i style="width:${Math.round((players / max) * 100)}%"></i></div>` : ""}
      <div class="sv-stats">${inactive ? "<span>Switched off</span>" : ""}${renew ? `<span>${renew}</span>` : ""}</div>
      <div class="sv-btns">
        <button class="sv-join" data-pact="join" ${sv.accessCode && !inactive ? "" : "disabled"}>${inactive ? "Off" : "Join"}</button>
        ${yours ? `<button class="sv-manage" data-pact="manage" title="Manage">⋯</button>` : ""}
      </div>
    </div>`;
  }

  $("#psServers").addEventListener("click", (e) => {
    const g = ps.list[ps.sel];
    if (!g) return;
    const act = e.target.closest("[data-priv]");
    if (act) return act.dataset.priv === "create" ? createDialog(g) : linkDialog();
    const card = e.target.closest("[data-vip]");
    if (card) {
      const b = e.target.closest("[data-pact]");
      if (b && b.dataset.pact === "manage") return manageDialog(g, Number(card.dataset.vip));
      if (card.dataset.code && !card.classList.contains("full")) return play(g.id, undefined, Number($("#psAs").value) || 0, { accessCode: card.dataset.code });
      return;
    }
    const pub = e.target.closest("[data-job]");
    if (pub && !pub.classList.contains("full")) play(g.id, pub.dataset.job, Number($("#psAs").value) || 0);
  });
  $("#psServersRefresh").onclick = () => { const g = ps.list[ps.sel]; if (g) loadServers(g); };
  $("#psServersFull").onclick = () => {
    rows.showFull = !rows.showFull;
    $("#psServersFull").textContent = rows.showFull ? "Showing full" : "Hiding full";
    const g = ps.list[ps.sel];
    if (g) loadServers(g);
  };
  $("#psServersSort").onclick = () => {
    rows.sortDesc = !rows.sortDesc;
    $("#psServersSort").textContent = rows.sortDesc ? "Most players" : "Fewest players";
    const g = ps.list[ps.sel];
    if (g) loadServers(g);
  };

  // ----- Dialogs -----
  function openDialog(html) {
    $("#psDialogBody").innerHTML = html;
    $("#psDialog").hidden = false;
    const first = $("#psDialogBody input");
    if (first) setTimeout(() => first.focus(), 50);
  }
  function closeDialog() { $("#psDialog").hidden = true; }
  $("#psDialogClose").onclick = closeDialog;
  $("#psDialog").addEventListener("click", (e) => { if (e.target.id === "psDialog") closeDialog(); });
  document.addEventListener("keydown", (e) => { if (e.key === "Escape") closeDialog(); });
  const dlgNote = (t, cls = "") => { const n = $("#dlgNote"); if (n) { n.textContent = t; n.className = "dlg-note " + cls; } };

  function createDialog(g) {
    if (!(S.user && S.user.signedIn)) { toast("Sign in first (Settings).", true); return go("settings"); }
    const pp = srv.priv || {};
    const webUrl = `https://www.roblox.com/games/${g.rootPlaceId}#!/game-instances`;
    if (pp.enabled === false) {
      return openDialog(`<h2>Private servers</h2><p class="muted">${esc(g.name)} doesn't offer private servers.</p>`);
    }
    if (pp.price == null) {
      // Roblox didn't tell us the price: let Roblox's own page handle the purchase.
      openDialog(`<h2>Create a private server</h2>
        <p class="muted">Roblox doesn't share this game's private server price with RoLauncher, so buying one happens on the game's Roblox page. It opens right here in the launcher, already signed in.</p>
        <div class="dlg-actions"><button class="ps-play" id="dlgWeb">Open the game's server page</button></div>`);
      $("#dlgWeb").onclick = () => { closeDialog(); host.open(webUrl); };
      return;
    }
    const free = pp.price === 0;
    const after = robux != null ? robux - pp.price : null;
    openDialog(`<h2>Create a private server</h2>
      <p class="muted">For <b>${esc(g.name)}</b>. Only people you invite can join.</p>
      <label class="dlg-label">Server name</label>
      <input class="dlg-input" id="dlgName" maxlength="50" value="${esc((S.user.displayName || "My") + "'s server")}" />
      <div class="dlg-price">
        <div><span>Price</span><b>${free ? "Free" : `${pp.price.toLocaleString()} Robux`}</b></div>
        ${free ? "" : `<div><span>Billing</span><b>Every month until you stop it</b></div>`}
        ${!free && after != null ? `<div><span>Balance after</span><b>${after.toLocaleString()} Robux</b></div>` : ""}
      </div>
      ${!free && after != null && after < 0 ? `<div class="dlg-note err">You need ${(-after).toLocaleString()} more Robux.</div>` : `<div class="dlg-note" id="dlgNote"></div>`}
      <div class="dlg-actions">
        <button class="ps-mini wide" id="dlgCancel">Cancel</button>
        <button class="ps-play" id="dlgCreate" ${!free && after != null && after < 0 ? "disabled" : ""}>${free ? "Create server" : `Buy for ${pp.price.toLocaleString()} Robux / month`}</button>
      </div>`);
    $("#dlgCancel").onclick = closeDialog;
    const btn = $("#dlgCreate");
    if (!btn || btn.disabled) return;
    btn.onclick = async () => {
      const name = $("#dlgName").value.trim() || "Private server";
      btn.disabled = true; btn.textContent = "Creating…";
      try {
        await host.post(`https://games.roblox.com/v1/games/vip-servers/${g.id}`, {
          name, expectedPrice: pp.price, isPurchaseConfirmed: true, idempotencyKey: crypto.randomUUID(),
        });
        closeDialog();
        toast(`🎉 Created “${name}”`);
        refreshRobux();
        loadPrivate(g);
      } catch (e) {
        btn.disabled = false; btn.textContent = free ? "Create server" : `Buy for ${pp.price.toLocaleString()} Robux / month`;
        dlgNote(e.message || "Couldn't create the server", "err");
      }
    };
  }

  function linkDialog() {
    openDialog(`<h2>Join with a link</h2>
      <p class="muted">Paste a private server invite, like <code>roblox.com/share?code=…&type=Server</code> or a link with <code>privateServerLinkCode=…</code>.</p>
      <input class="dlg-input" id="dlgLink" placeholder="https://www.roblox.com/share?code=…" />
      <div class="dlg-note" id="dlgNote"></div>
      <div class="dlg-actions"><button class="ps-mini wide" id="dlgCancel">Cancel</button><button class="ps-play" id="dlgJoin">Join server</button></div>`);
    $("#dlgCancel").onclick = closeDialog;
    const go_ = async () => {
      const raw = $("#dlgLink").value.trim();
      if (!raw) return;
      const btn = $("#dlgJoin");
      btn.disabled = true; btn.textContent = "Checking…";
      try {
        let placeId, universeId, linkCode;
        const share = raw.match(/[?&]code=([A-Za-z0-9_-]+)/);
        const old = raw.match(/privateServerLinkCode=([A-Za-z0-9_-]+)/);
        if (share && /type=Server/i.test(raw)) {
          const r = await host.post("https://apis.roblox.com/sharelinks/v1/resolve-link", { linkId: share[1], linkType: "Server" });
          const d = r && r.privateServerInviteData;
          if (!d || (d.status && d.status !== "Valid")) throw new Error(d && d.status ? `This invite is ${d.status.toLowerCase()}.` : "That invite link didn't work.");
          placeId = d.placeId; universeId = d.universeId; linkCode = d.linkCode;
        } else if (old) {
          const pm = raw.match(/games\/(\d+)/);
          if (!pm) throw new Error("The link is missing the game's ID.");
          placeId = Number(pm[1]); linkCode = old[1];
          universeId = await api.placeToUniverse(placeId);
        } else throw new Error("That doesn't look like a private server link.");
        if (!universeId || !linkCode) throw new Error("That invite link didn't work.");
        closeDialog();
        play(universeId, undefined, Number($("#psAs").value) || 0, { linkCode });
      } catch (e) {
        btn.disabled = false; btn.textContent = "Join server";
        dlgNote(e.message, "err");
      }
    };
    $("#dlgJoin").onclick = go_;
    $("#dlgLink").addEventListener("keydown", (e) => { if (e.key === "Enter") go_(); });
  }

  function manageDialog(g, vipId) {
    const pp = srv.priv || { mine: new Map() };
    const m = pp.mine.get(vipId);
    const card = $(`#psServers [data-vip="${vipId}"]`);
    const name = m ? m.name : card ? card.querySelector(".sv-top b").textContent : "";
    const active = m ? m.active !== false : true;
    openDialog(`<h2>Manage server</h2>
      <label class="dlg-label">Server name</label>
      <div class="dlg-row"><input class="dlg-input" id="dlgName" maxlength="50" value="${esc(name)}" /><button class="ps-mini wide" id="dlgRename">Save</button></div>
      <label class="dlg-label">Invite link</label>
      <div class="dlg-row"><input class="dlg-input" id="dlgLinkOut" readonly placeholder="Press “Get link”" /><button class="ps-mini wide" id="dlgGetLink">Get link</button></div>
      <div class="dlg-row"><button class="ps-mini wide" id="dlgNewLink" title="Old links stop working">Make a new link</button>
        <button class="ps-mini wide" id="dlgActive">${active ? "Switch server off" : "Switch server on"}</button></div>
      ${m && m.expirationDate ? `<p class="muted small">${m.willRenew ? "Renews" : "Expires"} on ${new Date(m.expirationDate).toLocaleDateString([], { dateStyle: "medium" })}${m.priceInRobux ? ` · ${m.priceInRobux.toLocaleString()} Robux / month` : ""}. Stop or restart the monthly payment on Roblox's page for this game.</p>` : ""}
      <div class="dlg-note" id="dlgNote"></div>`);
    const url = `https://games.roblox.com/v1/vip-servers/${vipId}`;
    const patch = async (body) => host.patch(url, body);
    const showLink = (r) => {
      if (r && r.link) { $("#dlgLinkOut").value = r.link; navigator.clipboard?.writeText(r.link).then(() => dlgNote("Link copied to clipboard", "ok"), () => {}); }
      else dlgNote("Roblox didn't return a link for this server.", "err");
    };
    $("#dlgRename").onclick = async () => {
      try { await patch({ name: $("#dlgName").value.trim() }); dlgNote("Name saved", "ok"); loadPrivate(g); } catch (e) { dlgNote(e.message, "err"); }
    };
    $("#dlgGetLink").onclick = async () => { try { showLink(await patch({})); } catch (e) { dlgNote(e.message, "err"); } };
    $("#dlgNewLink").onclick = async () => {
      if (!confirm("Make a new invite link? Anyone with the old link won't be able to join anymore.")) return;
      try { showLink(await patch({ newJoinCode: true })); } catch (e) { dlgNote(e.message, "err"); }
    };
    $("#dlgActive").onclick = async () => {
      try { await patch({ active: !active }); closeDialog(); toast(active ? "Server switched off" : "Server switched on"); loadPrivate(g); } catch (e) { dlgNote(e.message, "err"); }
    };
  }

  /* ---------- Live badges on running games (the top bar shows the game itself) ---------- */
  const baseSessions = renderSessions;
  renderSessions = function () {
    baseSessions();
    if (ps.list.length) {
      const live = new Set(running().map((x) => x.g.id));
      $$("#psTiles .ps-tile[data-i]").forEach((t) => {
        const g = ps.list[Number(t.dataset.i)];
        const has = t.querySelector(".ps-badge");
        if (live.has(g.id) && !has) t.insertAdjacentHTML("beforeend", `<span class="ps-badge"></span>`);
        if (!live.has(g.id) && has) has.remove();
      });
      showSelected();
    }
  };

  const baseFav = toggleFav;
  toggleFav = function (uid) { baseFav(uid); refreshHome(); };

  const baseDraw = drawFriends;
  drawFriends = function () { baseDraw(); if (ps.list[ps.sel]) renderInfoCards(ps.list[ps.sel]); };

  /* ---------- Keyboard / controller-style navigation ---------- */
  document.addEventListener("keydown", (e) => {
    if (currentPage !== "launchpad" || !$("#modal").hidden || !$("#itemModal").hidden || !$("#newsModal").hidden || !$("#psDialog").hidden || !$("#launching").hidden) return;
    if (e.target.closest && e.target.closest("input, select, textarea")) return;
    const k = e.key;
    if (k === "ArrowRight") { select(ps.sel + 1); e.preventDefault(); }
    else if (k === "ArrowLeft") { select(ps.sel - 1); e.preventDefault(); }
    else if (k === "ArrowDown") { $("#main").scrollBy({ top: 320, behavior: "smooth" }); e.preventDefault(); }
    else if (k === "ArrowUp") { $("#main").scrollBy({ top: -320, behavior: "smooth" }); e.preventDefault(); }
    else if (k === "Enter" && document.activeElement === document.body) { playSelected(); e.preventDefault(); }
    else if (k === "i" || k === "I") { if (ps.list[ps.sel]) openGame(ps.list[ps.sel].id); }
    else if (k === "f" || k === "F") { if (ps.list[ps.sel]) toggleFav(ps.list[ps.sel].id); }
  });

  refreshHome();
})();
