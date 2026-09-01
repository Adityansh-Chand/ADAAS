FROM node:24-slim

WORKDIR /app

COPY hr-backend/package*.json ./
RUN npm ci --omit=dev

COPY hr-backend/ ./
COPY assets/ /app/assets/

# Runs as a non-root user. node:24-slim ships an unprivileged `node` account, so
# this needs no useradd -- and the omission was the gap: a container process that
# does not need root should not have it, because the blast radius of any
# vulnerability in this image is otherwise the whole filesystem.
#
# The chown covers the writable path: notifications are written through to
# .data/, and a non-root process cannot create that directory under a
# root-owned WORKDIR.
RUN mkdir -p /app/.data && chown -R node:node /app
USER node

ENV PORT=3000
# Stated explicitly rather than left to resolve relative to WORKDIR.
ENV KB_PATH=/app/assets/hr_knowledge_base.json
EXPOSE 3000

HEALTHCHECK --interval=30s --timeout=5s --start-period=5s --retries=3   CMD node -e "fetch('http://localhost:'+(process.env.PORT||3000)+'/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

CMD ["npm", "start"]
