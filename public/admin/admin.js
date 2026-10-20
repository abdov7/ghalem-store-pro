/* Ghalem Store Pro — admin panel (public/admin/admin.js) */
'use strict';

const $ = (sel, root) => (root || document).querySelector(sel);
const $$ = (sel, root) => Array.from((root || document).querySelectorAll(sel));

const esc = (s) => String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({
  '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
}[c]));

const fmtDzd = (n) => (Number(n) || 0).toString().replace(/\B(?=(\d{3})+(?!\d))/g, ' ') + ' د.ج';
const fmtDate = (iso) => {
  if (!iso) return '—';
  try { return new Date(iso).toLocaleString('ar-DZ', { dateStyle: 'medium', timeStyle: 'short' }); }
  catch (e) { return String(iso).slice(0, 16).replace('T', ' '); }
};
const toLocalInput = (iso) => {
  if (!iso) return '';
  const d = new Date(iso);
  const p = (x) => String(x).padStart(2, '0');
  return d.getFullYear() + '-' + p(d.getMonth() + 1) + '-' + p(d.getDate()) + 'T' + p(d.getHours()) + ':' + p(d.getMinutes());
};

const STATUS_AR = {
  awaiting_payment: 'بانتظار الدفع',
  under_review: 'قيد مراجعة الدفع',
  paid: 'تم الدفع',
  shipped: 'تم الشحن',
  rejected: 'مرفوض'
};
const TRANSITIONS = {
  awaiting_payment: [
    { to: 'under_review', label: 'وضع قيد المراجعة', cls: 'info' },
    { to: 'rejected', label: 'رفض الطلب', cls: 'danger' }
  ],
  under_review: [
    { to: 'paid', label: 'تأكيد الدفع', cls: 'ok' },
    { to: 'awaiting_payment', label: 'إرجاع لبانتظار الدفع', cls: 'warn' },
    { to: 'rejected', label: 'رفض الطلب', cls: 'danger' }
  ],
  paid: [
    { to: 'shipped', label: 'تأكيد الشحن', cls: 'ok' }
  ],
  shipped: [],
  rejected: []
};
const SETTING_KEYS = [
  { key: 'store_name', label: 'اسم المتجر' },
  { key: 'whatsapp_number', label: 'رقم واتساب', ltr: true },
  { key: 'support_text', label: 'نص الدعم', textarea: true },
  { key: 'pay_ccp_label', label: 'تسمية حساب CCP' },
  { key: 'pay_ccp_number', label: 'رقم حساب CCP', ltr: true },
  { key: 'pay_baridimob_label', label: 'تسمية حساب BaridiMob' },
  { key: 'pay_baridimob_number', label: 'رقم حساب BaridiMob', ltr: true },
  { key: 'payment_instructions_ar', label: 'تعليمات الدفع (عربي)', textarea: true }
];

let toastTimer = null;
function toast(msg) {
  const t = $('#toast');
  t.textContent = msg;
  t.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => t.classList.remove('show'), 2600);
}

async function api(path, opts) {
  const o = Object.assign({ credentials: 'same-origin', headers: { 'Content-Type': 'application/json' } }, opts || {});
  let res;
  try { res = await fetch(path, o); }
  catch (e) { throw new Error('تعذّر الاتصال بالخادم'); }
  if (res.status === 401) { showLogin(); throw new Error('انتهت الجلسة — سجّل الدخول مجدداً'); }
  let data = {};
  try { data = await res.json(); } catch (e) { /* empty */ }
  if (!res.ok) throw new Error(data && data.error ? data.error : 'حدث خطأ غير متوقع');
  return data;
}
function statusPill(s, sAr) {
  return '<span class="status-pill st-' + esc(s) + '">' + esc(sAr || STATUS_AR[s] || s) + '</span>';
}

/* ================= Auth ================= */
function showLogin() {
  $('#appView').hidden = true;
  $('#loginView').hidden = false;
}
function showApp(username) {
  $('#loginView').hidden = true;
  $('#appView').hidden = false;
  $('#meLabel').textContent = username ? 'مرحباً، ' + username : '';
  loadTab('orders');
}

$('#loginForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  const btn = $('#loginBtn');
  const err = $('#loginErr');
  err.textContent = '';
  btn.disabled = true;
  try {
    const r = await api('/api/admin/login', {
      method: 'POST',
      body: JSON.stringify({ username: $('#loginUser').value.trim(), password: $('#loginPass').value })
    });
    $('#loginPass').value = '';
    showApp(r.username);
  } catch (ex) {
    err.textContent = ex.message;
  } finally {
    btn.disabled = false;
  }
});

$('#logoutBtn').addEventListener('click', async () => {
  try { await api('/api/admin/logout', { method: 'POST' }); } catch (e) {}
  showLogin();
  toast('تم تسجيل الخروج');
});

