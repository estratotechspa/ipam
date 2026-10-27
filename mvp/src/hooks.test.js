// Los hooks y verificaciones de Git: Conventional Commits y convención de ramas.
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { verificar } = require('../../scripts/hooks/verificar-commit');

const RAMA = path.join(__dirname, '..', '..', 'scripts', 'hooks', 'verificar-rama.sh');

test('Conventional Commits: acepta los tipos válidos, con ámbito y con cambio incompatible (!)', () => {
  for (const m of [
    'feat: agrega algo',
    'fix(reservas): corrige la expiración',
    'docs(adr): 0010',
    'refactor!: cambia el contrato',
    'chore(deps): sube express',
    'feat(fase-7): /metrics en formato Prometheus\n\ncuerpo largo',
    'Merge pull request #12 from x/y',
    'Revert "feat: x"',
    'fixup! feat: x',
  ]) {
    assert.equal(verificar(m).ok, true, m);
  }
});

test('Conventional Commits: rechaza mensajes sin tipo, con tipo desconocido, sin descripción o demasiado largos', () => {
  for (const m of [
    '',
    'agregué cosas',
    'Feat: mayúscula',
    'feature: tipo raro',
    'feat:sin espacio',
    'feat: ',
    'feat(Ámbito): x',
    `feat: ${'x'.repeat(120)}`,
    'wip',
  ]) {
    const r = verificar(m);
    assert.equal(r.ok, false, `debería rechazar «${m.slice(0, 30)}»`);
    assert.ok(r.motivo);
  }
});

test('convención de ramas: tipo/descripcion o main/master', () => {
  for (const ok of ['feat/ipam-agentes-completo', 'fix/expiracion', 'docs/adr-0010', 'poc/cloudflare-tunnel', 'main', 'master', 'renovate/express-5.x']) {
    assert.equal(spawnSync('sh', [RAMA, ok]).status, 0, ok);
  }
  for (const mal of ['MiRama', 'feature/x', 'feat/', 'feat/Mayuscula', 'x']) {
    const r = spawnSync('sh', [RAMA, mal], { encoding: 'utf8' });
    assert.equal(r.status, 1, mal);
    assert.match(r.stderr, /convención/);
  }
});
