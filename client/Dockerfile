FROM node:24-alpine AS build
WORKDIR /app
COPY package.json package-lock.json* ./
COPY api/package.json api/package.json
COPY worker/package.json worker/package.json
COPY client/package.json client/package.json
COPY packages/shared/package.json packages/shared/package.json
RUN npm install --ignore-scripts
COPY client client
RUN npm run build --workspace=client

FROM nginx:alpine
COPY --from=build /app/client/dist /usr/share/nginx/html
EXPOSE 80
