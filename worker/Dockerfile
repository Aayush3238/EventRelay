FROM node:24-alpine
WORKDIR /app
COPY package.json package-lock.json* ./
COPY api/package.json api/package.json
COPY worker/package.json worker/package.json
COPY client/package.json client/package.json
COPY packages/shared/package.json packages/shared/package.json
RUN npm install --omit=dev --ignore-scripts
COPY packages/shared packages/shared
COPY worker worker
COPY db db
CMD ["node", "worker/src/worker.js"]
