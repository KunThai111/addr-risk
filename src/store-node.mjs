import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const DATA_DIR = join(dirname(fileURLToPath(import.meta.url)), '..', 'data');
const file = (name) => join(DATA_DIR, name);
const readJson = (name) => (existsSync(file(name)) ? JSON.parse(readFileSync(file(name), 'utf8')) : {});
const writeJson = (name, obj) => writeFileSync(file(name), JSON.stringify(obj, null, 2) + '\n');

/** Node 环境的名单存储：读写仓库里的 data/*.json */
export const nodeStore = {
  seed: (chain) => readJson(`huobi-${chain}.json`).addresses || {},
  custom: (chain) => readJson('custom.json')[chain] || {},
  learned: (chain) => readJson('learned-huobi.json')[chain] || {},
  saveLearned(chain, address, record) {
    const all = readJson('learned-huobi.json');
    all[chain] = all[chain] || {};
    if (all[chain][address]) return false;
    all[chain][address] = record;
    writeJson('learned-huobi.json', all);
    return true;
  },
  addCustom(chain, address, label) {
    const all = readJson('custom.json');
    all[chain] = { ...(all[chain] || {}), [address]: label };
    writeJson('custom.json', all);
  },
  writeSeed(chain, source, addresses) {
    writeJson(`huobi-${chain}.json`, { source, updatedAt: new Date().toISOString().slice(0, 10), addresses });
  },
};
