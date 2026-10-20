# The container for Vercel (or any other Docker host). All data goes to the cloud Postgres
# database in DATABASE_URL, because the container's own disk is wiped on every restart.
# On a host with a permanent volume mounted at /app/data, SQLite works too: set
# EPHEMERAL_DISK=0 and leave DATABASE_URL empty.
FROM node:22-bookworm-slim
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev
COPY server ./server
COPY public ./public
COPY scripts ./scripts
COPY docs ./docs
# Vercel sends traffic to port 80 unless the project sets PORT.
ENV NODE_ENV=production PORT=80 EPHEMERAL_DISK=1 DB_PATH=data/app.sqlite
EXPOSE 80
CMD ["node", "server/index.js"]
