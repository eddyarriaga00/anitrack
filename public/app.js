// AniTrack frontend.
// Show data: AniList GraphQL (public, CORS-friendly).
// Tracking: saved on this device out of the box; synced to your MyAnimeList list once connected (via server.js proxy).
const $ = (s, r = document) => r.querySelector(s);
const $$ = (s, r = document) => [...r.querySelectorAll(s)];
const esc = s => String(s ?? "").replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const sleep = ms => new Promise(r => setTimeout(r, ms));
const view = $("#view");

const STATUSES = { watching: "Watching", plan_to_watch: "Plan to watch", completed: "Completed", on_hold: "On hold", dropped: "Dropped" };
const FORMATS = { TV: "TV", TV_SHORT: "TV Short", MOVIE: "Movie", SPECIAL: "Special", OVA: "OVA", ONA: "ONA", MUSIC: "Music" };
const SEASONS = ["WINTER", "SPRING", "SUMMER", "FALL"];
const GENRES = ["Action", "Adventure", "Comedy", "Drama", "Ecchi", "Fantasy", "Horror", "Mahou Shoujo", "Mecha", "Music", "Mystery", "Psychological", "Romance", "Sci-Fi", "Slice of Life", "Sports", "Supernatural", "Thriller"];
const SCORE_WORDS = ["", "Appalling", "Horrible", "Very bad", "Bad", "Average", "Fine", "Good", "Very good", "Great", "Masterpiece"];

const state = { icsItems: [], listView: (() => { try { return localStorage.getItem("anitrack.view") || "grid"; } catch { return "grid"; } })(), auth: { configured: false, loggedIn: false }, user: null, listStatus: "watching", listSort: "updated", schedMine: false, heroTimer: null };
const entryIndex = new Map(); // card key -> entry (for quick +1)
const mediaIndex = new Map(); // AniList id -> media (for quick add)
const mine = new Set();       // "a<alId>" / "m<malId>" keys of everything on your list
const mineKeys = e => [e.alId && "a" + e.alId, e.malId && "m" + e.malId].filter(Boolean);
const isMine = m => mine.has("a" + m.id) || (!!m.idMal && mine.has("m" + m.idMal));
async function refreshMine() {
  const all = await T.all().catch(() => []);
  mine.clear(); all.forEach(e => mineKeys(e).forEach(k => mine.add(k)));
  return all;
}

// =============== AniList ===============
const alCache = new Map();
const SS_TTL = 10 * 60 * 1000;
function ssGet(key) {
  try { const v = JSON.parse(sessionStorage.getItem("al:" + key)); return v && Date.now() - v.t < SS_TTL ? v.d : null; } catch { return null; }
}
function ssSet(key, d) {
  try { sessionStorage.setItem("al:" + key, JSON.stringify({ t: Date.now(), d })); }
  catch { try { Object.keys(sessionStorage).filter(k => k.startsWith("al:")).forEach(k => sessionStorage.removeItem(k)); } catch {} }
}
function al(query, variables = {}) {
  const key = query.replace(/\s+/g, " ") + JSON.stringify(variables);
  if (alCache.has(key)) return alCache.get(key);
  const hit = ssGet(key);
  if (hit) { const p = Promise.resolve(hit); alCache.set(key, p); return p; }
  const p = (async () => {
    for (let i = 0; i < 4; i++) {
      let r;
      try {
        r = await fetch("https://graphql.anilist.co", {
          method: "POST", headers: { "Content-Type": "application/json", Accept: "application/json" },
          body: JSON.stringify({ query, variables }),
        });
      } catch { throw new Error("Can't reach AniList — check your internet connection."); }
      if (r.status === 429) { await sleep((Number(r.headers.get("Retry-After")) || 2) * 1000); continue; }
      const j = await r.json();
      if (!j.data && j.errors) throw new Error(j.errors[0].message);
      if (!j.errors) ssSet(key, j.data);
      return j.data;
    }
    throw new Error("AniList is busy — try again in a minute.");
  })();
  alCache.set(key, p);
  p.catch(() => alCache.delete(key));
  setTimeout(() => alCache.delete(key), 10 * 60 * 1000);
  return p;
}

const CARD = `id idMal title { romaji english } coverImage { large extraLarge color } bannerImage format episodes averageScore seasonYear status nextAiringEpisode { episode timeUntilAiring airingAt }`;

function currentSeason(d = new Date()) {
  return { season: SEASONS[Math.floor(d.getMonth() / 3)], year: d.getFullYear() };
}
const airedOf = m => (m.nextAiringEpisode ? m.nextAiringEpisode.episode - 1 : m.status === "NOT_YET_RELEASED" ? 0 : m.episodes || 0);

// Fill in airing info (new episodes, next episode) for list entries.
async function enrich(entries) {
  const byAl = entries.filter(e => e.alId), byMal = entries.filter(e => !e.alId && e.malId);
  const q = f => `query($ids: [Int], $page: Int) { Page(page: $page, perPage: 50) { media(${f}: $ids, type: ANIME) { id idMal title { romaji english } status episodes format genres nextAiringEpisode { episode timeUntilAiring airingAt } coverImage { large color } } } }`;
  const apply = (list, field, keyOf) => {
    const chunks = [];
    for (let i = 0; i < list.length; i += 50) chunks.push(list.slice(i, i + 50));
    return Promise.all(chunks.map(async c => {
      const data = await al(q(field), { ids: c.map(keyOf), page: 1 }).catch(() => null);
      for (const m of data?.Page.media || []) {
        const e = c.find(x => (field === "id_in" ? x.alId === m.id : x.malId === m.idMal));
        if (!e) continue;
        e.alId ??= m.id; e.malId ??= m.idMal;
        e.aired = airedOf(m); e.next = m.nextAiringEpisode; e.airStatus = m.status;
        if (!e.total && m.episodes) e.total = m.episodes;
        e.color = m.coverImage?.color; e.genres = m.genres; e.format = m.format;
        if (!e.cover || !e.title) { e.cover ||= m.coverImage?.large; e.title = titleOf(m); }
      }
    }));
  };
  await Promise.all([apply(byAl, "id_in", e => e.alId), apply(byMal, "idMal_in", e => e.malId)]);
  return entries;
}

// =============== MAL proxy ===============
async function mal(path, opts = {}) {
  const r = await fetch("/api/mal/" + path, opts);
  const data = await r.json().catch(() => ({}));
  if (r.status === 401) { state.auth.loggedIn = false; renderAuth(); }
  if (!r.ok) throw new Error(data.error || data.message || `MyAnimeList error ${r.status}`);
  return data;
}

// =============== tracking store ===============
// Local (this browser) when MAL isn't connected, MyAnimeList when it is.
const LS_KEY = "anitrack.list.v1";
const local = {
  read() { try { return JSON.parse(localStorage.getItem(LS_KEY)) || {}; } catch { return {}; } },
  write(o) { try { localStorage.setItem(LS_KEY, JSON.stringify(o)); } catch {} },
  all() { return Object.values(this.read()).map(e => ({ ...e })); },
  get(ref) { const e = ref.alId ? this.read()["al:" + ref.alId] : this.all().find(x => x.malId && x.malId === ref.malId); return e ? { ...e } : null; },
  save(ref, f) {
    const o = this.read(), k = "al:" + ref.alId, p = o[k] || {};
    o[k] = {
      alId: ref.alId, malId: ref.malId ?? p.malId ?? null, title: ref.title || p.title, cover: ref.cover || p.cover, total: ref.total || p.total || 0,
      status: f.status ?? p.status ?? "plan_to_watch", watched: f.watched ?? p.watched ?? 0, score: f.score ?? p.score ?? 0,
      started: f.started !== undefined ? f.started : p.started ?? null, finished: f.finished !== undefined ? f.finished : p.finished ?? null,
      rewatches: f.rewatches ?? p.rewatches ?? 0, notes: f.notes ?? p.notes ?? "", updated: Date.now(),
    };
    this.write(o); return { ...o[k] };
  },
  remove(ref) { const o = this.read(); delete o["al:" + ref.alId]; this.write(o); },
  clear(keys) { const o = this.read(); keys.forEach(k => delete o[k]); this.write(o); },
};

const fromMal = (n, ls) => ({
  malId: n.id, alId: null, title: n.title, cover: n.main_picture?.large || n.main_picture?.medium || "", total: n.num_episodes || 0,
  status: ls?.status, watched: ls?.num_episodes_watched || 0, score: ls?.score || 0, updated: Date.parse(ls?.updated_at) || 0,
  started: ls?.start_date || null, finished: ls?.finish_date || null, rewatches: ls?.num_times_rewatched || 0, notes: ls?.comments || "",
});

