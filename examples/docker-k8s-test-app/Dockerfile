FROM node:20-alpine

WORKDIR /app

COPY server.js ./server.js

ENV NODE_ENV=production
ENV PORT=8080
ENV APP_NAME=oshal-test-app

EXPOSE 8080

HEALTHCHECK --interval=15s --timeout=3s --start-period=5s --retries=3 \
  CMD node -e "require('http').get('http://127.0.0.1:8080/health', (res) => process.exit(res.statusCode === 200 ? 0 : 1)).on('error', () => process.exit(1))"

CMD ["node", "server.js"]
