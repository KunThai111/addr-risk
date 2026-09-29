import { fetchJson } from './util.mjs';

/**
 * 名单存储由运行环境注入：Node 用 store-node.mjs（读写 data/），浏览器用 web/store-browser.mjs（仓库 JSON + localStorage）。
 * 接口：seed(chain) / custom(chain) / learned(chain) 返回 { 地址: 值 }；
 *       saveLearned(chain, addr, record) → 是否新增；addCustom(chain, addr, label)；writeSeed(chain, source, addresses)
 */
let store = null;
export function useStore(impl) {
  store = impl;
}
function requireStore() {
  if (!store) throw new Error('名单存储未初始化（useStore）');
  return store;
}

const ETH_LABELS_URL =
  'https://raw.githubusercontent.com/brianleect/etherscan-labels/main/data/etherscan/combined/combinedAccountLabels.json';

export const HUOBI_TAG_RE = /huobi|htx|火币/i;

const norm = (chain, a) => (chain === 'eth' ? a.toLowerCase() : a);

/** 返回 { [address]: label }，合并内置名单、用户确认和行为识别学到的地址 */
export function loadHuobiLabels(chain) {
  const s = requireStore();
  const learned = Object.fromEntries(Object.entries(s.learned(chain)).map(([a, v]) => [a, `${v.label}（行为识别）`]));
  const merged = { ...learned, ...s.seed(chain), ...s.custom(chain) };
  return Object.fromEntries(Object.entries(merged).map(([a, l]) => [norm(chain, a), l]));
}

export function loadLearned(chain) {
  return requireStore().learned(chain);
}

/** 行为识别出的高置信度火币地址落盘，下次直接命中 */
export function saveLearned(chain, address, record) {
  return requireStore().saveLearned(chain, address, { ...record, learnedAt: new Date().toISOString().slice(0, 19) });
}

/** 用户确认的火币地址 */
export function addCustom(chain, address, label) {
  requireStore().addCustom(chain, norm(chain, address), label);
}

export async function updateEthLabels() {
  const all = await fetchJson(ETH_LABELS_URL, { timeout: 60000 });
  const addresses = {};
  for (const [addr, info] of Object.entries(all)) {
    const name = info.name || '';
    const isHuobiWallet = (info.labels || []).includes('huobi') || /^(huobi|htx)\b/i.test(name);
    if (isHuobiWallet && !/donation/i.test(name)) addresses[addr.toLowerCase()] = name;
  }
  requireStore().writeSeed('eth', ETH_LABELS_URL, addresses);
  return Object.keys(addresses).length;
}

export async function updateTronLabels(searchTaggedAddresses) {
  const found = await searchTaggedAddresses(['HTX', 'Huobi'], HUOBI_TAG_RE);
  const addresses = { ...requireStore().seed('tron'), ...found };
  requireStore().writeSeed('tron', 'Tronscan search/v2（标签含 HTX / Huobi）', addresses);
  return Object.keys(addresses).length;
}
