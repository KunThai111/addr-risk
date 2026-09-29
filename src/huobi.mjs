import { cfg } from './config.mjs';
/**
 * 火币地址行为识别。
 *
 * 交易所资金链路：用户 → 充值地址 →（归集）→ 归集钱包 → 热/冷钱包 → 出金钱包 → 用户。
 * 标签只能覆盖热/冷钱包这类公开地址，充值地址和轮换的内部钱包大多没有标签，
 * 所以对每个钱包先看它的资金是不是汇入火币（归集），再决定它是不是火币的地址。
 */

export const KIND_LABEL = {
  labeled: '火币标注地址',
  collection: '火币归集钱包',
  deposit: '火币充值地址',
  depositSuspect: '疑似火币充值地址',
  hot: '火币出金钱包',
};

const MAX_DEPTH = 2;
const OUT_SHARE = 0.9;
const IN_SHARE = 0.8;
const COLLECTION_MIN_SENDERS = 10;
const HOT_MIN_RECIPIENTS = 20;
const SWEEP_EMPTY_RATIO = 0.95;

const short = (a) => `${a.slice(0, 6)}…${a.slice(-4)}`;
const countBy = (list, key) => list.reduce((m, t) => m.set(key(t), (m.get(key(t)) || 0) + 1), new Map());

/** 按币种回放余额：转出金额 ≥ 转出前余额的 95% 记为一次“清空式”转出 */
function sweepStats(addr, txs) {
  const byToken = new Map();
  for (const t of [...txs].sort((a, b) => a.time - b.time)) {
    const k = t.token || 'native';
    const s = byToken.get(k) || { bal: 0n, seenIn: false, outs: 0, empties: 0 };
    const v = BigInt(t.value || 0);
    if (t.to === addr) {
      s.bal += v;
      s.seenIn = true;
    } else if (t.from === addr && s.seenIn) {
      s.outs++;
      if (s.bal > 0n && v * 100n >= s.bal * BigInt(Math.round(SWEEP_EMPTY_RATIO * 100))) s.empties++;
      s.bal = s.bal > v ? s.bal - v : 0n;
    }
    byToken.set(k, s);
  }
  let outs = 0;
  let empties = 0;
  for (const s of byToken.values()) {
    outs += s.outs;
    empties += s.empties;
  }
  return { outs, empties, ratio: outs ? empties / outs : 0 };
}

/** 每个对手方占这组转账的比例：各币种按金额算占比，再按该币种的笔数加权 */
function shareByPeer(list, peerOf) {
  const byAsset = new Map();
  for (const t of list) {
    const k = t.token || 'native';
    const a = byAsset.get(k) || { n: 0, total: 0n, peers: new Map() };
    const v = BigInt(t.value || 0);
    a.n++;
    a.total += v;
    a.peers.set(peerOf(t), (a.peers.get(peerOf(t)) || 0n) + v);
    byAsset.set(k, a);
  }
  const shares = new Map();
  for (const a of byAsset.values()) {
    if (a.total === 0n) continue;
    for (const [peer, v] of a.peers) {
      shares.set(peer, (shares.get(peer) || 0) + (a.n / list.length) * (Number((v * 10000n) / a.total) / 10000));
    }
  }
  return [...shares.entries()].map(([peer, share]) => ({ peer, share })).sort((x, y) => y.share - x.share);
}

/**
 * 归集去向：按金额从大到小累加，覆盖 90% 转出金额的那几个地址。
 * 交易所充值地址只会归集到本交易所的钱包，去向通常只有 1～3 个。
 */
export function sweepDestinations(addr, txs) {
  const out = txs.filter((t) => t.from === addr);
  const cores = [];
  let covered = 0;
  for (const s of shareByPeer(out, (t) => t.to)) {
    cores.push(s);
    covered += s.share;
    if (covered >= OUT_SHARE) break;
  }
  return { outCount: out.length, sweep: sweepStats(addr, txs), cores, covered };
}

const MAX_SWEEP_DESTS = 3;

/**
 * @param ctx.loadData   (addr) => Promise<{ transfers }>，与追踪共用缓存
 * @param ctx.labelOf    (addr) => 火币标签或 null（名单 + 浏览器标签）
 * @param ctx.isContract (addr) => boolean
 * @param ctx.isValueTx  (t) => 是否为有效资金转账（排除投毒、假币、粉尘、非主流资产）
 * @param ctx.onLearned  (addr, result) => void，高置信度结果回调（用于落盘）
 * @param ctx.onResult   (addr, result) => void，任何判定为火币的结果（含递归中顺带识别的地址）
 */
