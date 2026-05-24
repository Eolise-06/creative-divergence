# ============================================
# Stage 1: Build frontend
# ============================================
FROM node:22-alpine AS build
WORKDIR /app

# Dependencies (cached unless package*.json change)
COPY package*.json ./
RUN npm ci --ignore-scripts \
 && npm cache clean --force

# Source
COPY . .

# Build
RUN npx vite build

# ============================================
# Stage 2: Production runtime
# ============================================
FROM node:22-alpine

# Runtime deps only (smaller, safer)
WORKDIR /app
COPY package*.json ./
RUN npm ci --omit=dev --ignore-scripts --no-audit --no-fund \
 && npm cache clean --force \
 && apk add --no-cache wget

# Copy build artifacts
COPY --from=build /app/dist ./dist
COPY server/index.js ./server/

# Non-root user
RUN addgroup -S app && adduser -S -G app app \
 && chown -R app:app /app
USER app

EXPOSE 3001

HEALTHCHECK --interval=30s --timeout=3s --start-period=5s --retries=3 \
  CMD wget -qO- http://localhost:3001/api/health || exit 1

CMD ["node", "server/index.js"]
