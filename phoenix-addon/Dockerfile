# syntax=docker/dockerfile:1
FROM node:20-alpine AS builder
WORKDIR /app
COPY package.json package-lock.json* ./
RUN npm ci --omit=dev --no-audit --no-fund || npm install --omit=dev --no-audit --no-fund

FROM node:20-alpine AS runtime
WORKDIR /app
RUN apk add --no-cache curl tini
COPY --from=builder /app/node_modules ./node_modules
COPY package.json ./
COPY server.js addon.js ./
COPY lib/ ./lib/
RUN addgroup -g 1001 -S nodejs && \
    adduser -S phoenix -u 1001 -G nodejs && \
    chown -R phoenix:nodejs /app
USER phoenix
HEALTHCHECK --interval=30s --timeout=10s --start-period=15s --retries=3 \
  CMD curl -f http://localhost:${PORT:-3000}/health || exit 1
EXPOSE ${PORT:-3000}
ENV NODE_ENV=production
ENV PORT=3000
ENTRYPOINT ["/sbin/tini", "--"]
CMD ["node", "server.js"]
