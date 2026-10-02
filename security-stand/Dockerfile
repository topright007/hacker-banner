FROM node:22-bookworm-slim AS agent
ARG OPENCODE_VERSION=1.18.11
RUN apt-get update && apt-get install -y --no-install-recommends ca-certificates curl git \
    && rm -rf /var/lib/apt/lists/* \
    && npm install -g opencode-ai@${OPENCODE_VERSION}
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
