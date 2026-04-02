FROM python:3.14-slim-bookworm

ARG TARGETARCH
ARG NODE_VERSION=24.14.1

RUN apt-get update && \
    apt-get install -y --no-install-recommends curl xz-utils ca-certificates git && \
    rm -rf /var/lib/apt/lists/*

RUN set -eux; \
    case "${TARGETARCH}" in \
      amd64) NODE_ARCH=x64 ;; \
      arm64) NODE_ARCH=arm64 ;; \
      *) echo "Unsupported architecture: ${TARGETARCH}" && exit 1 ;; \
    esac; \
    curl -fsSL "https://nodejs.org/dist/v${NODE_VERSION}/node-v${NODE_VERSION}-linux-${NODE_ARCH}.tar.xz" \
      -o /tmp/node.tar.xz && \
    tar -xJf /tmp/node.tar.xz -C /usr/local --strip-components=1 && \
    rm /tmp/node.tar.xz

RUN pip install --no-cache-dir pysimlin

RUN npm install -g @simlin/mcp@0.1.4 @anthropic-ai/claude-code

COPY mcp.json /opt/simlin-agent/mcp.json
COPY CLAUDE.md /opt/simlin-agent/CLAUDE.md

RUN useradd -m -s /bin/bash agent && \
    mkdir -p /workspace && chown agent:agent /workspace && \
    git config --system user.name "simlin-agent" && \
    git config --system user.email "simlin-agent@localhost"

USER agent
WORKDIR /workspace

ENTRYPOINT ["claude", "-p", "--bare", "--dangerously-skip-permissions", "--mcp-config", "/opt/simlin-agent/mcp.json", "--system-prompt-file", "/opt/simlin-agent/CLAUDE.md"]
CMD ["--model", "claude-opus-4-6"]
