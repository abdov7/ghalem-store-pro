# Ghalem Store Pro — production image
FROM node:24-alpine

WORKDIR /app

# Install deps first (better layer caching)
COPY package.json package-lock.json* ./
RUN npm ci --omit=dev 2>/dev/null || npm install --omit=dev --no-audit --no-fund

# App code
COPY server/ ./server/
COPY public/ ./public/

# Writable data dir (SQLite file + receipt uploads live here; mount a volume over it)
RUN mkdir -p data/uploads && chown -R node:node /app
USER node

ENV NODE_ENV=production
ENV PORT=3000
ENV DB_PATH=/app/data/ghalem-store.db
ENV UPLOAD_DIR=/app/data/uploads
EXPOSE 3000

# Fails fast if SESSION_SECRET is missing (server enforces it in production)
CMD ["node", "server/index.js"]
