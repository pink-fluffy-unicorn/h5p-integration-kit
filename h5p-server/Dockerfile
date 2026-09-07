# H5P Server Dockerfile
# License: GPL-3.0-or-later (due to @lumieducation/h5p-server dependency)
#
# This container provides an H5P content authoring and playback server
# that can be integrated with any LMS via HTTP API.

# Node 20 reached end of life in April 2026 - stay on the current LTS line
FROM node:24-alpine

LABEL maintainer="Chris Honselaar"
LABEL description="H5P Content Server for LMS Integration"
LABEL license="GPL-3.0-or-later"

# Pull in the Alpine security fixes that were published after the base image was
# built (typically libssl3/libcrypto3). Without this step every vulnerability scan
# of the image reports the OpenSSL CVEs of the day. Docker caches this layer, so a
# deployment build has to run with --pull --no-cache to actually get new fixes.
RUN apk upgrade --no-cache

# Create app directory
WORKDIR /app

# Install dependencies first (better layer caching)
COPY package*.json ./
RUN npm ci --omit=dev

# npm, npx and corepack are only needed for the install above. Their bundled
# dependencies (tar, minimatch, glob, ...) make up most of the findings of image
# scanners, and the server is started with node directly, so drop them from the
# runtime image.
RUN rm -rf /usr/local/lib/node_modules /usr/local/bin/npm /usr/local/bin/npx /usr/local/bin/corepack /root/.npm

# Copy application code
COPY src/ ./src/

# Create directories for H5P data (will be mounted as volumes)
RUN mkdir -p /data/h5p/content /data/h5p/libraries /data/h5p/temp /data/h5p/core /data/h5p/editor /data/h5p/userdata

# Environment variables with sensible defaults
ENV NODE_ENV=production
ENV PORT=3000
ENV H5P_BASE_URL=http://localhost:3000
ENV DJANGO_URL=http://host.docker.internal:8000
ENV H5P_DATA_PATH=/data/h5p

# Expose the server port
EXPOSE 3000

# Health check
HEALTHCHECK --interval=30s --timeout=10s --start-period=5s --retries=3 \
    CMD wget --no-verbose --tries=1 --spider http://localhost:3000/health || exit 1

# Run as non-root user for security
RUN addgroup -g 1001 -S h5p && adduser -u 1001 -S h5p -G h5p
RUN chown -R h5p:h5p /app /data
USER h5p

CMD ["node", "src/index.js"]
