# The app built for a company's own server. Build from the repository root:
#   docker build -f deploy/app.Dockerfile --build-arg PUBLIC_URL=https://draw.example.com .
# Same base images as the root Dockerfile, which stays as upstream ships it.
FROM --platform=${BUILDPLATFORM} node:24@sha256:8530f76a96d88820d288761f022e318970dda93d01536919fbc16076b7983e63 AS build

WORKDIR /opt/node_app

COPY . .

# do not ignore optional dependencies:
# Error: Cannot find module @rollup/rollup-linux-x64-gnu
RUN --mount=type=cache,target=/root/.cache/yarn \
    npm_config_target_arch=${TARGETARCH} yarn --frozen-lockfile --network-timeout 600000

ARG NODE_ENV=production
ARG PUBLIC_URL

# Vite reads these at build time; variables already set in the environment
# win over .env.production.
ENV VITE_APP_SELF_HOSTED=true \
    VITE_APP_AUTH_ENABLED=true \
    VITE_APP_STORAGE_URL=/api \
    VITE_APP_BACKEND_V2_GET_URL=/api/v2/ \
    VITE_APP_BACKEND_V2_POST_URL=/api/v2/post/ \
    VITE_APP_FIREBASE_CONFIG={} \
    VITE_APP_ENABLE_TRACKING=false \
    VITE_APP_DISABLE_SENTRY=true

RUN test -n "$PUBLIC_URL" || (echo "PUBLIC_URL build arg is required" && exit 1)
RUN VITE_APP_WS_SERVER_URL="$PUBLIC_URL" \
    npm_config_target_arch=${TARGETARCH} yarn build:app:docker

FROM nginx:stable-alpine-slim@sha256:2c605dbeab79a6b2a63340474fe58119d0ef95bdc4b1f41df0aa689659b3d13b

COPY --from=build /opt/node_app/excalidraw-app/build /usr/share/nginx/html

HEALTHCHECK CMD wget -q -O /dev/null http://localhost || exit 1
