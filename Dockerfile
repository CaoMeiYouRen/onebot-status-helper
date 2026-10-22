ARG NODE_VERSION=24.22.1

# 使用官方 node 镜像：Node 24.22.1 修复了 2026-10-21 的安全问题，且 brotli/openssl/c-ares 为静态链接，
# 不依赖 Alpine 仓库的 apk 包（当前 v3.24 仍停留在 24.18.1）
FROM public.ecr.aws/docker/library/node:${NODE_VERSION}-alpine AS nodejs

# RUN npm config set registry https://registry.npmmirror.com && \
#     pnpm config set registry https://registry.npmmirror.com &&

RUN npm install -g pnpm@11

# 阶段一：构建阶段
FROM nodejs AS builder

WORKDIR /app

COPY package.json .npmrc pnpm-lock.yaml pnpm-workspace.yaml /app/

RUN pnpm i --frozen-lockfile

COPY . /app

RUN pnpm run build

# 阶段二：缩小阶段
FROM nodejs AS docker-minifier

WORKDIR /app

RUN pnpm add @vercel/nft@0.24.4 fs-extra@11.2.0 --save-prod

COPY --from=builder /app /app

RUN export PROJECT_ROOT=/app/ && \
    node /app/scripts/minify-docker.cjs && \
    rm -rf /app/node_modules /app/scripts && \
    mv /app/app-minimal/node_modules /app/ && \
    rm -rf /app/app-minimal

# 阶段三：生产阶段
FROM public.ecr.aws/docker/library/node:${NODE_VERSION}-alpine AS runtime

# 官方 alpine 镜像不带时区数据，docker-compose 中设置了 TZ
RUN apk add --no-cache tzdata

ENV NODE_ENV=production

WORKDIR /app

COPY --from=docker-minifier /app /app

EXPOSE 3000

CMD ["node", "dist/index.mjs"]
