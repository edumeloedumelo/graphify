FROM node:20-slim

ENV NODE_ENV=production \
    STATE_DIR=/data \
    PLAYWRIGHT_BROWSERS_PATH=/ms-playwright

WORKDIR /app

COPY package*.json ./

# playwright install --with-deps: instala o Chromium e as libs de sistema que ele
# exige (a lista vem do proprio Playwright, por isso o cache do apt so e apagado depois)
RUN apt-get update \
    && apt-get install -y --no-install-recommends ca-certificates fonts-liberation \
    && npm install --omit=dev \
    && npx playwright install --with-deps chromium \
    && apt-get clean \
    && rm -rf /var/lib/apt/lists/*

RUN mkdir -p /data

COPY . .

EXPOSE 3000

CMD ["node", "src/index.js"]
