FROM node:24-slim

WORKDIR /app

COPY hr-backend/package*.json ./
RUN npm ci --omit=dev

COPY hr-backend/ ./
COPY assets/ /assets/

ENV PORT=3000
EXPOSE 3000

CMD ["npm", "start"]