const T = {
  get mal() { return state.auth.loggedIn; },
  cache: null,
  canTrack(ref) { return this.mal ? !!ref.malId : !!ref.alId; },
  async all(force) {
    if (!this.mal) return local.all();
    if (this.cache && !force && Date.now() - this.cache.t < 60000) return this.cache.list.map(e => ({ ...e }));
    let url = "users/@me/animelist?limit=1000&nsfw=true&fields=list_status,num_episodes";
    const list = [];
    for (let i = 0; i < 6 && url; i++) {
      const r = await mal(url);
      r.data.forEach(d => list.push(fromMal(d.node, d.list_status)));
      url = r.paging?.next ? r.paging.next.replace(/^https:\/\/api\.myanimelist\.net\/v2\//, "") : null;
    }
    this.cache = { t: Date.now(), list };
    return list.map(e => ({ ...e }));
  },
  async get(ref) {
    if (!this.mal) return local.get(ref);
    if (!ref.malId) return null;
    const r = await mal(`anime/${ref.malId}?fields=my_list_status{start_date,finish_date,num_times_rewatched,comments},num_episodes`)
      .catch(() => mal(`anime/${ref.malId}?fields=my_list_status,num_episodes`));
    return r.my_list_status ? { ...fromMal(r, r.my_list_status), alId: ref.alId } : null;
  },
  async save(ref, f) {
    mineKeys(ref).forEach(k => mine.add(k));
    if (!this.mal) return local.save(ref, f);
    const body = new URLSearchParams();
    if (f.status) body.set("status", f.status);
    if (f.watched != null) body.set("num_watched_episodes", f.watched);
    if (f.score != null) body.set("score", f.score);
    if (f.started !== undefined) body.set("start_date", f.started || "");
    if (f.finished !== undefined) body.set("finish_date", f.finished || "");
    if (f.rewatches != null) body.set("num_times_rewatched", f.rewatches);
    if (f.notes != null) body.set("comments", f.notes);
    const ls = await mal(`anime/${ref.malId}/my_list_status`, { method: "PATCH", body });
    const e = { ...ref, status: ls.status, watched: ls.num_episodes_watched, score: ls.score, updated: Date.now(),
      started: ls.start_date || null, finished: ls.finish_date || null, rewatches: ls.num_times_rewatched || 0, notes: ls.comments || "" };
    if (this.cache) {
      const i = this.cache.list.findIndex(x => x.malId === e.malId);
      i >= 0 ? (this.cache.list[i] = { ...this.cache.list[i], ...e }) : this.cache.list.unshift(e);
    }
    return e;
  },
  async remove(ref) {
    mineKeys(ref).forEach(k => mine.delete(k));
    if (!this.mal) return local.remove(ref);
    await mal(`anime/${ref.malId}/my_list_status`, { method: "DELETE" }).catch(() => {});
    if (this.cache) this.cache.list = this.cache.list.filter(x => x.malId !== ref.malId);
  },
};

// Work out the new status when episode progress changes.
function progressFields(e, n) {
  const total = e.total || 0;
  n = Math.max(0, total ? Math.min(total, n) : n);
  let status = e.status;
  if (total && n >= total) status = "completed";
  else if (n > 0 && (!status || status === "plan_to_watch" || status === "completed")) status = "watching";
  else if (!status) status = "plan_to_watch";
  return withDates(e, { status, watched: n });
}
const todayStr = () => { const d = new Date(); return new Date(d - d.getTimezoneOffset() * 60000).toISOString().slice(0, 10); };
// Auto-fill start/finish dates the first time a show is started or completed.
function withDates(e, f) {
  if (!e?.started && ((f.watched || 0) > 0 || f.status === "watching" || f.status === "completed")) f.started = todayStr();
  if (f.status === "completed" && e?.status !== "completed" && !e?.finished) f.finished = todayStr();
  return f;
}

const niceDate = s => { const [y, m, d] = String(s).split("-").map(Number); return y ? new Date(y, (m || 1) - 1, d || 1).toLocaleDateString([], { month: "short", day: "numeric", year: y !== new Date().getFullYear() ? "numeric" : undefined }) : s; };

// =============== watch history (kept on this device) ===============
const HKEY = "anitrack.history.v1";
const history_ = {
  read() { try { return JSON.parse(localStorage.getItem(HKEY)) || []; } catch { return []; } },
  add(ev) { const h = this.read(); h.push(ev); try { localStorage.setItem(HKEY, JSON.stringify(h.slice(-3000))); } catch {} },
};
// Save + log what changed (episodes watched, completions, adds).
async function track(ref, prev, fields) {
  const saved = await T.save(ref, fields);
  const a = prev?.watched || 0, b = saved.watched ?? a;
  const base = { t: Date.now(), alId: ref.alId || null, malId: ref.malId || null, title: ref.title, cover: ref.cover };
  if (b > a) history_.add({ ...base, kind: "ep", from: a + 1, to: b });
  if (saved.status === "completed" && prev?.status !== "completed") history_.add({ ...base, kind: "done" });
  if (!prev && saved.status && b === 0) history_.add({ ...base, kind: "add", status: saved.status });
  return saved;
}

// =============== helpers ===============
const titleOf = m => m.title?.english || m.title?.romaji || m.title || "";
const fmt = f => FORMATS[f] || f || "";
const score = s => (s ? (s / 10).toFixed(1) : null);
const refOf = m => ({ alId: m.id, malId: m.idMal || null, title: titleOf(m), cover: m.coverImage?.large || "", total: m.episodes || 0 });
const keyOf = e => (e.alId ? "a" + e.alId : "m" + e.malId);
const linkOf = e => (e.alId ? `#anime/${e.alId}` : `#mal/${e.malId}`);
const cap = s => (s ? s[0] + s.slice(1).toLowerCase() : "");
function until(sec) {
  const d = Math.floor(sec / 86400), h = Math.floor((sec % 86400) / 3600), m = Math.floor((sec % 3600) / 60);
  return d ? `${d}d ${h}h` : h ? `${h}h ${m}m` : `${Math.max(1, m)}m`;
}
const clock = ts => new Date(ts * 1000).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
function cleanText(html) {
  const t = document.createElement("textarea");
  t.innerHTML = String(html || "").replace(/<br\s*\/?>/gi, "\n").replace(/<[^>]+>/g, "");
  return t.value.replace(/\(Source:[^)]*\)\s*$/i, "").replace(/\n{3,}/g, "\n\n").trim();
}
function toast(text, kind = "ok") {
  const t = $("#toast");
  t.textContent = text; t.className = `toast show ${kind}`;
  clearTimeout(t._h); t._h = setTimeout(() => (t.className = "toast"), 2800);
}
const statusNote = s => ({ RELEASING: "Airing", FINISHED: "Finished", NOT_YET_RELEASED: "Upcoming", CANCELLED: "Cancelled", HIATUS: "Hiatus" }[s] || s);
function download(name, text, type) {
  const a = Object.assign(document.createElement("a"), { href: URL.createObjectURL(new Blob([text], { type })), download: name });
  document.body.append(a); a.click(); a.remove(); setTimeout(() => URL.revokeObjectURL(a.href), 1000);
}
function hashParams() { const i = location.hash.indexOf("?"); return new URLSearchParams(i < 0 ? "" : location.hash.slice(i + 1)); }

// =============== auth ===============
async function loadAuth() {
  try {
    const r = await fetch("/auth/status");
    if (!r.ok || !(r.headers.get("content-type") || "").includes("json")) throw 0;
    state.auth = await r.json();
  } catch { state.auth = { configured: false, loggedIn: false, static: true }; }
  if (state.auth.loggedIn) state.user = await mal("users/@me").catch(() => null);
  renderAuth();
}
function renderAuth() {
  const el = $("#auth");
  if (state.auth.loggedIn) el.innerHTML = `${state.user?.picture ? `<img src="${esc(state.user.picture)}" alt="">` : ""}
    <span class="name">${esc(state.user?.name || "Connected")}</span><button class="link hide-sm" data-logout>Log out</button>`;
  else if (state.auth.configured) el.innerHTML = `<a class="btn sm primary" href="/auth/login">Connect MAL</a>`;
  else el.innerHTML = `<a class="btn sm ghost" href="#mylist" title="Your list is saved on this device">Local list</a>`;
}

// =============== cards & rows ===============
function card(m, extra = "") {
  mediaIndex.set(m.id, m);
  const next = m.nextAiringEpisode;
  const meta = [fmt(m.format), m.episodes ? `${m.episodes} eps` : null, m.seasonYear].filter(Boolean).join(" · ");
  const on = isMine(m);
  return `<div class="card ${on ? "on-list" : ""}" style="--c:${esc(m.coverImage?.color || "#8b5cf6")}">
    <a class="poster" href="#anime/${m.id}"><img loading="lazy" src="${esc(m.coverImage?.large)}" alt="">
      ${m.averageScore ? `<span class="badge score">★ ${score(m.averageScore)}</span>` : ""}
      ${extra || (next ? `<span class="badge next">EP ${next.episode} · ${until(next.timeUntilAiring)}</span>` : "")}
    </a>
    ${T.canTrack(refOf(m)) ? `<button class="qadd" data-qadd="${m.id}" title="${on ? "On your list" : "Add to Plan to watch"}" aria-label="${on ? "On your list" : "Add to Plan to watch"}">${on ? "✓" : "＋"}</button>` : ""}
    <a class="ct" href="#anime/${m.id}">${esc(titleOf(m))}</a><div class="cm">${esc(meta)}</div></div>`;
}

function entryCard(e) {
  const k = keyOf(e); entryIndex.set(k, e);
  const total = e.total || 0, w = e.watched || 0;
  const fresh = e.status === "watching" && e.aired != null ? Math.max(0, e.aired - w) : 0;
  const pct = total ? Math.min(100, (w / total) * 100) : w ? 50 : 0;
  return `<div class="card" data-entry="${k}" style="--c:${esc(e.color || "#8b5cf6")}">
    <a class="poster" href="${linkOf(e)}"><img loading="lazy" src="${esc(e.cover)}" alt="">
      ${e.score ? `<span class="badge score">★ ${e.score}</span>` : ""}
      ${fresh ? `<span class="badge new">${fresh > 99 ? "99+" : fresh} ${e.airStatus === "RELEASING" ? "new" : "left"}</span>` : e.next && e.status === "watching" ? `<span class="badge next">EP ${e.next.episode} · ${until(e.next.timeUntilAiring)}</span>` : ""}
    </a>
    ${!(total && w >= total) ? `<button class="plus" data-plus="${k}" title="Mark episode ${w + 1} watched">+1 ep</button>` : ""}
    <div class="bar"><i style="width:${pct}%"></i></div>
    <a href="${linkOf(e)}" class="ct">${esc(e.title)}</a>
    <div class="cm">Ep ${w} / ${total || "?"}${fresh ? ` · <b class="hot">${fresh} to watch</b>` : ""}</div></div>`;
}

function listRow(e) {
  const k = keyOf(e); entryIndex.set(k, e);
  const total = e.total || 0, w = e.watched || 0;
  const fresh = e.status === "watching" && e.aired != null ? Math.max(0, e.aired - w) : 0;
  const pct = total ? Math.min(100, (w / total) * 100) : w ? 50 : 0;
  return `<div class="lrow" data-row="${k}">
    <a class="lr-t" href="${linkOf(e)}"><img loading="lazy" src="${esc(e.cover)}" alt=""><div><b>${esc(e.title)}</b>
      <span>${[fmt(e.format), e.next && e.status === "watching" ? `EP ${e.next.episode} in ${until(e.next.timeUntilAiring)}` : null].filter(Boolean).join(" · ")}${fresh ? ` · <b class="hot">${fresh > 99 ? "99+" : fresh} ${e.airStatus === "RELEASING" ? "new" : "left"}</b>` : ""}</span></div></a>
    <div class="lr-p"><button data-lstep="-1" data-k="${k}" aria-label="One episode less" ${w ? "" : "disabled"}>−</button><span>${w}<small> / ${total || "?"}</small></span><button data-lstep="1" data-k="${k}" aria-label="One episode more" ${total && w >= total ? "disabled" : ""}>+</button>
      <div class="bar"><i style="width:${pct}%"></i></div></div>
    <select data-lscore="${k}" aria-label="Score"><option value="0">–</option>${[10, 9, 8, 7, 6, 5, 4, 3, 2, 1].map(n => `<option value="${n}" ${e.score === n ? "selected" : ""}>★ ${n}</option>`).join("")}</select>
  </div>`;
}

function row(title, items, render = card, sub = "", more = "") {
  if (!items?.length) return "";
  return `<section class="row fade-in"><div class="row-h"><h2>${title}${sub ? ` <small>${sub}</small>` : ""}</h2>
    <div class="arrows">${more ? `<a class="link" href="${more}">See all</a>` : ""}<button data-scroll="-1" aria-label="Scroll left">‹</button><button data-scroll="1" aria-label="Scroll right">›</button></div></div>
    <div class="track-x">${items.map(x => render(x)).join("")}</div></section>`;
}

const skRow = () => `<section class="row"><div class="row-h"><div class="sk line" style="width:180px;height:20px"></div></div><div class="track-x">${
  Array.from({ length: 8 }, () => `<div><div class="sk poster-sk"></div><div class="sk line"></div></div>`).join("")}</div></section>`;
const skGrid = n => `<div class="grid">${Array.from({ length: n }, () => `<div><div class="sk poster-sk"></div><div class="sk line"></div></div>`).join("")}</div>`;
const errorBox = e => `<div class="empty"><h3>Couldn't load this</h3><p>${esc(e.message)}</p><button class="btn" data-retry>Try again</button></div>`;

