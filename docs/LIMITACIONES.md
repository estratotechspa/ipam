# Limitaciones y alcance

Lo que el IPAM **no** hace o hace con salvedades. Se mantiene honesto a propósito.

## Fuera de alcance
- **On-premise: manual.** El IPAM registra rangos on-premise si los cargas como pool, pero **no** automatiza reglas ni rutas hacia el centro de datos. Las reglas perimetrales hacia on-premise las hace una persona. En el flujo de [CONTRATO-YAML-REDES](CONTRATO-YAML-REDES.md) ese paso queda explícito como manual.
- **Fortinet fuera de alcance.** No hay integración con firewalls Fortinet; cualquier regla en ellos es manual y no la ve ni la valida el IPAM.
- **El IPAM no crea redes.** Asigna y registra rangos. Crear VPC, subredes y firewall lo hacen los pipelines de infraestructura (OpenTofu).
- **Solo IPv4.** IPv6 no está implementado (hay una propuesta aparte, sin construir).
- **No descubre redes existentes.** Solo conoce lo que se le asignó por él; no escanea la nube para detectar rangos ya en uso fuera de él.
- **Un solo escritor lógico por pool.** La consistencia se garantiza en PostgreSQL; no hay multi-región activa-activa.

## Sobre la aprobación humana
El IPAM exige `aprobado_por` y `referencia` para que un agente confirme, y los guarda en la auditoría. **No puede verificar que esa persona exista ni que realmente aprobó**: un agente mal configurado podría escribir cualquier nombre. La garantía real es el **ambiente protegido con aprobadores** del pipeline (GitLab/GitHub), que debe configurarse para que solo las personas indicadas ejecuten el paso manual. Ver [BUENAS-PRACTICAS](BUENAS-PRACTICAS.md).

## Sobre el POC (Render + Supabase)
- El plan gratuito de Render **duerme** el servicio: la primera petición puede tardar más de un minuto.
- Acceso **Basic** (usuario y contraseña) solo para pruebas; para uso real, configura OIDC.
- `sslmode=require` cifra pero **no verifica el certificado** del servidor (comportamiento de libpq). Para verificarlo, usa `DATABASE_SSL_CA`.
- Los límites de los planes gratuitos cambian: verifícalos en las páginas oficiales.
- El modo transacción del pooler (puerto 6543) **no funciona** con el IPAM.

## Sobre lo verificado
- Las pruebas automáticas corren contra PostgreSQL 14, 15, 16 y 17 reales.
- Los pipelines de GitHub y GitLab, los manifiestos de GKE/EKS/AKS/Cloud Run y los ejemplos de OpenTofu **no se ejecutaron contra cuentas reales**; se validaron sintácticamente y, donde fue posible, en contenedores locales.
- La imagen de runtime (Chainguard, fijada por digest) trae una versión de Node más nueva que la que prueba el CI (22).
- `exceljs` arrastra una dependencia con un aviso de severidad moderada en `npm audit` (aceptado; la severidad alta bloquea el CI).
- El contrato YAML de redes es una **propuesta pendiente de validar** con el equipo dueño de `cd-agents`.
- La herramienta de escaneo mencionada como «Whisky» está **por confirmar**; hoy se usan Trivy y Checkov.

## Rendimiento
Pensado para decenas de pools y miles de asignaciones, no para millones. El límite de peticiones y la cuota por token evitan que un agente descontrolado sature el servicio.
