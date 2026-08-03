# syntax=docker/dockerfile:1.7
FROM node:24-bookworm-slim AS build

WORKDIR /app
RUN apt-get update \
    && apt-get install -y --no-install-recommends openssl \
    && rm -rf /var/lib/apt/lists/*
COPY package.json package-lock.json ./
RUN npm ci

COPY . .
RUN DATABASE_URL=postgresql://generate_only:generate_only@127.0.0.1:5432/flowchain_generate_only npm run db:generate
RUN npm run build
RUN find server -type f -name "*.test.mjs" -delete \
    && rm -rf server/domain/test-fixtures

FROM build AS release-dependencies

# Keep production dependencies plus the exact Prisma CLI already present in
# the npm cache because migrations are an explicit release operation. Remove
# devDependencies from the stage-local manifest before the offline install so
# npm never needs metadata for omitted tools such as Playwright.
RUN npm prune --omit=dev \
    && node -e "const fs=require('node:fs');const p=require('./package.json');delete p.devDependencies;p.dependencies={...p.dependencies,prisma:'7.8.0'};fs.writeFileSync('./package.json',JSON.stringify(p))" \
    && npm install --offline --no-save --omit=dev --ignore-scripts --package-lock=false

FROM node:24-bookworm-slim AS runtime

ARG FLOWCHAIN_COMMIT_SHA=unknown
ARG FLOWCHAIN_BRANCH=unknown
ENV NODE_ENV=production \
    SCM_API_PORT=8787 \
    FLOWCHAIN_COMMIT_SHA=${FLOWCHAIN_COMMIT_SHA} \
    FLOWCHAIN_BRANCH=${FLOWCHAIN_BRANCH}

LABEL org.opencontainers.image.revision=${FLOWCHAIN_COMMIT_SHA} \
      org.opencontainers.image.ref.name=${FLOWCHAIN_BRANCH}

WORKDIR /app
RUN apt-get update \
    && apt-get install -y --no-install-recommends openssl \
    && rm -rf /var/lib/apt/lists/* \
    && mkdir -p /var/lib/flowchain/uploads \
    && chown -R node:node /var/lib/flowchain

COPY --from=build --chown=node:node /app/package.json /app/package-lock.json /app/prisma.config.ts ./
COPY --from=release-dependencies --chown=node:node /app/node_modules ./node_modules
COPY --from=build --chown=node:node /app/node_modules/.prisma ./node_modules/.prisma
COPY --from=build --chown=node:node /app/dist ./dist
COPY --from=build --chown=node:node /app/server ./server
COPY --from=build --chown=node:node /app/shared ./shared
COPY --from=build --chown=node:node /app/prisma ./prisma

USER node
EXPOSE 8787
VOLUME ["/var/lib/flowchain/uploads"]
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD ["node", "-e", "fetch('http://127.0.0.1:8787/api/health').then(r=>{if(!r.ok)process.exit(1)}).catch(()=>process.exit(1))"]

CMD ["node", "server/index.mjs"]
