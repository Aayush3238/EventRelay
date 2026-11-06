FROM node:24-alpine
WORKDIR /app
COPY package.json package-lock.json* ./
COPY api/package.json api/package.json
COPY worker/package.json worker/package.json
COPY client/package.json client/package.json
COPY packages/shared/package.json packages/shared/package.json
RUN npm install --omit=dev --ignore-scripts
COPY packages/shared packages/shared
COPY api api
COPY worker worker
COPY db db
EXPOSE 4000
# Exec-form CMD (separate args) — Render passes dockerCommand as ONE string,
# so compound shell commands must live here, not in render.yaml.
# Migrations are idempotent; RUN_BACKGROUND comes from the environment,
# so the paid 3-service setup (separate worker) just leaves it unset.
CMD ["sh", "-c", "node db/migrate.js && node api/src/server.js"]
