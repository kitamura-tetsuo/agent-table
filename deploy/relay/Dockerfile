# Supply the exact image from node-image.txt; no floating default.
ARG NODE_IMAGE
FROM ${NODE_IMAGE}
WORKDIR /app
COPY package.json .node-version ./
COPY scripts/ ./scripts/
COPY src/ ./src/
USER 10001:10001
ENTRYPOINT ["node", "scripts/relay-controller.mjs"]
