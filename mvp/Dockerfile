# Imagen endurecida: construcción en dos etapas y runtime sin shell ni gestor de paquetes.
# Ambas bases son parámetros para poder usar las imágenes aprobadas por un cliente:
#   docker build --build-arg BASE_IMAGE=registro.cliente.cl/node:22 --build-arg BUILD_IMAGE=registro.cliente.cl/node:22 .
# La base de runtime debe traer Node >= 20 en el PATH y ejecutar como usuario no root.
ARG BUILD_IMAGE=node:22-alpine@sha256:0a7108bf6c7bf5de370ffb1a3ed6be93d405b43ff159f681a8d18c0e2bc2e402
ARG BASE_IMAGE=cgr.dev/chainguard/node@sha256:95f6858673107192ab0c550f4d8d31347d53d33f799c14bf74222c61e0063641

# hadolint ignore=DL3006
FROM ${BUILD_IMAGE} AS deps
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev --ignore-scripts && npm cache clean --force

# hadolint ignore=DL3006
FROM ${BASE_IMAGE}
WORKDIR /app
ENV NODE_ENV=production PATH=/usr/local/bin:/usr/bin:/bin:/nodejs/bin
COPY --from=deps /app/node_modules ./node_modules
COPY package.json ./
COPY src ./src
COPY public ./public
USER 65532:65532
EXPOSE 8080
HEALTHCHECK --interval=15s --timeout=3s --start-period=10s \
  CMD ["node", "-e", "fetch('http://127.0.0.1:8080/api/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"]
ENTRYPOINT []
CMD ["node", "src/server.js"]
