// Idempotent seed — the 8 games, all packages, and placeholder settings.
// CRITICAL: ZERO real secrets. All contact/payment numbers are obvious placeholders.
// The owner enters real values via the admin panel after deployment.
import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';
import { openDb } from './db.js';
import { migrate } from './migrate.js';

const GAMES = [
  {
    id: 'freefire', name_ar: 'فري فاير', name_en: 'Free Fire', short: 'FF',
    unit_ar: 'جوهرة', id_label: 'معرّف اللاعب (UID)', extra_label: null,
    cover_file: 'freefire.webp', sort_order: 1,
  },
  {
    id: 'pubg', name_ar: 'ببجي موبايل', name_en: 'PUBG Mobile', short: 'PUBG',
    unit_ar: 'UC', id_label: 'معرّف اللاعب (Player ID)', extra_label: null,
    cover_file: 'pubg.webp', sort_order: 2,
  },
  {
    id: 'codm', name_ar: 'كول أوف ديوتي موبايل', name_en: 'COD Mobile', short: 'COD',
    unit_ar: 'CP', id_label: 'معرّف اللاعب (Player ID)', extra_label: null,
    cover_file: 'codm.webp', sort_order: 3,
  },
  {
    id: 'mlbb', name_ar: 'موبايل ليجندز', name_en: 'Mobile Legends', short: 'ML',
    unit_ar: 'جوهرة', id_label: 'معرّف المستخدم (User ID)',
    extra_label: 'معرّف المنطقة (Zone ID)', cover_file: 'mlbb.webp', sort_order: 4,
  },
  {
    id: 'efootball', name_ar: 'eFootball', name_en: 'eFootball', short: 'eFB',
    unit_ar: 'عملة', id_label: 'معرّف اللاعب (Player ID)', extra_label: null,
    cover_file: 'efootball.webp', sort_order: 5,
  },
  {
    id: 'roblox', name_ar: 'روبلوكس', name_en: 'Roblox', short: 'RBX',
    unit_ar: 'Robux', id_label: 'اسم المستخدم (Username)', extra_label: null,
    cover_file: 'roblox.webp', sort_order: 6,
  },
  {
    id: 'fortnite', name_ar: 'فورتنايت', name_en: 'Fortnite', short: 'FN',
    unit_ar: 'V-Bucks', id_label: 'اسم حساب Epic', extra_label: null,
    cover_file: 'fortnite.webp', sort_order: 7,
  },
  {
    id: 'valorant', name_ar: 'فالورانت', name_en: 'Valorant', short: 'VAL',
    unit_ar: 'نقاط', id_label: 'Riot ID',
    extra_label: 'الوسم (Tag) — مثال: #DZ01', cover_file: 'valorant.webp', sort_order: 8,
  },
];

// [label_ar, amount_label, price_dzd, is_hot]
const PACKAGES = {
  freefire: [
    ['100 جوهرة', '100', 300, 0],
    ['310 جوهرة', '310', 950, 1],
    ['520 جوهرة', '520', 1550, 0],
    ['1060 جوهرة', '1060', 3100, 0],
    ['2180 جوهرة', '2180', 6250, 0],
    ['5600 جوهرة', '5600', 15600, 0],
    ['عضوية أسبوعية', '7 أيام', 650, 0],
    ['عضوية شهرية', '30 يوم', 3100, 0],
  ],
  pubg: [
    ['60 UC', '60', 300, 0],
    ['325 UC', '325', 1550, 1],
    ['660 UC', '660', 3100, 0],
    ['1800 UC', '1800', 7800, 0],
    ['3850 UC', '3850', 15600, 0],
    ['8100 UC', '8100', 31200, 0],
  ],
  codm: [
    ['80 CP', '80', 300, 0],
    ['400 CP', '400', 1550, 0],
    ['800 CP', '800', 3100, 1],
    ['2000 CP', '2000', 7800, 0],
    ['5000 CP', '5000', 15600, 0],
  ],
  mlbb: [
    ['55 جوهرة', '55', 300, 0],
    ['165 جوهرة', '165', 950, 0],
    ['275 جوهرة', '275', 1550, 1],
    ['565 جوهرة', '565', 3100, 0],
    ['1155 جوهرة', '1155', 6250, 0],
  ],
  efootball: [
    ['100 عملة', '100', 300, 0],
    ['550 عملة', '550', 1550, 1],
    ['1050 عملة', '1050', 3100, 0],
    ['2150 عملة', '2150', 6250, 0],
  ],
  roblox: [
    ['80 Robux', '80', 300, 0],
    ['400 Robux', '400', 1550, 1],
    ['800 Robux', '800', 3100, 0],
    ['2000 Robux', '2000', 7800, 0],
  ],
  fortnite: [
    ['1000 V-Bucks', '1000', 2800, 1],
    ['2800 V-Bucks', '2800', 7200, 0],
    ['5000 V-Bucks', '5000', 11500, 0],
  ],
  valorant: [
    ['475 نقطة', '475', 1550, 1],
    ['1000 نقطة', '1000', 3100, 0],
    ['2400 نقطة', '2400', 7800, 0],
  ],
};

