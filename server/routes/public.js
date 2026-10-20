// Public read-only API: health, catalog, public settings.
import { Router } from 'express';
import { effectivePrice, currentMaxDiscount } from '../pricing.js';
import { PUBLIC_SETTING_KEYS } from '../middleware/validate.js';

function gameShape(db, game, nowIso) {
  const pkgs = db
    .prepare('SELECT * FROM packages WHERE game_id = ? AND active = 1 ORDER BY sort_order ASC, id ASC')
    .all(game.id);
  const packages = pkgs.map((p) => {
    const discountPct = currentMaxDiscount(db, game.id, p.id, nowIso);
    const out = {
      id: p.id,
      label_ar: p.label_ar,
      amount_label: p.amount_label,
      price_dzd: p.price_dzd,
      is_hot: p.is_hot === 1,
    };
    if (discountPct > 0) {
      out.old_price_dzd = p.price_dzd;
      out.discount_pct = discountPct;
      out.price_dzd = effectivePrice(p.price_dzd, discountPct);
    } else {
      out.old_price_dzd = null;
      out.discount_pct = null;
    }
    return out;
  });
  return {
    id: game.id,
    name_ar: game.name_ar,
    name_en: game.name_en,
    short: game.short,
    unit_ar: game.unit_ar,
    id_label: game.id_label,
    extra_label: game.extra_label,
    cover_url: `/assets/covers/${game.cover_file}`,
    packages,
  };
}

export function publicRouter(db) {
  const r = Router();

  r.get('/health', (req, res) => {
    res.json({ ok: true, now: new Date().toISOString() });
  });

  r.get('/games', (req, res) => {
    const nowIso = new Date().toISOString();
    const games = db.prepare('SELECT * FROM games WHERE active = 1 ORDER BY sort_order ASC, id ASC').all();
    res.json(games.map((g) => gameShape(db, g, nowIso)));
  });

  r.get('/games/:id', (req, res) => {
    const game = db.prepare('SELECT * FROM games WHERE id = ? AND active = 1').get(req.params.id);
    if (!game) return res.status(404).json({ error: 'اللعبة غير موجودة' });
    res.json(gameShape(db, game, new Date().toISOString()));
  });

  r.get('/settings/public', (req, res) => {
    const rows = db
      .prepare(`SELECT key, value FROM settings WHERE key IN (${PUBLIC_SETTING_KEYS.map(() => '?').join(',')})`)
      .all(...PUBLIC_SETTING_KEYS);
    const out = {};
    for (const k of PUBLIC_SETTING_KEYS) out[k] = '';
    for (const row of rows) out[row.key] = row.value;
    res.json(out);
  });

  return r;
}
