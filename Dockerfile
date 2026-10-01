# syntax=docker/dockerfile:1

FROM node:22-bookworm-slim AS client-build
WORKDIR /app
COPY client/package.json ./client/package.json
RUN npm --prefix client install --no-audit --no-fund
COPY client ./client
RUN npm --prefix client run build

FROM node:22-bookworm-slim AS runtime
ENV NODE_ENV=production
WORKDIR /app

# O renderer HTML da aplicação executa gerar_html.py (somente stdlib Python).
RUN apt-get update \
    && apt-get install -y --no-install-recommends python3 ca-certificates \
    && rm -rf /var/lib/apt/lists/*

COPY server/package.json ./server/package.json
RUN npm --prefix server install --omit=dev --no-audit --no-fund

COPY server ./server
COPY --from=client-build /app/client/dist ./client/dist

RUN mkdir -p /var/data
ENV DATA_DIR=/var/data
ENV PYTHON_BIN=python3
EXPOSE 10000

CMD ["node", "server/src/index.js"]
