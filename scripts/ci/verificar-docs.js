#!/usr/bin/env node
"use strict";
// Verifica la documentación: (1) todos los enlaces relativos de los .md apuntan a un archivo que existe (y, si llevan #ancla, a un
// título real), y (2) los bloques ```mermaid tienen sintaxis válida (con mermaid-cli si está disponible: IPAM_MERMAID=1).
const fs = require("node:fs");
const path = require("node:path");
const RAIZ = path.resolve(__dirname, "..", "..");
const IGNORAR = new Set([
  "node_modules",
  ".git",
  ".gitlab-ci-local",
  ".terraform",
  "sbom",
]);

function* archivos(dir) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    if (IGNORAR.has(e.name)) continue;
    const p = path.join(dir, e.name);
    if (e.isDirectory()) yield* archivos(p);
    else if (e.name.endsWith(".md")) yield p;
  }
}
const slug = (t) =>
  t
    .toLowerCase()
    .replace(/<[^>]+>/g, "")
    .replace(/[`*_~]/g, "")
    .replace(/[^\p{L}\p{N}\s-]/gu, "")
    .trim()
    .replace(/\s/g, "-");
const anclas = (md) =>
  new Set([...md.matchAll(/^#{1,6}\s+(.+?)\s*$/gm)].map((m) => slug(m[1])));

let errores = 0;
const falla = (f, msg) => {
  console.error(`✗ ${path.relative(RAIZ, f)}: ${msg}`);
  errores++;
};
let enlaces = 0;
let diagramas = 0;
const bloques = [];
for (const f of archivos(RAIZ)) {
  const md = fs.readFileSync(f, "utf8");
  const sinCodigo = md.replace(/```[\s\S]*?```/g, "");
  for (const m of sinCodigo.matchAll(/\[[^\]]*\]\(([^)\s]+)\)/g)) {
    const url = m[1];
    if (/^(https?:|mailto:|#)/.test(url) || url.startsWith("/")) {
      if (url.startsWith("#") && !anclas(md).has(url.slice(1)))
        falla(f, `ancla inexistente ${url}`);
      continue;
    }
    enlaces++;
    const [rel, ancla] = url.split("#");
    const destino = path.resolve(path.dirname(f), decodeURIComponent(rel));
    if (!fs.existsSync(destino)) {
      falla(f, `enlace roto → ${url}`);
      continue;
    }
    if (
      ancla &&
      destino.endsWith(".md") &&
      !anclas(fs.readFileSync(destino, "utf8")).has(ancla)
    )
      falla(f, `ancla inexistente → ${url}`);
  }
  for (const m of md.matchAll(/```mermaid\n([\s\S]*?)```/g)) {
    diagramas++;
    bloques.push({ f, codigo: m[1] });
  }
}
if (process.env.IPAM_MERMAID === "1") {
  const { execFileSync } = require("node:child_process");
  const tmp = fs.mkdtempSync(path.join(require("node:os").tmpdir(), "mmd-"));
  bloques.forEach((b, i) => {
    const entrada = path.join(tmp, `d${i}.mmd`);
    fs.writeFileSync(entrada, b.codigo);
    try {
      // IPAM_CHROMIUM = ruta a un Chromium ya instalado (si no, mermaid-cli usa el suyo).
      const cfg = path.join(tmp, "puppeteer.json");
      fs.writeFileSync(
        cfg,
        JSON.stringify({
          args: ["--no-sandbox"],
          ...(process.env.IPAM_CHROMIUM
            ? { executablePath: process.env.IPAM_CHROMIUM }
            : {}),
        }),
      );
      execFileSync(
        "npx",
        [
          "--yes",
          "@mermaid-js/mermaid-cli@11.4.2",
          "-i",
          entrada,
          "-o",
          path.join(tmp, `d${i}.svg`),
          "-p",
          cfg,
          "-q",
        ],
        { stdio: "pipe" },
      );
    } catch (e) {
      falla(
        b.f,
        `diagrama Mermaid inválido: ${String(e.stderr || e.message)
          .split("\n")
          .slice(0, 3)
          .join(" ")}`,
      );
    }
  });
}
console.log(
  `${enlaces} enlaces relativos y ${diagramas} diagramas Mermaid revisados${process.env.IPAM_MERMAID === "1" ? " (sintaxis validada)" : " (sintaxis: IPAM_MERMAID=1 para validar)"}`,
);
process.exit(errores ? 1 : 0);
