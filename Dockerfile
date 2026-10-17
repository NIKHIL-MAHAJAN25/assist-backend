# Assist backend — production image. Prisma needs OpenSSL in the runtime.
FROM node:22-bookworm-slim
RUN apt-get update && apt-get install -y --no-install-recommends openssl ca-certificates && rm -rf /var/lib/apt/lists/*
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev
COPY prisma ./prisma
RUN npx prisma generate
COPY . .
ENV NODE_ENV=production PORT=3000
EXPOSE 3000
# Apply any pending migrations, then start. Safe to repeat on every start.
CMD ["sh", "-c", "npx prisma migrate deploy && node index.js"]
