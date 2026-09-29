import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { fetchJson } from './util.mjs';

const DATA_DIR = join(dirname(fileURLToPath(import.meta.url)), '..', 'data');
const LEARNED_FILE = join(DATA_DIR, 'learned-huobi.json');
const ETH_LABELS_URL =
  'https://raw.githubusercontent.com/brianleect/etherscan-labels/main/data/etherscan/combined/combinedAccountLabels.json';

export const HUOBI_TAG_RE = /huobi|htx|火币/i;

const readJson = (file) => (existsSync(file) ? JSON.parse(readFileSync(file, 'utf8')) : {});
const norm = (chain, a) => (chain === 'eth' ? a.toLowerCase() : a);

/** 返回 { [address]: label }，合并内置名单、custom.json 和行为识别学到的地址 */
export function loadHuobiLabels(chain) {
  const builtin = readJson(join(DATA_DIR, `huobi-${chain}.json`)).addresses || {};
  const custom = readJson(join(DATA_DIR, 'custom.json'))[chain] || {};
  const learned = Object.fromEntries(Object.entries(loadLearned(chain)).map(([a, v]) => [a, `${v.label}（行为识别）`]));
  const merged = { ...learned, ...builtin, ...custom };
  return Object.fromEntries(Object.entries(merged).map(([a, l]) => [norm(chain, a), l]));
}

export function loadLearned(chain) {
  return readJson(LEARNED_FILE)[chain] || {};
}

/** 行为识别出的高置信度火币地址落盘，下次直接命中 */
export function saveLearned(chain, address, record) {
  const all = readJson(LEARNED_FILE);
  all[chain] = all[chain] || {};
  if (all[chain][address]) return false;
  all[chain][address] = { ...record, learnedAt: new Date().toISOString().slice(0, 19) };
  writeFileSync(LEARNED_FILE, JSON.stringify(all, null, 2) + '\n');
  return true;
}

/** 用户确认的火币地址写进 custom.json */
export function addCustom(chain, address, label) {
  const file = join(DATA_DIR, 'custom.json');
  const all = readJson(file);
  all[chain] = { ...(all[chain] || {}), [norm(chain, address)]: label };
  writeFileSync(file, JSON.stringify(all, null, 2) + '\n');
}

export async function updateEthLabels() {
  const all = await fetchJson(ETH_LABELS_URL, { timeout: 60000 });
  const addresses = {};
  for (const [addr, info] of Object.entries(all)) {
    const name = info.name || '';
    const isHuobiWallet = (info.labels || []).includes('huobi') || /^(huobi|htx)\b/i.test(name);
    if (isHuobiWallet && !/donation/i.test(name)) addresses[addr.toLowerCase()] = name;
  }
  writeSeed('eth', ETH_LABELS_URL, addresses);
  return Object.keys(addresses).length;
}

export async function updateTronLabels(searchTaggedAddresses) {
  const found = await searchTaggedAddresses(['HTX', 'Huobi'], HUOBI_TAG_RE);
  const prev = readJson(join(DATA_DIR, 'huobi-tron.json')).addresses || {};
  const addresses = { ...prev, ...found };
  writeSeed('tron', 'Tronscan search/v2（标签含 HTX / Huobi）', addresses);
  return Object.keys(addresses).length;
}

function writeSeed(chain, source, addresses) {
  const out = { source, updatedAt: new Date().toISOString().slice(0, 10), addresses };
  writeFileSync(join(DATA_DIR, `huobi-${chain}.json`), JSON.stringify(out, null, 2) + '\n');
}