// =============== hero ===============
function hero(list) {
  const items = list.filter(m => m.bannerImage).slice(0, 6);
  if (!items.length) return "";
  return `<section class="hero">${items.map((m, i) => {
    const next = m.nextAiringEpisode;
    return `<div class="slide ${i ? "" : "on"}" style="--bg-img:url('${esc(m.bannerImage)}')"><div class="hero-in">
      <div class="kicker">#${i + 1} Trending now</div>
      <h1>${esc(titleOf(m))}</h1>
      <div class="chips">
        ${m.averageScore ? `<span class="chip score">★ ${score(m.averageScore)}</span>` : ""}
        <span class="chip">${esc(fmt(m.format))}</span>
        ${next ? `<span class="chip live">EP ${next.episode} in ${until(next.timeUntilAiring)}</span>` : m.episodes ? `<span class="chip">${m.episodes} eps</span>` : ""}
        ${(m.genres || []).slice(0, 3).map(g => `<span>${esc(g)}</span>`).join(" · ")}
      </div>
      <p>${esc(cleanText(m.description))}</p>
      <div class="actions">
        <a class="btn primary" href="#anime/${m.id}">View details</a>
        ${m.trailer?.site === "youtube" ? `<button class="btn" data-trailer="${esc(m.trailer.id)}">▶ Trailer</button>` : ""}
        ${T.canTrack(refOf(m)) ? isMine(m) ? `<a class="btn" href="#anime/${m.id}">✓ On your list</a>` : `<button class="btn" data-qadd="${m.id}">＋ My List</button>` : ""}
      </div></div></div>`;
  }).join("")}
  <div class="dots">${items.map((_, i) => `<button data-dot="${i}" class="${i ? "" : "on"}" aria-label="Slide ${i + 1}"></button>`).join("")}</div></section>`;
}
function heroGo(i) {
  const slides = $$(".hero .slide"), dots = $$(".hero .dots button");
  if (!slides.length) return;
  const n = (i + slides.length) % slides.length;
  slides.forEach((s, k) => s.classList.toggle("on", k === n));
  dots.forEach((d, k) => d.classList.toggle("on", k === n));
  state.heroIdx = n;
}
function startHero() {
  clearInterval(state.heroTimer); state.heroIdx = state.heroIdx || 0;
  state.heroTimer = setInterval(() => !document.hidden && heroGo(state.heroIdx + 1), 8000);
}

// =============== pages ===============
async function pageHome() {
  view.innerHTML = `<div class="sk hero-sk"></div><div class="rows">${skRow()}${skRow()}</div>`;
  const { season, year } = currentSeason();
  const now = Math.floor(Date.now() / 1000);
  const q = `query($season: MediaSeason, $year: Int, $from: Int, $to: Int) {
    trending: Page(perPage: 20) { media(type: ANIME, sort: TRENDING_DESC, isAdult: false) { ${CARD} description genres trailer { id site } } }
    airing: Page(perPage: 20) { media(type: ANIME, season: $season, seasonYear: $year, sort: POPULARITY_DESC, isAdult: false) { ${CARD} } }
    soon: Page(perPage: 40) { airingSchedules(airingAt_greater: $from, airingAt_lesser: $to, sort: TIME) { episode airingAt media { ${CARD} isAdult popularity } } }
    upcoming: Page(perPage: 20) { media(type: ANIME, status: NOT_YET_RELEASED, sort: POPULARITY_DESC, isAdult: false) { ${CARD} } }
    popular: Page(perPage: 20) { media(type: ANIME, sort: POPULARITY_DESC, isAdult: false) { ${CARD} } }
    top: Page(perPage: 20) { media(type: ANIME, sort: SCORE_DESC, isAdult: false) { ${CARD} } }
  }`;
  const [data, mine_all] = await Promise.all([
    al(q, { season, year, from: now, to: now + 86400 }),
    T.all().catch(() => []),
  ]);
  const watching = mine_all.filter(e => e.status === "watching");
  await enrich(watching).catch(() => {});
  watching.sort((a, b) => (Math.max(0, (b.aired ?? 0) - b.watched) > 0) - (Math.max(0, (a.aired ?? 0) - a.watched) > 0) || b.updated - a.updated);
  data.trending.media.forEach(m => mediaIndex.set(m.id, m));
  const soon = data.soon.airingSchedules.filter(s => !s.media.isAdult && s.media.popularity > 2000).slice(0, 20);
  const seasonName = cap(season);
  const because = await becauseRow(mine_all).catch(() => "");

  view.innerHTML = hero(data.trending.media) + `<div class="rows">
    ${row("Continue watching", watching.slice(0, 24), entryCard, T.mal ? "synced with MAL" : "", "#mylist")}
    ${!mine_all.length ? onboarding() : ""}
    ${because}
    ${row("Trending now", data.trending.media, card, "", "#browse?sort=TRENDING_DESC")}
    ${row("Airing in the next 24 hours", soon, s => card(s.media, `<span class="badge next">EP ${s.episode} · ${clock(s.airingAt)}</span>`), "", "#schedule")}
    ${row(`${seasonName} ${year}`, data.airing.media, card, "this season", `#browse?season=${season}&year=${year}`)}
    ${row("Coming soon", data.upcoming.media)}
    ${row("All-time popular", data.popular.media, card, "", "#browse?sort=POPULARITY_DESC")}
    ${row("Top rated", data.top.media, card, "", "#browse?sort=SCORE_DESC")}
  </div>`;
  startHero();
}

async function becauseRow(all) {
  const pool = all.filter(e => e.status === "completed" || e.status === "watching")
    .sort((a, b) => (b.score || 0) - (a.score || 0) || b.updated - a.updated).slice(0, 6);
  if (!pool.length) return "";
  const seed = pool[Math.floor(Math.random() * pool.length)];
  const arg = seed.alId ? "id: $id" : "idMal: $id";
  const d = await al(`query($id: Int) { Media(${arg}, type: ANIME) { id title { romaji english } recommendations(perPage: 25, sort: RATING_DESC) { nodes { mediaRecommendation { ${CARD} } } } } }`, { id: seed.alId || seed.malId });
  const recs = (d?.Media?.recommendations.nodes || []).map(n => n.mediaRecommendation).filter(m => m && !isMine(m));
  return recs.length >= 3 ? row(`Because you watched <a class="because" href="#anime/${d.Media.id}">${esc(titleOf(d.Media))}</a>`, recs) : "";
}

function onboarding() {
  return `<section class="onboard fade-in">
    <div><h2>Start your list</h2><p>Open any show and tap an episode to track it. ${T.mal ? "Everything syncs to MyAnimeList." : state.auth.static ? "It's saved in this browser — export it to MyAnimeList from My List any time." : "It's saved on this device right away — connect MyAnimeList any time to sync."}</p></div>
    <div class="actions"><a class="btn primary" href="#browse?season=${currentSeason().season}&year=${currentSeason().year}">Browse this season</a><a class="btn" href="#random">🎲 Surprise me</a></div>
  </section>`;
}

async function pageSearch(q) {
  $("#search").q.value = q;
  view.innerHTML = `<div class="page"><div class="page-h"><div><h1>“${esc(q)}”</h1><p>Searching…</p></div></div>${skGrid(12)}</div>`;
  const data = await al(`query($q: String) { Page(perPage: 40) { media(type: ANIME, search: $q, isAdult: false, sort: SEARCH_MATCH) { ${CARD} } } }`, { q });
  const list = data.Page.media;
  view.innerHTML = `<div class="page fade-in"><div class="page-h"><div><h1>“${esc(q)}”</h1><p>${list.length} result${list.length === 1 ? "" : "s"}</p></div></div>
    ${list.length ? `<div class="grid">${list.map(m => card(m)).join("")}</div>` : `<div class="empty"><h3>No matches</h3><p>Try a different spelling or the Japanese title.</p></div>`}</div>`;
}

// ---------- browse (genre / season / format / sort, URL-driven) ----------
const SORTS = { TRENDING_DESC: "Trending", POPULARITY_DESC: "Popular", SCORE_DESC: "Top rated", START_DATE_DESC: "Newest" };
let browsePage = 1;
async function pageBrowse(append) {
  const p = hashParams();
  const f = { genre: p.get("genre") || "", sort: p.get("sort") || (p.get("season") ? "POPULARITY_DESC" : "TRENDING_DESC"), season: p.get("season") || "", year: p.get("year") || "", format: p.get("format") || "" };
  const link = changes => "#browse?" + new URLSearchParams(Object.entries({ ...f, ...changes }).filter(([, v]) => v)).toString();
  const { season: cs, year: cy } = currentSeason();
  const years = Array.from({ length: cy - 1969 }, (_, i) => cy + 1 - i);
  const sIdx = SEASONS.indexOf(f.season);
  const shift = d => { let i = sIdx + d, y = Number(f.year || cy); if (i < 0) { i = 3; y--; } if (i > 3) { i = 0; y++; } return link({ season: SEASONS[i], year: y }); };
  const title = f.season ? `${cap(f.season)} ${f.year || cy}` : f.genre ? f.genre : "Browse";
  const head = `<div class="page-h"><div><h1>${esc(title)}</h1><p>${[f.genre || "All genres", f.format ? fmt(f.format) : null, SORTS[f.sort]].filter(Boolean).map(esc).join(" · ")}</p></div>
      <div class="season-nav">
        ${f.season ? `<a class="btn sm" href="${shift(-1)}">‹ Prev</a>` : ""}
        <select data-browse="season" aria-label="Season"><option value="">Any season</option>${SEASONS.map(s => `<option value="${s}" ${s === f.season ? "selected" : ""}>${cap(s)}</option>`).join("")}</select>
        <select data-browse="year" aria-label="Year"><option value="">Any year</option>${years.map(y => `<option ${String(y) === f.year ? "selected" : ""}>${y}</option>`).join("")}</select>
        <select data-browse="format" aria-label="Format"><option value="">Any format</option>${Object.entries(FORMATS).map(([k, v]) => `<option value="${k}" ${k === f.format ? "selected" : ""}>${v}</option>`).join("")}</select>
        ${f.season ? `<a class="btn sm" href="${shift(1)}">Next ›</a>` : `<a class="btn sm" href="${link({ season: cs, year: cy })}">This season</a>`}
      </div></div>
    <div class="page-h"><div class="tabs">${Object.entries(SORTS).map(([k, v]) => `<a class="tab ${k === f.sort ? "on" : ""}" href="${link({ sort: k })}">${v}</a>`).join("")}</div></div>
    <div class="page-h"><div class="tabs scroll">${["", ...GENRES].map(g => `<a class="tab ${g === f.genre ? "on" : ""}" href="${link({ genre: g })}">${g || "All genres"}</a>`).join("")}</div></div>`;
  if (!append) { browsePage = 1; view.innerHTML = `<div class="page">${head}${skGrid(18)}</div>`; }
  const vars = {
    page: browsePage, sort: [f.sort], genre: f.genre || undefined, format: f.format || undefined,
    season: f.season || undefined, seasonYear: f.year ? Number(f.year) : f.season ? cy : undefined,
    notYet: f.season || f.year ? undefined : "NOT_YET_RELEASED",
  };
  const data = await al(`query($page: Int, $sort: [MediaSort], $genre: String, $format: MediaFormat, $season: MediaSeason, $seasonYear: Int, $notYet: MediaStatus) {
    Page(page: $page, perPage: 42) { pageInfo { hasNextPage } media(type: ANIME, sort: $sort, genre: $genre, format: $format, season: $season, seasonYear: $seasonYear, isAdult: false, status_not: $notYet) { ${CARD} } } }`, vars);
  const cards = data.Page.media.map(m => card(m)).join("");
  const more = data.Page.pageInfo.hasNextPage ? `<div class="more"><button class="btn" data-more-browse>Load more</button></div>` : "";
  if (append) { $("#browse-grid").insertAdjacentHTML("beforeend", cards); $(".more")?.remove(); $("#browse-grid").insertAdjacentHTML("afterend", more); }
  else view.innerHTML = `<div class="page">${head}${data.Page.media.length ? `<div class="grid fade-in" id="browse-grid">${cards}</div>${more}` : `<div class="empty"><h3>Nothing matches these filters</h3><a class="btn" href="#browse">Reset filters</a></div>`}</div>`;
}

// ---------- weekly airing schedule ----------
async function pageSchedule() {
  view.innerHTML = `<div class="page"><div class="page-h"><div><h1>Airing schedule</h1><p>Loading the next 7 days…</p></div></div>${skGrid(6)}</div>`;
  const start = new Date(); start.setHours(0, 0, 0, 0);
  const from = Math.floor(start / 1000), to = from + 7 * 86400;
  const q = `query($page: Int, $from: Int, $to: Int) { Page(page: $page, perPage: 50) { pageInfo { hasNextPage } airingSchedules(airingAt_greater: $from, airingAt_lesser: $to, sort: TIME) { episode airingAt media { ${CARD} isAdult popularity } } } }`;
  const all = [];
  for (let page = 1; page <= 8; page++) {
    const d = await al(q, { page, from, to });
    all.push(...d.Page.airingSchedules);
    if (!d.Page.pageInfo.hasNextPage) break;
  }
  const mine = await T.all().catch(() => []);
  const mineSet = new Set(mine.flatMap(e => [e.alId && "a" + e.alId, e.malId && "m" + e.malId]).filter(Boolean));
  const isMine = m => mineSet.has("a" + m.id) || (m.idMal && mineSet.has("m" + m.idMal));
  state.icsItems = all.filter(s => !s.media.isAdult && isMine(s.media) && s.airingAt * 1000 > Date.now());
  const items = all.filter(s => !s.media.isAdult && (state.schedMine ? isMine(s.media) : s.media.popularity > 800 || isMine(s.media)));
  const days = new Map();
  for (const s of items) {
    const d = new Date(s.airingAt * 1000); d.setHours(0, 0, 0, 0);
    if (!days.has(+d)) days.set(+d, []);
    days.get(+d).push(s);
  }
  const now = Date.now() / 1000;
  const today = +start;
  const dayName = t => t === today ? "Today" : t === today + 86400000 ? "Tomorrow" : new Date(t).toLocaleDateString([], { weekday: "long" });
  view.innerHTML = `<div class="page fade-in"><div class="page-h"><div><h1>Airing schedule</h1><p>Times in your timezone · next 7 days</p></div>
      <div class="tabs"><button data-sched="all" class="${state.schedMine ? "" : "on"}">All shows</button><button data-sched="mine" class="${state.schedMine ? "on" : ""}">My shows</button>
      ${state.icsItems.length ? `<button data-ics title="Download a calendar file with your shows' air times">📅 Add my shows to calendar</button>` : ""}</div></div>
    <div class="wrap-g">${days.size ? [...days].map(([t, list]) => `<section class="day ${t === today ? "today" : ""}">
      <h2>${dayName(t)} <small>${new Date(t).toLocaleDateString([], { month: "short", day: "numeric" })}</small></h2>
      <div class="sched">${list.map(s => `<a class="sitem ${isMine(s.media) ? "mine" : ""} ${s.airingAt < now ? "past" : ""}" href="#anime/${s.media.id}">
        <time>${clock(s.airingAt)}</time><img loading="lazy" src="${esc(s.media.coverImage?.large)}" alt="">
        <div><b>${esc(titleOf(s.media))}</b><span>EP ${s.episode}${s.media.episodes ? ` of ${s.media.episodes}` : ""}${s.airingAt < now ? " · aired" : ` · in ${until(s.airingAt - now)}`}</span></div>
        ${isMine(s.media) ? `<em>On your list</em>` : ""}</a>`).join("")}</div></section>`).join("")
      : `<div class="empty"><h3>${state.schedMine ? "None of your shows air this week" : "Nothing scheduled"}</h3>${state.schedMine ? `<p>Add airing shows to your Watching list to see them here.</p>` : ""}</div>`}</div></div>`;
  const upNext = $(".sitem:not(.past)");
  if (upNext && upNext !== $(".sitem")) scrollTo({ top: upNext.getBoundingClientRect().top + scrollY - 160, behavior: "instant" });
}

function downloadIcs() {
  const stamp = t => new Date(t).toISOString().replace(/[-:]/g, "").replace(/\.\d{3}/, "");
  const escI = s => String(s).replace(/([,;\\])/g, "\\$1").replace(/\n/g, " ");
  const base = state.auth.static ? location.origin + location.pathname : PAGES_URL;
  const ev = state.icsItems.map(s => ["BEGIN:VEVENT", `UID:anitrack-${s.media.id}-${s.episode}@anitrack`, `DTSTAMP:${stamp(Date.now())}`,
    `DTSTART:${stamp(s.airingAt * 1000)}`, "DURATION:PT24M", `SUMMARY:${escI(`${titleOf(s.media)} — Episode ${s.episode}`)}`,
    `URL:${base}#anime/${s.media.id}`, "BEGIN:VALARM", "TRIGGER:-PT10M", "ACTION:DISPLAY", `DESCRIPTION:${escI(titleOf(s.media))} airs in 10 minutes`, "END:VALARM", "END:VEVENT"].join("\r\n"));
  download("anitrack-schedule.ics", ["BEGIN:VCALENDAR", "VERSION:2.0", "PRODID:-//AniTrack//EN", "CALSCALE:GREGORIAN", "X-WR-CALNAME:AniTrack", ...ev, "END:VCALENDAR"].join("\r\n") + "\r\n", "text/calendar");
  toast(`${state.icsItems.length} episode${state.icsItems.length === 1 ? "" : "s"} exported — open the file to add them to your calendar`);
}

