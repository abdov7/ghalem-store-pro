/* Ghalem Store Pro — storefront SPA (public/app.js) */
'use strict';

/* ================= Helpers ================= */
const $ = (sel, root) => (root || document).querySelector(sel);
const $$ = (sel, root) => Array.from((root || document).querySelectorAll(sel));

const esc = (s) => String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({
  '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
}[c]));

const fmtDzd = (n) => {
  const v = Number(n) || 0;
  return v.toString().replace(/\B(?=(\d{3})+(?!\d))/g, ' ') + ' د.ج';
};

const fmtDate = (iso) => {
  if (!iso) return '';
  try {
    return new Date(iso).toLocaleString('ar-DZ', { dateStyle: 'medium', timeStyle: 'short' });
  } catch (e) {
    return String(iso).slice(0, 16).replace('T', ' ');
  }
};

const STATUS_AR = {
  awaiting_payment: 'بانتظار الدفع',
  under_review: 'قيد مراجعة الدفع',
  paid: 'تم الدفع',
  shipped: 'تم الشحن',
  rejected: 'مرفوض'
};
const PAY_METHOD_AR = { ccp: 'CCP', baridimob: 'BaridiMob' };

let toastTimer = null;
function toast(msg) {
  const t = $('#toast');
  t.textContent = msg;
  t.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => t.classList.remove('show'), 2600);
}

async function api(path, opts) {
  const o = Object.assign({ headers: { 'Content-Type': 'application/json' } }, opts || {});
  let res;
  try {
    res = await fetch(path, o);
  } catch (e) {
    throw new Error('تعذّر الاتصال بالخادم. تحقق من الإنترنت وحاول مجدداً.');
  }
  let data = {};
  try { data = await res.json(); } catch (e) { /* empty body */ }
  if (!res.ok) throw new Error(data && data.error ? data.error : 'حدث خطأ غير متوقع. حاول مجدداً.');
  return data;
}

/* ================= Sound (WebAudio UI + Layla voice) ================= */
const Sound = (() => {
  const LS_KEY = 'gspro-sound';
  let on = true;
  let ctx = null;
  let gestured = false;
  try { on = localStorage.getItem(LS_KEY) !== '0'; } catch (e) { on = true; }

  function ensureCtx() {
    if (!on || !gestured) return null;
    if (!ctx) {
      try { ctx = new (window.AudioContext || window.webkitAudioContext)(); }
      catch (e) { return null; }
    }
    if (ctx.state === 'suspended') ctx.resume().catch(() => {});
    return ctx;
  }
  function tone(freq, dur, type, when, gain) {
    const c = ensureCtx();
    if (!c) return;
    const t = c.currentTime + (when || 0);
    const osc = c.createOscillator();
    const g = c.createGain();
    osc.type = type || 'sine';
    osc.frequency.value = freq;
    g.gain.setValueAtTime(0.0001, t);
    g.gain.exponentialRampToValueAtTime(gain || 0.12, t + 0.012);
    g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
    osc.connect(g); g.connect(c.destination);
    osc.start(t); osc.stop(t + dur + 0.05);
  }
  const voices = {};
  function voice(name) {
    if (!on || !gestured) return;
    try {
      let a = voices[name];
      if (!a) {
        a = new Audio('assets/voice/' + name + '.mp3');
        a.preload = 'auto';
        voices[name] = a;
      }
      a.currentTime = 0;
      a.play().catch(() => {});
    } catch (e) { /* ignore */ }
  }
  function unlock() { gestured = true; }
  window.addEventListener('pointerdown', unlock, { once: true, passive: true });
  window.addEventListener('keydown', unlock, { once: true });

  return {
    get on() { return on; },
    toggle() {
      on = !on;
      try { localStorage.setItem(LS_KEY, on ? '1' : '0'); } catch (e) {}
      return on;
    },
    click()  { tone(660, 0.06, 'sine', 0, 0.08); },
    add()    { tone(520, 0.07, 'sine', 0, 0.10); tone(780, 0.09, 'sine', 0.07, 0.10); },
    success(){ tone(523, 0.10, 'sine', 0, 0.11); tone(659, 0.10, 'sine', 0.10, 0.11); tone(784, 0.16, 'sine', 0.20, 0.12); },
    error()  { tone(180, 0.22, 'sawtooth', 0, 0.08); },
    voice
  };
})();

function syncSoundBtn() {
  const b = $('#soundBtn');
  b.classList.toggle('muted', !Sound.on);
  b.setAttribute('aria-pressed', String(Sound.on));
}
$('#soundBtn').addEventListener('click', () => {
  Sound.toggle();
  syncSoundBtn();
  if (Sound.on) Sound.click();
  toast(Sound.on ? 'تم تشغيل الصوت' : 'تم كتم الصوت');
});
syncSoundBtn();

/* ================= Catalog ================= */
const state = {
  games: [],
  settings: {},
  loaded: false,
  loadError: null
};

async function loadCatalog() {
  if (state.loaded) return;
  try {
    const [games, settings] = await Promise.all([
      api('/api/games'),
      api('/api/settings/public').catch(() => ({}))
    ]);
    state.games = Array.isArray(games) ? games : [];
    state.settings = settings || {};
    state.loaded = true;
    setupSupportLinks();
  } catch (e) {
    state.loadError = e.message;
  }
}

function setupSupportLinks() {
  const wa = (state.settings.whatsapp_number || '').replace(/[^\d]/g, '');
  const valid = /^\d{6,15}$/.test(wa);
  const link = valid ? 'https://wa.me/' + wa : '#';
  const fw = $('#footerWa');
  if (valid) { fw.href = link; fw.target = '_blank'; }
  else fw.style.display = 'none';
  const pw = $('#panelWa');
  if (valid) { pw.href = link; }
  else pw.style.display = 'none';
}

const gameById = (id) => state.games.find((g) => g.id === id);
function pkgById(game, pid) {
  return (game && game.packages || []).find((p) => String(p.id) === String(pid));
}
function minPrice(game) {
  const ps = (game.packages || []);
  if (!ps.length) return null;
  return Math.min.apply(null, ps.map((p) => Number(p.price_dzd) || 0));
}
function gameDeals() {
  const out = [];
  state.games.forEach((g) => {
    (g.packages || []).forEach((p) => {
      if (p.discount_pct) out.push({ game: g, pkg: p });
    });
  });
  return out;
}

