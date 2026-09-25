# creator-os-runtime — the production image, built FROM THIS REPO (no hand-made
# artifact). Same Bun the test suite pins (1.4.2). The one-file bundle is built
# inside the image with the same command as `npm run build`, so /health's source
# hash is the hash of the file this image runs.
FROM oven/bun:1.4.2 AS build
WORKDIR /app
COPY package.json ./
RUN bun install --production
COPY src ./src
RUN bun build src/index.js --target=bun --minify --external hono --outfile dist/runtime.js

FROM oven/bun:1.4.2
WORKDIR /app
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/package.json ./package.json
COPY --from=build /app/dist/runtime.js ./runtime.js
ENV NODE_ENV=production
CMD ["bun", "runtime.js"]
