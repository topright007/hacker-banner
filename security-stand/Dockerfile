FROM node:22-bookworm-slim AS agent
ARG OPENCODE_VERSION=2.0.22
ARG TARGETARCH
RUN apt-get update && apt-get install -y --no-install-recommends ca-certificates curl git ripgrep \
    && rm -rf /var/lib/apt/lists/* \
    && case "${TARGETARCH}" in \
         amd64) opencode_arch=x64 ;; \
         arm64) opencode_arch=arm64 ;; \
         *) echo "unsupported architecture: ${TARGETARCH}" >&2; exit 1 ;; \
       esac \
    && package_file="$(npm pack "@opencode/cli-linux-${opencode_arch}@${OPENCODE_VERSION}" --pack-destination /tmp)" \
    && tar -xzf "/tmp/${package_file}" -C /usr/local/bin --strip-components=2 package/bin/opencode \
    && chmod 0755 /usr/local/bin/opencode \
    && rm "/tmp/${package_file}" \
    && opencode --version
USER node
WORKDIR /workspace
ENV OPENCODE_DISABLE_AUTOUPDATE=true \
    OPENCODE_DISABLE_MODELS_FETCH=true \
    OPENCODE_DISABLE_DEFAULT_PLUGINS=true \
    OPENCODE_DISABLE_LSP_DOWNLOAD=true
CMD ["sleep", "infinity"]

FROM python:3.12-slim-bookworm AS service
WORKDIR /app
COPY services/ /app/
USER 65534:65534
CMD ["python", "-u", "api.py"]

FROM debian:bookworm-slim AS guard
RUN apt-get update && apt-get install -y --no-install-recommends iptables \
    && rm -rf /var/lib/apt/lists/*
COPY services/guard.sh /guard.sh
CMD ["sh", "/guard.sh"]
