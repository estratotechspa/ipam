# Política de seguridad

## Cómo reportar una vulnerabilidad
**No abras un issue público.** Repórtala en privado:

1. **GitHub:** pestaña *Security* → *Report a vulnerability* (reporte privado), o
2. **GitLab:** crea un issue marcado como **confidencial**, o
3. Por correo a **ext_carlos.quiroz@cajalosandes.cl**.

Incluye: qué versión, cómo reproducirlo, qué impacto crees que tiene y, si puedes, una prueba mínima. **No incluyas datos reales ni credenciales.**

Qué puedes esperar: acuse de recibo en **3 días hábiles**, una primera evaluación en **10 días hábiles** y un aviso cuando haya corrección. Te pedimos coordinar la
divulgación pública con nosotros hasta que haya un arreglo disponible. Agradecemos el reporte de buena fe.

## Versiones con soporte
Solo la última versión publicada recibe correcciones de seguridad (hoy: **0.3.x**).

## Qué consideramos en alcance
Autenticación y autorización (tokens, sesiones, roles), inyección (SQL, cabeceras, XSS), SSRF en el webhook saliente, filtración de secretos (logs, errores, métricas),
exposición de datos entre ambientes, denegación de servicio por el propio servicio, y la cadena de suministro (dependencias e imagen).

## Cómo cuidamos esto (resumen)
- Tokens de servicio: 256 bits aleatorios, solo se guarda su hash SHA-256, vencen y se revocan al instante.
- Consultas SQL solo parametrizadas (regla de lint que falla si no); auditoría de solo inserción; roles de base de datos de permisos mínimos.
- Escaneos automáticos en cada cambio: gitleaks (secretos), Semgrep (SAST), Trivy (dependencias, imagen y configuración), Checkov (IaC), `npm audit` y SBOM CycloneDX.
- Modelo de amenazas y límites conocidos: [`docs/MODELO-DE-AMENAZAS.md`](docs/MODELO-DE-AMENAZAS.md) y [`docs/LIMITACIONES.md`](docs/LIMITACIONES.md).
