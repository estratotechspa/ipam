## Qué cambia y por qué
<!-- Una o dos frases. Enlaza el ticket o el ADR si lo hay. -->

## Cómo se probó
<!-- Comandos que corriste y resultado (make ci, pruebas nuevas, prueba manual…). Di explícitamente qué NO pudiste verificar. -->

## Lista de seguridad y calidad
- [ ] `make ci` pasa en local (lint, formato, tipos, pruebas, portabilidad, escaneos).
- [ ] Hay pruebas nuevas o actualizadas para el comportamiento que cambia.
- [ ] **Sin secretos** en el código, los logs, los ejemplos ni los mensajes de error (solo valores de relleno).
- [ ] Consultas SQL **solo parametrizadas** (la regla de lint no se desactivó sin justificación).
- [ ] Toda entrada nueva se valida con esquema (contrato OpenAPI actualizado y `src/openapi.js` en paridad con las rutas).
- [ ] Los errores no devuelven detalles internos (solo `request_id`).
- [ ] Si toca el esquema SQL: es **idempotente** (se aplica dos veces sin error), migra desde el esquema viejo, y `mvp/db/schema.sql` y `mvp/chart/ipam/files/schema.sql` son idénticos.
- [ ] Si agrega configuración: variable de entorno con valor por defecto seguro, documentada en `docs/CONFIGURACION.md` y en `values.yaml`.
- [ ] No se agregó código específico de un proveedor de nube o de CI (`scripts/verificar-portabilidad.sh` pasa).
- [ ] La documentación (y el CHANGELOG) está actualizada.

## Riesgos y reversa
<!-- ¿Qué podría salir mal? ¿Cómo se revierte? -->
