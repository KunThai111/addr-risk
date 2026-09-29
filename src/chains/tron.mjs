import { fetchJson, base58ToHex, hexToBase58, sleep, limiter } from '../util.mjs';

const TRONGRID = 'https://api.trongrid.io';
const TRONSCAN = 'https://apilist.tronscanapi.com/api';

const USDT = 'TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6t';

export const OFFICIAL_TOKENS = {
  [USDT]: 'USDT',
  TEkxiTehnzSmSe2XqrBj4w32RUN966rdz8: 'USDC',
};

export const normalize = (a) => a;
export const goplusChainId = 'tron';

const scanKey = () => process.env.TRONSCAN_API_KEY;
const gridKey = () => process.env.TRONGRID_API_KEY;
/** TronGrid 无 Key 时每个接口限 1 次/秒；Tronscan 带 Key 约 5 次/秒 */
const gridQueue = limiter(gridKey() ? 120 : 1100);
const scanQueue = limiter(220);

/** 两家接口超限时都可能返回 HTTP 200 + Error 字段，必须识别出来重试，否则会被当成“没有交易” */
async function getWithRateGuard(queue, url, headers) {
  for (let attempt = 0; attempt < 6; attempt++) {
    const res = await queue(() => fetchJson(url, { headers }));
    const err = res?.Error || (res?.code === 429 ? res.message : null);
    if (!err) return res;
    const wait = Number(String(err).match(/suspended for (\d+)\s*s/)?.[1] || 3);
    await sleep((wait + 1) * 1000);
  }
  throw new Error(`接口持续限流：${url.split('?')[0]}`);
}

function addTag(tags, addr, tag) {
  if (!addr || !tag) return;
  tags[addr] = [...new Set([...(tags[addr] || []), tag])];
}

async function fetchViaTronscan(address, max) {
  const headers = { 'TRON-PRO-API-KEY': scanKey() };
  const tags = {};
  const scam = new Set();
  const contracts = new Set();
  const transfers = [];
  const PAGE = 50;

  const collectRisk = (res) => {
    for (const [a, info] of Object.entries(res.normalAddressInfo || {})) if (info?.risk) scam.add(a);
  };

  let trc20Count = 0;
  for (let start = 0; start < max && start < 10000; start += PAGE) {
    const res = await getWithRateGuard(scanQueue, `${TRONSCAN}/token_trc20/transfers?relatedAddress=${address}&limit=${PAGE}&start=${start}`, headers);
    const list = res.token_transfers || [];
    collectRisk(res);
    for (const t of list) {
      if (t.finalResult && t.finalResult !== 'SUCCESS') continue;
      addTag(tags, t.from_address, t.from_address_tag?.from_address_tag);
      addTag(tags, t.to_address, t.to_address_tag?.to_address_tag);
      if (t.fromAddressIsContract) contracts.add(t.from_address);
      if (t.toAddressIsContract) contracts.add(t.to_address);
      transfers.push({
        hash: t.transaction_id,
        time: t.block_ts,
        from: t.from_address,
        to: t.to_address,
        value: t.quant || '0',
        symbol: t.tokenInfo?.tokenAbbr || '?',
        decimals: Number(t.tokenInfo?.tokenDecimal || 0),
        token: t.contract_address,
        tokenScam: !!t.riskTransaction,
      });
    }
    trc20Count += list.length;
    if (list.length < PAGE) break;
  }

  let nativeCount = 0;
  for (let start = 0; start < max && start < 10000; start += PAGE) {
    const res = await getWithRateGuard(scanQueue, `${TRONSCAN}/transfer?address=${address}&limit=${PAGE}&start=${start}&sort=-timestamp`, headers);
    const list = res.data || [];
    collectRisk(res);
    for (const t of list) {
      if (t.contractRet !== 'SUCCESS' || t.tokenInfo?.tokenAbbr?.toLowerCase() !== 'trx') continue;
      addTag(tags, t.transferFromAddress, t.transferFromTag);
      addTag(tags, t.transferToAddress, t.transferToTag);
      transfers.push({
        hash: t.transactionHash,
        time: t.timestamp,
        from: t.transferFromAddress,
        to: t.transferToAddress,
        value: String(t.amount),
        symbol: 'TRX',
        decimals: 6,
        token: null,
        tokenScam: !!t.riskTransaction,
      });
    }
    nativeCount += list.length;
    if (list.length < PAGE) break;
  }

  return { transfers, truncated: trc20Count >= max || nativeCount >= max, tags, scam: [...scam], contracts: [...contracts] };
}

async function gridPaged(path, max) {
  const out = [];
  let fingerprint = '';
  while (out.length < max) {
    const url = `${TRONGRID}${path}${path.includes('?') ? '&' : '?'}limit=200${fingerprint ? `&fingerprint=${fingerprint}` : ''}`;
    const res = await getWithRateGuard(gridQueue, url, gridKey() ? { 'TRON-PRO-API-KEY': gridKey() } : {});
    const list = res.data || [];
    out.push(...list);
    fingerprint = res.meta?.fingerprint;
    if (!fingerprint || list.length < 200) break;
  }
  return out.slice(0, max);
}

