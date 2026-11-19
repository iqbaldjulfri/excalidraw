# Build from this folder: docker build -t excalidraw-auth server/
FROM node:24-alpine AS build

WORKDIR /app
COPY package.json ./
COPY src ./src
# same esbuild version as the rest of the repo
RUN npx --yes esbuild@0.19.10 src/index.ts --bundle --platform=node \
    --target=node20 --format=esm --outfile=dist/index.mjs

FROM node:24-alpine

WORKDIR /app
COPY --from=build /app/dist/index.mjs ./

# a fresh named volume copies this folder's owner, so the server can write it
RUN mkdir /data && chown node:node /data
VOLUME /data
ENV DATA_DIR=/data PORT=3015
USER node

EXPOSE 3015
HEALTHCHECK CMD wget -q -O /dev/null http://localhost:3015/auth/health || exit 1
CMD ["node", "index.mjs"]
