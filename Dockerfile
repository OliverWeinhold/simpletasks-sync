FROM node:24-alpine

WORKDIR /app
ENV NODE_ENV=production \
    HOST=0.0.0.0 \
    PORT=8463 \
    DATA_DIR=/data

# no runtime dependencies, node runs the typescript sources directly
COPY package.json LICENSE README.md ./
COPY src ./src

RUN mkdir -p /data && chown node:node /data
USER node
VOLUME /data
EXPOSE 8463

HEALTHCHECK --interval=30s --timeout=3s --start-period=5s \
  CMD wget -qO- http://127.0.0.1:8463/v1/health > /dev/null || exit 1

CMD ["node", "--disable-warning=ExperimentalWarning", "src/index.ts"]
