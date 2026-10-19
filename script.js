const API = 'https://graphql.anilist.co';
const $ = id => document.getElementById(id);
const form = $('searchForm'), input = $('query'), hint = $('hint');
const grid = $('grid'), statusEl = $('status');
const fStatus = $('statusFilter'), fGenre = $('genreFilter'), fSort = $('sortFilter');
const searchBtn = $('searchBtn'), randomBtn = $('randomBtn'), moreBtn = $('moreBtn');
const favNav = $('favNav'), dialog = $('details');

let current = [];      // anime currently shown in the grid
let lastSearch = '';   // '' = browsing without a title
let page = 1;
let mode = 'browse';   // 'browse' | 'favorites'
let openId = null, dialogMedia = null, dialogRecs = [];
let favs = loadFavs();

/* ---------- Queries ---------- */
const CORE = `id title{romaji english} coverImage{large medium} averageScore episodes status genres description(asHtml:false) siteUrl`;
const LIST_QUERY = `
query ($search: String, $status: MediaStatus, $genre: String, $sort: [MediaSort], $page: Int, $perPage: Int) {
  Page(page: $page, perPage: $perPage) {
    pageInfo { hasNextPage }
    media(search: $search, status: $status, genre: $genre, type: ANIME, sort: $sort, isAdult: false) { ${CORE} }
  }
}`;
const DETAIL_QUERY = `
query ($id: Int) {
  Media(id: $id, type: ANIME) {
    ${CORE} bannerImage format season seasonYear duration
    nextAiringEpisode { episode timeUntilAiring }
    trailer { id site }
    studios(isMain: true) { nodes { name } }
    externalLinks { site url type }
    characters(sort: ROLE, perPage: 6) { nodes { name { full } image { medium } } }
    recommendations(sort: RATING_DESC, perPage: 6) { nodes { mediaRecommendation { id title { romaji english } coverImage { large medium } } } }
  }
}`;
const STATUS_LABELS = { FINISHED:'Finished', RELEASING:'Airing', NOT_YET_RELEASED:'Not yet aired', CANCELLED:'Cancelled', HIATUS:'On hiatus' };

/* ---------- Helpers ---------- */
function esc(s){ return String(s).replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c])); }
const safeUrl = u => /^https:\/\//.test(u || '') ? u : '';
const cap = s => s ? s[0] + s.slice(1).toLowerCase() : '';
function fmtTime(s){
  const d = Math.floor(s / 86400), h = Math.floor(s % 86400 / 3600), m = Math.floor(s % 3600 / 60);
  return d ? d + 'd ' + h + 'h' : h ? h + 'h ' + m + 'm' : m + 'm';
}
function validate(text){
  const q = text.trim();
  if(!q) return 'Enter an anime title to search.';
  if(q.length < 2) return 'Type at least 2 characters.';
  if(!/[\p{L}\p{N}]/u.test(q)) return 'Use letters or numbers in your search.';
  if(q.length > 100) return 'Keep the title under 100 characters.';
  return '';
}

/* ---------- Favorites (saved in the browser) ---------- */
function loadFavs(){ try{ return JSON.parse(localStorage.getItem('animeFinderFavs') || '[]'); }catch{ return []; } }
function saveFavs(){ try{ localStorage.setItem('animeFinderFavs', JSON.stringify(favs)); }catch{} }
const isFav = id => favs.some(f => f.id === id);
const pick = m => ({ id:m.id, title:m.title, coverImage:m.coverImage, averageScore:m.averageScore, episodes:m.episodes, status:m.status, genres:m.genres, description:m.description, siteUrl:m.siteUrl });
function toggleFav(m){
  favs = isFav(m.id) ? favs.filter(f => f.id !== m.id) : [...favs, pick(m)];
  saveFavs();
  if(mode === 'favorites') showFavs(); else syncHearts();
  syncDialogFav();
}
function heart(id){ return isFav(id) ? '&#9829;' : '&#9825;'; }
function syncHearts(){
  favNav.innerHTML = '&#9829; My List (' + favs.length + ')';
  favNav.setAttribute('aria-pressed', mode === 'favorites');
  grid.querySelectorAll('.fav').forEach(b => { const f = isFav(+b.dataset.id); b.setAttribute('aria-pressed', f); b.innerHTML = heart(+b.dataset.id); });
}
function syncDialogFav(){
  const b = dialog.querySelector('[data-fav]');
  if(b && dialogMedia){ const f = isFav(dialogMedia.id); b.innerHTML = (f ? '&#9829; In My List' : '&#9825; Add to My List'); b.setAttribute('aria-pressed', f); }
}

