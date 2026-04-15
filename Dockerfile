FROM node:22-slim
# git is required for ephemeral clone-based repo fetching
RUN apt-get update && apt-get install -y --no-install-recommends git ca-certificates && rm -rf /var/lib/apt/lists/*
WORKDIR /app
COPY package.json package-lock.json* ./
RUN npm install --production
COPY . .
EXPOSE 8080
# V8 heap limit. Leaves headroom for git subprocesses and native allocations.
# Tuned for 2GiB Cloud Run instances (service is currently deployed at that size).
ENV NODE_OPTIONS="--max-old-space-size=1536"
CMD ["node", "server.js"]