/* ================= Cart ================= */
const Cart = (() => {
  const LS = 'gspro-cart';
  let items = [];
  try {
    const raw = localStorage.getItem(LS);
    if (raw) items = JSON.parse(raw) || [];
  } catch (e) { items = []; }
  if (!Array.isArray(items)) items = [];

  function persist() {
    try { localStorage.setItem(LS, JSON.stringify(items)); } catch (e) {}
  }
  function find(game_id, package_id) {
    return items.find((i) => i.game_id === game_id && String(i.package_id) === String(package_id));
  }
  function clean() {
    // drop entries that no longer exist in the live catalog
    items = items.filter((i) => {
      const g = gameById(i.game_id);
      return g && pkgById(g, i.package_id);
    });
  }
  return {
    all() { clean(); return items; },
    count() { clean(); return items.reduce((n, i) => n + (Number(i.qty) || 0), 0); },
    estimate() {
      clean();
      return items.reduce((sum, i) => {
        const p = pkgById(gameById(i.game_id), i.package_id);
        return sum + (p ? (Number(p.price_dzd) || 0) * (Number(i.qty) || 0) : 0);
      }, 0);
    },
    add(game_id, package_id, qty) {
      const q = Math.max(1, Math.min(10, Number(qty) || 1));
      const ex = find(game_id, package_id);
      if (ex) ex.qty = Math.min(10, (Number(ex.qty) || 0) + q);
      else items.push({ game_id, package_id, qty: q });
      persist(); renderCartBadge();
    },
    setQty(game_id, package_id, qty) {
      const ex = find(game_id, package_id);
      if (!ex) return;
      const q = Number(qty) || 0;
      if (q <= 0) items = items.filter((i) => i !== ex);
      else ex.qty = Math.max(1, Math.min(10, q));
      persist(); renderCartBadge(); renderCartDrawer();
    },
    remove(game_id, package_id) {
      items = items.filter((i) => !(i.game_id === game_id && String(i.package_id) === String(package_id)));
      persist(); renderCartBadge(); renderCartDrawer();
    },
    clear() { items = []; persist(); renderCartBadge(); renderCartDrawer(); }
  };
})();

function renderCartBadge() {
  const n = Cart.count();
  [['#cartCount'], ['#cartCountM']].forEach(([sel]) => {
    const b = $(sel);
    b.style.display = n ? 'grid' : 'none';
    b.textContent = n > 99 ? '99+' : String(n);
    b.classList.remove('pop');
    void b.offsetWidth;
    b.classList.add('pop');
  });
}

