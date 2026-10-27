// CI portable: la lógica vive en el repositorio, no en el proveedor. Estas pruebas hacen cumplir esa regla.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const RAIZ = path.join(__dirname, '..', '..');
const leer = (r) => fs.readFileSync(path.join(RAIZ, r), 'utf8');
const entorno = (vars) => {
  const r = spawnSync('sh', [path.join(RAIZ, 'scripts/ci/entorno.sh'), '--mostrar'], {
    env: { PATH: process.env.PATH, HOME: process.env.HOME, ...vars },
    encoding: 'utf8',
  });
  assert.equal(r.status, 0, r.stderr);
  return Object.fromEntries(
    r.stdout
      .trim()
      .split('\n')
      .map((l) => l.split(/=(.*)/s).slice(0, 2)),
  );
};

test('entorno.sh traduce GitHub y GitLab a las MISMAS variables neutras', () => {
  const gh = entorno({
    GITHUB_ACTIONS: 'true',
    GITHUB_SHA: 'abcdef0123456789',
    GITHUB_REF_NAME: 'feat/x',
    GITHUB_EVENT_NAME: 'push',
    GITHUB_REPOSITORY: 'Org/Ipam',
    GITHUB_REPOSITORY_OWNER: 'Org',
    GITHUB_ACTOR: 'yo',
    IPAM_RAMA_POR_DEFECTO: 'trunk',
  });
  const gl = entorno({
    GITLAB_CI: 'true',
    CI_COMMIT_SHA: 'abcdef0123456789',
    CI_COMMIT_BRANCH: 'feat/x',
    CI_COMMIT_REF_NAME: 'feat/x',
    CI_DEFAULT_BRANCH: 'trunk',
    CI_REGISTRY: 'registry.gitlab.com',
    CI_REGISTRY_IMAGE: 'registry.gitlab.com/org/ipam',
    CI_REGISTRY_USER: 'yo',
  });
  assert.deepEqual(Object.keys(gh).sort(), Object.keys(gl).sort(), 'ambos definen las mismas variables');
  for (const k of [
    'IPAM_SHA',
    'IPAM_SHA_CORTO',
    'IPAM_RAMA',
    'IPAM_RAMA_POR_DEFECTO',
    'IPAM_ES_RAMA_PRINCIPAL',
    'IPAM_ES_SOLICITUD',
    'IPAM_ES_TAG',
    'IPAM_VERSION',
    'IPAM_REGISTRY_USUARIO',
  ])
    assert.equal(gh[k], gl[k], k);
  assert.deepEqual(
    { p: gh.IPAM_PROVEEDOR, d: gh.IPAM_RAMA_POR_DEFECTO, reg: gh.IPAM_REGISTRY, img: gh.IPAM_IMAGEN },
    { p: 'github', d: 'trunk', reg: 'ghcr.io/org', img: 'ghcr.io/org/ipam' },
  );
  assert.deepEqual(
    { p: gl.IPAM_PROVEEDOR, reg: gl.IPAM_REGISTRY, img: gl.IPAM_IMAGEN },
    { p: 'gitlab', reg: 'registry.gitlab.com', img: 'registry.gitlab.com/org/ipam' },
  );
});

test('la rama por defecto no se escribe a fuego (main o master): sale de la variable neutra', () => {
  for (const rama of ['main', 'master', 'trunk', 'desarrollo']) {
    const e = entorno({ GITLAB_CI: 'true', CI_COMMIT_SHA: 'abc12345', CI_COMMIT_BRANCH: rama, CI_DEFAULT_BRANCH: rama });
    assert.equal(e.IPAM_ES_RAMA_PRINCIPAL, 'true', rama);
  }
  assert.equal(
    entorno({ GITLAB_CI: 'true', CI_COMMIT_SHA: 'abc12345', CI_COMMIT_BRANCH: 'feat/x', CI_DEFAULT_BRANCH: 'master' }).IPAM_ES_RAMA_PRINCIPAL,
    'false',
  );
  const mr = entorno({
    GITLAB_CI: 'true',
    CI_COMMIT_SHA: 'abc12345',
    CI_PIPELINE_SOURCE: 'merge_request_event',
    CI_MERGE_REQUEST_SOURCE_BRANCH_NAME: 'feat/y',
    CI_DEFAULT_BRANCH: 'main',
  });
  assert.deepEqual({ s: mr.IPAM_ES_SOLICITUD, r: mr.IPAM_RAMA }, { s: 'true', r: 'feat/y' });
});

test('versión: la etiqueta vX.Y.Z (sin la v) en un tag; la de package.json con el SHA corto en el resto; las IPAM_* dadas mandan', () => {
  assert.equal(entorno({ GITLAB_CI: 'true', CI_COMMIT_SHA: 'abc12345', CI_COMMIT_TAG: 'v1.4.2', CI_DEFAULT_BRANCH: 'main' }).IPAM_VERSION, '1.4.2');
  assert.equal(
    entorno({
      GITHUB_ACTIONS: 'true',
      GITHUB_SHA: 'abc12345def',
      GITHUB_REF_TYPE: 'tag',
      GITHUB_REF_NAME: 'v2.0.0',
      GITHUB_REPOSITORY: 'o/r',
      GITHUB_REPOSITORY_OWNER: 'o',
    }).IPAM_VERSION,
    '2.0.0',
  );
  const version = JSON.parse(leer('mvp/package.json')).version;
  assert.equal(
    entorno({ GITLAB_CI: 'true', CI_COMMIT_SHA: 'abc12345def', CI_COMMIT_BRANCH: 'x', CI_DEFAULT_BRANCH: 'main' }).IPAM_VERSION,
    `${version}-abc12345`,
  );
  assert.equal(
    entorno({
      GITLAB_CI: 'true',
      CI_COMMIT_SHA: 'abc12345',
      CI_DEFAULT_BRANCH: 'main',
      IPAM_REGISTRY: 'mi.registry.interno',
      IPAM_IMAGEN: 'mi.registry.interno/ipam',
    }).IPAM_IMAGEN,
    'mi.registry.interno/ipam',
  );
  assert.equal(version, '0.3.0');
});

