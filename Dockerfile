# VIGIL production image. One image, three roles (see deploy/docker-compose.yml):
#   web     npm start              (Next.js server)
#   worker  npm run worker         (ingestion, detection, notifications, retention)
#   migrate npm run db:migrate     (one-shot, before the others start)
# Build:  docker build -t vigil --build-arg APP_RELEASE=$(git rev-parse --short HEAD) .

FROM node:24-alpine AS deps
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --no-audit --no-fund

FROM node:24-alpine AS build
WORKDIR /app
ENV NEXT_TELEMETRY_DISABLED=1
COPY --from=deps /app/node_modules ./node_modules
COPY . .
RUN npm run build

FROM node:24-alpine AS runtime
WORKDIR /app
ARG APP_RELEASE=dev
ENV NODE_ENV=production \
    NEXT_TELEMETRY_DISABLED=1 \
    PORT=3000 \
    HOSTNAME=0.0.0.0 \
    APP_RELEASE=$APP_RELEASE
RUN addgroup -S vigil && adduser -S -G vigil vigil && mkdir -p /app/.data && chown vigil:vigil /app/.data
# The worker and migration scripts run from source with tsx, so the image keeps node_modules and src.
COPY --from=build --chown=vigil:vigil /app/node_modules ./node_modules
COPY --from=build --chown=vigil:vigil /app/.next ./.next
COPY --from=build --chown=vigil:vigil /app/public ./public
COPY --chown=vigil:vigil package.json package-lock.json next.config.ts tsconfig.json ./
COPY --chown=vigil:vigil src ./src
COPY --chown=vigil:vigil db ./db
COPY --chown=vigil:vigil rules ./rules
COPY --chown=vigil:vigil scripts ./scripts
USER vigil
EXPOSE 3000
VOLUME ["/app/.data"]
HEALTHCHECK --interval=30s --timeout=5s --start-period=40s --retries=3 CMD wget -qO- http://127.0.0.1:3000/api/health >/dev/null || exit 1
CMD ["npm", "start"]
