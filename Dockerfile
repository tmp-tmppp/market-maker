# Image of the market-maker service. Two stages: the build stage compiles TypeScript, the runtime stage holds only
# production dependencies and the compiled code (the service has no database, so there are no migrations). The base
# image is pinned by tag and digest (the same Node.js major as "engines" in package.json); Dependabot proposes updates.

# --- build stage -------------------------------------------------------------------------------------------
FROM node:26.13.1-trixie-slim@sha256:e6bedef217677b276c591795e169840edd9096dbf13f29df8ef8d1856b8820bc AS build
WORKDIR /app

# Dependencies first, so this layer stays cached while only the source changes.
COPY package.json package-lock.json ./
RUN npm ci --ignore-scripts

COPY tsconfig.json tsconfig.build.json ./
COPY src ./src
RUN npm run build

# --- runtime stage -----------------------------------------------------------------------------------------
FROM node:26.13.1-trixie-slim@sha256:e6bedef217677b276c591795e169840edd9096dbf13f29df8ef8d1856b8820bc AS runtime
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
