# Container image for the remote NOC MCP server (project requirement 6).
#
# This image runs src/server/http-main.ts, which is the SAME server object the
# local stdio entry point uses - only the transport differs.

FROM node:24-alpine AS build

WORKDIR /app

# Install dependencies first so a source-only change does not re-run npm ci.
COPY package.json package-lock.json ./
RUN npm ci

COPY tsconfig.json ./
COPY src ./src
RUN npm run build

# ---------------------------------------------------------------------------

FROM node:24-alpine AS runtime

WORKDIR /app
ENV NODE_ENV=production

# Only production dependencies reach the final image.
COPY package.json package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force

COPY --from=build /app/dist ./dist

# Do not run as root.
USER node

# The platform injects PORT; the server falls back to 8787 when it is absent.
ENV PORT=8787
EXPOSE 8787

# Liveness probe hits the non-MCP /health endpoint.
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD node -e "require('http').get('http://127.0.0.1:'+(process.env.PORT||8787)+'/health',r=>process.exit(r.statusCode===200?0:1)).on('error',()=>process.exit(1))"

CMD ["node", "dist/server/http-main.js"]