// PLACEHOLDERS ONLY — the owner fills real values in the admin panel.
const SETTINGS = {
  store_name: 'Ghalem Store',
  whatsapp_number: '213XXXXXXXXX',
  support_text: 'للاستفسارات والمساعدة تواصل معنا عبر واتساب على الرقم الموجود في صفحة المساعدة.',
  pay_ccp_label: 'الحساب البريدي الجاري (CCP)',
  pay_ccp_number: 'RIP-PLACEHOLDER',
  pay_baridimob_label: 'بريدي موب (BaridiMob)',
  pay_baridimob_number: 'RIP-PLACEHOLDER',
  payment_instructions_ar:
    '1. حوّل المبلغ الإجمالي للطلب إلى حسابنا: [أدخل رقمك هنا]\n' +
    '2. احتفظ بمرجع التحويل (رقم العملية) الظاهر في وصل الدفع.\n' +
    '3. أدخل مرجع التحويل أدناه وأرفق صورة الإيصال إن وُجدت.\n' +
    '4. سنراجع الدفع يدوياً ونشحن حسابك بعد التأكيد.',
};

export function seed(db) {
  const counts = { games: 0, packages: 0, settings: 0 };

  const gameExists = db.prepare('SELECT 1 FROM games WHERE id = ?');
  const insertGame = db.prepare(
    `INSERT INTO games (id, name_ar, name_en, short, unit_ar, id_label, extra_label,
      cover_file, sort_order, active)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 1)`,
  );
  for (const g of GAMES) {
    if (!gameExists.get(g.id)) {
      insertGame.run(
        g.id, g.name_ar, g.name_en, g.short, g.unit_ar, g.id_label,
        g.extra_label, g.cover_file, g.sort_order,
      );
      counts.games += 1;
    }
  }

  const pkgExists = db.prepare('SELECT 1 FROM packages WHERE game_id = ? AND label_ar = ?');
  const insertPkg = db.prepare(
    `INSERT INTO packages (game_id, label_ar, amount_label, price_dzd, is_hot, sort_order, active)
     VALUES (?, ?, ?, ?, ?, ?, 1)`,
  );
  for (const [gameId, pkgs] of Object.entries(PACKAGES)) {
    pkgs.forEach(([label_ar, amount_label, price_dzd, is_hot], i) => {
      if (!pkgExists.get(gameId, label_ar)) {
        insertPkg.run(gameId, label_ar, amount_label, price_dzd, is_hot, i + 1);
        counts.packages += 1;
      }
    });
  }

  const insertSetting = db.prepare('INSERT OR IGNORE INTO settings (key, value) VALUES (?, ?)');
  for (const [key, value] of Object.entries(SETTINGS)) {
    const r = insertSetting.run(key, value);
    if (r.changes > 0) counts.settings += 1;
  }

  return counts;
}

// CLI: `node server/seed.js`
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const db = openDb();
  migrate(db);
  const counts = seed(db);
  db.close();
  console.log(`seed: ok (games +${counts.games}, packages +${counts.packages}, settings +${counts.settings})`);
}
