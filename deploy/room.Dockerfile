# excalidraw-room built from source. The published excalidraw/excalidraw-room
# image is amd64 only and was last built in December 2023, so it can't run on
# Arm hosts such as EC2 Graviton. Build from the repository root:
#   docker build -f deploy/room.Dockerfile deploy
FROM node:24-alpine AS build

# upstream master as of December 2023; bump deliberately
ARG ROOM_COMMIT=03ff435860b508d7cd9e005cfc90f7977ae2a593

WORKDIR /room
RUN wget -qO- "https://github.com/excalidraw/excalidraw-room/archive/${ROOM_COMMIT}.tar.gz" \
    | tar xz --strip-components=1
RUN yarn --frozen-lockfile --network-timeout 600000 && yarn build

FROM node:24-alpine

WORKDIR /room
COPY --from=build /room/package.json ./
COPY --from=build /room/node_modules ./node_modules
COPY --from=build /room/dist ./dist

# above 1024 so the node user can bind it
ENV NODE_ENV=production PORT=3002
USER node

EXPOSE 3002
CMD ["node", "dist/index.js"]
