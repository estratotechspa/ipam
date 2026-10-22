# Cómo contribuir

## Correr todo en local
Requisitos: Node 22, Docker, `make`, Helm (opcional). Un PostgreSQL de pruebas (cualquier versión 14 a 17):
```bash
docker run -d --name ipam-pg -e POSTGRES_USER=ipam -e POSTGRES_PASSWORD=ci -e POSTGRES_DB=ipam -p 55432:5432 postgres:16-alpine
export DATABASE_URL=postgres://ipam:ci@127.0.0.1:55432/ipam
cd mvp && npm ci
npm run lint && npm run formato:verificar && npm run tipos      # calidad
node scripts/aplicar-sql.js db/schema.sql db/seed.sql           # base de ejemplo para las pruebas históricas (no necesita psql)
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

## Comandos del día a día
| Comando | Para qué |
|---|---|
| `make ayuda` | Lista todos los objetivos |
| `make lint` | ESLint, Prettier y tipos (TypeScript con `checkJs`) |
| `make test` / `make cobertura` | Pruebas contra PostgreSQL real / con cobertura |
| `make matriz-pg` | Pruebas en PostgreSQL 14, 15, 16 y 17 (contenedores desechables) |
| `make esquema` | Aplica el esquema dos veces y sobre el esquema viejo |
| `make test-e2e` | Pruebas de navegador (Playwright) y accesibilidad (axe) |
| `make scan` | gitleaks, Semgrep, Trivy y Checkov |
| `make helm-check` | `helm lint/template` en todos los escenarios y kube-linter |
| `make portabilidad` | Guardia contra acoplamiento a un proveedor |
| `make ci` | Todo lo anterior, igual que el CI |
| `npm run doc:config` | Regenera [CONFIGURACION](CONFIGURACION.md) desde `src/config.js` |
Los pipelines de GitHub y de GitLab solo llaman a estos objetivos ([ADR 0009](adr/0009-ci-portable-github-gitlab.md)).

## Cómo agregar un adaptador
La arquitectura es **hexagonal** ([ARQUITECTURA](ARQUITECTURA.md)): el núcleo (`dominio/`, `aplicacion/`) pide capacidades a **puertos** (interfaces en `mvp/src/aplicacion/puertos.js`) y los **adaptadores** (`mvp/src/adaptadores/`) los implementan. Ejemplo: publicar eventos a un destino nuevo (Pub/Sub, SNS, Slack…).
1. **Elige el puerto.** Para eventos es `PublicadorEventos`: `publicar(tipo, detalle)`, que **nunca debe lanzar** (un adaptador que falla no afecta a los demás ni a la operación).
2. **Crea el adaptador** en `mvp/src/adaptadores/eventos/mi-destino.js`, con una función `crearMiDestino(cfg, log)` que devuelve `{ publicar }`. Todo el código del SDK o del protocolo se queda **dentro del adaptador**; el núcleo no lo importa.
3. **Configúralo por variables de entorno:** agrega las variables en `mvp/src/config.js` con `def(...)` (valor seguro por defecto; `secreta: true` si lleva credenciales). Nunca leas `process.env` fuera de `config.js` (lo comprueba el lint).
4. **Regístralo** en la composición: en `eventos/index.js`, un `if (cfg.publicadores.includes('mi-destino'))` que añade el adaptador; y agrega el nombre a las opciones de `EVENTOS_PUBLICADORES`.
5. **Pruebas:** un `*.test.js` junto al adaptador (con el puerto en memoria no necesitas base de datos). Prueba el caso de fallo: el adaptador no debe lanzar.
6. **Documenta:** `npm run doc:config` regenera la tabla de variables; añade una línea en [CONFIGURACION](CONFIGURACION.md) si hace falta contexto y, si cambia una decisión de diseño, un ADR en `docs/adr/`.
7. **Verifica la portabilidad:** `make portabilidad` y `make lint test`. Si el adaptador es específico de una nube, debe ser **opcional** (apagado por defecto) y no puede estar en la ruta por defecto.
Otros puertos con adaptadores intercambiables: persistencia (`postgres` | `memoria`), límite de peticiones (`postgres` | `memoria`), métricas, trazas y tickets.
