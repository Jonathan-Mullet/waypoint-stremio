FROM node:22-alpine
RUN addgroup -S waypoint && adduser -S -G waypoint waypoint
WORKDIR /app
COPY package*.json ./
RUN npm ci --omit=dev
COPY src/ ./src/
COPY public/ ./public/
USER waypoint
ENV NODE_ENV=production PORT=3000
EXPOSE 3000
CMD ["node", "src/server.js"]