/* ================= Tabs ================= */
const loadedTabs = {};
$$('#tabs .tab').forEach((b) => b.addEventListener('click', () => loadTab(b.dataset.tab)));
function loadTab(name) {
  $$('#tabs .tab').forEach((b) => b.classList.toggle('active', b.dataset.tab === name));
  $$('.tabpane').forEach((p) => { p.classList.toggle('active', p.id === 'tab-' + name); p.hidden = p.id !== 'tab-' + name; });
  if (name === 'orders') OrdersTab.render(true);
  else if (name === 'products') ProductsTab.render();
  else if (name === 'discounts') DiscountsTab.render();
  else if (name === 'settings') SettingsTab.render();
  else if (name === 'audit') AuditTab.render(true);
  else if (name === 'password') PasswordTab.render();
  loadedTabs[name] = true;
}

/* ================= Orders ================= */
const OrdersTab = (() => {
  const pane = () => $('#tab-orders');
  let filters = { status: '', q: '', from: '', to: '', page: 1, per_page: 20 };
  let total = 0;

  function render(reset) {
    if (reset) { /* keep filters */ }
    const p = pane();
    p.innerHTML =
      '<div class="pane-head"><h2>الطلبات</h2></div>' +
      '<div class="filters">' +
        '<select id="fStatus" aria-label="الحالة">' +
          '<option value="">كل الحالات</option>' +
          Object.keys(STATUS_AR).map((s) => '<option value="' + s + '"' + (filters.status === s ? ' selected' : '') + '>' + esc(STATUS_AR[s]) + '</option>').join('') +
        '</select>' +
        '<input id="fQ" placeholder="بحث برقم الطلب أو مرجع التحويل" value="' + esc(filters.q) + '" style="min-width:200px" />' +
        '<input id="fFrom" type="date" value="' + esc(filters.from) + '" aria-label="من تاريخ" />' +
        '<input id="fTo" type="date" value="' + esc(filters.to) + '" aria-label="إلى تاريخ" />' +
        '<button class="btn primary sm" id="fGo" style="width:auto">بحث</button>' +
      '</div>' +
      '<div class="table-wrap"><table><thead><tr>' +
        '<th>رقم الطلب</th><th>الحالة</th><th>المجموع</th><th>الدفع</th><th>التاريخ</th>' +
      '</tr></thead><tbody id="ordersBody"><tr><td colspan="5" class="empty-box">جارٍ التحميل…</td></tr></tbody></table></div>' +
      '<div class="pager"><button class="btn ghost sm" id="pgPrev">السابق</button><span id="pgInfo"></span><button class="btn ghost sm" id="pgNext">التالي</button></div>';

    $('#fGo').addEventListener('click', () => {
      filters.status = $('#fStatus').value;
      filters.q = $('#fQ').value.trim();
      filters.from = $('#fFrom').value;
      filters.to = $('#fTo').value;
      filters.page = 1;
      fetchList();
    });
    $('#fQ').addEventListener('keydown', (e) => { if (e.key === 'Enter') $('#fGo').click(); });
    $('#pgPrev').addEventListener('click', () => { if (filters.page > 1) { filters.page--; fetchList(); } });
    $('#pgNext').addEventListener('click', () => { if (filters.page * filters.per_page < total) { filters.page++; fetchList(); } });
    fetchList();
  }

  async function fetchList() {
    const body = $('#ordersBody');
    body.innerHTML = '<tr><td colspan="5" class="empty-box">جارٍ التحميل…</td></tr>';
    const qs = new URLSearchParams();
    if (filters.status) qs.set('status', filters.status);
    if (filters.q) qs.set('q', filters.q);
    if (filters.from) qs.set('from', filters.from);
    if (filters.to) qs.set('to', filters.to);
    qs.set('page', filters.page);
    qs.set('per_page', filters.per_page);
    try {
      const r = await api('/api/admin/orders?' + qs.toString());
      const orders = r.orders || [];
      total = r.total || 0;
      if (!orders.length) {
        body.innerHTML = '<tr><td colspan="5" class="empty-box">لا توجد طلبات مطابقة.</td></tr>';
      } else {
        body.innerHTML = orders.map((o) =>
          '<tr class="clickable" data-id="' + esc(o.id) + '">' +
            '<td><b class="num" dir="ltr">' + esc(o.order_no) + '</b></td>' +
            '<td>' + statusPill(o.status) + '</td>' +
            '<td><b class="num">' + esc(fmtDzd(o.total_dzd)) + '</b></td>' +
            '<td>' + esc(o.payment_method === 'ccp' ? 'CCP' : o.payment_method === 'baridimob' ? 'BaridiMob' : o.payment_method) + '</td>' +
            '<td>' + esc(fmtDate(o.created_at)) + '</td>' +
          '</tr>'
        ).join('');
        $$('tr.clickable', body).forEach((tr) => tr.addEventListener('click', () => openDetail(tr.dataset.id)));
      }
      const pages = Math.max(1, Math.ceil(total / filters.per_page));
      $('#pgInfo').textContent = 'صفحة ' + filters.page + ' من ' + pages + ' — المجموع: ' + total;
    } catch (e) {
      body.innerHTML = '<tr><td colspan="5" class="empty-box">' + esc(e.message) + '</td></tr>';
    }
  }

  async function openDetail(id) {
    openDrawer('جارٍ تحميل الطلب…');
    try {
      const o = await api('/api/admin/orders/' + encodeURIComponent(id));
      const hasReceipt = !!(o.receipt_available || o.receipt_path || o.has_receipt);
      const actions = TRANSITIONS[o.status] || [];
      let html =
        '<div class="kv"><span>رقم الطلب</span><b class="num" dir="ltr">' + esc(o.order_no) + '</b></div>' +
        '<div class="kv"><span>الحالة</span>' + statusPill(o.status, o.status_ar) + '</div>' +
        '<div class="kv"><span>المجموع</span><b class="num">' + esc(fmtDzd(o.total_dzd)) + '</b></div>' +
        '<div class="kv"><span>طريقة الدفع</span><span>' + esc(o.payment_method) + '</span></div>' +
        (o.transfer_ref ? '<div class="kv"><span>مرجع التحويل</span><b class="num" dir="ltr">' + esc(o.transfer_ref) + '</b></div>' : '') +
        (o.customer_note ? '<div class="kv"><span>ملاحظة الزبون</span><span>' + esc(o.customer_note) + '</span></div>' : '') +
        '<div class="kv"><span>أُنشئ</span><span>' + esc(fmtDate(o.created_at)) + '</span></div>' +
        '<div class="kv"><span>حُدّث</span><span>' + esc(fmtDate(o.updated_at)) + '</span></div>' +
        (hasReceipt
          ? '<div class="sec-title">وصل الدفع</div><a class="btn info sm" href="/api/admin/orders/' + esc(o.id) + '/receipt" target="_blank" rel="noopener">تحميل الوصل</a>'
          : '<div class="sec-title">وصل الدفع</div><p class="muted" style="font-size:13px">لا يوجد وصل مرفق.</p>') +
        '<div class="sec-title">المنتجات ومعرّفات اللاعبين</div>' +
        (o.items || []).map((it) =>
          '<div class="item-box">' +
            '<b>' + esc(it.game_name_ar || it.game_id) + ' — ' + esc(it.label_snapshot || it.package_label) + '</b><br>' +
            'الكمية: <span class="num">' + esc(it.qty) + '</span> · السعر: <span class="num">' + esc(fmtDzd(it.unit_price_snapshot != null ? it.unit_price_snapshot : it.unit_price)) + '</span> · الإجمالي: <b class="num">' + esc(fmtDzd(it.line_total)) + '</b><br>' +
            'معرّف اللاعب: <b class="num" dir="ltr">' + esc(it.player_id) + '</b>' +
            (it.extra_value ? '<br>القيمة الإضافية: <b class="num" dir="ltr">' + esc(it.extra_value) + '</b>' : '') +
          '</div>'
        ).join('') +
        '<div class="sec-title">تغيير الحالة</div>';

      if (actions.length) {
        html += '<div class="field"><label for="stNote">ملاحظة (اختياري)</label><input id="stNote" maxlength="200" /></div>' +
          '<div class="status-actions">' +
          actions.map((a, i) => '<button class="btn sm ' + a.cls + '" data-to="' + esc(a.to) + '">' + esc(a.label) + '</button>').join('') +
          '</div>';
      } else {
        html += '<p class="muted" style="font-size:13px">هذه حالة نهائية — لا يمكن تغييرها.</p>';
      }

      const hist = o.history || [];
      html += '<div class="sec-title">السجل</div>';
      html += hist.length
        ? '<ul class="timeline">' + hist.map((hh) =>
            '<li class="' + (hh.to_status === 'rejected' ? 'bad' : 'done') + '"><b>' + esc(hh.to_status_ar || STATUS_AR[hh.to_status] || hh.to_status) + '</b><small>' + esc(fmtDate(hh.at || hh.created_at)) + (hh.changed_by ? ' — ' + esc(hh.changed_by) : '') + (hh.note ? ' — ' + esc(hh.note) : '') + '</small></li>'
          ).join('') + '</ul>'
        : '<p class="muted" style="font-size:13px">لا يوجد سجل بعد.</p>';

      const audit = o.audit || o.audit_entries || [];
      if (audit.length) {
        html += '<div class="sec-title">تدقيق</div>' + audit.map((a) =>
          '<div class="item-box">' + esc(a.action) + ' — ' + esc(a.admin_id != null ? 'مدير #' + a.admin_id : '') + ' <small class="muted">' + esc(fmtDate(a.created_at)) + '</small>' +
          (a.detail ? '<br><span class="muted">' + esc(a.detail) + '</span>' : '') + '</div>'
        ).join('');
      }

      $('#drawerBody').innerHTML = html;
      $$('#drawerBody [data-to]').forEach((b) => b.addEventListener('click', async () => {
        const note = ($('#stNote') || {}).value || '';
        if (!confirm('تأكيد تغيير الحالة إلى «' + b.textContent.trim() + '»؟')) return;
        b.disabled = true;
        try {
          const r = await api('/api/admin/orders/' + encodeURIComponent(id) + '/status', {
            method: 'PATCH',
            body: JSON.stringify({ to: b.dataset.to, note: note || undefined })
          });
          toast('تم تحديث الحالة إلى: ' + (STATUS_AR[r.status] || r.status));
          openDetail(id);
          fetchList();
        } catch (e) {
          toast(e.message);
          b.disabled = false;
        }
      }));
    } catch (e) {
      $('#drawerBody').innerHTML = '<div class="empty-box">' + esc(e.message) + '</div>';
    }
  }

  return { render };
})();

