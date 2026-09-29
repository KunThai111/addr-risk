import { cfg } from '../config.mjs';
import { fetchJson, sleep } from '../util.mjs';

const BLOCKSCOUT = 'https://eth.blockscout.com/api/v2';
const RPC = () => cfg('ETH_RPC_URL') || 'https://ethereum-rpc.publicnode.com';

const USDT = '0xdac17f958d2ee523a2206206994597c13d831ec7';
const CHAINALYSIS_ORACLE = '0x40C57923924B5c5c5455c48D93317139ADDaC8fb';

export const OFFICIAL_TOKENS = {
  [USDT]: 'USDT',
  '0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48': 'USDC',
};

export const normalize = (a) => a.toLowerCase();

async function paged(path, max) {
  const out = [];
  let next = null;
  while (out.length < max) {
    const qs = new URLSearchParams(next || {});
    const res = await fetchJson(`${BLOCKSCOUT}${path}${path.includes('?') ? '&' : '?'}${qs}`);
    out.push(...(res.items || []));
    next = res.next_page_params;
    if (!next) break;
    await sleep(200);
  }
  return out.slice(0, max);
}

/** Blockscout 会在地址对象上附带实体标签（如 "HTX: Hot Wallet"）和 is_scam 标记 */
function collectMeta(party, tags, scam, contracts) {
  if (!party?.hash) return null;
  if (party.is_contract) contracts.add(normalize(party.hash));
  const addr = normalize(party.hash);
  const names = (party.metadata?.tags || [])
    .filter((t) => t.tagType === 'name')
    .flatMap((t) => [t.name, t.meta?.main_entity])
    .filter(Boolean);
  if (party.name) names.push(party.name);
  if (names.length) tags[addr] = [...new Set([...(tags[addr] || []), ...names])];
  if (party.is_scam) scam.add(addr);
  return addr;
}

export async function fetchTransfers(address, { max }) {
  const native = await paged(`/addresses/${address}/transactions`, max);
  const tokens = await paged(`/addresses/${address}/token-transfers?type=ERC-20`, max);
  const tags = {};
  const scam = new Set();
  const contracts = new Set();
  const transfers = [];
  for (const t of native) {
    if (t.status !== 'ok' || !t.to || !t.timestamp) continue;
    transfers.push({
      hash: t.hash,
      time: Date.parse(t.timestamp),
      from: collectMeta(t.from, tags, scam, contracts),
      to: collectMeta(t.to, tags, scam, contracts),
      value: t.value,
      symbol: 'ETH',
      decimals: 18,
      token: null,
    });
  }
  for (const t of tokens) {
    transfers.push({
      hash: t.transaction_hash,
      time: Date.parse(t.timestamp),
      from: collectMeta(t.from, tags, scam, contracts),
      to: collectMeta(t.to, tags, scam, contracts),
      value: t.total?.value || '0',
      symbol: t.token?.symbol || '?',
      decimals: Number(t.total?.decimals ?? t.token?.decimals ?? 0),
      token: normalize(t.token?.address_hash || t.token?.address || ''),
      tokenScam: t.token?.reputation === 'scam',
    });
  }
  return { transfers, truncated: native.length >= max || tokens.length >= max, tags, scam: [...scam], contracts: [...contracts] };
}

async function ethCallBool(to, selector, address) {
  const data = selector + address.toLowerCase().replace(/^0x/, '').padStart(64, '0');
  const res = await fetchJson(RPC(), {
    method: 'POST',
    body: { jsonrpc: '2.0', id: 1, method: 'eth_call', params: [{ to, data }, 'latest'] },
  });
  if (res.error) throw new Error(res.error.message);
  return BigInt(res.result || '0x0') !== 0n;
}

export async function onchainChecks(address) {
  const [sanctioned, usdtFrozen] = await Promise.allSettled([
    ethCallBool(CHAINALYSIS_ORACLE, '0xdf592f7d', address),
    ethCallBool(USDT, '0xe47d6060', address),
  ]);
  return {
    chainalysisSanctioned: sanctioned.status === 'fulfilled' ? sanctioned.value : null,
    usdtFrozen: usdtFrozen.status === 'fulfilled' ? usdtFrozen.value : null,
  };
}

export const goplusChainId = '1';