/* ================= Router ================= */
function parseRoute() {
  const h = location.hash || '#/home';
  const m = h.match(/^#\/([a-z]+)(?:\/([^?]*))?(\?.*)?$/);
  const name = m ? m[1] : 'home';
  const param = m && m[2] ? decodeURIComponent(m[2]) : null;
  const query = {};
  if (m && m[3]) {
    new URLSearchParams(m[3].slice(1)).forEach((v, k) => { query[k] = v; });
  }
  return { name, param, query };
}

const viewEl = () => $('#view');
const VALID_ROUTES = ['home', 'games', 'game', 'deals', 'checkout', 'order', 'track', 'help'];

async function render() {
  await loadCatalog();
  const r = parseRoute();
  const name = VALID_ROUTES.includes(r.name) ? r.name : 'home';
  const v = viewEl();
  v.classList.remove('active');
  void v.offsetWidth;

  if (state.loadError && !state.loaded) {
    v.innerHTML =
      '<div class="error-box" style="margin-top:16px"><b>تعذّر تحميل المتجر</b>' +
      esc(state.loadError) + '<br><button class="btn-brand" id="retryLoad" style="margin-top:10px">إعادة المحاولة</button></div>';
    $('#retryLoad').addEventListener('click', () => { state.loadError = null; render(); });
    v.classList.add('active');
    return;
  }

  $$('#mainTabs .tab-btn').forEach((b) => b.classList.toggle('active', b.dataset.route === name || (name === 'game' && b.dataset.route === 'games')));
  $$('.bottomnav button[data-route]').forEach((b) => b.classList.toggle('on', b.dataset.route === name));

  try {
    if (name === 'home') renderHome(v);
    else if (name === 'games') renderGames(v, r.query.q || '');
    else if (name === 'game') renderGameDetail(v, r.param);
    else if (name === 'deals') renderDeals(v);
    else if (name === 'checkout') renderCheckout(v);
    else if (name === 'order') renderOrder(v, r.param);
    else if (name === 'track') renderTrack(v);
    else if (name === 'help') renderHelp(v);
  } catch (e) {
    v.innerHTML = '<div class="error-box" style="margin-top:16px"><b>حدث خطأ</b>' + esc(e.message) + '</div>';
  }
  v.classList.add('active');
  window.scrollTo(0, 0);
}
window.addEventListener('hashchange', render);

$$('#mainTabs .tab-btn').forEach((b) => b.addEventListener('click', () => {
  Sound.click();
  location.hash = '#/' + b.dataset.route;
}));
$$('.bottomnav button[data-route]').forEach((b) => b.addEventListener('click', () => {
  Sound.click();
  location.hash = '#/' + b.dataset.route;
}));

$('#searchForm').addEventListener('submit', (e) => {
  e.preventDefault();
  Sound.click();
  const q = $('#searchInput').value.trim();
  location.hash = '#/games' + (q ? '?q=' + encodeURIComponent(q) : '');
});

window.addEventListener('scroll', () => {
  $('#siteHeader').classList.toggle('scrolled', window.scrollY > 8);
}, { passive: true });

/* ================= Shared card builders (all dynamic data escaped) ================= */
function gameCardHTML(g) {
  const mp = minPrice(g);
  const dealCount = (g.packages || []).filter((p) => p.discount_pct).length;
  return (
    '<a class="gcard" href="#/game/' + esc(g.id) + '">' +
      '<div class="cover has-img">' +
        '<img class="cover-img" src="' + esc(g.cover_url || '') + '" alt="' + esc(g.name_ar) + '" loading="lazy" />' +
        '<span class="en" dir="ltr">' + esc(g.name_en) + '</span>' +
        (dealCount ? '<span class="off-tag">عرض خاص</span>' : '') +
        '<span class="cur">' + esc(g.unit_ar) + '</span>' +
      '</div>' +
      '<div class="gbody">' +
        '<div class="gname">' + esc(g.name_ar) + '</div>' +
        '<div class="from">' + (mp != null ? 'ابتداءً من <b class="num">' + esc(fmtDzd(mp)) + '</b>' : 'قريباً') + '</div>' +
      '</div>' +
    '</a>'
  );
}

function pkgHTML(g, p) {
  const hasDeal = !!p.discount_pct;
  return (
    '<div class="pkg" data-pkg="' + esc(p.id) + '">' +
      (p.is_hot ? '<span class="hot">الأكثر طلباً</span>' : '') +
      (hasDeal ? '<span class="off">-' + esc(p.discount_pct) + '%</span>' : '') +
      '<div class="amt">' + esc(p.amount_label) + ' <small>' + esc(g.unit_ar) + '</small></div>' +
      '<div class="price-row">' +
        '<span class="price num">' + esc(fmtDzd(p.price_dzd)) + '</span>' +
        (hasDeal && p.old_price_dzd ? '<span class="old num">' + esc(fmtDzd(p.old_price_dzd)) + '</span>' : '') +
      '</div>' +
      '<div class="acts">' +
        '<button class="btn-add" data-act="add" data-game="' + esc(g.id) + '" data-pkg="' + esc(p.id) + '">أضف للسلة</button>' +
        '<button class="btn-buy" data-act="buy" data-game="' + esc(g.id) + '" data-pkg="' + esc(p.id) + '">اشترِ الآن</button>' +
      '</div>' +
    '</div>'
  );
}

function bindPkgButtons(root) {
  $$('[data-act="add"]', root).forEach((b) => b.addEventListener('click', (e) => {
    e.stopPropagation();
    Sound.add();
    Cart.add(b.dataset.game, b.dataset.pkg, 1);
    Layla.voice('cart');
    toast('أُضيفت الباقة إلى السلة');
  }));
  $$('[data-act="buy"]', root).forEach((b) => b.addEventListener('click', (e) => {
    e.stopPropagation();
    Sound.add();
    Cart.add(b.dataset.game, b.dataset.pkg, 1);
    location.hash = '#/checkout';
  }));
}

/* ================= View: Home ================= */
function renderHome(v) {
  const games = state.games;
  const pkgCount = games.reduce((n, g) => n + (g.packages || []).length, 0);
  const deals = gameDeals();

  let html =
    '<div class="hero">' +
      '<svg class="deco"><use href="#i-pad"/></svg>' +
      '<span class="float-chip fc1"><svg class="ic"><use href="#i-flash"/></svg> شحن سريع بعد تأكيد الدفع</span>' +
      '<span class="float-chip fc2"><svg class="ic"><use href="#i-shield"/></svg> دفع محلي آمن</span>' +
      '<div class="inner">' +
        '<h1>اشحن لعبتك المفضلة<br />بالدينار الجزائري</h1>' +
        '<p>اختر لعبتك، حدّد الباقة، ادفع عبر CCP أو BaridiMob، وأرسل إثبات الدفع — يصلك الشحن على معرّف حسابك بعد مراجعة الدفع.</p>' +
        '<div class="cta-row">' +
          '<a class="btn btn-white" href="#/games"><svg class="ic" style="width:18px;height:18px"><use href="#i-grid"/></svg> تصفّح الألعاب</a>' +
          (deals.length ? '<a class="btn btn-ghost" href="#/deals"><svg class="ic" style="width:18px;height:18px"><use href="#i-bolt"/></svg> عروض حقيقية</a>' : '') +
        '</div>' +
        '<div class="trust" style="margin-top:22px">' +
          '<div class="t"><div><b class="num">' + esc(String(games.length)) + '</b><span>لعبة مدعومة</span></div></div>' +
          '<div class="t"><div><b class="num">' + esc(String(pkgCount)) + '</b><span>باقة شحن</span></div></div>' +
          '<div class="t"><div><b class="num">' + esc(String(deals.length)) + '</b><span>عرض نشط الآن</span></div></div>' +
          '<div class="t"><div><b>دفع محلي</b><span>CCP / BaridiMob</span></div></div>' +
        '</div>' +
      '</div>' +
    '</div>';

  html +=
    '<section class="block"><div class="sec-head"><h2><span class="dot"></span> الألعاب</h2><a href="#/games">عرض الكل</a></div>' +
    '<div class="games-grid" id="homeGamesGrid">' +
      games.map(gameCardHTML).join('') +
    '</div></section>';

  if (deals.length) {
    html +=
      '<section class="block"><div class="sec-head"><h2><span class="dot"></span> عروض نشطة الآن</h2><a href="#/deals">كل العروض</a></div>' +
      '<div class="deals-grid">' +
        deals.slice(0, 4).map((d) => dealCardHTML(d.game, d.pkg)).join('') +
      '</div></section>';
  }

  html +=
    '<section class="block"><div class="sec-head"><h2><span class="dot"></span> كيف تطلب؟</h2></div>' +
    '<div class="steps">' +
      '<div class="step"><div class="numstep">1</div><b>اختر باقتك</b><p>تصفّح الألعاب وأضف الباقات التي تريدها إلى السلة.</p></div>' +
      '<div class="step"><div class="numstep">2</div><b>أدخل معرّف اللاعب</b><p>اكتب معرّف حسابك بدقة — عليه سيتم الشحن مباشرة.</p></div>' +
      '<div class="step"><div class="numstep">3</div><b>ادفع وأرسل الإثبات</b><p>حوّل المبلغ عبر CCP أو BaridiMob ثم أرفق رقم التحويل في صفحة الطلب.</p></div>' +
      '<div class="step"><div class="numstep">4</div><b>استلم شحنك</b><p>بعد مراجعة الدفع نشحن حسابك، وتتابع حالة الطلب برقمه.</p></div>' +
    '</div></section>';

  html +=
    '<div class="home-cta"><div><h3>عندك سؤال؟ ليلى تساعدك</h3>' +
    '<p>اضغط على ليلى أسفل الشاشة في أي وقت — تجيبك عن الأسئلة الشائعة وتشرح لك خطوات الطلب.</p></div>' +
    '<button class="btn-brand" id="askLayla"><svg class="ic" style="width:18px;height:18px"><use href="#i-chat"/></svg> اسأل ليلى</button></div>';

  v.innerHTML = html;
  const ask = $('#askLayla');
  if (ask) ask.addEventListener('click', () => { Sound.click(); Layla.openPanel(); });
  Layla.onView('home');
}

function dealCardHTML(g, p) {
  return (
    '<a class="deal-card" href="#/game/' + esc(g.id) + '">' +
      '<div class="d-cover"><img src="' + esc(g.cover_url || '') + '" alt="' + esc(g.name_ar) + '" loading="lazy" /></div>' +
      '<div class="d-info">' +
        '<div class="d-game">' + esc(g.name_ar) + '</div>' +
        '<div class="d-name">' + esc(p.amount_label) + ' ' + esc(g.unit_ar) + '</div>' +
        '<div class="price-row">' +
          '<span class="price num">' + esc(fmtDzd(p.price_dzd)) + '</span>' +
          (p.old_price_dzd ? '<span class="old num">' + esc(fmtDzd(p.old_price_dzd)) + '</span>' : '') +
          '<span class="off">-' + esc(p.discount_pct) + '%</span>' +
        '</div>' +
      '</div>' +
    '</a>'
  );
}

/* ================= View: Games list ================= */
function renderGames(v, q) {
  q = (q || '').trim();
  const list = q
    ? state.games.filter((g) => (g.name_ar + ' ' + g.name_en + ' ' + g.short).toLowerCase().includes(q.toLowerCase()))
    : state.games;
  v.innerHTML =
    '<div class="page-intro"><h2>الألعاب</h2><p>اختر لعبتك لعرض باقات الشحن المتاحة بأسعار الدينار الجزائري.</p></div>' +
    (q ? '<p style="color:var(--ink-2);font-size:13.5px">نتائج البحث عن: <b>' + esc(q) + '</b> (' + list.length + ')</p>' : '') +
    (list.length
      ? '<div class="games-grid">' + list.map(gameCardHTML).join('') + '</div>'
      : '<div class="empty">لا توجد ألعاب مطابقة لبحثك.<br><a href="#/games">عرض كل الألعاب</a></div>');
  Layla.onView('games');
}

/* ================= View: Game detail ================= */
function renderGameDetail(v, gameId) {
  const g = gameById(gameId);
  if (!g) {
    v.innerHTML = '<div class="error-box" style="margin-top:16px"><b>اللعبة غير موجودة</b><br><a href="#/games">العودة إلى الألعاب</a></div>';
    return;
  }
  const pkgs = (g.packages || []).slice().sort((a, b) => (a.sort_order - b.sort_order) || (a.price_dzd - b.price_dzd));
  const others = state.games.filter((x) => x.id !== g.id);

  v.innerHTML =
    '<button class="back-btn" id="backBtn"><svg class="ic"><use href="#i-arrow"/></svg> كل الألعاب</button>' +
    '<div class="game-banner">' +
      '<img class="banner-img" src="' + esc(g.cover_url || '') + '" alt="' + esc(g.name_ar) + '" />' +
      '<div class="banner-shade"></div>' +
      '<div class="en" dir="ltr">' + esc(g.name_en) + '</div>' +
      '<h2>' + esc(g.name_ar) + '</h2>' +
      '<p>اشحن ' + esc(g.unit_ar) + ' على ' + esc(g.id_label) + ' الخاص بك مباشرة.</p>' +
    '</div>' +
    (others.length ? '<div class="other-games">' + others.map((o) =>
      '<a class="og-chip" href="#/game/' + esc(o.id) + '"><span class="dotc"><img src="' + esc(o.cover_url || '') + '" alt="" loading="lazy" /></span>' + esc(o.name_ar) + '</a>'
    ).join('') + '</div>' : '') +
    '<div class="pkg-panel">' +
      '<div class="p-head"><h3>باقات ' + esc(g.name_ar) + '</h3></div>' +
      '<p class="hint">اختر الباقة المناسبة — السعر النهائي المعتمد هو ما يظهر عند تأكيد الطلب.</p>' +
      (pkgs.length ? '<div class="pkgs">' + pkgs.map((p) => pkgHTML(g, p)).join('') + '</div>'
        : '<div class="empty">لا توجد باقات متاحة حالياً لهذه اللعبة.</div>') +
    '</div>';

  $('#backBtn').addEventListener('click', () => { Sound.click(); location.hash = '#/games'; });
  bindPkgButtons(v);
  Layla.onView('game');
}

/* ================= View: Deals (REAL discounts only) ================= */
function renderDeals(v) {
  const deals = gameDeals();
  v.innerHTML =
    '<div class="page-intro"><h2>العروض</h2><p>خصومات حقيقية سارية الآن فقط — تظهر هنا تلقائياً عند تفعيل أي خصم من لوحة الإدارة وتنتهي بانتهائه.</p></div>' +
    (deals.length
      ? '<div class="deals-grid">' + deals.map((d) => dealCardHTML(d.game, d.pkg)).join('') + '</div>'
      : '<div class="empty">لا توجد عروض نشطة حالياً.<br>تفقّد <a href="#/games">الألعاب</a> — الأسعار المعروضة هي الأسعار الحالية.</div>');
  if (deals.length) Layla.voice('flash');
  Layla.onView('deals');
}

/* ================= Cart drawer ================= */
function renderCartDrawer() {
  const body = $('#cartBody');
  const foot = $('#cartFoot');
  const items = Cart.all();
  if (!items.length) {
    body.innerHTML = '<div class="empty">سلتك فارغة.<br>تصفّح <a href="#/games">الألعاب</a> وأضف باقتك المفضلة.</div>';
    foot.innerHTML = '';
    return;
  }
  body.innerHTML = items.map((i) => {
    const g = gameById(i.game_id);
    const p = pkgById(g, i.package_id);
    if (!g || !p) return '';
    return (
      '<div class="cart-item">' +
        '<div class="thumb"><img src="' + esc(g.cover_url || '') + '" alt="' + esc(g.name_ar) + '" /></div>' +
        '<div class="ci-info"><b>' + esc(g.name_ar) + '</b><span>' + esc(p.amount_label) + ' ' + esc(g.unit_ar) + ' — <span class="num">' + esc(fmtDzd(p.price_dzd)) + '</span></span></div>' +
        '<div class="qty-ctl">' +
          '<button data-q="-1" data-game="' + esc(i.game_id) + '" data-pkg="' + esc(i.package_id) + '" aria-label="إنقاص">−</button>' +
          '<b class="num">' + esc(i.qty) + '</b>' +
          '<button data-q="1" data-game="' + esc(i.game_id) + '" data-pkg="' + esc(i.package_id) + '" aria-label="زيادة">+</button>' +
        '</div>' +
        '<button class="del-btn" data-del data-game="' + esc(i.game_id) + '" data-pkg="' + esc(i.package_id) + '" aria-label="حذف"><svg class="ic"><use href="#i-trash"/></svg></button>' +
      '</div>'
    );
  }).join('');

  foot.innerHTML =
    '<div class="total-row"><span>المجموع التقديري</span><b class="num">' + esc(fmtDzd(Cart.estimate())) + '</b></div>' +
    '<p class="est-note">المبلغ النهائي المعتمد يُحسب من الخادم عند تأكيد الطلب.</p>' +
    '<button class="btn-block" id="goCheckout">إتمام الطلب</button>' +
    '<button class="btn-ghost" id="clearCart" style="width:100%;margin-top:8px">إفراغ السلة</button>';

  $$('[data-q]', body).forEach((b) => b.addEventListener('click', () => {
    Sound.click();
    const cur = Cart.all().find((x) => x.game_id === b.dataset.game && String(x.package_id) === String(b.dataset.pkg));
    Cart.setQty(b.dataset.game, b.dataset.pkg, (cur ? cur.qty : 1) + Number(b.dataset.q));
  }));
  $$('[data-del]', body).forEach((b) => b.addEventListener('click', () => {
    Sound.click();
    Cart.remove(b.dataset.game, b.dataset.pkg);
  }));
  $('#goCheckout').addEventListener('click', () => {
    Sound.click();
    closeCart();
    location.hash = '#/checkout';
  });
  $('#clearCart').addEventListener('click', () => {
    Sound.click();
    Cart.clear();
    toast('تم إفراغ السلة');
  });
}

function openCart() {
  renderCartDrawer();
  $('#overlay').classList.add('show');
  $('#cartDrawer').classList.add('show');
  document.body.style.overflow = 'hidden';
}
function closeCart() {
  $('#overlay').classList.remove('show');
  $('#cartDrawer').classList.remove('show');
  document.body.style.overflow = '';
}
$('#cartBtn').addEventListener('click', () => { Sound.click(); openCart(); });
$('#cartBtnM').addEventListener('click', () => { Sound.click(); openCart(); });
$('#cartClose').addEventListener('click', () => { Sound.click(); closeCart(); });
$('#overlay').addEventListener('click', closeCart);

/* ================= View: Checkout ================= */
const PLAYER_RE = /^[\p{L}\p{N} _\-#.,@]{3,64}$/u;

function groupCartByGame() {
  const groups = [];
  Cart.all().forEach((i) => {
    const g = gameById(i.game_id);
    const p = pkgById(g, i.package_id);
    if (!g || !p) return;
    let gr = groups.find((x) => x.game.id === g.id);
    if (!gr) { gr = { game: g, items: [] }; groups.push(gr); }
    gr.items.push({ cart: i, pkg: p });
  });
  return groups;
}

function renderCheckout(v) {
  const groups = groupCartByGame();
  if (!groups.length) {
    v.innerHTML = '<div class="error-box" style="margin-top:16px"><b>سلتك فارغة</b>أضف باقة أولاً من صفحة <a href="#/games">الألعاب</a>.</div>';
    return;
  }

  v.innerHTML =
    '<div class="page-intro"><h2>إتمام الطلب</h2><p>أدخل معرّف اللاعب لكل لعبة بدقة — عليه سيتم الشحن. لا نحفظ معرّفاتك في المتصفح.</p></div>' +
    '<div class="pay-note">المبالغ المعروضة تقديرية. المبلغ النهائي يُحسب من الخادم لحظة تأكيد الطلب، وقد يختلف قليلاً إذا تغيّر سعر أو خصم.</div>' +
    '<form id="coForm" novalidate>' +
    groups.map((gr, gi) => {
      const g = gr.game;
      return (
        '<div class="co-game" data-gi="' + gi + '">' +
          '<div class="co-ghead"><img src="' + esc(g.cover_url || '') + '" alt="" /><b>' + esc(g.name_ar) + '</b></div>' +
          '<div class="co-items">' +
            gr.items.map((it) =>
              '<div class="co-item"><div><div class="ci-name">' + esc(it.pkg.amount_label) + ' ' + esc(g.unit_ar) + '</div>' +
              '<div class="ci-meta">الكمية: <span class="num">' + esc(it.cart.qty) + '</span></div></div>' +
              '<b class="num" style="color:var(--brand)">' + esc(fmtDzd(Number(it.pkg.price_dzd) * Number(it.cart.qty))) + '</b></div>'
            ).join('') +
          '</div>' +
          '<div class="field"><label for="pid-' + gi + '">' + esc(g.id_label) + ' *</label>' +
            '<input id="pid-' + gi + '" name="player_id" dir="ltr" autocomplete="off" placeholder="مثال: 5123456789" maxlength="64" />' +
            '<div class="err">المعرّف غير صالح — يجب أن يكون من 3 إلى 64 حرفاً (أحرف وأرقام و _ - # . , @ ومسافة).</div></div>' +
          (g.extra_label
            ? '<div class="field"><label for="ex-' + gi + '">' + esc(g.extra_label) + '</label>' +
              '<input id="ex-' + gi + '" name="extra_value" dir="ltr" autocomplete="off" maxlength="64" />' +
              '<div class="err">القيمة غير صالحة (حتى 64 حرفاً).</div></div>'
            : '') +
        '</div>'
      );
    }).join('') +
    '<div class="co-game"><div class="co-ghead"><b>طريقة الدفع</b></div>' +
      '<div class="pay-opts" id="payOpts">' +
        '<label class="pay-opt sel"><input type="radio" name="payment_method" value="ccp" checked /> CCP</label>' +
        '<label class="pay-opt"><input type="radio" name="payment_method" value="baridimob" /> BaridiMob</label>' +
      '</div>' +
      '<div class="field" style="margin-top:12px"><label for="coNote">ملاحظة (اختياري)</label>' +
      '<textarea id="coNote" maxlength="500" placeholder="أي تفاصيل إضافية تريد إخبارنا بها…"></textarea></div>' +
    '</div>' +
    '<div class="summary" id="coSummary"></div>' +
    '<button type="submit" class="btn-block" id="coSubmit">تأكيد الطلب</button>' +
    '<p class="est-note">بالضغط على تأكيد الطلب سيظهر لك رقم الحساب للتحويل.</p>' +
    '</form>';

  // payment option styling
  $$('#payOpts .pay-opt').forEach((lab) => lab.addEventListener('click', () => {
    Sound.click();
    $$('#payOpts .pay-opt').forEach((l) => l.classList.remove('sel'));
    lab.classList.add('sel');
  }));

  const refreshSummary = () => {
    const lines = [];
    let total = 0;
    groups.forEach((gr) => gr.items.forEach((it) => {
      const lt = Number(it.pkg.price_dzd) * Number(it.cart.qty);
      total += lt;
      lines.push('<div class="s-row"><span>' + esc(gr.game.name_ar) + ' — ' + esc(it.pkg.amount_label) + ' × <span class="num">' + esc(it.cart.qty) + '</span></span><span class="num">' + esc(fmtDzd(lt)) + '</span></div>');
    }));
    $('#coSummary').innerHTML = lines.join('') +
      '<div class="s-row total"><span>المجموع التقديري</span><span class="num">' + esc(fmtDzd(total)) + '</span></div>' +
      '<p class="est-note">تقديري — المبلغ النهائي المعتمد من الخادم.</p>';
  };
  refreshSummary();

  $('#coForm').addEventListener('submit', async (e) => {
    e.preventDefault();
    const form = e.target;
    const btn = $('#coSubmit');
    let ok = true;

    const items = [];
    groups.forEach((gr, gi) => {
      const pidInput = $('#pid-' + gi);
      const exInput = $('#ex-' + gi);
      const pid = pidInput.value.trim();
      const pidOk = PLAYER_RE.test(pid);
      pidInput.closest('.field').classList.toggle('invalid', !pidOk);
      if (!pidOk) ok = false;

      let extra = '';
      if (exInput) {
        extra = exInput.value.trim();
        // optional: empty or charset-only, max 64 chars
        const charsetOk = extra === '' || /^[\p{L}\p{N} _\-#.,@]{1,64}$/u.test(extra);
        exInput.closest('.field').classList.toggle('invalid', !charsetOk);
        if (!charsetOk) ok = false;
      }
      gr.items.forEach((it) => {
        items.push({
          game_id: gr.game.id,
          package_id: it.pkg.id,
          qty: Number(it.cart.qty),
          player_id: pid,
          extra_value: extra || undefined
        });
      });
    });

    const pm = form.querySelector('input[name="payment_method"]:checked');
    if (!pm) { ok = false; toast('اختر طريقة الدفع'); }

    if (!ok) {
      Sound.error();
      toast('تحقق من الحقول المحددة بالأحمر');
      const bad = form.querySelector('.field.invalid input');
      if (bad) bad.focus();
      return;
    }

    btn.disabled = true;
    btn.textContent = 'جارٍ إرسال الطلب…';
    const idempotency_key = (crypto.randomUUID ? crypto.randomUUID() : 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, (c) => {
      const r = Math.random() * 16 | 0;
      return (c === 'x' ? r : (r & 0x3 | 0x8)).toString(16);
    }));
    try {
      const order = await api('/api/orders', {
        method: 'POST',
        body: JSON.stringify({
          items,
          payment_method: pm.value,
          customer_note: $('#coNote').value.trim() || undefined,
          idempotency_key
        })
      });
      try {
        sessionStorage.setItem('gspro-last-order', JSON.stringify({
          order_no: order.order_no,
          payment: order.payment,
          total_dzd: order.total_dzd
        }));
      } catch (e) {}
      Cart.clear();
      Sound.success();
      Layla.voice('order');
      location.hash = '#/order/' + encodeURIComponent(order.order_no);
    } catch (err) {
      Sound.error();
      toast(err.message);
      btn.disabled = false;
      btn.textContent = 'تأكيد الطلب';
    }
  });

  Layla.voice('safe');
  Layla.onView('checkout');
}

/* ================= View: Order / Payment ================= */
function statusPill(s, sAr) {
  return '<span class="status-pill st-' + esc(s) + '">' + esc(sAr || STATUS_AR[s] || s) + '</span>';
}

function proofFormHTML(order_no, canProof) {
  if (!canProof) return '';
  return (
    '<div class="order-card"><h3 style="margin:0 0 4px">إثبات الدفع</h3>' +
    '<p class="sub" style="color:var(--ink-2);font-size:13px;margin:0 0 12px">بعد التحويل، أدخل رقم التحويل (المرجع) وأرفق صورة الوصل إن توفرت.</p>' +
    '<form id="proofForm" novalidate>' +
      '<div class="field"><label for="tref">رقم التحويل (المرجع) *</label>' +
        '<input id="tref" dir="ltr" autocomplete="off" maxlength="64" placeholder="مثال: CCP-123456" />' +
        '<div class="err">رقم التحويل مطلوب (4 أحرف على الأقل).</div></div>' +
      '<div class="field"><label for="receipt">صورة الوصل (اختياري — JPG/PNG/WebP حتى 3MB)</label>' +
        '<input type="file" id="receipt" class="file-input" accept="image/jpeg,image/png,image/webp" />' +
        '<div class="err">الملف يجب أن يكون صورة (JPG/PNG/WebP) بحجم أقصاه 3MB.</div></div>' +
      '<button type="submit" class="btn-block" id="proofBtn">إرسال إثبات الدفع</button>' +
    '</form></div>'
  );
}

function bindProofForm(order_no) {
  const form = $('#proofForm');
  if (!form) return;
  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    const refInput = $('#tref');
    const fileInput = $('#receipt');
    const ref = refInput.value.trim();
    let ok = true;
    if (ref.length < 4 || ref.length > 64) {
      refInput.closest('.field').classList.add('invalid');
      ok = false;
    } else refInput.closest('.field').classList.remove('invalid');

    const file = fileInput.files[0];
    if (file) {
      const goodType = ['image/jpeg', 'image/png', 'image/webp'].includes(file.type);
      const goodSize = file.size <= 3 * 1024 * 1024;
      fileInput.closest('.field').classList.toggle('invalid', !(goodType && goodSize));
      if (!(goodType && goodSize)) ok = false;
    } else fileInput.closest('.field').classList.remove('invalid');

    if (!ok) { Sound.error(); return; }

    const btn = $('#proofBtn');
    btn.disabled = true;
    btn.textContent = 'جارٍ الإرسال…';
    const fd = new FormData();
    fd.append('transfer_ref', ref);
    if (file) fd.append('receipt', file);
    try {
      const r = await fetch('/api/orders/' + encodeURIComponent(order_no) + '/proof', { method: 'POST', body: fd });
      const data = await r.json().catch(() => ({}));
      if (!r.ok) throw new Error(data.error || 'تعذّر إرسال الإثبات');
      Sound.success();
      toast('تم إرسال إثبات الدفع — طلبك قيد المراجعة');
      render(); // refresh order view
    } catch (err) {
      Sound.error();
      toast(err.message);
      btn.disabled = false;
      btn.textContent = 'إرسال إثبات الدفع';
    }
  });
}