/* ================= Drawer ================= */
function openDrawer(html) {
  $('#drawerTitle').textContent = 'تفاصيل الطلب';
  $('#drawerBody').innerHTML = html;
  $('#overlay').classList.add('show');
  $('#orderDrawer').classList.add('show');
  document.body.style.overflow = 'hidden';
}
function closeDrawer() {
  $('#overlay').classList.remove('show');
  $('#orderDrawer').classList.remove('show');
  document.body.style.overflow = '';
}
$('#drawerClose').addEventListener('click', closeDrawer);
$('#overlay').addEventListener('click', closeDrawer);

/* ================= Products ================= */
const ProductsTab = (() => {
  const pane = () => $('#tab-products');
  let games = [];
  let packages = [];

  async function render() {
    const p = pane();
    p.innerHTML = '<div class="pane-head"><h2>المنتجات</h2><button class="btn primary sm" id="addGameBtn" style="width:auto">لعبة جديدة</button></div><div id="gamesList"><div class="empty-box">جارٍ التحميل…</div></div>';
    $('#addGameBtn').addEventListener('click', () => gameForm(null));
    try {
      const [g, pk] = await Promise.all([
        api('/api/admin/games'),
        api('/api/admin/packages')
      ]);
      games = Array.isArray(g) ? g : (g.games || []);
      packages = Array.isArray(pk) ? pk : (pk.packages || []);
      renderList();
    } catch (e) {
      $('#gamesList').innerHTML = '<div class="empty-box">' + esc(e.message) + '</div>';
    }
  }

  function renderList() {
    const box = $('#gamesList');
    if (!games.length) { box.innerHTML = '<div class="empty-box">لا توجد ألعاب.</div>'; return; }
    box.innerHTML = games.map((g) => {
      const pkgs = packages.filter((x) => String(x.game_id) === String(g.id));
      return (
        '<div class="game-row" data-game="' + esc(g.id) + '">' +
          '<div class="game-row-head">' +
            '<span class="nm">' + esc(g.name_ar) + '</span>' +
            '<span class="meta num" dir="ltr">' + esc(g.name_en) + '</span>' +
            '<span class="meta">' + pkgs.length + ' باقة</span>' +
            (g.active ? '' : '<span class="inactive-tag">معطّلة</span>') +
            '<span class="spacer"></span>' +
            '<button class="btn ghost sm" data-edit-game="' + esc(g.id) + '">تعديل</button>' +
          '</div>' +
          '<div class="game-row-body">' +
            pkgs.map((x) =>
              '<div class="item-box" style="display:flex;align-items:center;gap:10px;flex-wrap:wrap">' +
                '<b>' + esc(x.amount_label) + '</b>' +
                '<span class="num">' + esc(fmtDzd(x.price_dzd)) + '</span>' +
                (x.is_hot ? '<span class="inactive-tag" style="background:#ffe9e2;color:#c85a10">الأكثر طلباً</span>' : '') +
                (x.active ? '' : '<span class="inactive-tag">معطّلة</span>') +
                '<span class="spacer" style="flex:1"></span>' +
                '<button class="btn ghost sm" data-edit-pkg="' + esc(x.id) + '">تعديل</button>' +
              '</div>'
            ).join('') +
            '<button class="btn ghost sm" data-add-pkg="' + esc(g.id) + '" style="margin-top:6px">+ باقة جديدة</button>' +
          '</div>' +
        '</div>'
      );
    }).join('');

    $$('.game-row-head', box).forEach((h) => h.addEventListener('click', (e) => {
      if (e.target.closest('button')) return;
      h.closest('.game-row').classList.toggle('open');
    }));
    $$('[data-edit-game]', box).forEach((b) => b.addEventListener('click', () => gameForm(gameByIdLocal(b.dataset.editGame))));
    $$('[data-edit-pkg]', box).forEach((b) => b.addEventListener('click', () => pkgForm(pkgByIdLocal(b.dataset.editPkg), b.dataset.editPkg && pkgByIdLocal(b.dataset.editPkg).game_id)));
    $$('[data-add-pkg]', box).forEach((b) => b.addEventListener('click', () => pkgForm(null, b.dataset.addPkg)));
  }

  function gameByIdLocal(id) { return games.find((g) => String(g.id) === String(id)); }
  function pkgByIdLocal(id) { return packages.find((x) => String(x.id) === String(id)); }

  function gameForm(g) {
    const isNew = !g;
    g = g || {};
    openDrawer(
      '<div class="sec-title" style="margin-top:0">' + (isNew ? 'لعبة جديدة' : 'تعديل لعبة') + '</div>' +
      '<form id="gForm">' +
      (isNew ? '<div class="field"><label>المعرّف (id) *</label><input name="id" dir="ltr" required pattern="[a-z0-9]+" placeholder="freefire" /></div>' : '') +
      '<div class="field"><label>الاسم بالعربية *</label><input name="name_ar" value="' + esc(g.name_ar || '') + '" required /></div>' +
      '<div class="field-row"><div class="field"><label>الاسم بالإنجليزية *</label><input name="name_en" dir="ltr" value="' + esc(g.name_en || '') + '" required /></div>' +
      '<div class="field"><label>الاختصار *</label><input name="short" value="' + esc(g.short || '') + '" required /></div></div>' +
      '<div class="field-row"><div class="field"><label>الوحدة (مثال: جوهرة) *</label><input name="unit_ar" value="' + esc(g.unit_ar || '') + '" required /></div>' +
      '<div class="field"><label>ملف الغلاف</label><input name="cover_file" dir="ltr" value="' + esc(g.cover_file || '') + '" placeholder="freefire.webp" /></div></div>' +
      '<div class="field"><label>تسمية معرّف اللاعب *</label><input name="id_label" value="' + esc(g.id_label || '') + '" required /></div>' +
      '<div class="field"><label>تسمية الحقل الإضافي (اختياري)</label><input name="extra_label" value="' + esc(g.extra_label || '') + '" /></div>' +
      '<div class="field"><label>ترتيب العرض</label><input name="sort_order" type="number" value="' + esc(g.sort_order != null ? g.sort_order : 0) + '" /></div>' +
      '<label class="toggle"><input type="checkbox" name="active" ' + (g.active === 0 ? '' : 'checked') + ' /> مفعّلة</label>' +
      '<div style="margin-top:12px"><button type="submit" class="btn primary" style="width:100%">حفظ</button></div>' +
      '</form>'
    );
    $('#gForm').addEventListener('submit', async (e) => {
      e.preventDefault();
      const f = e.target;
      const body = {
        name_ar: f.name_ar.value.trim(),
        name_en: f.name_en.value.trim(),
        short: f.short.value.trim(),
        unit_ar: f.unit_ar.value.trim(),
        id_label: f.id_label.value.trim(),
        extra_label: f.extra_label.value.trim() || null,
        cover_file: f.cover_file.value.trim(),
        sort_order: Number(f.sort_order.value) || 0,
        active: f.active.checked ? 1 : 0
      };
      try {
        if (isNew) {
          body.id = f.id.value.trim();
          await api('/api/admin/games', { method: 'POST', body: JSON.stringify(body) });
        } else {
          await api('/api/admin/games/' + encodeURIComponent(g.id), { method: 'PUT', body: JSON.stringify(body) });
        }
        toast('تم الحفظ');
        closeDrawer();
        render();
      } catch (err) { toast(err.message); }
    });
  }

  function pkgForm(x, gameId) {
    const isNew = !x;
    x = x || {};
    openDrawer(
      '<div class="sec-title" style="margin-top:0">' + (isNew ? 'باقة جديدة' : 'تعديل باقة') + '</div>' +
      '<form id="pForm">' +
      '<div class="field"><label>اللعبة</label><select name="game_id">' +
        games.map((g) => '<option value="' + esc(g.id) + '"' + (String(g.id) === String(gameId || x.game_id) ? ' selected' : '') + '>' + esc(g.name_ar) + '</option>').join('') +
      '</select></div>' +
      '<div class="field"><label>التسمية (مثال: 310 جوهرة) *</label><input name="label_ar" value="' + esc(x.label_ar || '') + '" required /></div>' +
      '<div class="field-row"><div class="field"><label>الكمية (مثال: 310) *</label><input name="amount_label" value="' + esc(x.amount_label || '') + '" required /></div>' +
      '<div class="field"><label>السعر (د.ج) *</label><input name="price_dzd" type="number" min="0" step="1" value="' + esc(x.price_dzd != null ? x.price_dzd : '') + '" required /></div></div>' +
      '<div class="field"><label>ترتيب العرض</label><input name="sort_order" type="number" value="' + esc(x.sort_order != null ? x.sort_order : 0) + '" /></div>' +
      '<label class="toggle"><input type="checkbox" name="is_hot" ' + (x.is_hot ? 'checked' : '') + ' /> الأكثر طلباً</label><br>' +
      '<label class="toggle" style="margin-top:6px"><input type="checkbox" name="active" ' + (x.active === 0 ? '' : 'checked') + ' /> مفعّلة</label>' +
      '<div style="margin-top:12px"><button type="submit" class="btn primary" style="width:100%">حفظ</button></div>' +
      '</form>'
    );
    $('#pForm').addEventListener('submit', async (e) => {
      e.preventDefault();
      const f = e.target;
      const price = Math.round(Number(f.price_dzd.value));
      if (!(price > 0)) { toast('السعر يجب أن يكون رقماً موجباً'); return; }
      const body = {
        game_id: f.game_id.value,
        label_ar: f.label_ar.value.trim(),
        amount_label: f.amount_label.value.trim(),
        price_dzd: price,
        sort_order: Number(f.sort_order.value) || 0,
        is_hot: f.is_hot.checked ? 1 : 0,
        active: f.active.checked ? 1 : 0
      };
      try {
        if (isNew) await api('/api/admin/packages', { method: 'POST', body: JSON.stringify(body) });
        else await api('/api/admin/packages/' + encodeURIComponent(x.id), { method: 'PUT', body: JSON.stringify(body) });
        toast('تم الحفظ');
        closeDrawer();
        render();
      } catch (err) { toast(err.message); }
    });
  }

  return { render };
})();

