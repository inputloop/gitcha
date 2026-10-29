# SPDX-FileCopyrightText: 2026 Bryant Frankford <nathanielfrankford@gmail.com> and Contributors
# SPDX-FileCopyrightText: 2026 Corwin Brust <corwin@bru.st>
# SPDX-License-Identifier: GPL-3.0-or-later OR LGPL-3.0-or-later
# Gitcha registry server
FROM node:22-alpine
# The server runs git (smart HTTP) and gpg (signature checks); the Alpine node image has neither. SSH is not in this image.
RUN apk add --no-cache git git-daemon gnupg
WORKDIR /app
COPY package.json package-lock.json ./
COPY server/package.json server/
COPY extension/package.json extension/
# The build option: Cassandra support (the cassandra-driver module) is in unless --build-arg GITCHA_WITH_CASSANDRA=no.
# The image's database is still chosen at run time with GITCHA_STORE (docker-compose.yml picks cassandra).
ARG GITCHA_WITH_CASSANDRA=yes
RUN if [ "$GITCHA_WITH_CASSANDRA" = no ]; then omit=--omit=optional; fi; npm ci --omit=dev $omit --workspace server
COPY server server
COPY extension/lib extension/lib
ENV GITCHA_HOST=0.0.0.0 GITCHA_PORT=4873 GITCHA_DATA_DIR=/data NODE_ENV=production
RUN mkdir -p /data && chown node:node /data
VOLUME /data
EXPOSE 4873
USER node
CMD ["node", "server/src/index.js"]
