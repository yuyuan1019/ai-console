FROM node:24-bookworm-slim

ENV LANG=C.UTF-8 \
    LC_ALL=C.UTF-8 \
    CI=true

WORKDIR /app/console

COPY console/apps/api/package*.json apps/api/
RUN cd apps/api && npm ci

COPY console/apps/web/package*.json apps/web/
RUN cd apps/web && npm ci

COPY console/db db
COPY console/apps apps
COPY console/agent-dist agent-dist

RUN cd apps/web && npm run build

RUN mkdir -p data

ENV DB_PATH=/app/console/data/ai-console.db \
    PORT=3000

EXPOSE 3000

CMD ["npm", "--prefix", "apps/api", "run", "start"]
