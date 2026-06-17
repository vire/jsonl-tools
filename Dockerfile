# Bun app image. The server serves the HTML entries via Bun.serve's runtime
# bundling (development:false), so source is run directly — no separate build step.
FROM oven/bun:1.3.10-alpine

WORKDIR /app

# Install production dependencies against the committed lockfile first (cached
# layer). Dev deps (types, fake-indexeddb) are not needed at runtime.
COPY package.json bun.lock ./
RUN bun install --frozen-lockfile --production

# App source.
COPY . .

ENV NODE_ENV=production
ENV PORT=3987
EXPOSE 3987

# Default command; docker-compose runs migrations first (see compose file).
CMD ["bun", "run", "start"]
