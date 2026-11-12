# Image of the market-maker service. Two stages: the build stage compiles TypeScript, the runtime stage holds only
# production dependencies and the compiled code (the service has no database, so there are no migrations). The base
# image is pinned by tag and digest (the same Node.js major as "engines" in package.json); Dependabot proposes updates.

# --- build stage -------------------------------------------------------------------------------------------
FROM node:24.22.2-trixie-slim@sha256:0820eaa85e07d0490446dd01d14707e17e6108a36988cf374899cd057eb3812d AS build
WORKDIR /app

# Dependencies first, so this layer stays cached while only the source changes.
COPY package.json package-lock.json ./
RUN npm ci --ignore-scripts

COPY tsconfig.json tsconfig.build.json ./
COPY src ./src
RUN npm run build

# --- runtime stage -----------------------------------------------------------------------------------------
FROM node:24.22.2-trixie-slim@sha256:0820eaa85e07d0490446dd01d14707e17e6108a36988cf374899cd057eb3812d AS runtime
ENV NODE_ENV=production
WORKDIR /app

COPY package.json package-lock.json ./
RUN npm ci --omit=dev --ignore-scripts && npm cache clean --force

COPY --from=build /app/dist ./dist

# The base image's unprivileged user; the Helm chart also enforces a non-root user and a read-only file system.
USER node
# The health probes (8080) and GET /metrics (9464, METRICS_PORT): the bot has no other HTTP endpoint and nothing routes
# requests to it.
EXPOSE 8080 9464
CMD ["node", "dist/main.js"]
