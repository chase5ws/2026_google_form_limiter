# Chase's Google Form Limiter平台
# 用官方 Node.js 映像檔建置，不需要 Railpack／mise 從 GitHub 下載建置工具。
# 程式沒有任何套件依賴，所以不用 npm install。
FROM node:22-alpine

WORKDIR /app
ENV NODE_ENV=production

COPY package.json package-lock.json ./
COPY server.js ./
COPY lib ./lib
COPY public ./public

# 用 exec 形式啟動：node 直接收到 Railway 部署時送的 SIGTERM，才能在 30 秒緩衝內收尾
CMD ["node", "--disable-warning=ExperimentalWarning", "server.js"]
