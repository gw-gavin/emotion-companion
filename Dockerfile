# 暖屿 · 情感陪伴 AI —— 容器镜像
# 基础镜像固定 Node 22（与本机开发版本一致）
FROM node:22-alpine

WORKDIR /app

# 先装依赖（利用层缓存）
COPY package.json package-lock.json ./
RUN npm install --omit=dev

# 拷贝源码（node_modules / data 已被 .dockerignore 排除）
COPY . .

# 端口（Sealos/各平台按此暴露）
EXPOSE 3000

# 启动；PORT 由平台注入，缺省 3000
CMD ["node", "server.js"]