export function createHuobiClassifier(ctx) {
  const memo = new Map();

  /** chain：本次递归路径上的地址，用来切断 A→B→A 的环 */
  function classify(addr, depth = 0, chain = new Set()) {
    if (chain.has(addr)) return Promise.resolve(null);
    if (!memo.has(addr)) {
      const p = run(addr, depth, new Set([...chain, addr]))
        .then((r) => {
          if (r) ctx.onResult?.(addr, r);
          return r;
        })
        .catch((e) => {
          if (cfg('DEBUG')) console.error(`[huobi] ${addr}:`, e);
          return null;
        });
      memo.set(addr, p);
    }
    const timeout = new Promise((r) => { const t = setTimeout(() => r(null), 90000); t?.unref?.(); });
    return Promise.race([memo.get(addr), timeout]);
  }

  async function run(addr, depth, chain) {
    const rec = ctx.learnedOf?.(addr);
    if (rec) return { kind: rec.kind, label: rec.label, confidence: 'high', evidence: [...(rec.evidence || []), `（${rec.learnedAt} 行为识别后收录）`] };
    const pre = ctx.labelOf(addr);
    if (pre) return { kind: 'labeled', label: pre, confidence: 'high', evidence: [`标签：${pre}`] };
    if (ctx.isContract(addr)) return null;

    const data = await ctx.loadData(addr);
    const post = ctx.labelOf(addr);
    if (post) return { kind: 'labeled', label: post, confidence: 'high', evidence: [`标签：${post}`] };

    const txs = data.transfers.filter((t) => ctx.isValueTx(t) && t.from && t.to && t.from !== t.to);
    const out = txs.filter((t) => t.from === addr);
    const inc = txs.filter((t) => t.to === addr);
    const outBy = countBy(out, (t) => t.to);
    const inBy = countBy(inc, (t) => t.from);

    const outHuobi = await huobiShare(out, (t) => t.to, depth, chain);
    if (out.length && outHuobi.share >= OUT_SHARE) {
      const evidence = [`转出 ${out.length} 笔中 ${outHuobi.count} 笔流向火币，按金额占 ${Math.round(outHuobi.share * 100)}%：${outHuobi.names.join('、')}`];
      if (outHuobi.inferred) evidence.push(outHuobi.inferred);

      if (inBy.size >= COLLECTION_MIN_SENDERS) {
        evidence.push(`${inBy.size} 个不同地址向它转入，转出集中到火币`);
        return result(addr, 'collection', inBy.size >= 30 && !outHuobi.inferred ? 'high' : 'medium', evidence);
      }
      const sweep = sweepStats(addr, txs);
      if (sweep.outs >= 2 && sweep.ratio >= 0.8) {
        evidence.push(`${sweep.outs} 次转出中 ${sweep.empties} 次清空余额（归集节奏）`);
        return result(addr, 'deposit', outHuobi.inferred ? 'medium' : 'high', evidence);
      }
      evidence.push('资金只流向火币，但归集节奏不明显，也可能是只往火币充值的个人钱包');
      return result(addr, 'depositSuspect', 'medium', evidence);
    }

    const sd = sweepDestinations(addr, txs);
    if (sd.sweep.outs >= 3 && sd.sweep.ratio >= 0.8 && sd.covered >= OUT_SHARE && sd.cores.length <= MAX_SWEEP_DESTS) {
      const huobiDests = sd.cores.filter((c) => ctx.labelOf(c.peer));
      if (huobiDests.length) {
        const names = huobiDests.map((c) => ctx.labelOf(c.peer)).join('、');
        const huobiPart = huobiDests.reduce((s, c) => s + c.share, 0);
        const confidence = huobiPart >= 0.2 ? 'high' : 'medium';
        const r = result(addr, 'deposit', confidence, [
          `${sd.sweep.outs} 次转出中 ${sd.sweep.empties} 次清空余额（归集节奏）`,
          `资金只归集到 ${sd.cores.length} 个去向（占转出金额 ${Math.round(sd.covered * 100)}%），其中 ${names} 是火币`,
        ]);
        for (const c of sd.cores) if (!ctx.labelOf(c.peer)) inferCollection(c.peer, addr, names, confidence);
        return r;
      }
    }

    if (inc.length >= 2) {
      const inHuobi = await huobiShare(inc, (t) => t.from, MAX_DEPTH, chain);
      if (inHuobi.share >= IN_SHARE && outBy.size >= HOT_MIN_RECIPIENTS) {
        const evidence = [
          `转入 ${inc.length} 笔中 ${inHuobi.count} 笔来自火币，按金额占 ${Math.round(inHuobi.share * 100)}%：${inHuobi.names.join('、')}`,
          `向 ${outBy.size} 个不同地址打款（出金特征）`,
        ];
        return result(addr, 'hot', outBy.size >= 50 ? 'high' : 'medium', evidence);
      }
    }
    return null;
  }

  /**
   * 一组转账里流向（或来自）火币的比例：每个币种按金额算占比，再按笔数加权，
   * 避免 1 TRX 激活、手续费这类小额转账拉低比例。
   * 主要对手方没有标签时，递归判断它是不是火币的归集 / 出金钱包。
   */
  async function huobiShare(list, peerOf, depth, chain) {
    const none = { share: 0, count: 0, names: [], inferred: null };
    if (!list.length) return none;
    const huobiPeers = new Map();
    const peerCount = countBy(list, peerOf);
    for (const peer of peerCount.keys()) {
      const label = ctx.labelOf(peer);
      if (label) huobiPeers.set(peer, label);
    }

    let inferred = null;
    const [topPeer, topN] = [...peerCount.entries()].sort((a, b) => b[1] - a[1])[0];
    if (!huobiPeers.has(topPeer) && depth < MAX_DEPTH && topN / list.length >= 0.5) {
      const r = await classify(topPeer, depth + 1, chain);
      if (r && ['collection', 'hot', 'labeled'].includes(r.kind) && r.confidence === 'high') {
        huobiPeers.set(topPeer, `${short(topPeer)}（${KIND_LABEL[r.kind]}）`);
        inferred = `主要对手方 ${short(topPeer)} 被识别为${KIND_LABEL[r.kind]}：${r.evidence[0]}`;
      }
    }
    if (!huobiPeers.size) return none;

    const byAsset = new Map();
    for (const t of list) {
      const k = t.token || 'native';
      const a = byAsset.get(k) || { n: 0, total: 0n, huobi: 0n };
      const v = BigInt(t.value || 0);
      a.n++;
      a.total += v;
      if (huobiPeers.has(peerOf(t))) a.huobi += v;
      byAsset.set(k, a);
    }
    let weighted = 0;
    for (const a of byAsset.values()) if (a.total > 0n) weighted += a.n * (Number((a.huobi * 10000n) / a.total) / 10000);
    return {
      share: weighted / list.length,
      count: list.filter((t) => huobiPeers.has(peerOf(t))).length,
      names: [...new Set(huobiPeers.values())].slice(0, 3),
      inferred,
    };
  }

  function result(addr, kind, confidence, evidence) {
    const r = { kind, label: KIND_LABEL[kind], confidence, evidence };
    if (confidence === 'high' && kind !== 'depositSuspect') ctx.onLearned?.(addr, r);
    return r;
  }

  /** 同一个充值地址的归集去向属于同一家交易所：把没有标签的去向记为火币归集钱包 */
  function inferCollection(peer, depositAddr, huobiNames, confidence) {
    if (ctx.labelOf(peer) || ctx.learnedOf?.(peer)) return;
    const r = result(peer, 'collection', confidence, [
      `火币充值地址 ${short(depositAddr)} 的归集去向${huobiNames ? `（同一充值地址也归集到 ${huobiNames}）` : ''}`,
    ]);
    memo.set(peer, Promise.resolve(r));
    ctx.onResult?.(peer, r);
    return r;
  }

  /**
   * 用户确认某地址是火币后，顺着它的资金结构学习：
   * 它若呈现充值地址的归集节奏，归集去向就是火币的归集钱包。
   */
  async function learnFrom(addr, label) {
    const data = await ctx.loadData(addr);
    const txs = data.transfers.filter((t) => ctx.isValueTx(t) && t.from && t.to && t.from !== t.to);
    const sd = sweepDestinations(addr, txs);
    const report = { sweep: sd.sweep, cores: sd.cores, covered: sd.covered, learned: [] };
    const isDepositLike = sd.sweep.outs >= 2 && sd.sweep.ratio >= 0.8 && sd.cores.length <= MAX_SWEEP_DESTS;
    const knownShare = sd.cores.filter((c) => ctx.labelOf(c.peer)).reduce((s, c) => s + c.share, 0);
    const isInternalLike = knownShare >= 0.6;
    report.knownShare = knownShare;
    report.pattern = isDepositLike ? 'deposit' : isInternalLike ? 'internal' : 'other';
    if (report.pattern === 'other') return report;
    const names = sd.cores.filter((c) => ctx.labelOf(c.peer)).map((c) => ctx.labelOf(c.peer)).join('、');
    for (const c of sd.cores) {
      const r = inferCollection(c.peer, addr, names || label, 'high');
      if (r) report.learned.push({ address: c.peer, share: c.share, ...r });
    }
    return report;
  }

  return { classify, learnFrom };
}
