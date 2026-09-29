/**
 * 浏览器环境的名单存储：种子名单和共享学习名单来自仓库里的 data/*.json（只读），
 * 访问者自己确认 / 学到的地址存在本机 localStorage。
 */
const LS_KEY = 'addr-risk:labels';

async function loadJson(base, name) {
  try {
    const res = await fetch(new URL(name, base), { cache: 'no-cache' });
    return res.ok ? await res.json() : {};
  } catch {
    return {};
  }
}

export async function createBrowserStore(base) {
  const [eth, tron, learnedShared, customShared] = await Promise.all([
    loadJson(base, 'huobi-eth.json'),
    loadJson(base, 'huobi-tron.json'),
    loadJson(base, 'learned-huobi.json'),
    loadJson(base, 'custom.json'),
  ]);
  const seeds = { eth: eth.addresses || {}, tron: tron.addresses || {} };
  const local = JSON.parse(localStorage.getItem(LS_KEY) || '{"learned":{},"custom":{}}');
  const persist = () => localStorage.setItem(LS_KEY, JSON.stringify(local));

  return {
    seed: (chain) => seeds[chain] || {},
    custom: (chain) => ({ ...(customShared[chain] || {}), ...(local.custom[chain] || {}) }),
    learned: (chain) => ({ ...(learnedShared[chain] || {}), ...(local.learned[chain] || {}) }),
    saveLearned(chain, address, record) {
      if (learnedShared[chain]?.[address] || local.learned[chain]?.[address]) return false;
      local.learned[chain] = { ...(local.learned[chain] || {}), [address]: record };
      persist();
      return true;
    },
    addCustom(chain, address, label) {
      local.custom[chain] = { ...(local.custom[chain] || {}), [address]: label };
      persist();
    },
    writeSeed() {
      throw new Error('浏览器里不能更新种子名单，请用命令行 npm run update-labels');
    },
    /** 导出本机学到 / 确认的地址，方便合并回仓库 */
    exportLocal: () => JSON.parse(JSON.stringify(local)),
  };
}
