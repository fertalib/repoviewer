FROM node:22-slim
# git is required for ephemeral clone-based repo fetching
RUN apt-get update && apt-get install -y --no-install-recommends git ca-certificates && rm -rf /var/lib/apt/lists/*
WORKDIR /app
COPY package.json package-lock.json* ./
RUN npm install --production
COPY . .
EXPOSE 8080
# Leave ~100MB headroom for git subprocesses on small (512MiB) Cloud Run instances.
ENV NODE_OPTIONS="--max-old-space-size=384"
CMD ["node", "server.js"]