test('entorno.sh nunca imprime la clave del registry', () => {
  const r = spawnSync('sh', [path.join(RAIZ, 'scripts/ci/entorno.sh'), '--mostrar'], {
    env: { PATH: process.env.PATH, GITLAB_CI: 'true', CI_COMMIT_SHA: 'a', CI_REGISTRY_PASSWORD: 'SECRETO-NO-IMPRIMIR', CI_DEFAULT_BRANCH: 'main' },
    encoding: 'utf8',
  });
  assert.ok(!r.stdout.includes('SECRETO-NO-IMPRIMIR') && !r.stderr.includes('SECRETO-NO-IMPRIMIR'));
});

test('los scripts y el Makefile NO usan variables de un proveedor de CI (solo entorno.sh las traduce)', () => {
  const archivos = fs
    .readdirSync(path.join(RAIZ, 'scripts/ci'))
    .filter((f) => f !== 'entorno.sh' && !f.endsWith('.js'))
    .map((f) => `scripts/ci/${f}`)
    .concat('Makefile', 'scripts/verificar-portabilidad.sh');
  assert.ok(archivos.length >= 12);
  for (const f of archivos)
    assert.doesNotMatch(
      leer(f),
      /\bGITHUB_[A-Z_]+|\bCI_(COMMIT|PIPELINE|REGISTRY|DEFAULT|MERGE|JOB|PROJECT)[A-Z_]*|\bGITLAB_CI\b/,
      `${f} usa variables de un proveedor de CI`,
    );
});

test('los pipelines son envoltorios finos: llaman a make o a scripts/ci y mantienen los mismos trabajos y el mismo orden en GitHub y GitLab', () => {
  const gh = leer('.github/workflows/ci.yml');
  const gl = leer('.gitlab-ci.yml');
  for (const [nombre, txt] of [
    ['ci.yml', gh],
    ['.gitlab-ci.yml', gl],
  ]) {
    for (const objetivo of [
      'make portabilidad',
      'make lint',
      'make helm-check',
      'make alertas',
      'make test',
      'make esquema',
      'make cobertura',
      'make sbom',
      'make docs',
    ])
      assert.match(txt, new RegExp(objetivo), `${nombre} no llama a «${objetivo}»`);
    assert.match(txt, /compose-check/, nombre);
    assert.match(txt, /e2e/, nombre);
    assert.match(txt, /escanear|make scan/, nombre);
    assert.doesNotMatch(txt, /:latest\b/, `${nombre} usa la etiqueta latest`);
  }
  // Orden de etapas / dependencias: validar → probar → escanear → construir → liberar (+ «poc»: trabajos manuales o programados del POC).
  assert.match(gl, /stages: \[validar, probar, escanear, construir, liberar, poc\]/);
  assert.match(gh, /needs: validar/);
  assert.match(gh, /needs: \[probar, escanear\]/);
  // La rama por defecto no está escrita a fuego en ninguno de los dos.
  assert.doesNotMatch(gl, /\$CI_COMMIT_BRANCH == ["']?(main|master)/);
  assert.doesNotMatch(gh, /branches: \[(main|master)/);
  assert.match(gh, /default_branch/);
  assert.match(gl, /CI_DEFAULT_BRANCH/);
  // PostgreSQL 14 a 17 en los dos.
  for (const v of [14, 15, 16, 17]) {
    assert.match(gh, new RegExp(`postgres:${v}-alpine@sha256`));
    assert.match(gl, new RegExp(`postgres:${v}-alpine@sha256`));
  }
});

test('toda acción de GitHub y toda imagen de CI está fijada por commit o digest', () => {
  for (const f of fs.readdirSync(path.join(RAIZ, '.github/workflows'))) {
    for (const m of leer(`.github/workflows/${f}`).matchAll(/uses:\s*(\S+)/g))
      assert.match(m[1], /@[0-9a-f]{40}$/, `${f}: «${m[1]}» no está fijada por commit`);
  }
  for (const m of leer('.gitlab-ci.yml').matchAll(/(?:image:|name:)\s*'?([a-z0-9./_-]+(?::[\w.-]+)?)(@sha256:[0-9a-f]{64})?'?/gi)) {
    if (/^(node|postgres|docker|mcr|ghcr|semgrep|aquasec|bridgecrew|gcr)/.test(m[1]) && m[0].includes('image')) assert.ok(m[2], `imagen sin digest: ${m[1]}`);
  }
});

test('Renovate (no Dependabot) está configurado y fija por digest', () => {
  const r = JSON.parse(leer('renovate.json'));
  assert.ok(r.extends.includes('helpers:pinGitHubActionDigests') && r.extends.includes('docker:pinDigests'));
  assert.ok(!fs.existsSync(path.join(RAIZ, '.github/dependabot.yml')));
});
