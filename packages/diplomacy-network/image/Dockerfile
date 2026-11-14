# The one image every Diplomacy Network job runs in: Debian with the tools agents reach
# for and nothing project-specific. Everything else is installed by the agent, at run
# time, through the broker. The tag is the hash of this directory (src/executor/container.js).

ARG BASE=debian:bookworm-slim@sha256:734a72b3d6142a71993b4bc580ca01d8ca687f77a2c422d96a961d3376b179bc
FROM ${BASE}

ARG NODE_VERSION=26.13.1
ARG NODE_SHA256_ARM64=89e1853138db51e8b82d3e98ba9c0d3f2956a28e5e55ea1b7e12d25aae92d5dd
ARG NODE_SHA256_AMD64=5c063e46bab0fbc1c17cc445d7ff129cbdcd0471be6ed83b6ab864f8143bc864
ARG COREPACK_VERSION=0.36.0
ARG GH_VERSION=2.104.0
ARG GH_SHA256_ARM64=cb34cefc6f4e77b90731374a2b737516bb8f3033c6ca46aa949e5344f68069e3
ARG GH_SHA256_AMD64=98cb101ad87dbbd3f6b2f2bfcbd43197ccd07643140121d8a9cfaa91eadbc24e
ARG GLAB_VERSION=1.130.0
ARG GLAB_SHA256_ARM64=062d53acb0f2cbcc79a014600df1aa0fb440bb3a08a5d4900d3b49b553b22767
ARG GLAB_SHA256_AMD64=ce06313b2075af25180cd195ab3496d42bc5857c85a1c12ba996838dfe9d822c
ARG CLAUDE_CODE_VERSION=2.1.325

# pip refuses to touch Debian's own site-packages without this; in a disposable
# container that refusal protects nothing.
ENV DEBIAN_FRONTEND=noninteractive \
    LANG=C.UTF-8 \
    PIP_BREAK_SYSTEM_PACKAGES=1 \
    PIP_NO_CACHE_DIR=1

RUN apt-get update \
 && apt-get install -y --no-install-recommends \
      ca-certificates curl git openssh-client rsync jq ripgrep less unzip xz-utils zip \
      procps lsof zsh tmux python3 python3-pip python3-venv build-essential android-tools-adb \
 && rm -rf /var/lib/apt/lists/*

# Node, gh and glab from their own releases, each checked against the hash pinned above.
# Node's headers are left out: node-gyp fetches its own.
RUN set -eu; arch="$(dpkg --print-architecture)"; \
    case "$arch" in \
      arm64) node_arch=arm64; node_sha="$NODE_SHA256_ARM64"; gh_sha="$GH_SHA256_ARM64"; glab_sha="$GLAB_SHA256_ARM64" ;; \
      amd64) node_arch=x64; node_sha="$NODE_SHA256_AMD64"; gh_sha="$GH_SHA256_AMD64"; glab_sha="$GLAB_SHA256_AMD64" ;; \
      *) echo "unsupported architecture: $arch" >&2; exit 1 ;; \
    esac; \
    cd /tmp; \
    curl -fsSLo node.tar.xz "https://nodejs.org/dist/v${NODE_VERSION}/node-v${NODE_VERSION}-linux-${node_arch}.tar.xz"; \
    echo "${node_sha}  node.tar.xz" | sha256sum -c -; \
    tar -xJf node.tar.xz -C /usr/local --strip-components=1 --no-same-owner \
      --exclude='*/include' --exclude='*/share' --exclude='*/CHANGELOG.md' --exclude='*/README.md'; \
    curl -fsSLo gh.tgz "https://github.com/cli/cli/releases/download/v${GH_VERSION}/gh_${GH_VERSION}_linux_${arch}.tar.gz"; \
    echo "${gh_sha}  gh.tgz" | sha256sum -c -; \
    tar -xzf gh.tgz --strip-components=2 -C /usr/local/bin "gh_${GH_VERSION}_linux_${arch}/bin/gh"; \
    curl -fsSLo glab.tgz "https://gitlab.com/gitlab-org/cli/-/releases/v${GLAB_VERSION}/downloads/glab_${GLAB_VERSION}_linux_${arch}.tar.gz"; \
    echo "${glab_sha}  glab.tgz" | sha256sum -c -; \
    tar -xzf glab.tgz --strip-components=1 -C /usr/local/bin bin/glab; \
    rm -f node.tar.xz gh.tgz glab.tgz; \
    npm install -g "corepack@${COREPACK_VERSION}" "@anthropic-ai/claude-code@${CLAUDE_CODE_VERSION}"; \
    npm cache clean --force; rm -rf /root/.npm /tmp/*; \
    node --version; npm --version; corepack --version; gh --version; glab --version; claude --version

WORKDIR /work
CMD ["sleep", "infinity"]
