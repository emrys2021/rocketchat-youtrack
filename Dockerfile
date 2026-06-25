FROM node:20-alpine

WORKDIR /app
ENV NODE_ENV=production

COPY package.json package-lock.json* ./
RUN npm install --omit=dev

COPY src ./src

USER node
EXPOSE 8080

# 默认启动 outgoing webhook 模式（server.js）。
# bot-login realtime 模式：覆盖 CMD 为 ["node", "src/bot-runner.js"]，
# 或在 compose / k8s 里把 command 设为 npm run start:bot。
CMD ["node", "src/server.js"]
