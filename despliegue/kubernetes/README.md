# Kubernetes (Helm genérico + ajustes por nube)

El chart está en [`mvp/chart/ipam`](../../mvp/chart/ipam) y no depende de ninguna nube. Aquí viven solo los **ajustes por plataforma**.

```bash
# Genérico (cualquier clúster)
helm upgrade --install ipam mvp/chart/ipam -n ipam --create-namespace \
  --set image.repository=REGISTRY/ipam --set image.tag=0.3.0 \
  --set secrets.existingSecret=ipam-secrets          # Secret creado por ti (ver docs/ops/DESPLIEGUE.md)

# Con los ajustes de tu nube (-f se suma al chart; los --set ganan sobre el archivo)
helm upgrade --install ipam mvp/chart/ipam -n ipam -f despliegue/kubernetes/values-gke.yaml     # o values-eks.yaml / values-aks.yaml
```

| Archivo | Nube | Ingress | Identidad de carga de trabajo | Base gestionada |
|---|---|---|---|---|
| `values-gke.yaml` | Google Cloud | `gce` | Workload Identity | Cloud SQL |
| `values-eks.yaml` | AWS | `alb` | IRSA | RDS / Aurora |
| `values-aks.yaml` | Azure | `webapprouting…` | Workload Identity | PostgreSQL servidor flexible |

**Estado honesto:** el chart pasa `helm lint` y `helm template` (en CI). Los tres archivos de ajustes **no se probaron en clústeres reales**
(no hay acceso a esas cuentas): revisa los valores marcados como FICTICIOS o «verifícalo», en especial `trustProxy` (número de saltos de proxy).
Valores de ejemplo por ambiente (`values-dev.yaml`, `values-qa.yaml`, `values-prod.yaml`): ver [`docs/ops/DESPLIEGUE.md`](../../docs/ops/DESPLIEGUE.md).