/* ---------- API ---------- */
async function gql(query, vars){
  let res;
  const clean = Object.fromEntries(Object.entries(vars).filter(([, v]) => v != null && v !== ''));
  try{
    res = await fetch(API, { method:'POST', headers:{ 'Content-Type':'application/json', 'Accept':'application/json' }, body: JSON.stringify({ query, variables: clean }) });
  }catch(e){
    console.error('AniList fetch failed:', e);
    throw new Error('Could not reach AniList. Check your internet connection and try again.');
  }
  if(res.status === 429) throw new Error('Too many requests. Wait a minute and try again.');
  let json = null;
  try{ json = await res.json(); }catch{}
  if(!res.ok || (json && json.errors)){
    console.error('AniList error response:', res.status, json);
    throw new Error('AniList reported a problem: ' + (json && json.errors && json.errors[0] ? json.errors[0].message : 'error ' + res.status));
  }
  return json.data;
}

/* ---------- Grid ---------- */
function setLoading(msg){
  searchBtn.disabled = randomBtn.disabled = true;
  moreBtn.hidden = true;
  statusEl.innerHTML = '<span class="spinner"></span>' + esc(msg);
  grid.innerHTML = '';
}
const done = () => { searchBtn.disabled = randomBtn.disabled = false; };
function showError(msg){ statusEl.textContent = ''; grid.innerHTML = '<div class="message error">' + esc(msg) + '</div>'; moreBtn.hidden = true; }

async function loadList(append = false){
  mode = 'browse';
  const q = lastSearch, sort = fSort.value || (q ? null : 'TRENDING_DESC');
  if(append){ page++; moreBtn.disabled = true; }
  else{ page = 1; current = []; setLoading(q ? 'Searching for "' + q + '"...' : 'Loading anime...'); }
  try{
    const data = await gql(LIST_QUERY, { search:q, status:fStatus.value, genre:fGenre.value, sort: sort && [sort], page, perPage:12 });
    const start = current.length, list = data.Page.media || [];
    current = current.concat(list);
    if(!current.length){
      statusEl.textContent = '';
      grid.innerHTML = '<div class="message">Nothing found' + (q ? ' for "' + esc(q) + '"' : '') + '. Check the spelling, try a shorter title, or change the filters.</div>';
    }else{
      statusEl.textContent = q ? current.length + ' result' + (current.length > 1 ? 's' : '') + ' for "' + q + '"' : (fSort.value ? 'Browsing anime.' : 'Trending on AniList right now.');
      render(list, start, append);
    }
    moreBtn.hidden = !data.Page.pageInfo.hasNextPage;
  }catch(err){
    if(append){ page--; statusEl.textContent = err.message; }
    else showError(err.message);
  }finally{ done(); moreBtn.disabled = false; syncHearts(); }
}

// AniList has no random endpoint: pick a random page (1 item) among the 500 most popular titles.
async function randomAnime(){
  mode = 'browse';
  setLoading('Picking something random...');
  try{
    const data = await gql(LIST_QUERY, { sort:['POPULARITY_DESC'], page: Math.floor(Math.random() * 500) + 1, perPage:1 });
    current = data.Page.media || [];
    statusEl.textContent = 'Your random pick:';
    render(current, 0, false);
  }catch(err){ showError(err.message); }
  finally{ done(); syncHearts(); }
}

function showFavs(){
  mode = 'favorites'; current = [...favs]; moreBtn.hidden = true;
  if(!current.length){
    statusEl.textContent = '';
    grid.innerHTML = '<div class="message">Your list is empty. Tap the heart on any anime to save it here.</div>';
  }else{
    statusEl.textContent = 'My List: ' + current.length + ' saved anime.';
    render(current, 0, false);
  }
  syncHearts();
}

