FROM node:22-bookworm-slim@sha256:43ac6c60b8f89723f746e8a92ce91abd5017e627ce1ddfe4238355d3a30b772c AS node
FROM python:3.12-slim-bookworm@sha256:54c85f3c47607a77f32adec749d3c81d1348bf25833671f512b26a9b6d778cb3
COPY --from=node /usr/local/bin/node /usr/local/bin/node
COPY --from=node /usr/local/lib/node_modules /usr/local/lib/node_modules
RUN ln -s /usr/local/lib/node_modules/npm/bin/npm-cli.js /usr/local/bin/npm \
    && apt-get update && apt-get install -y --no-install-recommends git ca-certificates \
    && rm -rf /var/lib/apt/lists/* \
    && useradd --uid 10001 --create-home --shell /bin/sh agent \
    && npm install --global @opencode/cli@2.0.22
WORKDIR /opt/aidr
COPY pyproject.toml ./
COPY src ./src
COPY config ./config
RUN pip install --no-cache-dir .
COPY adapters/opencode/package.json adapters/opencode/package-lock.json ./adapters/opencode/
RUN cd adapters/opencode && npm ci --ignore-scripts
COPY adapters/opencode/src ./adapters/opencode/src
COPY adapters/opencode/tsconfig.json ./adapters/opencode/tsconfig.json
COPY adapters/opencode/index.js ./adapters/opencode/index.js
RUN cd adapters/opencode && npm run build
COPY tests/container ./tests/container
ENTRYPOINT ["python", "/opt/aidr/tests/container/run.py"]
