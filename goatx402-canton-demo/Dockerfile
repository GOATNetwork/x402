# Multi-stage build for the goatx402-canton-demo SPA.
# Builds with pnpm + Vite, serves the static bundle via nginx.

# syntax=docker/dockerfile:1.7

FROM node:22-bookworm-slim AS builder

WORKDIR /app

# Pin pnpm 9 (latest 11.x triggers ERR_UNKNOWN_BUILTIN_MODULE on this base).
RUN corepack enable && corepack prepare pnpm@9.15.0 --activate

COPY package.json pnpm-lock.yaml ./
# Lockfile was generated under the package's old name (@goat-canton-payment/client-web).
# Renaming the package broke --frozen-lockfile; install without it on first build,
# then commit the regenerated lockfile in a follow-up if pinning matters in CI.
RUN pnpm install --no-frozen-lockfile

COPY . .
RUN pnpm run build

# ---------------------------------------------------------------------
FROM nginx:1.27-alpine

COPY --from=builder /app/dist /usr/share/nginx/html

# Minimal nginx.conf: serve the SPA + index.html fallback for client-side routing.
RUN printf 'server {\n\
  listen 4173;\n\
  root /usr/share/nginx/html;\n\
  index index.html;\n\
  location / { try_files $uri /index.html; }\n\
}\n' > /etc/nginx/conf.d/default.conf

EXPOSE 4173
