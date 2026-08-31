FROM node:24-slim

WORKDIR /app

COPY hr-backend/package*.json ./
RUN npm ci --omit=dev

COPY hr-backend/ ./
COPY assets/ /app/assets/

ENV PORT=3000
# Stated explicitly rather than left to resolve relative to WORKDIR.
ENV KB_PATH=/app/assets/hr_knowledge_base.json
EXPOSE 3000

HEALTHCHECK --interval=30s --timeout=5s --start-period=5s --retries=3   CMD node -e "fetch('http://localhost:'+(process.env.PORT||3000)+'/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

CMD ["npm", "start"]
