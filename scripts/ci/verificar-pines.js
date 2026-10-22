#!/usr/bin/env node
"use strict";
// Verifica los «pines» de la cadena de suministro: cada imagen fijada por digest (image@sha256:…) y cada acción de CI fijada por commit EXISTEN de verdad
// en su registry/repositorio, y no se usa `latest`. Un digest mal copiado hace fallar el CI; esto lo descubre antes.
//   node scripts/ci/verificar-pines.js            (revisa y falla si algo no existe)
//   node scripts/ci/verificar-pines.js --solo-leer (solo lista lo que encontró, sin red)
// Habla con los registries por la API estándar (HEAD del manifiesto, con el desafío de autenticación anónimo). HEAD no cuenta para el límite de descargas de Docker Hub.
const fs = require("node:fs");
const path = require("node:path");

const RAIZ = path.join(__dirname, "..", "..");
const ARCHIVOS = [
  "mvp/Dockerfile",
  "mvp/postgres/Dockerfile",
  ".gitlab-ci.yml",
  "docs/ops/gitlab/.gitlab-ci.yml",
  "scripts/ci/escanear.sh",
  "scripts/ci/postgres-local.sh",
  "scripts/ci/construir-imagen.sh",
  "scripts/ci/dast.sh",
  "scripts/ci/firmar-imagen.sh",
  "despliegue/docker-compose/docker-compose.yml",
  "mvp/docker-compose.yml",
];
const ACEPTA = [
  "application/vnd.oci.image.index.v1+json",
  "application/vnd.docker.distribution.manifest.list.v2+json",
  "application/vnd.oci.image.manifest.v1+json",
  "application/vnd.docker.distribution.manifest.v2+json",
].join(", ");

function listarArchivos() {
  const todos = ARCHIVOS.map((f) => path.join(RAIZ, f)).filter((f) =>
    fs.existsSync(f),
  );
  const wf = path.join(RAIZ, ".github", "workflows");
  if (fs.existsSync(wf))
    for (const f of fs.readdirSync(wf))
      if (/\.ya?ml$/.test(f)) todos.push(path.join(wf, f));
  return todos;
}

/** Encuentra pines en el texto: imágenes con digest, acciones con commit, y usos de `latest`. */
function encontrar(texto, archivo) {
  const imagenes = [],
    acciones = [],
    latest = [];
  for (const m of texto.matchAll(
    /([A-Za-z0-9][A-Za-z0-9._\-/]*(?::[A-Za-z0-9._-]+)?)@(sha256:[0-9a-f]{64})/g,
  ))
    imagenes.push({ ref: m[1], digest: m[2], archivo });
  for (const m of texto.matchAll(
    /uses:\s*([A-Za-z0-9._-]+\/[A-Za-z0-9._-]+(?:\/[A-Za-z0-9._/-]+)?)@([0-9a-f]{40})/g,
  ))
    acciones.push({
      repo: m[1].split("/").slice(0, 2).join("/"),
      sha: m[2],
      archivo,
    });
  for (const m of texto.matchAll(
    /(?:image:|FROM|docker run[^\n]*\s)\s*['"]?([A-Za-z0-9./_-]+:latest)\b/g,
  ))
    latest.push({ ref: m[1], archivo });
  return { imagenes, acciones, latest };
}

function separar(ref) {
  const sinTag = ref.replace(/:[A-Za-z0-9._-]+$/, "");
  const partes = sinTag.split("/");
  let host = "registry-1.docker.io",
    nombre = sinTag;
  if (partes.length > 1 && /[.:]/.test(partes[0])) {
    host = partes[0];
    nombre = partes.slice(1).join("/");
  } else if (partes.length === 1) nombre = `library/${sinTag}`;
  return { host, nombre };
}

async function existe({ ref, digest }) {
  const { host, nombre } = separar(ref);
  const url = `https://${host}/v2/${nombre}/manifests/${digest}`;
  const cab = { Accept: ACEPTA };
  let r = await fetch(url, { method: "HEAD", headers: cab });
  if (r.status === 401) {
    const desafio = r.headers.get("www-authenticate") || "";
    const reino = /realm="([^"]+)"/.exec(desafio),
      servicio = /service="([^"]+)"/.exec(desafio),
      alcance = /scope="([^"]+)"/.exec(desafio);
    if (!reino) return { ok: false, motivo: "sin desafío de autenticación" };
    const t = new URL(reino[1]);
    if (servicio) t.searchParams.set("service", servicio[1]);
    t.searchParams.set(
      "scope",
      alcance ? alcance[1] : `repository:${nombre}:pull`,
    );
    const tk = await (await fetch(t)).json();
    r = await fetch(url, {
      method: "HEAD",
      headers: {
        ...cab,
        Authorization: `Bearer ${tk.token || tk.access_token}`,
      },
    });
  }
  if (r.status === 200) return { ok: true };
  // 429 (límite de descargas anónimas de Docker Hub) y 5xx no prueban que el digest sea malo: se marcan «sin verificar».
  if (r.status === 429 || r.status >= 500)
    return { ok: false, indeterminado: true, motivo: `HTTP ${r.status}` };
  return { ok: false, motivo: `HTTP ${r.status}` };
}