function renderOrder(v, order_no) {
  if (!order_no) {
    v.innerHTML = '<div class="error-box" style="margin-top:16px"><b>رقم طلب غير صالح</b></div>';
    return;
  }
  v.innerHTML = '<div class="loading"><div class="spin"></div>جارٍ تحميل الطلب…</div>';

  // Payment instructions survive only from the creation response (session-scoped)
  let cached = null;
  try {
    const raw = sessionStorage.getItem('gspro-last-order');
    if (raw) {
      const o = JSON.parse(raw);
      if (o.order_no === order_no) cached = o;
    }
  } catch (e) {}

  api('/api/orders/' + encodeURIComponent(order_no)).then((o) => {
    const canProof = o.status === 'awaiting_payment';
    let html =
      '<div class="page-intro"><h2>طلبك</h2><p>احتفظ برقم الطلب لتتبع حالته في أي وقت.</p></div>' +
      '<div class="order-card">' +
        '<div class="o-no"><b class="num" dir="ltr">' + esc(o.order_no) + '</b>' + statusPill(o.status, o.status_ar) + '</div>' +
        '<div class="s-row" style="display:flex;justify-content:space-between;padding:4px 0"><span>المجموع</span><b class="num" style="color:var(--brand);font-size:18px">' + esc(fmtDzd(o.total_dzd)) + '</b></div>' +
        '<div class="s-row" style="display:flex;justify-content:space-between;padding:4px 0;color:var(--ink-2);font-size:13px"><span>طريقة الدفع</span><span>' + esc(PAY_METHOD_AR[o.payment_method] || o.payment_method) + '</span></div>' +
        '<div class="s-row" style="display:flex;justify-content:space-between;padding:4px 0;color:var(--ink-2);font-size:13px"><span>تاريخ الطلب</span><span>' + esc(fmtDate(o.created_at)) + '</span></div>' +
      '</div>';

    if (cached && cached.payment) {
      const p = cached.payment;
      html +=
        '<div class="order-card"><h3 style="margin:0 0 4px">خطوات الدفع</h3>' +
        '<p style="color:var(--ink-2);font-size:13.5px;line-height:1.9;margin:0 0 12px">' + esc(p.instructions || 'حوّل المبلغ الإجمالي إلى الحساب التالي، ثم أرسل رقم التحويل أدناه.') + '</p>' +
        '<div class="copy-row" style="margin-bottom:10px"><code>' + esc(p.account_number) + '</code>' +
        '<button class="copy-btn" id="copyAcc"><svg class="ic"><use href="#i-copy"/></svg> نسخ</button></div>' +
        '<p style="font-size:12.5px;color:var(--ink-2)">' + esc(p.account_label || '') + ' — المبلغ: <b class="num" style="color:var(--brand)">' + esc(fmtDzd(cached.total_dzd)) + '</b></p>' +
        '</div>';
      Layla.voice('payment');
    } else if (canProof) {
      html += '<div class="pay-note">تفاصيل حساب الدفع ظهرت لك لحظة إنشاء الطلب. إن فقدتها، تواصل معنا عبر صفحة المساعدة وسنرسلها لك.</div>';
    }

    html += proofFormHTML(order_no, canProof);

    html += '<div class="order-card"><h3 style="margin:0 0 6px">محتويات الطلب</h3>';
    (o.items || []).forEach((it) => {
      html += '<div class="co-item"><div><div class="ci-name">' + esc(it.game_name_ar) + ' — ' + esc(it.package_label) + '</div>' +
        '<div class="ci-meta">الكمية: <span class="num">' + esc(it.qty) + '</span> · ' + esc('معرّف اللاعب') + ': <span class="num" dir="ltr">' + esc(it.player_id) + '</span></div></div>' +
        '<b class="num" style="color:var(--brand)">' + esc(fmtDzd(it.line_total)) + '</b></div>';
    });
    html += '</div>';

    // timeline from history
    const hist = o.history || [];
    html += '<div class="order-card"><h3 style="margin:0 0 6px">سير الطلب</h3>';
    if (hist.length) {
      html += '<ul class="timeline">' + hist.map((hh, i) =>
        '<li class="' + (hh.to_status === 'rejected' ? 'bad' : 'done') + '"><b>' + esc(hh.to_status_ar || STATUS_AR[hh.to_status] || hh.to_status) + '</b><span>' + esc(fmtDate(hh.at)) + '</span></li>'
      ).join('') + '</ul>';
    } else {
      html += '<p style="color:var(--ink-2);font-size:13.5px">' + esc(o.status_ar || STATUS_AR[o.status]) + '</p>';
    }
    html += '</div>';

    v.innerHTML = html;

    const cp = $('#copyAcc');
    if (cp && cached && cached.payment) {
      cp.addEventListener('click', () => {
        Sound.click();
        const num = cached.payment.account_number;
        if (navigator.clipboard) navigator.clipboard.writeText(num).then(() => toast('تم نسخ رقم الحساب')).catch(() => toast(num));
        else toast(num);
      });
    }
    bindProofForm(order_no);
    Layla.onView('order');
  }).catch((err) => {
    v.innerHTML = '<div class="error-box" style="margin-top:16px"><b>تعذّر العثور على الطلب</b>' + esc(err.message) + '<br><a href="#/track">جرّب رقماً آخر</a></div>';
    Sound.error();
  });
}