/* ================= Discounts ================= */
const DiscountsTab = (() => {
  const pane = () => $('#tab-discounts');
  let discounts = [];
  let games = [];
  let packages = [];

  async function render() {
    const p = pane();
    p.innerHTML = '<div class="pane-head"><h2>الخصومات</h2><button class="btn primary sm" id="addDiscBtn" style="width:auto">خصم جديد</button></div>' +
      '<p class="muted" style="font-size:13px;margin:-4px 0 12px">تظهر الخصومات في المتجر فقط أثناء فترة سريانها الفعلية.</p>' +
      '<div class="table-wrap"><table><thead><tr><th>النطاق</th><th>المستهدف</th><th>النسبة</th><th>من</th><th>إلى</th><th>الحالة</th><th></th></tr></thead>' +
      '<tbody id="discBody"><tr><td colspan="7" class="empty-box">جارٍ التحميل…</td></tr></tbody></table></div>';
    $('#addDiscBtn').addEventListener('click', () => discForm(null));
    try {
      const [d, g, pk] = await Promise.all([
        api('/api/admin/discounts'),
        api('/api/admin/games'),
        api('/api/admin/packages')
      ]);
      discounts = Array.isArray(d) ? d : (d.discounts || []);
      games = Array.isArray(g) ? g : (g.games || []);
      packages = Array.isArray(pk) ? pk : (pk.packages || []);
      renderList();
    } catch (e) {
      $('#discBody').innerHTML = '<tr><td colspan="7" class="empty-box">' + esc(e.message) + '</td></tr>';
    }
  }

  function targetName(d) {
    if (d.scope === 'package') {
      const x = packages.find((p) => String(p.id) === String(d.package_id));
      return x ? (x.label_ar + ' (' + (games.find((g) => String(g.id) === String(x.game_id)) || {}).name_ar + ')') : 'باقة #' + d.package_id;
    }
    const g = games.find((gg) => String(gg.id) === String(d.game_id));
    return g ? g.name_ar : d.game_id;
  }
  function isLive(d) {
    const now = Date.now();
    return d.active && new Date(d.starts_at).getTime() <= now && now <= new Date(d.ends_at).getTime();
  }

  function renderList() {
    const body = $('#discBody');
    if (!discounts.length) { body.innerHTML = '<tr><td colspan="7" class="empty-box">لا توجد خصومات.</td></tr>'; return; }
    body.innerHTML = discounts.map((d) =>
      '<tr>' +
        '<td>' + esc(d.scope === 'package' ? 'باقة' : 'لعبة') + '</td>' +
        '<td>' + esc(targetName(d)) + '</td>' +
        '<td><b class="num">-' + esc(d.percent) + '%</b></td>' +
        '<td>' + esc(fmtDate(d.starts_at)) + '</td>' +
        '<td>' + esc(fmtDate(d.ends_at)) + '</td>' +
        '<td>' + (isLive(d) ? '<span class="status-pill st-paid">نشط الآن</span>' : '<span class="inactive-tag">غير نشط</span>') + '</td>' +
        '<td style="white-space:nowrap"><button class="btn ghost sm" data-edit="' + esc(d.id) + '">تعديل</button> <button class="btn danger sm" data-del="' + esc(d.id) + '">حذف</button></td>' +
      '</tr>'
    ).join('');
    $$('[data-edit]', body).forEach((b) => b.addEventListener('click', () => discForm(discounts.find((x) => String(x.id) === String(b.dataset.edit)))));
    $$('[data-del]', body).forEach((b) => b.addEventListener('click', async () => {
      if (!confirm('حذف هذا الخصم نهائياً؟')) return;
      try {
        await api('/api/admin/discounts/' + encodeURIComponent(b.dataset.del), { method: 'DELETE' });
        toast('تم حذف الخصم');
        render();
      } catch (e) { toast(e.message); }
    }));
  }

  function discForm(d) {
    const isNew = !d;
    d = d || { scope: 'package', percent: 10, active: 1 };
    openDrawer(
      '<div class="sec-title" style="margin-top:0">' + (isNew ? 'خصم جديد' : 'تعديل خصم') + '</div>' +
      '<form id="dForm">' +
      '<div class="field"><label>النطاق</label><select name="scope" id="dScope">' +
        '<option value="package"' + (d.scope === 'package' ? ' selected' : '') + '>باقة محددة</option>' +
        '<option value="game"' + (d.scope === 'game' ? ' selected' : '') + '>لعبة كاملة</option>' +
      '</select></div>' +
      '<div class="field" id="dPkgWrap"><label>الباقة</label><select name="package_id">' +
        packages.map((x) => '<option value="' + esc(x.id) + '"' + (String(x.id) === String(d.package_id) ? ' selected' : '') + '>' + esc(x.label_ar) + ' — ' + esc((games.find((g) => String(g.id) === String(x.game_id)) || {}).name_ar || '') + '</option>').join('') +
      '</select></div>' +
      '<div class="field" id="dGameWrap"><label>اللعبة</label><select name="game_id">' +
        games.map((g) => '<option value="' + esc(g.id) + '"' + (String(g.id) === String(d.game_id) ? ' selected' : '') + '>' + esc(g.name_ar) + '</option>').join('') +
      '</select></div>' +
      '<div class="field"><label>النسبة % (1–90) *</label><input name="percent" type="number" min="1" max="90" value="' + esc(d.percent) + '" required /></div>' +
      '<div class="field-row"><div class="field"><label>يبدأ في *</label><input name="starts_at" type="datetime-local" value="' + esc(toLocalInput(d.starts_at)) + '" required /></div>' +
      '<div class="field"><label>ينتهي في *</label><input name="ends_at" type="datetime-local" value="' + esc(toLocalInput(d.ends_at)) + '" required /></div></div>' +
      '<label class="toggle"><input type="checkbox" name="active" ' + (d.active === 0 ? '' : 'checked') + ' /> مفعّل</label>' +
      '<div style="margin-top:12px"><button type="submit" class="btn primary" style="width:100%">حفظ</button></div>' +
      '</form>'
    );
    const scopeSel = $('#dScope');
    const syncScope = () => {
      $('#dPkgWrap').style.display = scopeSel.value === 'package' ? '' : 'none';
      $('#dGameWrap').style.display = scopeSel.value === 'game' ? '' : 'none';
    };
    scopeSel.addEventListener('change', syncScope);
    syncScope();
    $('#dForm').addEventListener('submit', async (e) => {
      e.preventDefault();
      const f = e.target;
      const pct = Number(f.percent.value);
      if (!(pct >= 1 && pct <= 90)) { toast('النسبة يجب أن تكون بين 1 و 90'); return; }
      const s = new Date(f.starts_at.value);
      const en = new Date(f.ends_at.value);
      if (isNaN(s) || isNaN(en) || en <= s) { toast('تحقق من تاريخي البداية والنهاية'); return; }
      const body = {
        scope: f.scope.value,
        percent: pct,
        starts_at: s.toISOString(),
        ends_at: en.toISOString(),
        active: f.active.checked ? 1 : 0
      };
      if (body.scope === 'package') body.package_id = Number(f.package_id.value);
      else body.game_id = f.game_id.value;
      try {
        if (isNew) await api('/api/admin/discounts', { method: 'POST', body: JSON.stringify(body) });
        else await api('/api/admin/discounts/' + encodeURIComponent(d.id), { method: 'PUT', body: JSON.stringify(body) });
        toast('تم الحفظ');
        closeDrawer();
        render();
      } catch (err) { toast(err.message); }
    });
  }

  return { render };
})();

