# ruyi — zero runtime deps, so the image is just Node + our compiled dist.
# Build context = the repo; dist is compiled inside the image (tsc is a devDep,
# not shipped). State lives in /data (env RUYI_STATE) — always bind-mount a
# host directory there, or the database dies with the container.

FROM node:24-slim

WORKDIR /app
COPY package.json tsconfig.json tsconfig.build.json ./
COPY src ./src
COPY prompts ./prompts
COPY config.example.json ./
RUN npm install --registry=https://registry.npmmirror.com --no-audit --no-fund && npm run build && npm cache clean --force

ENV RUYI_STATE=/data \
    NODE_ENV=production
VOLUME ["/data"]
EXPOSE 8899

ENTRYPOINT ["node", "dist/cli.js"]
CMD ["serve"]
