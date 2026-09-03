FROM node:22-bookworm-slim

RUN apt-get update \
 && apt-get install -y --no-install-recommends git ca-certificates curl jq \
 && rm -rf /var/lib/apt/lists/*

RUN npm install -g @anthropic-ai/claude-code

RUN useradd --create-home --uid 1001 agent \
 && mkdir -p /home/agent/.claude \
 && chown -R agent:agent /home/agent/.claude

COPY docker/entrypoint.sh /usr/local/bin/entrypoint.sh
RUN chmod +x /usr/local/bin/entrypoint.sh

COPY skills /home/agent/.claude/skills
RUN chown -R agent:agent /home/agent && chmod -R a+rwX /home/agent

ENV HOME=/home/agent
USER agent
WORKDIR /workspace
ENTRYPOINT ["/usr/local/bin/entrypoint.sh"]
