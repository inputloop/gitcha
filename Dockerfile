# SPDX-FileCopyrightText: 2026 Bryant Frankford <nathanielfrankford@gmail.com> and Contributors
# SPDX-License-Identifier: GPL-3.0-or-later OR LGPL-3.0-or-later
# Gitcha registry server
FROM node:22-alpine
WORKDIR /app
COPY package.json package-lock.json ./
COPY server/package.json server/
COPY extension/package.json extension/
RUN npm ci --omit=dev --workspace server
COPY server server
COPY extension/lib extension/lib
ENV GITCHA_HOST=0.0.0.0 GITCHA_PORT=4873 GITCHA_DATA_DIR=/data NODE_ENV=production
RUN mkdir -p /data && chown node:node /data
VOLUME /data
EXPOSE 4873
USER node
CMD ["node", "server/src/index.js"]
