FROM mcr.microsoft.com/playwright:v1.58.2-noble

WORKDIR /app

ENV NODE_ENV=production
ENV DISPLAY=:99

RUN corepack enable
RUN apt-get update && apt-get install -y xvfb && rm -rf /var/lib/apt/lists/*

COPY package.json pnpm-lock.yaml ./
RUN pnpm install --frozen-lockfile

COPY . .

RUN pnpm run build

ENTRYPOINT ["xvfb-run", "-a", "node", "dist/index.js"]
