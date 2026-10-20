// Guards /api/admin/* — requires a logged-in admin session.
export function requireAdmin(req, res, next) {
  if (req.session && req.session.adminId) return next();
  return res.status(401).json({ error: 'غير مصرح — سجل الدخول أولاً' });
}
