FROM node:22-alpine AS base
RUN corepack enable && corepack prepare pnpm@10.30.2 --activate
WORKDIR /app

# install deps
FROM base AS deps
COPY pnpm-lock.yaml pnpm-workspace.yaml package.json ./
COPY backend/package.json backend/
COPY frontend/package.json frontend/
COPY shared/package.json shared/
RUN pnpm install --frozen-lockfile

# download OUI databases
FROM base AS oui
RUN apk add --no-cache curl
RUN mkdir -p /app/data && \
    curl -sL "https://standards-oui.ieee.org/oui/oui.csv" -o /app/data/oui24.csv && \
    curl -sL "https://standards-oui.ieee.org/oui36/oui36.csv" -o /app/data/oui36.csv

# build frontend + backend
FROM deps AS build
COPY shared/ shared/
COPY frontend/ frontend/
COPY backend/ backend/
RUN pnpm build

# production
FROM base AS production
COPY pnpm-lock.yaml pnpm-workspace.yaml package.json ./
COPY backend/package.json backend/
COPY shared/package.json shared/
RUN pnpm install --frozen-lockfile --prod
COPY --from=build /app/backend/dist backend/dist/
COPY --from=build /app/frontend/dist frontend/dist/
COPY --from=build /app/shared shared/
COPY --from=oui /app/data data/

ENV NODE_ENV=production
ENV NODE_TLS_REJECT_UNAUTHORIZED=0
EXPOSE 3001

CMD ["node", "backend/dist/index.js"]
