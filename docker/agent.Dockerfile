FROM node:24-bookworm-slim

ARG GO_VERSION=1.24.4
ARG DOCKER_VERSION=27.5.1
ARG PNPM_VERSION=10.23.0

RUN apt-get update \
 && apt-get install -y --no-install-recommends git ca-certificates curl jq unzip \
 && rm -rf /var/lib/apt/lists/*

RUN arch="$(dpkg --print-architecture)" \
 && case "$arch" in \
      amd64) goarch=amd64; dockerarch=x86_64 ;; \
      arm64) goarch=arm64; dockerarch=aarch64 ;; \
      *) echo "unsupported architecture $arch" >&2; exit 1 ;; \
    esac \
 && curl -fsSL "https://go.dev/dl/go${GO_VERSION}.linux-${goarch}.tar.gz" | tar -C /usr/local -xz \
 && curl -fsSL "https://download.docker.com/linux/static/stable/${dockerarch}/docker-${DOCKER_VERSION}.tgz" \
    | tar -C /usr/local/bin --strip-components=1 -xz docker/docker

ENV PATH=/usr/local/go/bin:/home/agent/go/bin:$PATH
ENV GOPATH=/home/agent/go
ENV GOFLAGS=-buildvcs=false
ENV npm_config_store_dir=/home/agent/.pnpm-store

RUN npm install -g @anthropic-ai/claude-code "pnpm@${PNPM_VERSION}"

RUN useradd --create-home --uid 1001 agent \
 && mkdir -p /home/agent/.claude /home/agent/go /home/agent/.pnpm-store /home/agent/.cache \
 && chown -R agent:agent /home/agent

COPY docker/entrypoint.sh /usr/local/bin/entrypoint.sh
COPY docker/githooks /usr/local/share/git-hooks
RUN chmod +x /usr/local/bin/entrypoint.sh /usr/local/share/git-hooks/*

COPY skills /home/agent/.claude/skills
RUN chown -R agent:agent /home/agent && chmod -R a+rwX /home/agent

ENV HOME=/home/agent
USER agent
WORKDIR /workspace
ENTRYPOINT ["/usr/local/bin/entrypoint.sh"]