// ---------- my list ----------
async function pageMyList() {
  view.innerHTML = `<div class="page"><div class="page-h"><div><h1>My List</h1></div></div>${skGrid(12)}</div>`;
  const all = await T.all(true);
  const counts = Object.fromEntries(Object.keys(STATUSES).map(k => [k, all.filter(e => e.status === k).length]));
  if (!state.listChosen && !counts[state.listStatus]) state.listStatus = Object.keys(STATUSES).find(k => counts[k]) || "watching";
  let list = all.filter(e => e.status === state.listStatus);
  await enrich(all.filter(e => e.status === state.listStatus || all.length <= 400)).catch(() => {});
  const sorters = {
    updated: (a, b) => b.updated - a.updated,
    title: (a, b) => a.title.localeCompare(b.title),
    score: (a, b) => b.score - a.score,
    progress: (a, b) => (b.total ? b.watched / b.total : 0) - (a.total ? a.watched / a.total : 0),
    fresh: (a, b) => Math.max(0, (b.aired ?? 0) - b.watched) - Math.max(0, (a.aired ?? 0) - a.watched),
  };
  list.sort(sorters[state.listSort] || sorters.updated);

  const eps = all.reduce((s, e) => s + (e.watched || 0), 0);
  const scored = all.filter(e => e.score);
  const mean = scored.length ? (scored.reduce((s, e) => s + e.score, 0) / scored.length).toFixed(2) : "—";
  const days = (eps * 23.5 / 60 / 24).toFixed(1);
  const pendingLocal = T.mal ? local.all().filter(e => e.malId) : [];

  const banner = T.mal
    ? pendingLocal.length ? `<div class="notice"><div><b>${pendingLocal.length} show${pendingLocal.length > 1 ? "s" : ""} tracked on this device before you connected.</b> Copy them into your MyAnimeList list?</div><button class="btn sm primary" data-sync>Sync to MAL</button></div>` : ""
    : `<div class="notice"><div><b>Your list is saved in this browser.</b> ${state.auth.configured ? "Connect MyAnimeList to sync it to your profile." : state.auth.static ? "To update your MyAnimeList profile, click Export for MAL and upload the file at myanimelist.net/import.php. (Live MAL sync works when you run AniTrack on your computer.)" : "To sync with your MyAnimeList profile, add a MAL Client ID (see README) — or export it for MAL's import page."}</div>
       <div class="actions">${state.auth.configured ? `<a class="btn sm primary" href="/auth/login">Connect MAL</a>` : state.auth.static ? `<a class="btn sm" href="https://myanimelist.net/import.php" target="_blank" rel="noopener">MAL import page ↗</a>` : `<a class="btn sm" href="https://myanimelist.net/apiconfig" target="_blank" rel="noopener">Get MAL Client ID ↗</a>`}
       <button class="btn sm" data-export="mal" ${all.length ? "" : "disabled"}>Export for MAL</button><button class="btn sm" data-export="json" ${all.length ? "" : "disabled"}>Backup</button><label class="btn sm">Restore<input type="file" accept=".json" data-import hidden></label></div></div>`;

  view.innerHTML = `<div class="page fade-in">
    <div class="page-h"><div><h1>My List</h1><p>${T.mal ? `Synced with MyAnimeList${state.user ? ` · ${esc(state.user.name)}` : ""}` : "Saved on this device"}</p></div>
      ${all.length ? `<button class="btn sm" data-share-list>🔗 Share my list</button>` : ""}</div>
    <div class="stats">
      <div><b>${all.length}</b><span>Shows</span></div><div><b>${eps.toLocaleString()}</b><span>Episodes</span></div>
      <div><b>${days}</b><span>Days watched</span></div><div><b>${mean}</b><span>Mean score</span></div>
    </div>
    ${insights(all, counts)}
    ${activityPanel()}
    ${banner}
    <div class="page-h"><div class="tabs">${Object.entries(STATUSES).map(([k, v]) => `<button data-list="${k}" class="${k === state.listStatus ? "on" : ""}">${v} <i>${counts[k]}</i></button>`).join("")}</div>
      <select data-sort-list aria-label="Sort">${Object.entries({ updated: "Recently updated", fresh: "New episodes", progress: "Progress", score: "Your score", title: "Title" })
        .map(([k, v]) => `<option value="${k}" ${k === state.listSort ? "selected" : ""}>${v}</option>`).join("")}</select>
      <div class="seg" role="group" aria-label="View"><button data-view="grid" class="${state.listView === "grid" ? "on" : ""}" title="Poster grid">▦</button><button data-view="table" class="${state.listView === "table" ? "on" : ""}" title="Compact list">☰</button></div></div>
    ${list.length ? state.listView === "table" ? `<div class="ltable">${list.map(listRow).join("")}</div>` : `<div class="grid">${list.map(entryCard).join("")}</div>`
      : `<div class="empty"><h3>Nothing in ${STATUSES[state.listStatus]}</h3><p>Open any show and tap an episode, or use “＋ My List”.</p><a class="btn" href="#home">Explore</a></div>`}
  </div>`;
}

