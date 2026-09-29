export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** 串行执行，相邻两次调用至少间隔 gapMs（可传函数，按当前配置动态取值） */
export function limiter(gapMs) {
  let chain = Promise.resolve();
  return (fn) => {
    const run = chain.then(fn);
    chain = run.catch(() => {}).then(() => sleep(typeof gapMs === 'function' ? gapMs() : gapMs));
    return run;
  };
}

export async function fetchJson(url, { method = 'GET', headers = {}, body, retries = 5, timeout = 30000 } = {}) {
  let lastErr;
  for (let i = 0; i <= retries; i++) {
    try {
      const res = await fetch(url, {
        method,
        headers: { accept: 'application/json', ...(body ? { 'content-type': 'application/json' } : {}), ...headers },
        body: body ? JSON.stringify(body) : undefined,
        signal: AbortSignal.timeout(timeout),
      });
      if (res.status === 429 || res.status >= 500) throw new Error(`HTTP ${res.status}`);
      const text = await res.text();
      if (!res.ok) throw Object.assign(new Error(`HTTP ${res.status}: ${text.slice(0, 200)}`), { fatal: true });
      return JSON.parse(text);
    } catch (e) {
      lastErr = e;
      if (e.fatal || i === retries) break;
      await sleep(1500 * 2 ** i);
    }
  }
  throw lastErr;
}

export function detectChain(address) {
  if (/^0x[0-9a-fA-F]{40}$/.test(address)) return 'eth';
  if (/^T[1-9A-HJ-NP-Za-km-z]{33}$/.test(address)) return 'tron';
  return null;
}

const B58 = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';

/** 纯 JS 的 SHA-256（同步），浏览器和 Node 通用，只用于 TRON 地址校验和 */
const K256 = new Uint32Array([
  0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5, 0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3,
  0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174, 0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
  0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967, 0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13,
  0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85, 0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
  0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3, 0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208,
  0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2,
]);
function sha256(bytes) {
  const len = bytes.length;
  const padded = new Uint8Array(((len + 9 + 63) >> 6) << 6);
  padded.set(bytes);
  padded[len] = 0x80;
  const bits = BigInt(len) * 8n;
  for (let i = 0; i < 8; i++) padded[padded.length - 1 - i] = Number((bits >> BigInt(8 * i)) & 0xffn);
  const h = new Uint32Array([0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a, 0x510e527f, 0x9b05688c, 0x1f83d9ab, 0x5be0cd19]);
  const w = new Uint32Array(64);
  const rotr = (x, n) => (x >>> n) | (x << (32 - n));
  for (let off = 0; off < padded.length; off += 64) {
    for (let i = 0; i < 16; i++) w[i] = (padded[off + 4 * i] << 24) | (padded[off + 4 * i + 1] << 16) | (padded[off + 4 * i + 2] << 8) | padded[off + 4 * i + 3];
    for (let i = 16; i < 64; i++) {
      const s0 = rotr(w[i - 15], 7) ^ rotr(w[i - 15], 18) ^ (w[i - 15] >>> 3);
      const s1 = rotr(w[i - 2], 17) ^ rotr(w[i - 2], 19) ^ (w[i - 2] >>> 10);
      w[i] = (w[i - 16] + s0 + w[i - 7] + s1) | 0;
    }
    let [a, b, c, d, e, f, g, hh] = h;
    for (let i = 0; i < 64; i++) {
      const t1 = (hh + (rotr(e, 6) ^ rotr(e, 11) ^ rotr(e, 25)) + ((e & f) ^ (~e & g)) + K256[i] + w[i]) | 0;
      const t2 = ((rotr(a, 2) ^ rotr(a, 13) ^ rotr(a, 22)) + ((a & b) ^ (a & c) ^ (b & c))) | 0;
      hh = g; g = f; f = e; e = (d + t1) | 0; d = c; c = b; b = a; a = (t1 + t2) | 0;
    }
    h[0] += a; h[1] += b; h[2] += c; h[3] += d; h[4] += e; h[5] += f; h[6] += g; h[7] += hh;
  }
  const out = new Uint8Array(32);
  for (let i = 0; i < 8; i++) for (let j = 0; j < 4; j++) out[4 * i + j] = (h[i] >>> (24 - 8 * j)) & 0xff;
  return out;
}

const hexToBytes = (hex) => Uint8Array.from(hex.match(/../g) || [], (b) => parseInt(b, 16));
const bytesToHex = (bytes) => [...bytes].map((b) => b.toString(16).padStart(2, '0')).join('');

export function base58ToHex(addr) {
  let n = 0n;
  for (const c of addr) {
    const i = B58.indexOf(c);
    if (i < 0) throw new Error(`非法 base58 字符: ${c}`);
    n = n * 58n + BigInt(i);
  }
  let hex = n.toString(16);
  if (hex.length % 2) hex = '0' + hex;
  return hex.slice(0, -8);
}

export function hexToBase58(hex) {
  hex = hex.replace(/^0x/, '');
  if (hex.length === 40) hex = '41' + hex;
  const payload = hexToBytes(hex);
  const full = new Uint8Array(payload.length + 4);
  full.set(payload);
  full.set(sha256(sha256(payload)).subarray(0, 4), payload.length);
  let n = BigInt('0x' + bytesToHex(full));
  let out = '';
  while (n > 0n) {
    out = B58[Number(n % 58n)] + out;
    n /= 58n;
  }
  for (const b of full) {
    if (b !== 0) break;
    out = '1' + out;
  }
  return out;
}

export function formatAmount(raw, decimals) {
  const v = BigInt(raw || 0);
  const d = BigInt(10) ** BigInt(decimals || 0);
  const int = v / d;
  const fracFull = (v % d).toString().padStart(Number(decimals || 0), '0');
  const keep = int === 0n ? Math.min(fracFull.length, (fracFull.match(/^0*/)[0].length || 0) + 3) : 4;
  const frac = fracFull.slice(0, keep).replace(/0+$/, '');
  return frac ? `${int}.${frac}` : `${int}`;
}

/** 冒充稳定币的假币：符号含非 ASCII 形近字符（ÚЅDС、ꓴSDC），或形如 USDT/USDC/U5DC 但不是官方合约 */
export function isFakeStable(t, officialTokens) {
  if (!t.token || officialTokens[t.token]) return false;
  const sym = t.symbol || '';
  return /[^\x20-\x7e]/.test(sym) || /^[uv][s5$]d[ct7]\+?$/i.test(sym.trim());
}

/** 有效资金转账 = 非投毒/假币 + 原生币或官方稳定币 + 非粉尘（< 0.0001 个） */
export function makeTxFilters(officialTokens) {
  const isPoison = (t) => BigInt(t.value || 0) === 0n || !!t.tokenScam || isFakeStable(t, officialTokens);
  const isMainAsset = (t) => !t.token || !!officialTokens[t.token];
  const isDust = (t) => BigInt(t.value || 0) < 10n ** BigInt(Math.max(0, t.decimals - 4));
  return { isPoison, isMainAsset, isDust, isValueTx: (t) => !isPoison(t) && isMainAsset(t) && !isDust(t) };
}

export const fmtTime = (ms) => (ms ? new Date(ms).toISOString().replace('T', ' ').slice(0, 19) : '-');
