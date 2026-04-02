FROM node:20-alpine

WORKDIR /app

COPY package*.json ./
RUN npm ci --omit=dev

COPY tsconfig.json ./
COPY src/ ./src/
RUN npm install typescript --save-dev && npx tsc && npm uninstall typescript

ENV PORT=3000
ENV MCP_TRANSPORT=http

EXPOSE 3000

CMD ["node", "dist/index.js"]
