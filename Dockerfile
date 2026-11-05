FROM node:22-bookworm-slim

LABEL org.opencontainers.image.source=https://github.com/RobertTLange/headless-cli

RUN apt-get update \
  && apt-get install -y --no-install-recommends bash ca-certificates curl git ripgrep \
  && rm -rf /var/lib/apt/lists/*

RUN mkdir -p /headless-home && chown node:node /headless-home

# Everything below installs the latest release of each agent CLI at build
# time: rebuild the image to pick up new versions.
RUN npm install -g \
  @anthropic-ai/claude-code \
  @google/gemini-cli \
  @mariozechner/pi-coding-agent \
  @openai/codex \
  opencode-ai

ARG TARGETARCH

# Grok's installer writes its binary under $HOME/.grok, which is the agent's
# runtime config directory inside the container (seeded or mounted per run).
# Install under a throwaway HOME and copy the resolved binary out instead.
# Putting the installer's bin dir on PATH stops it from symlinking grok and
# agent into /usr/local/bin (agent belongs to Cursor, installed next).
RUN set -eu; \
  grok_home="$(mktemp -d)"; \
  curl -fsSL https://x.ai/cli/install.sh -o "${grok_home}/install.sh"; \
  HOME="${grok_home}" PATH="${grok_home}/.grok/bin:${PATH}" bash "${grok_home}/install.sh"; \
  install -m 0755 "$(readlink -f "${grok_home}/.grok/bin/grok")" /usr/local/bin/grok; \
  rm -rf "${grok_home}"; \
  grok --version

# Cursor's official installer always installs the current release into
# $HOME/.local/share/cursor-agent/versions/<version>; move that tree to a
# non-root path so it works for any container user.
RUN set -eu; \
  cursor_home="$(mktemp -d)"; \
  curl -fsSL https://cursor.com/install -o "${cursor_home}/install.sh"; \
  HOME="${cursor_home}" bash "${cursor_home}/install.sh"; \
  cursor_dir="$(dirname "$(readlink -f "${cursor_home}/.local/bin/cursor-agent")")"; \
  rm -rf /opt/cursor-agent; \
  mv "${cursor_dir}" /opt/cursor-agent; \
  rm -rf "${cursor_home}"; \
  ln -sf /opt/cursor-agent/cursor-agent /usr/local/bin/cursor-agent; \
  ln -sf /usr/local/bin/cursor-agent /usr/local/bin/agent

RUN set -eu; \
  case "${TARGETARCH:-$(dpkg --print-architecture)}" in \
    amd64) agy_file="agy_cli_linux_x64.tar.gz" ;; \
    arm64) agy_file="agy_cli_linux_arm64.tar.gz" ;; \
    *) echo "unsupported Antigravity CLI architecture: ${TARGETARCH:-unknown}" >&2; exit 1 ;; \
  esac; \
  agy_tarball="/tmp/agy.tar.gz"; \
  curl "https://github.com/google-antigravity/antigravity-cli/releases/latest/download/${agy_file}" -fsSL -o "${agy_tarball}"; \
  tar -xzf "${agy_tarball}" -C /tmp antigravity; \
  install -m 0755 /tmp/antigravity /usr/local/bin/agy; \
  rm -f "${agy_tarball}" /tmp/antigravity

ENV AGY_CLI_DISABLE_AUTO_UPDATE=true
ENV PATH="/home/node/.local/bin:/home/node/.cursor/bin:/home/node/.cursor/cli/bin:/headless-home/.local/bin:/headless-home/.cursor/bin:/headless-home/.cursor/cli/bin:/root/.local/bin:/root/.cursor/bin:/root/.cursor/cli/bin:${PATH}"

WORKDIR /workspace
