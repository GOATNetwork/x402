# Multi-stage build for the goatx402-canton-demo SPA.
# Builds with pnpm + Vite, serves the static bundle via nginx.

# syntax=docker/dockerfile:1.7

FROM node:20-bookworm-slim AS builder

WORKDIR /app

# Enable pnpm via corepack (ships with node:20).
RUN corepack enable && corepack prepare pnpm@latest --activate

COPY package.json pnpm-lock.yaml ./
RUN pnpm install --frozen-lockfile

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