/* ================= Settings ================= */
const SettingsTab = (() => {
  const pane = () => $('#tab-settings');
  async function render() {
    const p = pane();
    p.innerHTML = '<div class="pane-head"><h2>الإعدادات</h2></div><div class="card" style="max-width:640px"><form id="setForm"><div class="empty-box">جارٍ التحميل…</div></form></div>';
    try {
      const s = await api('/api/admin/settings');
      $('#setForm').innerHTML =
        SETTING_KEYS.map((k) =>
          '<div class="field"><label for="set-' + esc(k.key) + '">' + esc(k.label) + '</label>' +
          (k.textarea
            ? '<textarea id="set-' + esc(k.key) + '" name="' + esc(k.key) + '">' + esc(s[k.key] || '') + '</textarea>'
            : '<input id="set-' + esc(k.key) + '" name="' + esc(k.key) + '" value="' + esc(s[k.key] || '') + '"' + (k.ltr ? ' dir="ltr"' : '') + ' />') +
          '</div>'
        ).join('') +
        '<button type="submit" class="btn primary" style="width:100%">حفظ الإعدادات</button>';
      $('#setForm').addEventListener('submit', async (e) => {
        e.preventDefault();
        const body = {};
        SETTING_KEYS.forEach((k) => { body[k.key] = e.target[k.key].value; });
        try {
          await api('/api/admin/settings', { method: 'PUT', body: JSON.stringify(body) });
          toast('تم حفظ الإعدادات');
        } catch (err) { toast(err.message); }
      });
    } catch (e) {
      $('#setForm').innerHTML = '<div class="empty-box">' + esc(e.message) + '</div>';
    }
  }
  return { render };
})();