const STATUS_COLORS = { watching: "#8b5cf6", completed: "#34d399", plan_to_watch: "#60a5fa", on_hold: "#fbbf24", dropped: "#f87171" };
function insights(all, counts) {
  if (all.length < 2) return "";
  const g = new Map();
  all.forEach(e => (e.genres || []).forEach(x => g.set(x, (g.get(x) || 0) + 1)));
  const top = [...g].sort((a, b) => b[1] - a[1]).slice(0, 8);
  const max = top[0]?.[1] || 1;
  const fav = all.filter(e => e.score).sort((a, b) => b.score - a.score)[0];
  return `<section class="insights fade-in">
    <div class="panel"><h3>Status breakdown</h3>
      <div class="stack">${Object.keys(STATUSES).filter(k => counts[k]).map(k => `<i style="flex:${counts[k]};background:${STATUS_COLORS[k]}" title="${STATUSES[k]}: ${counts[k]}"></i>`).join("")}</div>
      <ul class="legend">${Object.entries(STATUSES).map(([k, v]) => `<li><i style="background:${STATUS_COLORS[k]}"></i>${v}<b>${counts[k]}</b></li>`).join("")}</ul>
      ${fav ? `<p class="fav">Highest rated: <a href="${linkOf(fav)}">${esc(fav.title)}</a> <span>★ ${fav.score}</span></p>` : ""}
    </div>
    ${top.length ? `<div class="panel"><h3>Your top genres</h3><div class="gbars">${top.map(([name, n]) => `<a href="#browse?genre=${encodeURIComponent(name)}" class="gbar"><span>${esc(name)}</span><div><i style="width:${(n / max) * 100}%"></i></div><b>${n}</b></a>`).join("")}</div></div>` : ""}
  </section>`;
}

const relTime = t => {
  const s = (Date.now() - t) / 1000;
  return s < 60 ? "just now" : s < 3600 ? `${Math.floor(s / 60)}m ago` : s < 86400 ? `${Math.floor(s / 3600)}h ago` : s < 604800 ? `${Math.floor(s / 86400)}d ago` : new Date(t).toLocaleDateString([], { month: "short", day: "numeric" });
};
function activityPanel() {
  const h = history_.read();
  if (!h.length) return "";
  const dayKey = t => { const d = new Date(t); d.setHours(0, 0, 0, 0); return +d; };
  const per = new Map();
  h.filter(e => e.kind === "ep").forEach(e => per.set(dayKey(e.t), (per.get(dayKey(e.t)) || 0) + (e.to - e.from + 1)));
  const days = Array.from({ length: 30 }, (_, i) => { const d = new Date(); d.setHours(0, 0, 0, 0); d.setDate(d.getDate() - (29 - i)); return +d; });
  const counts = days.map(d => per.get(d) || 0);
  const max = Math.max(1, ...counts);
  const total = counts.reduce((a, b) => a + b, 0);
  let streak = 0;
  for (let i = days.length - 1 - (counts[days.length - 1] ? 0 : 1); i >= 0 && counts[i]; i--) streak++;
  const recent = h.slice(-12).reverse();
  const line = e => e.kind === "ep" ? `Watched ${e.from === e.to ? `EP ${e.to}` : `EP ${e.from}–${e.to}`}` : e.kind === "done" ? "🎉 Completed" : `Added to ${STATUSES[e.status] || "list"}`;
  return `<section class="activity fade-in">
    <div class="panel"><h3>Last 30 days</h3>
      <div class="act-sum"><div><b>${total}</b><span>episodes</span></div><div><b>${streak}</b><span>day streak${streak ? " 🔥" : ""}</span></div><div><b>${counts.filter(Boolean).length}</b><span>active days</span></div></div>
      <div class="spark">${days.map((d, i) => `<i style="height:${counts[i] ? 12 + (counts[i] / max) * 88 : 4}%" class="${counts[i] ? "" : "zero"}" title="${new Date(d).toLocaleDateString([], { month: "short", day: "numeric" })}: ${counts[i]} ep${counts[i] === 1 ? "" : "s"}"></i>`).join("")}</div>
      <div class="spark-x"><span>30 days ago</span><span>Today</span></div>
    </div>
    <div class="panel"><h3>Recent activity</h3><ul class="feed">${recent.map(e => `<li><a href="${e.alId ? `#anime/${e.alId}` : `#mal/${e.malId}`}"><img loading="lazy" src="${esc(e.cover)}" alt=""><div><b>${esc(e.title)}</b><span>${line(e)}</span></div><time>${relTime(e.t)}</time></a></li>`).join("")}</ul></div>
  </section>`;
}

// ---------- shareable list links ----------
const SCODE = { watching: "w", completed: "c", plan_to_watch: "p", on_hold: "h", dropped: "d" };
const SREV = Object.fromEntries(Object.entries(SCODE).map(([k, v]) => [v, k]));
const PAGES_URL = "https://eddyarriaga00.github.io/anitrack/";
const b64u = bytes => { let s = ""; bytes.forEach(b => (s += String.fromCharCode(b))); return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, ""); };
const unb64u = str => { let s = str.replace(/-/g, "+").replace(/_/g, "/"); while (s.length % 4) s += "="; return Uint8Array.from(atob(s), c => c.charCodeAt(0)); };
const pipe = async (bytes, stream) => new Uint8Array(await new Response(new Blob([bytes]).stream().pipeThrough(stream)).arrayBuffer());
async function encodeList(entries) {
  const d = entries.filter(e => e.alId).map(e => [e.alId, SCODE[e.status] || "p", e.watched || 0, e.score || 0]);
  const bytes = new TextEncoder().encode(JSON.stringify({ v: 1, n: state.user?.name || "", d }));
  return window.CompressionStream ? "z" + b64u(await pipe(bytes, new CompressionStream("deflate-raw"))) : "j" + b64u(bytes);
}
async function decodeList(code) {
  let bytes = unb64u(code.slice(1));
  if (code[0] === "z") bytes = await pipe(bytes, new DecompressionStream("deflate-raw"));
  return JSON.parse(new TextDecoder().decode(bytes));
}
async function shareList(btn) {
  btn.disabled = true; btn.textContent = "Making link…";
  try {
    const all = await T.all();
    await enrich(all.filter(e => !e.alId)).catch(() => {});
    const url = (state.auth.static ? location.origin + location.pathname : PAGES_URL) + "#shared/" + await encodeList(all);
    if (navigator.share && matchMedia("(hover: none)").matches) await navigator.share({ title: "My anime list", url }).catch(() => {});
    else { await navigator.clipboard.writeText(url); toast(`Link to your ${all.length}-show list copied`); }
  } catch (err) { toast("Couldn't make a share link: " + err.message, "err"); }
  btn.disabled = false; btn.textContent = "🔗 Share my list";
}
async function pageShared(code) {
  view.innerHTML = `<div class="page"><div class="page-h"><div><h1>Shared list</h1><p>Loading…</p></div></div>${skGrid(12)}</div>`;
  const data = await decodeList(code).catch(() => null);
  if (!data?.d) throw new Error("This shared-list link is broken or got cut off. Ask for the link again.");
  const items = data.d.map(([id, s, w, sc]) => ({ id, status: SREV[s] || "plan_to_watch", w, sc }));
  const media = new Map();
  for (let i = 0; i < items.length; i += 50) {
    const d = await al(`query($ids: [Int]) { Page(perPage: 50) { media(id_in: $ids, type: ANIME) { ${CARD} } } }`, { ids: items.slice(i, i + 50).map(x => x.id) });
    d.Page.media.forEach(m => media.set(m.id, m));
  }
  const known = items.filter(x => media.has(x.id));
  const counts = Object.fromEntries(Object.keys(STATUSES).map(k => [k, known.filter(x => x.status === k).length]));
  const tab = state.sharedStatus && counts[state.sharedStatus] ? state.sharedStatus : Object.keys(STATUSES).find(k => counts[k]) || "watching";
  const common = known.filter(x => isMine(media.get(x.id))).length;
  const scored = known.filter(x => x.sc);
  const mean = scored.length ? (scored.reduce((a, x) => a + x.sc, 0) / scored.length).toFixed(1) : null;
  const shown = known.filter(x => x.status === tab).sort((a, b) => b.sc - a.sc);
  document.title = `${data.n ? data.n + "'s" : "Shared"} anime list · AniTrack`;
  view.innerHTML = `<div class="page fade-in"><div class="page-h"><div><div class="kicker">Shared list</div><h1>${data.n ? `${esc(data.n)}'s anime list` : "Someone's anime list"}</h1>
      <p>${known.length} shows${mean ? ` · mean score ${mean}` : ""}${common ? ` · <b class="hot">${common} also on your list</b>` : ""}</p></div></div>
    <div class="page-h"><div class="tabs">${Object.entries(STATUSES).map(([k, v]) => `<button data-shared="${k}" class="${k === tab ? "on" : ""}">${v} <i>${counts[k]}</i></button>`).join("")}</div></div>
    <div class="grid">${shown.map(x => { const m = media.get(x.id); return card(m, `<span class="badge next">${x.sc ? `★ ${x.sc} · ` : ""}${x.w}/${m.episodes || "?"} eps</span>`); }).join("")}</div></div>`;
}

// ---------- studio ----------
let studioPage = 1;
async function pageStudio(id, append) {
  if (!append) { studioPage = 1; view.innerHTML = `<div class="page"><div class="page-h"><div><h1>Studio</h1><p>Loading…</p></div></div>${skGrid(12)}</div>`; }
  const d = await al(`query($id: Int, $page: Int) { Studio(id: $id) { name isAnimationStudio favourites siteUrl
    media(sort: [START_DATE_DESC], isMain: true, page: $page, perPage: 42) { pageInfo { hasNextPage total } nodes { ${CARD} isAdult type } } } }`, { id: Number(id), page: studioPage });
  const st = d.Studio;
  if (!st) throw new Error("Studio not found.");
  const list = st.media.nodes.filter(m => !m.isAdult && m.type === "ANIME");
  const more = st.media.pageInfo.hasNextPage ? `<div class="more"><button class="btn" data-more-studio="${id}">Load more</button></div>` : "";
  document.title = `${st.name} · AniTrack`;
  if (append) { $("#studio-grid").insertAdjacentHTML("beforeend", list.map(m => card(m)).join("")); $(".more")?.remove(); $("#studio-grid").insertAdjacentHTML("afterend", more); return; }
  const best = [...list].filter(m => m.averageScore).sort((a, b) => b.averageScore - a.averageScore).slice(0, 3);
  view.innerHTML = `<div class="page fade-in"><div class="page-h"><div><div class="kicker">${st.isAnimationStudio ? "Animation studio" : "Producer"}</div><h1>${esc(st.name)}</h1>
      <p>${st.favourites ? `♥ ${st.favourites.toLocaleString()} fans on AniList` : ""}${best.length ? ` · Best rated: ${best.map(m => esc(titleOf(m))).join(", ")}` : ""}</p></div>
      <a class="btn sm" href="${esc(st.siteUrl)}" target="_blank" rel="noopener">AniList ↗</a></div>
    <div class="grid" id="studio-grid">${list.map(m => card(m)).join("")}</div>${more}</div>`;
}

// ---------- character ----------
function cleanMd(t) {
  return cleanText(String(t || "")
    .replace(/~![\s\S]*?!~/g, "")
    .replace(/__(.+?)__/g, "$1").replace(/\*\*(.+?)\*\*/g, "$1")
    .replace(/\[([^\]]+)\]\([^)]+\)/g, "$1"));
}
async function pageCharacter(id) {
  view.innerHTML = `<div class="page"><div class="wrap"><div class="sk" style="width:200px;aspect-ratio:2/3"></div></div></div>`;
  const d = await al(`query($id: Int) { Character(id: $id) { id name { full native alternative } image { large } description age gender bloodType
    dateOfBirth { month day } favourites siteUrl
    media(sort: POPULARITY_DESC, perPage: 30, type: ANIME) { edges { characterRole voiceActors(language: JAPANESE) { id name { full } image { medium } } node { ${CARD} isAdult } } } } }`, { id: Number(id) });
  const c = d.Character;
  if (!c) throw new Error("Character not found.");
  document.title = `${c.name.full} · AniTrack`;
  const edges = (c.media?.edges || []).filter(e => !e.node.isAdult);
  const va = edges.find(e => e.voiceActors?.length)?.voiceActors[0];
  const bday = c.dateOfBirth?.month ? new Date(2000, c.dateOfBirth.month - 1, c.dateOfBirth.day || 1).toLocaleDateString([], { month: "long", ...(c.dateOfBirth.day ? { day: "numeric" } : {}) }) : null;
  const facts = [["Age", c.age], ["Gender", c.gender], ["Birthday", bday], ["Blood type", c.bloodType], ["Voice (JP)", va?.name.full], ["Fans", c.favourites ? `♥ ${c.favourites.toLocaleString()}` : null]].filter(([, v]) => v);
  const desc = cleanMd(c.description);
  view.innerHTML = `<div class="page fade-in"><div class="wrap char-page">
    <img class="d-cover" src="${esc(c.image?.large)}" alt="">
    <div>
      <div class="kicker">Character</div>
      <h1>${esc(c.name.full)}</h1>
      <div class="alt">${esc([c.name.native, ...(c.name.alternative || []).slice(0, 3)].filter(Boolean).join(" · "))}</div>
      ${facts.length ? `<dl class="info facts">${facts.map(([k, v]) => `<dt>${k}</dt><dd>${esc(v)}</dd>`).join("")}</dl>` : ""}
      ${desc ? `<div class="synopsis ${desc.length > 700 ? "clamp" : ""}" id="syn">${esc(desc)}</div>${desc.length > 700 ? `<button class="link" data-more style="margin-top:8px">Read more</button>` : ""}` : ""}
      <p class="note small" style="margin-top:14px">Spoilers hidden. <a class="link" href="${esc(c.siteUrl)}" target="_blank" rel="noopener">Full profile on AniList ↗</a></p>
    </div></div>
    ${edges.length ? `<div class="page-h" style="margin-top:36px"><h2>Appears in</h2></div><div class="grid">${edges.map(e => card(e.node, `<span class="badge next">${e.characterRole === "MAIN" ? "Main role" : e.characterRole === "SUPPORTING" ? "Supporting" : "Background"}</span>`)).join("")}</div>` : ""}
  </div>`;
}

// ---------- random ----------
async function pageRandom() {
  view.innerHTML = `<div class="page"><div class="empty"><h3>🎲 Rolling…</h3></div></div>`;
  const page = 1 + Math.floor(Math.random() * 400);
  const d = await al(`query($page: Int) { Page(page: $page, perPage: 1) { media(type: ANIME, sort: POPULARITY_DESC, isAdult: false, format_in: [TV, MOVIE, ONA, OVA]) { id } } }`, { page });
  alCache.clear(); try { Object.keys(sessionStorage).filter(k => k.startsWith("al:") && k.includes("Page(page: $page, perPage: 1)")).forEach(k => sessionStorage.removeItem(k)); } catch {}
  location.replace(`#anime/${d.Page.media[0].id}`);
}