async function existeCommit({ repo, sha }) {
  const r = await fetch(`https://api.github.com/repos/${repo}/commits/${sha}`, {
    method: "HEAD",
    headers: { "User-Agent": "ipam-verificar-pines" },
  });
  if (r.status === 200) return { ok: true };
  if (r.status === 403 || r.status === 429 || r.status >= 500)
    return {
      ok: false,
      indeterminado: true,
      motivo: `HTTP ${r.status} (límite de la API de GitHub?)`,
    };
  return { ok: false, motivo: `HTTP ${r.status}` };
}

(async () => {
  const solo = process.argv.includes("--solo-leer");
  const imagenes = new Map(),
    acciones = new Map(),
    latest = [];
  for (const f of listarArchivos()) {
    const e = encontrar(fs.readFileSync(f, "utf8"), path.relative(RAIZ, f));
    for (const i of e.imagenes) imagenes.set(`${i.ref}@${i.digest}`, i);
    for (const a of e.acciones) acciones.set(`${a.repo}@${a.sha}`, a);
    latest.push(...e.latest);
  }
  console.log(
    `Pines encontrados: ${imagenes.size} imágenes por digest, ${acciones.size} acciones por commit.`,
  );
  let fallos = 0,
    sinVerificar = 0;
  const estricto = process.argv.includes("--estricto");
  for (const l of latest) {
    console.log(`  ✗ ${l.archivo}: usa «${l.ref}» (etiqueta mutable)`);
    fallos++;
  }
  if (!solo) {
    for (const [clave, i] of imagenes) {
      const r = await existe(i).catch((e) => ({
        ok: false,
        motivo: e.message,
      }));
      console.log(
        `  ${r.ok ? "✓" : r.indeterminado ? "?" : "✗"} ${clave.slice(0, 95)}${r.ok ? "" : r.indeterminado ? `   → sin verificar (${r.motivo}) en ${i.archivo}` : `   → NO existe (${r.motivo}) en ${i.archivo}`}`,
      );
      if (r.indeterminado) sinVerificar++;
      else if (!r.ok) fallos++;
    }
    for (const [clave, a] of acciones) {
      const r = await existeCommit(a).catch((e) => ({
        ok: false,
        motivo: e.message,
      }));
      console.log(
        `  ${r.ok ? "✓" : r.indeterminado ? "?" : "✗"} acción ${clave}${r.ok ? "" : r.indeterminado ? `   → sin verificar (${r.motivo})` : `   → NO existe (${r.motivo}) en ${a.archivo}`}`,
      );
      if (r.indeterminado) sinVerificar++;
      else if (!r.ok) fallos++;
    }
  }
  if (estricto) fallos += sinVerificar;
  if (sinVerificar)
    console.log(
      `  (${sinVerificar} sin verificar por límites del registry: repite más tarde o con --estricto en un CI con credenciales)`,
    );
  console.log(fallos ? `Pines: FALLÓ (${fallos})` : "Pines: OK");
  process.exit(fallos ? 1 : 0);
})();
module.exports = { encontrar, separar };
