FROM node:20-slim
RUN mkdir -p /data
WORKDIR /app
COPY package*.json ./
RUN npm install --omit=dev
COPY . .
CMD ["node", "src/index.js"]