/* ================= View: Track ================= */
function renderTrack(v) {
  v.innerHTML =
    '<div class="page-intro"><h2>تتبع الطلب</h2><p>أدخل رقم طلبك (مثال: <span class="num" dir="ltr">GS-20250101-AB12</span>) لعرض حالته.</p></div>' +
    '<div class="order-card"><form id="trackForm">' +
      '<div class="field"><label for="trackNo">رقم الطلب</label>' +
      '<input id="trackNo" dir="ltr" autocomplete="off" placeholder="GS-…" maxlength="32" style="text-transform:uppercase" /></div>' +
      '<button type="submit" class="btn-block">عرض حالة الطلب</button>' +
    '</form><div id="trackResult" style="margin-top:14px"></div></div>';

  $('#trackForm').addEventListener('submit', async (e) => {
    e.preventDefault();
    const no = $('#trackNo').value.trim();
    if (!no) { toast('أدخل رقم الطلب أولاً'); return; }
    Sound.click();
    const box = $('#trackResult');
    box.innerHTML = '<div class="loading"><div class="spin"></div>جارٍ البحث…</div>';
    try {
      const o = await api('/api/orders/' + encodeURIComponent(no));
      const hist = o.history || [];
      box.innerHTML =
        '<div class="o-no" style="display:flex;justify-content:space-between;align-items:center;gap:10px;margin-bottom:10px">' +
          '<b class="num" dir="ltr">' + esc(o.order_no) + '</b>' + statusPill(o.status, o.status_ar) + '</div>' +
        '<div style="display:flex;justify-content:space-between;padding:4px 0"><span>المجموع</span><b class="num" style="color:var(--brand)">' + esc(fmtDzd(o.total_dzd)) + '</b></div>' +
        (hist.length ? '<ul class="timeline">' + hist.map((hh) =>
          '<li class="' + (hh.to_status === 'rejected' ? 'bad' : 'done') + '"><b>' + esc(hh.to_status_ar || STATUS_AR[hh.to_status] || hh.to_status) + '</b><span>' + esc(fmtDate(hh.at)) + '</span></li>'
        ).join('') + '</ul>' : '') +
        '<a class="btn-outline" style="margin-top:10px" href="#/order/' + esc(encodeURIComponent(o.order_no)) + '">فتح صفحة الطلب</a>';
      Layla.voice('shipping');
    } catch (err) {
      Sound.error();
      box.innerHTML = '<div class="error-box"><b>لم يتم العثور على الطلب</b>' + esc(err.message) + '</div>';
    }
  });
  Layla.onView('track');
}

