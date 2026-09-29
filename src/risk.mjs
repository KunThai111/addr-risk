import { fetchJson, sleep } from './util.mjs';

const GOPLUS = 'https://api.gopluslabs.io/api/v1/address_security';

const FLAG_RULES = {
  sanctioned: [100, '制裁名单'],
  stealing_attack: [90, '盗币攻击'],
  money_laundering: [90, '洗钱'],
  cybercrime: [80, '网络犯罪'],
  darkweb_transactions: [80, '暗网交易'],
  financial_crime: [70, '金融犯罪'],
  phishing_activities: [70, '钓鱼'],
  blackmail_activities: [70, '勒索'],
  mixer: [60, '混币器'],
  honeypot_related_address: [50, '貔貅盘关联'],
  number_of_malicious_contracts_created: [50, '创建过恶意合约'],
  fake_kyc: [40, '虚假 KYC'],
  blacklist_doubt: [40, '疑似黑名单'],
  malicious_mining_activities: [40, '恶意挖矿'],
  fake_token: [30, '假代币'],
  fake_standard_interface: [20, '伪造标准接口'],
  gas_abuse: [20, 'Gas 滥用'],
  reinit: [20, '合约重初始化'],
};

export async function goplusCheck(address, chainId) {
  const res = await fetchJson(`${GOPLUS}/${address}?chain_id=${chainId}`);
  if (res.code !== 1 || !res.result) throw new Error(`GoPlus 返回异常: ${res.message}`);
  const flags = [];
  for (const [key, [weight, label]] of Object.entries(FLAG_RULES)) {
    const v = res.result[key];
    if (v && v !== '0') flags.push({ key, label, weight, source: 'GoPlus' });
  }
  return { flags, dataSource: res.result.data_source || '' };
}

export function scoreFromFlags(flags) {
  if (!flags.length) return 0;
  const max = Math.max(...flags.map((f) => f.weight));
  return Math.min(100, max + 5 * (flags.length - 1));
}

export function riskLevel(score) {
  if (score >= 80) return '严重';
  if (score >= 50) return '高';
  if (score >= 20) return '中';
  return '低';
}

/** 对交互最频繁的 N 个对手方逐个做 GoPlus 检查 */
export async function checkCounterparties(counterparties, chainId, limit) {
  const hits = [];
  for (const cp of counterparties.slice(0, limit)) {
    try {
      const { flags } = await goplusCheck(cp.address, chainId);
      if (flags.length) hits.push({ ...cp, flags, score: scoreFromFlags(flags) });
    } catch {}
    await sleep(500);
  }
  return hits;
}