async function fetchViaTrongrid(address, max) {
  const trc20 = await gridPaged(`/v1/accounts/${address}/transactions/trc20?only_confirmed=true`, max);
  const native = await gridPaged(`/v1/accounts/${address}/transactions?only_confirmed=true`, max);
  const transfers = [];
  for (const t of trc20) {
    transfers.push({
      hash: t.transaction_id,
      time: t.block_timestamp,
      from: t.from,
      to: t.to,
      value: t.value,
      symbol: t.token_info?.symbol || '?',
      decimals: Number(t.token_info?.decimals || 0),
      token: t.token_info?.address || null,
    });
  }
  for (const t of native) {
    const c = t.raw_data?.contract?.[0];
    if (c?.type !== 'TransferContract' || t.ret?.[0]?.contractRet !== 'SUCCESS') continue;
    const v = c.parameter.value;
    transfers.push({
      hash: t.txID,
      time: t.block_timestamp,
      from: hexToBase58(v.owner_address),
      to: hexToBase58(v.to_address),
      value: String(v.amount),
      symbol: 'TRX',
      decimals: 6,
      token: null,
    });
  }
  return { transfers, truncated: trc20.length >= max || native.length >= max };
}

/** 有 TRONSCAN_API_KEY 时走 Tronscan（自带对手方标签和风险标记），否则走 TronGrid */
export function fetchTransfers(address, { max }) {
  return scanKey() ? fetchViaTronscan(address, max) : fetchViaTrongrid(address, max);
}

export async function onchainChecks(address) {
  let usdtFrozen = null;
  try {
    const param = base58ToHex(address).slice(2).padStart(64, '0');
    const res = await gridQueue(() =>
      fetchJson(`${TRONGRID}/wallet/triggerconstantcontract`, {
        method: 'POST',
        headers: gridKey() ? { 'TRON-PRO-API-KEY': gridKey() } : {},
        body: { owner_address: address, contract_address: USDT, function_selector: 'isBlackListed(address)', parameter: param, visible: true },
      }),
    );
    const hex = res.constant_result?.[0];
    if (hex) usdtFrozen = BigInt('0x' + hex) !== 0n;
  } catch {}
  return { chainalysisSanctioned: null, usdtFrozen };
}

const tagCache = new Map();

/**
 * 需要 TRONSCAN_API_KEY，否则返回 null。
 * label：实体名（如 "HTX 1"）；redTag：Tronscan 风险标签（如 Scam）；feedbackRisk：有用户举报
 */
export async function fetchTag(address) {
  if (!scanKey()) return null;
  if (!tagCache.has(address)) {
    tagCache.set(
      address,
      getWithRateGuard(scanQueue, `${TRONSCAN}/accountv2?address=${address}`, { 'TRON-PRO-API-KEY': scanKey() })
        .then((res) => ({
          label: [...new Set([res.addressTag, res.publicTag, res.blueTag].filter(Boolean))].join(' / '),
          redTag: res.redTag || '',
          greyTag: res.greyTag || '',
          feedbackRisk: !!res.feedbackRisk,
        }))
        .catch((e) => {
          tagCache.delete(address);
          throw e;
        }),
    );
  }
  return tagCache.get(address);
}

export function tagRiskFlags(info) {
  if (!info) return [];
  const flags = [];
  if (info.redTag) flags.push({ key: 'tronscan_red', label: `Tronscan 风险标签：${info.redTag}`, weight: 80, source: 'Tronscan' });
  if (info.greyTag) flags.push({ key: 'tronscan_grey', label: `Tronscan 可疑标签：${info.greyTag}`, weight: 40, source: 'Tronscan' });
  if (info.feedbackRisk) flags.push({ key: 'tronscan_feedback', label: 'Tronscan 有用户举报', weight: 30, source: 'Tronscan' });
  return flags;
}

/** 用 Tronscan 搜索拉取带 HTX / Huobi 标签的地址，作为种子名单 */
export async function searchTaggedAddresses(terms, tagRe) {
  if (!scanKey()) throw new Error('需要 TRONSCAN_API_KEY');
  const found = {};
  for (const term of terms) {
    for (let start = 0; start < 200; start += 10) {
      const res = await getWithRateGuard(scanQueue, `${TRONSCAN}/search/v2?term=${encodeURIComponent(term)}&type=address&start=${start}&limit=10`, {
        'TRON-PRO-API-KEY': scanKey(),
      });
      const list = res.address || [];
      for (const a of list) if (a.address_tag && tagRe.test(a.address_tag)) found[a.address] = a.address_tag;
      if (list.length < 10) break;
    }
  }
  return found;
}
