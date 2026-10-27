# Calidad y seguridad del código, explicadas en simple

Todo lo que se puede automatizar corre en **CI** (GitHub y GitLab) y en el **pre-commit**; el resto está documentado. Con un solo comando: `make ci`.
Referencias: OWASP ASVS nivel 2 y OWASP API Security Top 10.

## Calidad
| Práctica | Qué hace | Cómo correrla |
|---|---|---|
| **ESLint** (config «flat») | Encuentra errores, código muerto, funciones demasiado complejas (≤ 25) o largas (≤ 160 líneas) y prohíbe `process.env` fuera de `config.js`, `console` y `eval` | `make lint` · `npm run lint` |
| **Prettier + `.editorconfig`** | Formato único; se discute lo que importa, no las comas | `npm run formato` (arregla) · `npm run formato:verificar` |
| **Tipos graduales** | JSDoc con `// @ts-check` y `tsc --checkJs` en `dominio/` y `aplicacion/` (sin migrar a TypeScript) | `npm run tipos` |
| **Validación de entrada con esquema** | Los cuerpos se validan con Ajv usando los **mismos esquemas del contrato OpenAPI**: lo documentado y lo aceptado no pueden divergir | pruebas `openapi.test.js` y `contrato.test.js` |
| **Cobertura ≥ 80 %** en `dominio/` y `aplicacion/` (hoy ~97 %) | Falla si baja | `npm run cobertura` |
| **Pruebas de propiedades** (fast-check) | Genera cientos de casos al azar para el invariante «nunca se solapan dos rangos» y para el cálculo de CIDR (se compara con una versión de fuerza bruta) | `npm test` |
| **Conventional Commits y ramas** | `tipo(ámbito): descripción`; ramas `tipo/descripcion` | hook `commit-msg` (lefthook) y `scripts/hooks/` |
| **Gobernanza** | `CODEOWNERS` (vale en GitHub y GitLab), plantillas de PR y MR con lista de seguridad, `SECURITY.md`, `docs/CONTRIBUIR.md` | — |

**Definición de terminado** (también en `CONTRIBUIR.md` y en las plantillas): pruebas, lint, escaneos en verde, documentación y OpenAPI al día, sin secretos, migración idempotente.

## Seguridad
| Práctica | Qué hace |
|---|---|
| **SQL solo parametrizado** | Una regla de lint falla si se arma SQL con texto; una prueba demuestra que la regla detecta plantillas, concatenación, `concat`, `replace` y `join` |
| **Comparaciones en tiempo constante** | Tokens, contraseñas y firmas HMAC se comparan con `timingSafeEqual` (así no se filtra información por el tiempo de respuesta) |
| **Contraseña Basic con hash** | `APP_PASS` acepta un hash `scrypt$…` (`npm run hash-password`); se **recomienda** siempre que uses Basic |
| **Webhooks salientes** | Anti-SSRF (privadas y metadatos bloqueados, DNS validado al conectar, sin redirecciones), timeouts, firma HMAC y reintentos acotados |
| **Errores sin detalles** | El cliente solo ve un código y el `request_id`; la causa queda en el log del servidor; los logs redactan credenciales automáticamente |
| **Auditoría de solo inserción** | Disparador en la base y rol de la app sin UPDATE/DELETE |
| **Roles de base de datos** | `ipam_migrador` (DDL, solo para migrar) e `ipam_app` (solo DML): ver `ACCESO-Y-SEGURIDAD.md` |
| **Interfaz** | CSP sin scripts en línea, DOM construido con nodos de texto, cookies HttpOnly/SameSite/Secure |
| **Cadena de suministro** | `package-lock.json` + `npm ci`; `npm audit` falla con severidad alta; SBOM CycloneDX; licencias; imagen base, acciones de CI e imágenes de CI **fijadas por digest o commit**; nada de `latest` |
| **Escaneos portables** | gitleaks (secretos), Semgrep (SAST), Trivy (dependencias, imagen y Helm/IaC) y Checkov (IaC de ejemplo), como contenedores con versión fija: `make scan` |
| **Contenedor** | Usuario no root, sistema de archivos de solo lectura, sin capacidades, `seccomp RuntimeDefault`, requests/limits; `NetworkPolicy` (y una de denegación por defecto, opcional) |
| **Procedencia (opcional, apagada)** | Firma de imagen con cosign sin llaves y atestación SLSA: pasos listos, se activan con `FIRMAR_IMAGEN=true` |
| **DAST (opcional, apagado)** | OWASP ZAP baseline contra una instancia efímera (`ACTIVAR_DAST=true`) |

Qué amenazas cubre cada cosa y qué riesgo queda: [`MODELO-DE-AMENAZAS.md`](MODELO-DE-AMENAZAS.md). Límites conocidos: [`LIMITACIONES.md`](LIMITACIONES.md).