function info(a){
  const t = a.title || {};
  const text = (a.description || '').replace(/<br\s*\/?>/gi, ' ').replace(/<[^>]+>/g, '').replace(/\s+/g, ' ').trim();
  const c = a.coverImage || {};
  return {
    title: t.english || t.romaji || 'Untitled',
    img: c.large || c.medium || '',
    score: a.averageScore ? (a.averageScore / 10).toFixed(1) : 'N/A',
    eps: a.episodes || '?',
    status: STATUS_LABELS[a.status] || 'Unknown',
    genres: a.genres || [],
    synopsis: text || 'No synopsis available.',
    url: /^https:\/\/anilist\.co\//.test(a.siteUrl || '') ? a.siteUrl : ''
  };
}

function cardHTML(a, i){
  const d = info(a), f = isFav(a.id);
  return `<article class="card">
    <button class="open" data-i="${i}" aria-label="View details for ${esc(d.title)}">
      <img src="${esc(d.img)}" alt="Cover of ${esc(d.title)}" loading="lazy">
      <div class="body">
        <h3>${esc(d.title)}</h3>
        <div class="meta"><span class="score">&#9733; ${d.score}</span><span>${d.eps} eps</span><span>${esc(d.status)}</span></div>
        <div class="tags">${d.genres.slice(0, 3).map(g => '<span>' + esc(g) + '</span>').join('')}</div>
        <p class="syn">${esc(d.synopsis)}</p>
      </div></button>
    <button class="fav" data-id="${a.id}" aria-pressed="${f}" aria-label="Toggle My List for ${esc(d.title)}">${heart(a.id)}</button>
  </article>`;
}
function render(list, start, append){
  const html = list.map((a, i) => cardHTML(a, start + i)).join('');
  if(append) grid.insertAdjacentHTML('beforeend', html); else grid.innerHTML = html;
}

/* ---------- Details dialog ---------- */
async function openDetails(base){
  openId = base.id;
  showDialog(base, 'loading');
  if(!dialog.open) dialog.showModal();
  try{
    const data = await gql(DETAIL_QUERY, { id: base.id });
    if(openId !== base.id || !dialog.open) return;
    showDialog({ ...base, ...data.Media }, 'ok');
  }catch(err){
    if(openId === base.id && dialog.open) showDialog(base, 'error', err.message);
  }
}

