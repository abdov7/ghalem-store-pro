// Single server-side implementation of the effective-price rule (CONTRACT.md §1):
//   candidates = active discounts where (scope='package' AND package_id=?)
//     OR (scope='game' AND game_id=?), with starts_at <= T <= ends_at.
//   Take MAX(percent), default 0.
//   effective = Math.round(base * (1 - pct/100) / 50) * 50   (nearest 50 DZD)
export function effectivePrice(baseDzd, percent) {
  const pct = Number(percent) || 0;
  return Math.round((Number(baseDzd) * (1 - pct / 100)) / 50) * 50;
}

export function currentMaxDiscount(db, gameId, packageId, nowIso) {
  const row = db
    .prepare(
      `SELECT COALESCE(MAX(percent), 0) AS pct FROM discounts
       WHERE active = 1 AND starts_at <= ? AND ends_at >= ?
         AND ((scope = 'package' AND package_id = ?) OR (scope = 'game' AND game_id = ?))`,
    )
    .get(nowIso, nowIso, packageId, gameId);
  return row ? Number(row.pct) : 0;
}
