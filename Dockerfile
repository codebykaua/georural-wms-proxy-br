FROM node:22-alpine

ENV NODE_ENV=production \
    HOST=0.0.0.0 \
    PORT=10000

WORKDIR /app

COPY --chown=node:node package.json server.mjs ./

USER node

EXPOSE 10000

CMD ["node", "server.mjs"]