// =============== detail ===============
const cur = { m: null, e: null, ref: null };
async function pageDetail(kind, id) {
  view.innerHTML = `<div class="sk" style="height:42vh;border-radius:0"></div><div class="wrap" style="margin-top:-120px;position:relative"><div class="sk" style="width:200px;aspect-ratio:2/3"></div></div>`;
  const arg = kind === "mal" ? "idMal: $id" : "id: $id";
  const data = await al(`query($id: Int) { Media(${arg}, type: ANIME) {
    ${CARD} title { native } description genres duration source season episodes synonyms
    startDate { year month day } endDate { year month day } studios(isMain: true) { nodes { id name } }
    trailer { id site } rankings { rank type allTime context season year }
    externalLinks { site url type icon color language }
    streamingEpisodes { title thumbnail url site }
    tags { name rank isMediaSpoiler }
    characters(perPage: 12, sort: [ROLE, RELEVANCE]) { edges { role node { id name { full } image { medium } } voiceActors(language: JAPANESE) { name { full } } } }
    relations { edges { relationType(version: 2) node { ${CARD} type } } }
    recommendations(perPage: 16, sort: RATING_DESC) { nodes { mediaRecommendation { ${CARD} } } }
  } }`, { id: Number(id) });
  const m = data.Media;
  if (!m) throw new Error("This show isn't on AniList.");
  if (kind === "mal") history.replaceState(null, "", `#anime/${m.id}`);
  cur.m = m; cur.ref = refOf(m);
  cur.e = T.canTrack(cur.ref) ? await T.get(cur.ref).catch(() => null) : null;

  const next = m.nextAiringEpisode;
  const studio = m.studios?.nodes?.[0];
  const date = d => d?.year ? new Date(d.year, (d.month || 1) - 1, d.day || 1).toLocaleDateString(undefined, { year: "numeric", month: "short", ...(d.day ? { day: "numeric" } : {}) }) : null;
  const streams = (m.externalLinks || []).filter(l => l.type === "STREAMING");
  const official = (m.externalLinks || []).find(l => l.site === "Official Site");
  const related = (m.relations?.edges || []).filter(e => e.node.type === "ANIME").map(e => ({ ...e.node, _rel: e.relationType }));
  const recs = (m.recommendations?.nodes || []).map(n => n.mediaRecommendation).filter(Boolean);
  const chars = m.characters?.edges || [];
  const tags = (m.tags || []).filter(t => !t.isMediaSpoiler && t.rank >= 60).slice(0, 10);
  const rank = (m.rankings || []).filter(r => r.allTime).sort((a, b) => a.rank - b.rank)[0];
  const info = [
    ["Format", fmt(m.format)], ["Episodes", m.episodes], ["Duration", m.duration ? `${m.duration} min` : null],
    ["Status", statusNote(m.status)], ["Aired", [date(m.startDate), date(m.endDate)].filter(Boolean).join(" – ") || null],
    ["Season", m.season ? `${cap(m.season)} ${m.seasonYear}` : null],
    ["Studio", studio ? { html: `<a class="link" href="#studio/${studio.id}">${esc(studio.name)}</a>` } : null], ["Source", m.source ? cap(m.source.replace(/_/g, " ")) : null],
    ["Score", m.averageScore ? `${score(m.averageScore)} / 10` : null],
    ["Rank", rank ? `#${rank.rank} ${rank.context.replace("all time", "").trim()}` : null],
  ].filter(([, v]) => v);
  const desc = cleanText(m.description);
  const relLabel = r => cap(String(r || "").replace(/_/g, " "));

  view.innerHTML = `<article class="detail fade-in" style="--c:${esc(m.coverImage?.color || "#1c1c29")}">
    <div class="d-banner" style="background-image:url('${esc(m.bannerImage || m.coverImage?.extraLarge)}')"></div>
    <div class="wrap d-head">
      <img class="d-cover" src="${esc(m.coverImage?.extraLarge || m.coverImage?.large)}" alt="">
      <div class="d-title">
        <div class="chips">
          ${m.averageScore ? `<span class="chip score">★ ${score(m.averageScore)}</span>` : ""}
          <span class="chip">${esc(fmt(m.format))}</span>
          ${next ? `<span class="chip live">EP ${next.episode} in ${until(next.timeUntilAiring)}</span>` : `<span class="chip">${esc(statusNote(m.status))}</span>`}
          ${(m.genres || []).map(g => `<a class="chip link-chip" href="#browse?genre=${encodeURIComponent(g)}">${esc(g)}</a>`).join("")}
        </div>
        <h1>${esc(titleOf(m))}</h1>
        <div class="alt">${esc([m.title.native, m.title.english && m.title.romaji !== m.title.english ? m.title.romaji : null].filter(Boolean).join(" · "))}</div>
        <div class="actions">
          ${m.trailer?.site === "youtube" ? `<button class="btn primary" data-trailer="${esc(m.trailer.id)}">▶ Watch trailer</button>` : ""}
          <button class="btn" data-share>Share</button>
          ${m.idMal ? `<a class="btn" href="https://myanimelist.net/anime/${m.idMal}" target="_blank" rel="noopener">MyAnimeList ↗</a>` : ""}
          <a class="btn" href="https://anilist.co/anime/${m.id}" target="_blank" rel="noopener">AniList ↗</a>
        </div>
      </div>
    </div>
    <div class="wrap d-grid">
      <aside class="d-side">
        <div class="panel"><h3>Your progress ${T.mal ? `<span class="pill">MAL</span>` : `<span class="pill dim">This device</span>`}</h3><div id="tracker"></div></div>
        ${streams.length || official ? `<div class="panel"><h3>Where to watch</h3><div class="watch">
          ${streams.map(l => `<a href="${esc(l.url)}" target="_blank" rel="noopener" style="--lc:${esc(l.color || "#8b5cf6")}">${l.icon ? `<img src="${esc(l.icon)}" alt="">` : ""}${esc(l.site)}${l.language ? ` <small>${esc(l.language)}</small>` : ""}<span>↗</span></a>`).join("")}
          ${official ? `<a href="${esc(official.url)}" target="_blank" rel="noopener">Official site<span>↗</span></a>` : ""}
        </div></div>` : ""}
        <div class="panel"><h3>Details</h3><dl class="info">${info.map(([k, v]) => `<dt>${k}</dt><dd>${v.html || esc(v)}</dd>`).join("")}</dl>
          ${m.synonyms?.length ? `<p class="syn">Also known as: ${esc(m.synonyms.slice(0, 4).join(", "))}</p>` : ""}</div>
      </aside>
      <div class="d-main">
        ${desc ? `<section class="sec"><h2>Synopsis</h2><div class="synopsis ${desc.length > 600 ? "clamp" : ""}" id="syn">${esc(desc)}</div>
          ${desc.length > 600 ? `<button class="link" data-more style="margin-top:8px">Read more</button>` : ""}
          ${tags.length ? `<div class="tags">${tags.map(t => `<span>${esc(t.name)}</span>`).join("")}</div>` : ""}</section>` : ""}
        <section class="sec" id="episodes"></section>
        ${m.trailer?.site === "youtube" ? `<section class="sec"><h2>Trailer</h2>
          <div class="trailer" data-inline-trailer="${esc(m.trailer.id)}" style="background-image:url('https://i.ytimg.com/vi/${esc(m.trailer.id)}/hqdefault.jpg')">
          <div class="play"><svg viewBox="0 0 24 24" width="30" height="30"><path fill="#fff" d="M8 5v14l11-7z"/></svg></div></div></section>` : ""}
        ${chars.length ? `<section class="sec"><h2>Characters</h2><div class="chars">${chars.map(c => `<a class="char" href="#character/${c.node.id}"><img loading="lazy" src="${esc(c.node.image?.medium)}" alt=""><div><b>${esc(c.node.name?.full)}</b><span>${c.role === "MAIN" ? "Main" : "Supporting"}${c.voiceActors?.[0] ? ` · CV ${esc(c.voiceActors[0].name.full)}` : ""}</span></div></a>`).join("")}</div></section>` : ""}
        ${related.length ? row("Franchise", [...related, { ...m, _rel: "CURRENT" }].sort((a, b) => (a.seasonYear || 9999) - (b.seasonYear || 9999)),
          r => r._rel === "CURRENT" ? card(r, `<span class="badge here">You're here</span>`) : card(r, `<span class="badge next">${esc(relLabel(r._rel))} · ${r.seasonYear || "TBA"}</span>`), "in release order") : ""}
        ${row("You might also like", recs)}
      </div>
    </div>
  </article>`;
  renderTracker();
}

function epCounts() {
  const m = cur.m, w = cur.e?.watched || 0;
  const aired = airedOf(m), total = m.episodes || 0;
  return { aired, total, w, shown: Math.max(total, aired, w) };
}

function renderTracker() {
  const m = cur.m, el = $("#tracker"), epEl = $("#episodes");
  if (!el) return;
  const { aired, total, w, shown } = epCounts();
  const trackable = T.canTrack(cur.ref);
  const e = cur.e;

  if (!trackable) el.innerHTML = `<p class="note">This title isn't on MyAnimeList yet, so it can't be synced.</p>`;
  else {
    const nextEp = w + 1;
    const canNext = nextEp <= Math.max(aired, total && m.status === "FINISHED" ? total : 0);
    el.innerHTML = `<div class="tracker">
      ${canNext ? `<button class="btn primary wide" data-step="1">✓ Watched episode ${nextEp}</button>` : e?.status === "completed" ? `<div class="done">✓ Completed</div>` : ""}
      <div class="prog"><button data-step="-1" aria-label="One episode less">−</button>
        <div class="num">${w}<small> / ${total || "?"}</small></div>
        <button class="inc" data-step="1" aria-label="One episode more">+</button></div>
      ${total ? `<div class="bar" style="margin:0"><i style="width:${Math.min(100, (w / total) * 100)}%"></i></div>` : ""}
      <label>Status<select data-field="status"><option value="">Not on list</option>${Object.entries(STATUSES).map(([k, v]) => `<option value="${k}" ${k === e?.status ? "selected" : ""}>${v}</option>`).join("")}</select></label>
      <label>Your score<select data-field="score"><option value="0">No score</option>${[10, 9, 8, 7, 6, 5, 4, 3, 2, 1].map(n => `<option value="${n}" ${e?.score === n ? "selected" : ""}>${n} — ${SCORE_WORDS[n]}</option>`).join("")}</select></label>
      ${e ? `<details class="more-d" ${cur.moreOpen ? "open" : ""}><summary>Dates, rewatches &amp; notes${e.started ? ` <small>· started ${esc(niceDate(e.started))}${e.finished ? `, finished ${esc(niceDate(e.finished))}` : ""}</small>` : ""}</summary>
        <div class="two"><label>Started<input type="date" data-field="started" value="${esc(e.started || "")}"></label><label>Finished<input type="date" data-field="finished" value="${esc(e.finished || "")}"></label></div>
        <label>Times rewatched<input type="number" min="0" max="99" data-field="rewatches" value="${e.rewatches || 0}"></label>
        <label>Notes<textarea data-field="notes" rows="3" maxlength="2000" placeholder="Thoughts, favorite moments, where you left off…">${esc(e.notes || "")}</textarea></label>
      </details>` : ""}
      <div class="saved" id="saved"></div>
      ${!T.mal ? `<p class="note small">Saved on this device. ${state.auth.configured ? `<a class="link" href="/auth/login">Connect MAL</a> to sync.` : `<a class="link" href="#mylist">Send to MAL</a>`}</p>` : ""}
      ${e ? `<button class="link" data-remove>Remove from list</button>` : ""}
    </div>`;
  }

  if (!epEl) return;
  if (!shown) { epEl.innerHTML = ""; return; }
  const thumbs = (m.streamingEpisodes || []).map(s => ({ ...s, n: Number((s.title.match(/Episode\s+(\d+)/i) || [])[1]) })).filter(s => s.n).sort((a, b) => a.n - b.n);
  const next = m.nextAiringEpisode;
  epEl.innerHTML = `<div class="eps-h"><h2>Episodes</h2><p>${trackable ? "Tap an episode to mark everything up to it watched." : total ? `${aired} of ${total} aired` : `${aired} aired`}${next ? ` · EP ${next.episode} airs ${new Date(next.airingAt * 1000).toLocaleDateString([], { weekday: "short", month: "short", day: "numeric" })} at ${clock(next.airingAt)}` : ""}</p></div>
    ${thumbs.length ? `<div class="ep-thumbs">${thumbs.slice(0, 60).map(s => `<a class="ept ${s.n <= w ? "w" : ""}" href="${esc(s.url)}" target="_blank" rel="noopener" title="Watch on ${esc(s.site)}">
        <div class="ept-img" style="background-image:url('${esc(s.thumbnail)}')">${s.n <= w ? `<span class="ck">✓</span>` : ""}</div>
        <b>${esc(s.title.replace(/^Episode\s+\d+\s*-\s*/i, ""))}</b><span>EP ${s.n} · ${esc(s.site)} ↗</span></a>`).join("")}</div>` : ""}
    <div class="eps">${Array.from({ length: shown }, (_, i) => i + 1).map(n =>
      `<button data-ep="${n}" class="${n <= w ? "w" : ""} ${n === w ? "cur" : ""}" ${!trackable || n > Math.max(aired, w, m.status === "FINISHED" ? total : 0) ? "disabled" : ""} title="Episode ${n}">${n}</button>`).join("")}</div>`;
}

async function updateEntry(fields, msg) {
  const saved = $("#saved"); if (saved) saved.textContent = "Saving…";
  try {
    cur.e = await track(cur.ref, cur.e, fields);
    renderTracker();
    $("#saved") && ($("#saved").textContent = T.mal ? "✓ Synced to MyAnimeList" : "✓ Saved");
    if (msg) toast(msg);
  } catch (err) { toast(err.message, "err"); if (saved) saved.textContent = ""; }
}

function setProgress(n) {
  const f = progressFields({ ...cur.ref, ...(cur.e || {}), total: cur.m.episodes || 0 }, n);
  const done = f.status === "completed" && cur.e?.status !== "completed";
  updateEntry(f, done ? `🎉 Completed ${titleOf(cur.m)}!` : f.watched ? `Episode ${f.watched} logged` : null);
}

// =============== trailer player ===============
function openTrailer(id) {
  $("#player-frame").src = `https://www.youtube-nocookie.com/embed/${encodeURIComponent(id)}?autoplay=1&rel=0`;
  $("#player").showModal();
}
$("#player").addEventListener("close", () => ($("#player-frame").src = "about:blank"));

