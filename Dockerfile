# later — Node.js + node:sqlite, no runtime deps, runs .ts directly (no build).
FROM node:24-alpine

ENV NODE_ENV=production

WORKDIR /app

# Only source is needed; there are no runtime dependencies to install.
# (devDependencies are for typecheck/tests and are intentionally omitted.)
COPY package.json ./
COPY src ./src
COPY public ./public
COPY scripts ./scripts

# Data lives in a mounted volume; created and owned by the runtime user.
RUN mkdir -p /app/data && chown -R node:node /app

USER node

ENV HOST=0.0.0.0 \
    PORT=8787 \
    DB_PATH=/app/data/later.db

EXPOSE 8787

CMD ["node", "src/server.ts"]
