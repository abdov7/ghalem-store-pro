// Security headers applied to every response.
export function securityHeaders(req, res, next) {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('Referrer-Policy', 'no-referrer');
  // Basic self-only content security policy.
  res.setHeader(
    'Content-Security-Policy',
    "default-src 'self'; base-uri 'self'; img-src 'self' data: blob:; " +
      "style-src 'self' 'unsafe-inline'; script-src 'self'; " +
      "font-src 'self' data:; media-src 'self'; connect-src 'self'; " +
      "form-action 'self'; frame-ancestors 'none'",
  );
  next();
}