// =============== import / export / sync ===============
const MAL_XML_STATUS = { watching: "Watching", completed: "Completed", on_hold: "On-Hold", dropped: "Dropped", plan_to_watch: "Plan to Watch" };
async function exportList(kind) {
  const all = await T.all();
  if (kind === "json") return download("anitrack-backup.json", JSON.stringify(local.read(), null, 2), "application/json");
  const rows = all.filter(e => e.malId).map(e => `  <anime>
    <series_animedb_id>${e.malId}</series_animedb_id>
    <series_title><![CDATA[${String(e.title).replace(/]]>/g, "]]]]><![CDATA[>")}]]></series_title>
    <my_watched_episodes>${e.watched || 0}</my_watched_episodes>
    <my_score>${e.score || 0}</my_score>
    <my_status>${MAL_XML_STATUS[e.status] || "Plan to Watch"}</my_status>
    <update_on_import>1</update_on_import>
  </anime>`).join("\n");
  download("anitrack-mal-import.xml", `<?xml version="1.0" encoding="UTF-8" ?>\n<myanimelist>\n  <myinfo><user_export_type>1</user_export_type></myinfo>\n${rows}\n</myanimelist>\n`, "application/xml");
  toast("Exported — upload it at myanimelist.net/import.php");
}
async function importBackup(file) {
  try {
    const data = JSON.parse(await file.text());
    const cur = local.read();
    let n = 0;
    for (const [k, v] of Object.entries(data)) if (k.startsWith("al:") && v?.alId) { cur[k] = v; n++; }
    local.write(cur); toast(`Restored ${n} shows`); route();
  } catch { toast("That file isn't an AniTrack backup", "err"); }
}
async function syncLocalToMal(btn) {
  const entries = local.all().filter(e => e.malId);
  btn.disabled = true;
  let ok = 0; const done = [];
  for (const e of entries) {
    btn.textContent = `Syncing ${ok + 1}/${entries.length}…`;
    try { await T.save(e, { status: e.status, watched: e.watched, score: e.score, started: e.started, finished: e.finished, rewatches: e.rewatches, notes: e.notes }); ok++; done.push("al:" + e.alId); } catch {}
    await sleep(250);
  }
  local.clear(done); T.cache = null;
  toast(`Synced ${ok} of ${entries.length} shows to MyAnimeList`, ok === entries.length ? "ok" : "err");
  route();
}

// =============== router ===============
let routeToken = 0;
async function route(opts = {}) {
  const token = ++routeToken;
  clearInterval(state.heroTimer);
  const path = location.hash.slice(1).split("?")[0];
  const [tab, ...rest] = path.split("/");
  const arg = decodeURIComponent(rest.join("/"));
  $$("nav a").forEach(a => a.classList.toggle("on", a.dataset.tab === (tab || "home")));
  if (tab !== "search" && document.activeElement !== $("#search").q) $("#search").q.value = "";
  if (!opts.keepScroll) window.scrollTo({ top: 0, behavior: "instant" });
  document.body.classList.add("loading");
  closeSuggest();
  await refreshMine();
  document.title = { browse: "Browse", schedule: "Schedule", mylist: "My List", search: `Search: ${arg}` }[tab] ? `${{ browse: "Browse", schedule: "Schedule", mylist: "My List", search: `Search: ${arg}` }[tab]} · AniTrack` : "AniTrack";
  try {
    if (tab === "anime" || tab === "mal") { await pageDetail(tab, arg); document.title = `${titleOf(cur.m)} · AniTrack`; }
    else if (tab === "search" && arg) await pageSearch(arg);
    else if (tab === "browse") await pageBrowse();
    else if (tab === "schedule") await pageSchedule();
    else if (tab === "mylist") await pageMyList();
    else if (tab === "random") await pageRandom();
    else if (tab === "studio" && arg) await pageStudio(arg);
    else if (tab === "character" && arg) await pageCharacter(arg);
    else if (tab === "shared" && arg) await pageShared(arg);
    else await pageHome();
  } catch (e) {
    if (token === routeToken) view.innerHTML = `<div class="page">${errorBox(e)}</div>`;
  }
  if (token === routeToken) document.body.classList.remove("loading");
  onScroll();
}