function showDialog(m, state, errMsg){
  dialogMedia = m;
  const d = info(m);
  const studio = m.studios && m.studios.nodes[0] ? m.studios.nodes[0].name : '';
  const facts = [m.format && m.format.replace(/_/g, ' '), m.seasonYear && cap(m.season) + ' ' + m.seasonYear, m.duration && m.duration + ' min per episode', studio && 'Studio: ' + studio].filter(Boolean);
  const next = m.nextAiringEpisode ? `<p class="airing">Episode ${m.nextAiringEpisode.episode} airs in ${fmtTime(m.nextAiringEpisode.timeUntilAiring)}</p>` : '';
  let links = '';
  if(m.trailer && m.trailer.id){
    const u = m.trailer.site === 'youtube' ? 'https://www.youtube.com/watch?v=' + encodeURIComponent(m.trailer.id)
            : m.trailer.site === 'dailymotion' ? 'https://www.dailymotion.com/video/' + encodeURIComponent(m.trailer.id) : '';
    if(u) links += `<a class="chip-link" href="${esc(u)}" target="_blank" rel="noopener">&#9654; Watch trailer</a>`;
  }
  (m.externalLinks || []).filter(l => l.type === 'STREAMING' && safeUrl(l.url)).slice(0, 5)
    .forEach(l => { links += `<a class="chip-link" href="${esc(l.url)}" target="_blank" rel="noopener">${esc(l.site)}</a>`; });
  if(d.url) links += `<a class="chip-link" href="${esc(d.url)}" target="_blank" rel="noopener">AniList page</a>`;

  let extra = '';
  if(state === 'loading') extra = '<p class="loading"><span class="spinner"></span>Loading more details...</p>';
  if(state === 'error') extra = '<p class="loading error">Could not load extra details. ' + esc(errMsg) + '</p>';
  if(state === 'ok'){
    const chars = (m.characters && m.characters.nodes) || [];
    dialogRecs = ((m.recommendations && m.recommendations.nodes) || []).map(n => n.mediaRecommendation).filter(Boolean);
    if(chars.length) extra += `<h4>Main characters</h4><div class="chars">${chars.map(c =>
      `<div class="char"><img src="${esc((c.image && c.image.medium) || '')}" alt="" loading="lazy"><span>${esc(c.name.full)}</span></div>`).join('')}</div>`;
    if(dialogRecs.length) extra += `<h4>If you like this, try</h4><div class="recs">${dialogRecs.map((r, i) => {
      const ri = info(r);
      return `<button class="rec" data-rec="${i}"><img src="${esc(ri.img)}" alt="" loading="lazy"><span>${esc(ri.title)}</span></button>`; }).join('')}</div>`;
  }
  const f = isFav(m.id);
  dialog.innerHTML = `<button class="xclose" data-close aria-label="Close details">&times;</button>
    ${m.bannerImage ? `<img class="banner" src="${esc(m.bannerImage)}" alt="">` : ''}
    <div class="dlg">
      <img class="cover" src="${esc(d.img)}" alt="Cover of ${esc(d.title)}">
      <div>
        <h3>${esc(d.title)}</h3>
        <div class="meta"><span class="score">&#9733; ${d.score}</span><span>${d.eps} episodes</span><span>${esc(d.status)}</span></div>
        ${facts.length ? `<div class="meta facts">${facts.map(x => '<span>' + esc(x) + '</span>').join('')}</div>` : ''}
        <div class="tags" style="margin-top:10px">${d.genres.map(g => '<span>' + esc(g) + '</span>').join('')}</div>
        ${next}
        <p>${esc(d.synopsis)}</p>
        ${links ? `<div class="links">${links}</div>` : ''}
      </div>
      <div class="extra">${extra}</div>
      <div class="actions">
        <button class="btn-ghost" data-fav aria-pressed="${f}">${f ? '&#9829; In My List' : '&#9825; Add to My List'}</button>
      </div>
    </div>`;
}

/* ---------- Events ---------- */
form.addEventListener('submit', e => {
  e.preventDefault();
  const err = validate(input.value);
  hint.textContent = err;
  input.setAttribute('aria-invalid', err ? 'true' : 'false');
  if(err){ input.focus(); return; }
  lastSearch = input.value.trim();
  loadList();
});
input.addEventListener('input', () => { hint.textContent = ''; input.removeAttribute('aria-invalid'); });
input.addEventListener('search', () => { if(!input.value && lastSearch){ lastSearch = ''; loadList(); } }); // clear (x) button
[fStatus, fGenre, fSort].forEach(s => s.addEventListener('change', loadList.bind(null, false)));
randomBtn.addEventListener('click', () => { hint.textContent = ''; randomAnime(); });
moreBtn.addEventListener('click', () => loadList(true));
favNav.addEventListener('click', () => { mode === 'favorites' ? loadList() : showFavs(); });
$('homeLink').addEventListener('click', () => { if(mode === 'favorites') loadList(); });

grid.addEventListener('click', e => {
  const fav = e.target.closest('.fav'), open = e.target.closest('.open');
  if(fav){ const m = current.find(a => a.id === +fav.dataset.id); if(m) toggleFav(m); }
  else if(open) openDetails(current[+open.dataset.i]);
});
dialog.addEventListener('click', e => {
  if(e.target === dialog || e.target.closest('[data-close]')) return dialog.close();
  if(e.target.closest('[data-fav]')) return toggleFav(dialogMedia);
  const rec = e.target.closest('[data-rec]');
  if(rec){ dialog.scrollTop = 0; openDetails(dialogRecs[+rec.dataset.rec]); }
});
dialog.addEventListener('close', () => { openId = null; });

syncHearts();
loadList(); // show trending on first load