/* ================= Audit log ================= */
const AuditTab = (() => {
  const pane = () => $('#tab-audit');
  let page = 1;
  const per = 30;
  async function render(reset) {
    if (reset) page = 1;
    const p = pane();
    p.innerHTML = '<div class="pane-head"><h2>سجل التدقيق</h2></div>' +
      '<div class="table-wrap"><table><thead><tr><th>التاريخ</th><th>المدير</th><th>الإجراء</th><th>الكيان</th><th>التفاصيل</th><th>IP</th></tr></thead>' +
      '<tbody id="auditBody"><tr><td colspan="6" class="empty-box">جارٍ التحميل…</td></tr></tbody></table></div>' +
      '<div class="pager"><button class="btn ghost sm" id="aPrev">السابق</button><span id="aInfo"></span><button class="btn ghost sm" id="aNext">التالي</button></div>';
    $('#aPrev').addEventListener('click', () => { if (page > 1) { page--; fetchLog(); } });
    $('#aNext').addEventListener('click', () => { page++; fetchLog(); });
    fetchLog();
  }
  async function fetchLog() {
    const body = $('#auditBody');
    try {
      const r = await api('/api/admin/audit-log?page=' + page);
      const rows = r.entries || r.rows || r.logs || [];
      if (!rows.length) body.innerHTML = '<tr><td colspan="6" class="empty-box">لا توجد إدخالات.</td></tr>';
      else body.innerHTML = rows.map((a) =>
        '<tr><td style="white-space:nowrap">' + esc(fmtDate(a.created_at)) + '</td>' +
        '<td>' + esc(a.username || (a.admin_id != null ? 'مدير #' + a.admin_id : '—')) + '</td>' +
        '<td><b>' + esc(a.action) + '</b></td>' +
        '<td>' + esc(a.entity || '—') + (a.entity_id ? ' <span class="num" dir="ltr">#' + esc(a.entity_id) + '</span>' : '') + '</td>' +
        '<td style="max-width:280px">' + esc(a.detail || '—') + '</td>' +
        '<td class="num" dir="ltr">' + esc(a.ip || '—') + '</td></tr>'
      ).join('');
      $('#aInfo').textContent = 'صفحة ' + page;
    } catch (e) {
      body.innerHTML = '<tr><td colspan="6" class="empty-box">' + esc(e.message) + '</td></tr>';
    }
  }
  return { render };
})();