// =============== events ===============
document.addEventListener("click", async ev => {
  const t = ev.target.closest("[data-trailer],[data-scroll],[data-dot],[data-qadd],[data-plus],[data-ep],[data-step],[data-list],[data-sched],[data-remove],[data-more],[data-more-browse],[data-more-studio],[data-inline-trailer],[data-retry],[data-logout],[data-close],[data-export],[data-sync],[data-share],[data-share-list],[data-shared],[data-view],[data-lstep],[data-ics]");
  if (!t) return;
  const d = t.dataset;
  if (d.trailer) openTrailer(d.trailer);
  else if (d.scroll) { const x = t.closest(".row").querySelector(".track-x"); x.scrollBy({ left: x.clientWidth * 0.85 * Number(d.scroll), behavior: "smooth" }); }
  else if (d.dot) { heroGo(Number(d.dot)); startHero(); }
  else if (d.qadd) {
    ev.preventDefault();
    const m = mediaIndex.get(Number(d.qadd)); if (!m) return;
    if (isMine(m)) { location.hash = `#anime/${m.id}`; return; }
    t.disabled = true;
    try {
      await track(refOf(m), null, { status: "plan_to_watch" });
      toast(`Added ${titleOf(m)} to Plan to watch`);
      $$(`[data-qadd="${m.id}"]`).forEach(b => {
        b.disabled = false;
        if (b.classList.contains("qadd")) { b.textContent = "✓"; b.title = "On your list"; b.closest(".card")?.classList.add("on-list"); }
        else b.textContent = "✓ On your list";
      });
    } catch (err) { toast(err.message, "err"); t.disabled = false; }
  }
  else if (d.plus) {
    ev.preventDefault();
    const e = entryIndex.get(d.plus); if (!e) return;
    t.disabled = true;
    try {
      const f = progressFields(e, (e.watched || 0) + 1);
      const saved = await track(e, { ...e }, f);
      Object.assign(e, { status: saved.status, watched: saved.watched, score: saved.score, started: saved.started, finished: saved.finished, updated: Date.now() });
      toast(f.status === "completed" ? `🎉 Completed ${e.title}!` : `${e.title} · EP ${f.watched} logged`);
      const cardEl = t.closest(".card");
      const onList = location.hash.startsWith("#mylist");
      if (onList && e.status !== state.listStatus) route({ keepScroll: true });
      else if (!onList && e.status === "completed") cardEl.remove();
      else cardEl.outerHTML = entryCard(e);
    } catch (err) { toast(err.message, "err"); t.disabled = false; }
  }
  else if (d.ep) { const n = Number(d.ep); setProgress(n === (cur.e?.watched || 0) ? n - 1 : n); }
  else if (d.step) setProgress((cur.e?.watched || 0) + Number(d.step));
  else if (d.remove) { await T.remove(cur.ref); cur.e = null; renderTracker(); toast("Removed from your list"); }
  else if (d.list) { state.listStatus = d.list; state.listChosen = true; route({ keepScroll: true }); }
  else if (d.sched) { state.schedMine = d.sched === "mine"; route(); }
  else if (d.more !== undefined) { $("#syn").classList.remove("clamp"); t.remove(); }
  else if (d.moreBrowse !== undefined) { t.disabled = true; t.textContent = "Loading…"; browsePage++; pageBrowse(true).catch(err => toast(err.message, "err")); }
  else if (d.moreStudio) { t.disabled = true; t.textContent = "Loading…"; studioPage++; pageStudio(d.moreStudio, true).catch(err => toast(err.message, "err")); }
  else if (d.inlineTrailer) {
    t.innerHTML = `<iframe src="https://www.youtube-nocookie.com/embed/${encodeURIComponent(d.inlineTrailer)}?autoplay=1&rel=0" allow="autoplay; encrypted-media; picture-in-picture; fullscreen" allowfullscreen title="Trailer"></iframe>`;
    t.removeAttribute("data-inline-trailer");
  }
  else if (d.retry !== undefined) route();
  else if (d.logout !== undefined) { await fetch("/auth/logout"); state.auth.loggedIn = false; state.user = null; T.cache = null; renderAuth(); route(); }
  else if (d.close !== undefined) t.closest("dialog").close();
  else if (d.export) exportList(d.export);
  else if (d.sync !== undefined) syncLocalToMal(t);
  else if (d.shareList !== undefined) shareList(t);
  else if (d.shared) { state.sharedStatus = d.shared; route({ keepScroll: true }); }
  else if (d.view) { state.listView = d.view; try { localStorage.setItem("anitrack.view", d.view); } catch {} route({ keepScroll: true }); }
  else if (d.ics !== undefined) downloadIcs();
  else if (d.lstep) {
    const e = entryIndex.get(d.k); if (!e) return;
    t.disabled = true;
    try {
      const f = progressFields(e, (e.watched || 0) + Number(d.lstep));
      const saved = await track(e, { ...e }, f);
      Object.assign(e, { status: saved.status, watched: saved.watched, started: saved.started, finished: saved.finished, updated: Date.now() });
      if (f.status === "completed" && Number(d.lstep) > 0) toast(`🎉 Completed ${e.title}!`);
      if (e.status !== state.listStatus) route({ keepScroll: true });
      else t.closest(".lrow").outerHTML = listRow(e);
    } catch (err) { toast(err.message, "err"); t.disabled = false; }
  }
  else if (d.share !== undefined) {
    const url = location.href, title = titleOf(cur.m);
    if (navigator.share) navigator.share({ title, url }).catch(() => {});
    else { await navigator.clipboard?.writeText(url).catch(() => {}); toast("Link copied"); }
  }
});

document.addEventListener("change", ev => {
  const el = ev.target;
  if (el.matches("[data-import]") && el.files[0]) return importBackup(el.files[0]);
  if (el.matches("[data-lscore]")) {
    const e = entryIndex.get(el.dataset.lscore); if (!e) return;
    track(e, { ...e }, { score: Number(el.value) }).then(s => { e.score = s.score; toast(`Scored ${e.title} ${s.score || "–"}`); }).catch(err => toast(err.message, "err"));
    return;
  }
  if (el.matches("[data-sort-list]")) { state.listSort = el.value; return route({ keepScroll: true }); }
  if (el.matches("[data-browse]")) {
    const p = hashParams(); el.value ? p.set(el.dataset.browse, el.value) : p.delete(el.dataset.browse);
    if (el.dataset.browse === "season" && el.value && !p.get("year")) p.set("year", currentSeason().year);
    location.hash = "browse?" + p.toString();
    return;
  }
  const f = el.dataset.field;
  if (!f || !cur.m) return;
  if (f === "status") {
    if (!el.value) return $("[data-remove]")?.click();
    const fields = { status: el.value };
    if (el.value === "completed" && cur.m.episodes) fields.watched = cur.m.episodes;
    updateEntry(withDates(cur.e, fields), `Moved to ${STATUSES[el.value]}`);
  } else if (f === "started" || f === "finished") {
    updateEntry({ [f]: el.value || null }, "Date saved");
  } else if (f === "rewatches") {
    updateEntry({ rewatches: Math.max(0, Math.min(99, Number(el.value) || 0)) }, "Saved");
  } else if (f === "notes") {
    updateEntry({ notes: el.value.slice(0, 2000) }, "Notes saved");
  } else if (f === "score") {
    updateEntry({ score: Number(el.value), ...(cur.e ? {} : { status: "plan_to_watch" }) }, "Score saved");
  }
});

document.addEventListener("toggle", e => { if (e.target.matches?.(".more-d")) cur.moreOpen = e.target.open; }, true);
$("#player").addEventListener("click", e => { if (e.target.id === "player") e.target.close(); });

const sug = { timer: null, idx: -1, items: [], token: 0 };
function closeSuggest() { $("#suggest").hidden = true; sug.idx = -1; }
function renderSuggest(q) {
  const box = $("#suggest");
  if (!sug.items.length) { box.innerHTML = `<div class="sg-empty">No matches for “${esc(q)}”</div>`; box.hidden = false; return; }
  box.innerHTML = sug.items.map((m, i) => `<a class="sg ${i === sug.idx ? "on" : ""}" href="#anime/${m.id}" data-i="${i}">
      <img src="${esc(m.coverImage?.medium)}" alt=""><div><b>${esc(titleOf(m))}</b><span>${[fmt(m.format), m.seasonYear, m.episodes ? `${m.episodes} eps` : null].filter(Boolean).join(" · ")}</span></div>
      ${m.averageScore ? `<em>★ ${score(m.averageScore)}</em>` : ""}${isMine(m) ? `<i>On list</i>` : ""}</a>`).join("")
    + `<a class="sg-all ${sug.idx === sug.items.length ? "on" : ""}" href="#search/${encodeURIComponent(q)}">See all results for “${esc(q)}” →</a>`;
  box.hidden = false;
}
async function loadSuggest(q) {
  const token = ++sug.token;
  const d = await al(`query($q: String) { Page(perPage: 7) { media(type: ANIME, search: $q, isAdult: false, sort: SEARCH_MATCH) { id idMal title { romaji english } coverImage { medium } format seasonYear episodes averageScore } } }`, { q }).catch(() => null);
  if (token !== sug.token || !d || $("#search").q.value.trim() !== q) return;
  sug.items = d.Page.media; sug.idx = -1;
  renderSuggest(q);
}
const goSearch = q => {
  const h = "#search/" + encodeURIComponent(q);
  location.hash.startsWith("#search/") ? location.replace(h) : (location.hash = h);
};
$("#search").addEventListener("submit", e => { e.preventDefault(); const q = e.target.q.value.trim(); if (q) { closeSuggest(); e.target.q.blur(); goSearch(q); } });
$("#search").q.addEventListener("input", e => {
  clearTimeout(sug.timer);
  const q = e.target.value.trim();
  if (q.length < 2) return closeSuggest();
  sug.timer = setTimeout(() => loadSuggest(q), 220);
});
$("#search").q.addEventListener("keydown", e => {
  const box = $("#suggest");
  if (box.hidden || !sug.items.length) return;
  const max = sug.items.length;
  if (e.key === "ArrowDown") { e.preventDefault(); sug.idx = Math.min(max, sug.idx + 1); renderSuggest(e.target.value.trim()); }
  else if (e.key === "ArrowUp") { e.preventDefault(); sug.idx = Math.max(-1, sug.idx - 1); renderSuggest(e.target.value.trim()); }
  else if (e.key === "Enter" && sug.idx >= 0) { e.preventDefault(); location.hash = sug.idx < max ? `#anime/${sug.items[sug.idx].id}` : `#search/${encodeURIComponent(e.target.value.trim())}`; e.target.blur(); }
  else if (e.key === "Escape") closeSuggest();
});
$("#search").q.addEventListener("focus", e => { if (e.target.value.trim().length >= 2 && sug.items.length) renderSuggest(e.target.value.trim()); });
document.addEventListener("pointerdown", e => { if (!e.target.closest("#search")) closeSuggest(); });

// Keyboard: "/" search, "g h/b/s/l" go to pages, ←/→ hero
let gPending = false;
document.addEventListener("keydown", e => {
  if (e.target.closest("input, select, textarea") || e.metaKey || e.ctrlKey || e.altKey) {
    if (e.key === "Escape") e.target.blur?.();
    return;
  }
  if (e.key === "/") { e.preventDefault(); $("#search").q.focus(); $("#search").q.select(); }
  else if (gPending) { gPending = false; const to = { h: "#home", b: "#browse", s: "#schedule", l: "#mylist", r: "#random" }[e.key]; if (to) location.hash = to; }
  else if (e.key === "?") toast("Shortcuts: / search · g h home · g b browse · g s schedule · g l list · g r random");
  else if (e.key === "g") { gPending = true; setTimeout(() => (gPending = false), 900); }
  else if ($(".hero") && (e.key === "ArrowRight" || e.key === "ArrowLeft")) { heroGo(state.heroIdx + (e.key === "ArrowRight" ? 1 : -1)); startHero(); }
});

const onScroll = () => $("#top").classList.toggle("solid", scrollY > 40 || !$(".hero, .d-banner"));
addEventListener("scroll", onScroll, { passive: true });
addEventListener("hashchange", () => route());
addEventListener("storage", e => { if (e.key === LS_KEY && location.hash.startsWith("#mylist")) route({ keepScroll: true }); });
loadAuth().then(() => route());

if ("serviceWorker" in navigator) navigator.serviceWorker.register("sw.js").catch(() => {});
