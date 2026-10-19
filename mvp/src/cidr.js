// Aritmética CIDR IPv4 (sin dependencias). Solo IPv4.
function ip2n(s) {
  const p = String(s).split('.');
  if (p.length !== 4) return null;
  let n = 0;
  for (const x of p) { if (!/^\d{1,3}$/.test(x) || +x > 255) return null; n = n * 256 + +x; }
  return n;
}
const n2ip = (n) => [Math.floor(n / 16777216), Math.floor(n / 65536) % 256, Math.floor(n / 256) % 256, n % 256].join('.');

function parse(c) {
  const m = /^(\d+\.\d+\.\d+\.\d+)\/(\d{1,2})$/.exec(String(c || '').trim());
  if (!m) return null;
  const ip = ip2n(m[1]), len = +m[2];
  if (ip === null || len > 32) return null;
  const size = 2 ** (32 - len);
  return { ip, len, size, start: ip, end: ip + size - 1, aligned: ip % size === 0 };
}
const overlap = (a, b) => a.start <= b.end && b.start <= a.end;

// Primeros `max` bloques /len alineados, dentro del pool y fuera de los ocupados (lista de CIDR).
function libres(poolCidr, ocupadosCidr, len, max = 3) {
  const p = parse(poolCidr);
  const size = 2 ** (32 - len), out = [];
  if (!p || len < p.len || len > 32) return out;
  const ocup = ocupadosCidr.map(parse).sort((x, y) => x.start - y.start);
  let cur = p.start;
  for (const o of ocup) {
    if (o.end < cur) continue;
    while (out.length < max && cur + size - 1 < o.start && cur + size - 1 <= p.end) { out.push(`${n2ip(cur)}/${len}`); cur += size; }
    if (out.length >= max) return out;
    cur = Math.max(cur, Math.ceil((o.end + 1) / size) * size);
  }
  while (out.length < max && cur + size - 1 <= p.end) { out.push(`${n2ip(cur)}/${len}`); cur += size; }
  return out;
}
module.exports = { parse, overlap, libres, n2ip };
