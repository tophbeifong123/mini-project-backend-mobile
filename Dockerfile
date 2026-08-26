# =============================================================================
# Flash Sale System — NestJS app image (multi-stage, pnpm via corepack)
# ⚠️ pnpm เท่านั้น — ห้าม npm / yarn (CLAUDE.md §1)
# =============================================================================

# ---------- Stage 1: build ---------------------------------------------------
FROM node:22-alpine AS builder

# corepack ไม่ต้องถาม/ไม่ต้องเช็ค signature ใน non-TTY build
ENV COREPACK_ENABLE_DOWNLOAD_PROMPT=0 \
    COREPACK_INTEGRITY_KEYS=0

# corepack มากับ Node แล้ว — activate pnpm โดยไม่ต้อง npm i -g
RUN corepack enable && corepack prepare pnpm@10.15.0 --activate

WORKDIR /app

# copy manifest ก่อน เพื่อให้ layer ของ dependency ถูก cache
COPY package.json pnpm-lock.yaml* ./
RUN pnpm install

# source ทั้งหมด แล้ว build (nest-cli.json จะ copy src/redis/lua/*.lua ไป dist/ ด้วย)
COPY . .
RUN pnpm run build


# ---------- Stage 2: production ---------------------------------------------
FROM node:22-alpine AS production

ENV COREPACK_ENABLE_DOWNLOAD_PROMPT=0 \
    COREPACK_INTEGRITY_KEYS=0 \
    NODE_ENV=production

RUN corepack enable && corepack prepare pnpm@10.15.0 --activate

WORKDIR /app

COPY package.json pnpm-lock.yaml* ./
RUN pnpm install --prod --ignore-scripts

# compiled JS
COPY --from=builder /app/dist ./dist
# Lua assets — nest build copy ให้แล้ว แต่ copy ซ้ำอีกชั้นกัน asset config พลาด
# (.lua ไม่ถูก compile โดย tsc — ถ้าหาย RedisService จะ defineCommand ไม่ได้)
COPY --from=builder /app/src/redis/lua ./dist/redis/lua

# ข้อมูลตั้งต้นสำหรับ seed — dist/database/migrate-and-seed.js อ่านไฟล์นี้
# path ตรงกันทั้งตอนรัน ts-node (<repo>/docs/...) และตอนรัน dist (/app/docs/...)
COPY --from=builder /app/docs/Requirement/products-seed.json ./docs/Requirement/products-seed.json

# entrypoint: migrate+seed บน app-1 เท่านั้น แล้วค่อย exec server
COPY scripts/app-entrypoint.sh /app/scripts/app-entrypoint.sh
RUN sed -i 's/\r$//' /app/scripts/app-entrypoint.sh && chmod +x /app/scripts/app-entrypoint.sh

# ไม่รันด้วย root
USER node

EXPOSE 3000

ENTRYPOINT ["/app/scripts/app-entrypoint.sh"]
CMD ["node", "dist/main.js"]