/* ================= View: Help ================= */
const FAQS = [
  { q: 'كيف أطلب شحناً للعبتي؟', a: 'اختر لعبتك من صفحة الألعاب، أضف الباقة إلى السلة، ثم أدخل معرّف اللاعب الخاص بك بدقة واختر طريقة الدفع. بعد تأكيد الطلب ستحصل على رقم الحساب للتحويل، ثم ترسل رقم التحويل كإثبات للدفع.' },
  { q: 'ما هي طرق الدفع المقبولة؟', a: 'نقبل الدفع عبر CCP و BaridiMob فقط. رقم الحساب يظهر لك مباشرة بعد تأكيد الطلب.' },
  { q: 'كم يستغرق الشحن بعد الدفع؟', a: 'بعد إرسال إثبات الدفع تتم مراجعته يدوياً، ثم يُشحن حسابك. يمكنك متابعة حالة طلبك لحظة بلحظة من صفحة «تتبع الطلب» برقم الطلب.' },
  { q: 'أين أجد معرّف اللاعب (UID)؟', a: 'تجد معرّف اللاعب داخل اللعبة في صفحة حسابك أو ملفك الشخصي — عادة أرقام ظاهرة بجانب اسمك. تأكد من نسخه بدقة لأن الشحن يتم عليه مباشرة.' },
  { q: 'هل الدفع آمن؟', a: 'نعم. الدفع يتم عبر تحويل CCP أو BaridiMob مباشرة، ولا نطلب منك أي بيانات بنكية. إثبات الدفع (رقم التحويل) يُستخدم فقط للتأكد من استلام المبلغ.' },
  { q: 'ماذا لو أدخلت معرّفاً خاطئاً؟', a: 'تواصل معنا فوراً عبر واتساب الدعم مع رقم طلبك قبل إتمام الشحن، وسنصحح المعرّف إن أمكن.' }
];

