# Cómo contribuir

> Esta guía se completa en la fase de documentación con «Cómo agregar un adaptador» y el detalle de cada comando. Lo esencial ya está aquí.

## Correr todo en local
Requisitos: Node 22, Docker, `make`, Helm (opcional). Un PostgreSQL de pruebas (cualquier versión 14 a 17):
```bash
docker run -d --name ipam-pg -e POSTGRES_USER=ipam -e POSTGRES_PASSWORD=ci -e POSTGRES_DB=ipam -p 55432:5432 postgres:16-alpine
export DATABASE_URL=postgres://ipam:ci@127.0.0.1:55432/ipam
cd mvp && npm ci
npm run lint && npm run formato:verificar && npm run tipos      # calidad
psql "$DATABASE_URL" -f db/schema.sql -f db/seed.sql            # base de ejemplo para las pruebas históricas
npm test                                                        # cada archivo de prueba usa su propia base temporal
npm run cobertura                                               # ≥ 80 % en dominio/ y aplicacion/ (sin base de datos)
```

## Convenciones
- **Commits:** Conventional Commits (`feat(reservas): …`, `fix: …`, `docs: …`). Lo verifica el hook `commit-msg` y el CI.
- **Ramas:** `tipo/descripcion` (`feat/…`, `fix/…`, `docs/…`); se integra a la rama principal con **PR (GitHub) o MR (GitLab)**, nunca directo.
- **Idioma:** código, comentarios, mensajes y documentación en español; si usas un término técnico en inglés, aclara qué significa la primera vez.

## Definición de terminado
- [ ] Pruebas nuevas o actualizadas y `npm test` en verde.
- [ ] Lint, formato y tipos en verde; escaneos (`make scan`) en verde.
- [ ] Documentación y contrato OpenAPI actualizados (hay una prueba que compara rutas y contrato).
- [ ] Sin secretos (ni en ejemplos, ni en logs, ni en mensajes de error).
- [ ] Si toca el esquema SQL: **idempotente** (se aplica dos veces), migra desde el esquema viejo, y `mvp/db/schema.sql` = `mvp/chart/ipam/files/schema.sql`.
- [ ] Nada específico de un proveedor de nube o de CI en `mvp/src/` (`scripts/verificar-portabilidad.sh`).