/* ================= Password ================= */
const PasswordTab = (() => {
  const pane = () => $('#tab-password');
  function render() {
    const p = pane();
    p.innerHTML = '<div class="pane-head"><h2>تغيير كلمة المرور</h2></div>' +
      '<div class="card" style="max-width:480px"><form id="pwForm">' +
      '<div class="field"><label for="pwCur">كلمة المرور الحالية</label><input id="pwCur" type="password" autocomplete="current-password" required /></div>' +
      '<div class="field"><label for="pwNew">كلمة المرور الجديدة (10 أحرف على الأقل)</label><input id="pwNew" type="password" autocomplete="new-password" required minlength="10" /></div>' +
      '<div class="field"><label for="pwNew2">تأكيد الجديدة</label><input id="pwNew2" type="password" autocomplete="new-password" required /></div>' +
      '<div class="form-err" id="pwErr"></div>' +
      '<button type="submit" class="btn primary" style="width:100%">تغيير كلمة المرور</button>' +
      '</form></div>';
    $('#pwForm').addEventListener('submit', async (e) => {
      e.preventDefault();
      const err = $('#pwErr');
      err.textContent = '';
      const cur = $('#pwCur').value;
      const nw = $('#pwNew').value;
      if (nw.length < 10) { err.textContent = 'كلمة المرور الجديدة يجب أن تكون 10 أحرف على الأقل'; return; }
      if (nw !== $('#pwNew2').value) { err.textContent = 'تأكيد كلمة المرور غير متطابق'; return; }
      try {
        await api('/api/admin/password', { method: 'POST', body: JSON.stringify({ current: cur, new: nw }) });
        e.target.reset();
        toast('تم تغيير كلمة المرور');
      } catch (ex) { err.textContent = ex.message; }
    });
  }
  return { render };
})();

/* ================= Boot ================= */
(async () => {
  try {
    const me = await api('/api/admin/me');
    showApp(me.username);
  } catch (e) {
    showLogin();
  }
})();
