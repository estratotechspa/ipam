# Imagen de producción del IPAM. Principios:
#  - multi-etapa: la etapa de dependencias (con npm) NO llega a la imagen final; el runtime no trae shell ni gestor de paquetes;
#  - usuario no root (65532) y pensada para correr con sistema de archivos de solo lectura y sin capacidades Linux;
#  - bases fijadas por digest (reproducible); se pueden reemplazar por las imágenes aprobadas de un cliente:
#      docker build --build-arg BASE_IMAGE=registro.cliente.cl/node:22 --build-arg BUILD_IMAGE=registro.cliente.cl/node:22 .
#    (la base de runtime debe traer Node >= 22 en el PATH y ejecutar como usuario no root);
#  - la MISMA imagen sirve en dev, qa, pre y prod: solo cambia la configuración (variables de entorno);
#  - sin registry fijo: se etiqueta y publica donde diga la variable de CI (ver scripts/ci/).
#  - multi-arquitectura (amd64 y arm64): `docker buildx build --platform linux/amd64,linux/arm64 …` (lo hace el CI).
ARG BUILD_IMAGE=node:22-alpine@sha256:0a7108bf6c7bf5de370ffb1a3ed6be93d405b43ff159f681a8d18c0e2bc2e402
# Node 22 LTS (la versión con la que se prueba todo: CI y desarrollo). Chainguard gratuito solo publica `latest` (hoy Node 26), así que
# no permite fijar la versión mayor; distroless sí, y mantiene lo importante: sin shell ni gestor de paquetes, usuario no root, amd64 y arm64.
ARG BASE_IMAGE=gcr.io/distroless/nodejs22-debian13@sha256:10747a1323be68f206aed893599d43e6697ad67257e7c42703553f99fbce3d33

# La etapa de dependencias corre SIEMPRE en la arquitectura del equipo que construye ($BUILDPLATFORM), no en la de destino: las
# dependencias de producción son JavaScript puro (sin módulos nativos; los scripts de instalación se omiten con --ignore-scripts),
# así que node_modules es idéntico para amd64 y arm64. Así `npm ci` no se ejecuta bajo emulación QEMU, donde Node fallaba al azar con
# «Illegal instruction» (SIGILL) al construir arm64 en el CI. Si algún día se agrega una dependencia nativa, quita esta línea
# (src/arquitectura.test.js lo detecta).
# hadolint ignore=DL3006,DL3029
FROM --platform=$BUILDPLATFORM ${BUILD_IMAGE} AS deps
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev --ignore-scripts && npm cache clean --force

# hadolint ignore=DL3006
FROM ${BASE_IMAGE}
ARG VERSION=0.3.0
ARG REVISION=desconocida
LABEL org.opencontainers.image.title="ipam" \
      org.opencontainers.image.description="IPAM: gestión de segmentos de red con reservas tentativas para agentes" \
      org.opencontainers.image.version="${VERSION}" \
      org.opencontainers.image.revision="${REVISION}"
WORKDIR /app
ENV NODE_ENV=production PATH=/usr/local/bin:/usr/bin:/bin:/nodejs/bin
COPY --from=deps /app/node_modules ./node_modules
COPY package.json ./
COPY src ./src
COPY db ./db
COPY public ./public
USER 65532:65532
EXPOSE 8080
# /healthz = «estoy vivo» (no toca la base). La disponibilidad real (base y esquema) la da /readyz.
HEALTHCHECK --interval=15s --timeout=3s --start-period=10s \
  CMD ["node", "-e", "fetch('http://127.0.0.1:'+(process.env.PORT||8080)+'/healthz').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"]
ENTRYPOINT []
CMD ["node", "src/server.js"]
