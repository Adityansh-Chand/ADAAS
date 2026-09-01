# The one image that carries @huggingface/transformers.
#
# It holds no HR data, needs no database, and exposes two endpoints that turn
# text into numbers. The transitive advisories in onnxruntime-node's dependency
# tree (adm-zip, sharp) have no upstream fix and therefore still exist -- but they
# now exist here, in a container that can be given no network egress and no
# access to anything, instead of in the image that serves employee leave records.
FROM node:24-slim

WORKDIR /app

COPY model-service/package*.json ./
RUN npm install --omit=dev

COPY model-service/server.js ./

ENV MODEL_SERVICE_PORT=3100
ENV MODEL_CACHE_DIR=/app/.model-cache
EXPOSE 3100

# Weights are pulled at build time rather than on the first request, so a cold
# container answers immediately and a deployment with no egress still works.
RUN node -e "const s=require('./server.js');" \
 && node -e "(async()=>{const t=await import('@huggingface/transformers');t.env.cacheDir='/app/.model-cache';await t.pipeline('feature-extraction','Xenova/bge-small-en-v1.5',{dtype:'fp32'});await t.AutoTokenizer.from_pretrained('mixedbread-ai/mxbai-rerank-xsmall-v1');await t.AutoModelForSequenceClassification.from_pretrained('mixedbread-ai/mxbai-rerank-xsmall-v1',{dtype:'fp32'});console.log('models cached');})()"

HEALTHCHECK --interval=30s --timeout=10s --start-period=20s --retries=3 \
  CMD node -e "fetch('http://localhost:'+(process.env.MODEL_SERVICE_PORT||3100)+'/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

CMD ["npm", "start"]
