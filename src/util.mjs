import { createHash } from 'node:crypto';

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** 串行执行，相邻两次调用至少间隔 gapMs */
export function limiter(gapMs) {
  let chain = Promise.resolve();
  return (fn) => {
    const run = chain.then(fn);
    chain = run.catch(() => {}).then(() => sleep(gapMs));
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
const sha256 = (buf) => createHash('sha256').update(buf).digest();

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
  const payload = Buffer.from(hex, 'hex');
  const full = Buffer.concat([payload, sha256(sha256(payload)).subarray(0, 4)]);
  let n = BigInt('0x' + full.toString('hex'));
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