function renderHelp(v) {
  v.innerHTML =
    '<div class="page-intro"><h2>المساعدة</h2><p>إجابات عن الأسئلة الأكثر شيوعاً حول الطلب والدفع والشحن.</p></div>' +
    '<div class="faq">' + FAQS.map((f, i) =>
      '<details' + (i === 0 ? ' open' : '') + '><summary>' + esc(f.q) + '</summary><p>' + esc(f.a) + '</p></details>'
    ).join('') + '</div>' +
    '<div class="support-card"><h3>ما زلت تحتاج مساعدة؟</h3>' +
    '<p>' + esc(state.settings.support_text || 'راسلنا وسنرد عليك في أقرب وقت.') + '</p>' +
    '<button class="btn-brand" id="helpLayla"><svg class="ic" style="width:18px;height:18px"><use href="#i-chat"/></svg> اسأل ليلى</button></div>';

  $('#helpLayla').addEventListener('click', () => { Sound.click(); Layla.openPanel(); });
  Layla.voice('howto');
  Layla.onView('help');
}

/* ================= Layla — the store helper ================= */
const Layla = (() => {
  const reduced = window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  const mascot = $('#mascot');
  const charBtn = $('#mascotChar');
  const bubble = $('#mascotBubble');
  const bubbleText = $('#bubbleText');
  const panel = $('#mascotPanel');
  const mpBody = $('#mpBody');
  const mpChips = $('#mpChips');
  const walker = $('#walker');
  const walkerBubble = $('#walkerBubble');
  const walkerText = $('#walkerText');
  const dot = $('#mascotDot');

  const TIPS = [
    'أهلاً بك في Ghalem Store! اضغط عليّ في أي وقت للمساعدة.',
    'تذكّر: أدخل معرّف اللاعب بدقة — عليه يتم الشحن.',
    'الدفع عبر CCP أو BaridiMob فقط، ورقم الحساب يظهر بعد تأكيد الطلب.',
    'بعد التحويل أرسل رقم التحويل كإثبات للدفع من صفحة طلبك.',
    'تابع حالة طلبك برقمه من صفحة «تتبع الطلب».',
    'العروض في صفحة «العروض» خصومات حقيقية سارية الآن فقط.'
  ];
  const PANEL_FAQS = [
    { q: 'كيف أطلب؟', a: 'اختر لعبتك ← أضف الباقة للسلة ← أدخل معرّف اللاعب ← ادفع عبر CCP أو BaridiMob ← أرسل رقم التحويل كإثبات. يصلك الشحن بعد مراجعة الدفع.' },
    { q: 'طرق الدفع؟', a: 'نقبل CCP و BaridiMob. رقم الحساب يظهر لك مباشرة بعد تأكيد الطلب.' },
    { q: 'أين معرّف اللاعب؟', a: 'داخل اللعبة في صفحة حسابك أو ملفك الشخصي — انسخه بدقة.' },
    { q: 'كم يستغرق الشحن؟', a: 'بعد إرسال إثبات الدفع نراجعه يدوياً ثم نشحن حسابك. تابع الحالة برقم طلبك من صفحة التتبع.' },
    { q: 'الدفع آمن؟', a: 'نعم — تحويل مباشر عبر CCP/BaridiMob ولا نطلب أي بيانات بنكية.' }
  ];

  let bubbleTimer = null;
  let tipIdx = 0;
  let panelOpen = false;
  let greeted = false;

  /* ---- blink loop ---- */
  function blinkLoop() {
    setTimeout(() => {
      document.body.classList.add('mascot-blink-on');
      setTimeout(() => document.body.classList.remove('mascot-blink-on'), 150);
      blinkLoop();
    }, 2800 + Math.random() * 3200);
  }

  /* ---- speech bubble ---- */
  function say(text, ms) {
    bubbleText.textContent = text;
    bubble.classList.add('show');
    clearTimeout(bubbleTimer);
    bubbleTimer = setTimeout(() => bubble.classList.remove('show'), ms || 6000);
  }
  function rotateTips() {
    if (reduced || panelOpen) { scheduleTips(); return; }
    tipIdx = (tipIdx + 1) % TIPS.length;
    say(TIPS[tipIdx]);
    scheduleTips();
  }
  function scheduleTips() {
    clearTimeout(rotateTips._t);
    rotateTips._t = setTimeout(rotateTips, 30000 + Math.random() * 20000);
  }
  $('#bubbleX').addEventListener('click', (e) => {
    e.stopPropagation();
    bubble.classList.remove('show');
  });

  /* ---- help panel ---- */
  function addMsg(text, me) {
    const d = document.createElement('div');
    d.className = 'msg ' + (me ? 'me' : 'bot');
    d.textContent = text; // textContent — never innerHTML with data
    mpBody.appendChild(d);
    mpBody.scrollTop = mpBody.scrollHeight;
    return d;
  }
  function addTyping() {
    const d = document.createElement('div');
    d.className = 'msg bot typing';
    d.innerHTML = '<i></i><i></i><i></i>'; // static markup only
    mpBody.appendChild(d);
    mpBody.scrollTop = mpBody.scrollHeight;
    return d;
  }
  function answer(faq) {
    addMsg(faq.q, true);
    Sound.click();
    const t = addTyping();
    setTimeout(() => {
      t.remove();
      addMsg(faq.a, false);
    }, reduced ? 60 : 700);
  }
  function openPanel() {
    panelOpen = true;
    panel.classList.add('show');
    panel.setAttribute('aria-hidden', 'false');
    bubble.classList.remove('show');
    dot.style.display = 'none';
    mascot.classList.add('waving');
    setTimeout(() => mascot.classList.remove('waving'), 900);
    Sound.voice('greeting');
    if (!mpBody.children.length) {
      addMsg('أهلاً! أنا ليلى، مساعدة المتجر. اختر سؤالاً وسأجيبك فوراً.', false);
    }
    if (!mpChips.children.length) {
      PANEL_FAQS.forEach((f) => {
        const c = document.createElement('button');
        c.className = 'mp-chip';
        c.type = 'button';
        c.textContent = f.q;
        c.addEventListener('click', () => answer(f));
        mpChips.appendChild(c);
      });
    }
  }
  function closePanel() {
    panelOpen = false;
    panel.classList.remove('show');
    panel.setAttribute('aria-hidden', 'true');
  }
  charBtn.addEventListener('click', () => {
    Sound.click();
    if (panelOpen) closePanel();
    else {
      openPanel();
      if (!greeted) { greeted = true; }
    }
  });
  $('#panelClose').addEventListener('click', () => { Sound.click(); closePanel(); });
  document.addEventListener('keydown', (e) => { if (e.key === 'Escape' && panelOpen) closePanel(); });

  /* ---- walking tour ---- */
  let walking = false;
  function walk() {
    if (reduced || walking || panelOpen || document.hidden) { scheduleWalk(); return; }
    walking = true;
    mascot.classList.add('away');
    walker.classList.add('show', 'walking');
    walkerText.textContent = TIPS[Math.floor(Math.random() * TIPS.length)];
    const dist = window.innerWidth + 260;
    const dur = Math.max(9, Math.min(18, dist / 110)); // ~110 px/s
    const frames = Math.max(1, Math.round(dur * 30));
    let f = 0;
    const start = -160;
    walker.style.transform = 'translateX(' + start + 'px)';
    setTimeout(() => walkerBubble.classList.add('show'), 1500);
    const dust = $('#walkerDust');
    const dustTimer = setInterval(() => {
      const p = document.createElement('span');
      p.className = 'puff';
      p.style.left = (20 + Math.random() * 60) + 'px';
      dust.appendChild(p);
      setTimeout(() => p.remove(), 600);
    }, 480);
    const timer = setInterval(() => {
      f++;
      const x = start + (dist - start) * (f / frames);
      walker.style.transform = 'translateX(' + x + 'px)';
      if (f >= frames) {
        clearInterval(timer);
        clearInterval(dustTimer);
        walker.classList.remove('walking');
        walkerBubble.classList.remove('show');
        walker.classList.add('hop');
        setTimeout(() => {
          walker.classList.remove('hop');
          walker.classList.add('wave');
          Sound.voice('greeting');
          setTimeout(() => {
            walker.classList.remove('wave', 'show');
            walker.style.transform = '';
            mascot.classList.remove('away');
            walking = false;
          }, 900);
        }, 600);
      }
    }, 1000 / 30);
    scheduleWalk();
  }
  function scheduleWalk() {
    clearTimeout(scheduleWalk._t);
    scheduleWalk._t = setTimeout(walk, 80000 + Math.random() * 70000); // every ~80–150s
  }
  walker.addEventListener('click', () => {
    Sound.click();
    walker.classList.add('hop');
    walkerText.textContent = 'تفضل! اضغط على أي لعبة لعرض باقاتها.';
    walkerBubble.classList.add('show');
    Sound.voice('howto');
    setTimeout(() => {
      walker.classList.remove('hop');
      setTimeout(() => walkerBubble.classList.remove('show'), 2500);
    }, 600);
  });

  /* ---- view hooks: contextual voice + tips ---- */
  function onView(name) {
    if (name === 'deals') {
      dot.style.display = 'none';
    }
    if (name === 'checkout') {
      say('تحقق من معرّف اللاعب مرة أخيرة قبل التأكيد!');
    }
  }

  /* ---- init ---- */
  blinkLoop();
  scheduleWalk();
  setTimeout(() => {
    if (!document.hidden) {
      say(TIPS[0], 8000);
      dot.style.display = 'grid';
    }
    scheduleTips();
  }, 4000);

  return {
    voice: Sound.voice,
    openPanel,
    onView,
    say
  };
})();

/* ================= Boot ================= */
renderCartBadge();
render();
