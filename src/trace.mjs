import { detectChain, formatAmount, makeTxFilters, limiter } from './util.mjs';
import * as eth from './chains/eth.mjs';
import * as tron from './chains/tron.mjs';
import { loadHuobiLabels, loadLearned, saveLearned, addCustom, HUOBI_TAG_RE } from './labels.mjs';
import { goplusCheck, scoreFromFlags, riskLevel } from './risk.mjs';
import { createHuobiClassifier } from './huobi.mjs';

const CHAINS = { eth, tron };
/** 风险随跳数衰减：第 n 跳对手方的风险按 DECAY[n] 传导到被查地址 */
const DECAY = [1, 0.6, 0.4, 0.25, 0.15, 0.1];

export const DEFAULTS = { hops: 5, fanout: 20, perNode: 100, rootMax: 3000, maxNodes: 200 };
/** 被查地址最近这么多笔交易的对手方必须逐个检测 */
const RECENT_MUST_CHECK = 20;

async function pool(items, size, worker, signal) {
  let i = 0;
  const runners = Array.from({ length: Math.min(size, items.length) }, async () => {
    while (i < items.length && !signal?.aborted) await worker(items[i++]);
  });
  await Promise.all(runners);
}

/** 用户确认一个火币地址：写入 custom.json，并顺着它的归集去向学习新的火币地址 */
export async function learnAddress(address, label = '火币地址（用户确认）') {
  const chain = detectChain(address);
  if (!chain) throw new Error('无法识别地址格式，目前只支持 ETH（0x…）和 TRON（T…）');
  const mod = CHAINS[chain];
  const addr = mod.normalize(address);
  addCustom(chain, addr, label);

  const list = loadHuobiLabels(chain);
  const learnedRecords = loadLearned(chain);
  const tags = {};
  const contracts = new Set();
  const cache = new Map();
  const learned = [];
  const classifier = createHuobiClassifier({
    loadData: (a) => {
      if (!cache.has(a)) {
        cache.set(
          a,
          mod.fetchTransfers(a, { max: 1000 }).then((d) => {
            for (const [x, v] of Object.entries(d.tags || {})) tags[x] = [...new Set([...(tags[x] || []), ...v])];
            (d.contracts || []).forEach((x) => contracts.add(x));
            return d;
          }),
        );
      }
      return cache.get(a);
    },
    labelOf: (a) => list[a] || (tags[a] || []).find((x) => HUOBI_TAG_RE.test(x)) || null,
    learnedOf: (a) => learnedRecords[a],
    isContract: (a) => contracts.has(a),
    isValueTx: makeTxFilters(mod.OFFICIAL_TOKENS).isValueTx,
    onLearned: (a, r) => {
      if (!contracts.has(a) && saveLearned(chain, a, { label: r.label, kind: r.kind, evidence: r.evidence })) learned.push({ address: a, ...r });
    },
  });
  const report = await classifier.learnFrom(addr, label);
  const labelOf = (a) => list[a] || (tags[a] || []).find((x) => HUOBI_TAG_RE.test(x)) || null;
  return {
    chain,
    address: addr,
    label,
    pattern: report.pattern,
    sweep: report.sweep,
    knownShare: report.knownShare,
    destinations: report.cores.map((c) => ({ address: c.peer, share: c.share, label: labelOf(c.peer) || learned.find((l) => l.address === c.peer)?.label || null })),
    learned,
  };
}

export async function trace(address, userOpts, emit, signal) {
  const opts = { ...DEFAULTS, ...userOpts };
  opts.hops = Math.min(5, Math.max(1, opts.hops));
  const chain = detectChain(address);
  if (!chain) throw new Error('无法识别地址格式，目前只支持 ETH（0x…）和 TRON（T…）');
  const mod = CHAINS[chain];
  const root = mod.normalize(address);
  const officialTokens = mod.OFFICIAL_TOKENS;
  const huobiList = loadHuobiLabels(chain);
  const goplus = limiter(400);
  const tronTags = chain === 'tron' && process.env.TRONSCAN_API_KEY ? (fn) => fn() : null;

  const tags = {};
  const scam = new Set();
  const contracts = new Set();
  const cache = new Map();
  const nodes = new Map();
  const edges = new Map();
  const huobiHits = [];
  const riskHits = [];
  const poisonPeers = [];
  let requests = 0;

  const { isPoison, isMainAsset, isDust, isValueTx } = makeTxFilters(officialTokens);
  const huobiLabel = (a) => huobiList[a] || (tags[a] || []).find((x) => HUOBI_TAG_RE.test(x)) || null;
  const learned = [];
  const learnedRecords = loadLearned(chain);
  const behaviorHuobi = new Map();
  const huobi = createHuobiClassifier({
    loadData: (a) => loadData(a),
    labelOf: huobiLabel,
    learnedOf: (a) => learnedRecords[a],
    onResult: (addr, r) => behaviorHuobi.set(addr, r),
    isContract: (a) => contracts.has(a),
    isValueTx,
    onLearned: (addr, r) => {
      if (saveLearned(chain, addr, { label: r.label, kind: r.kind, evidence: r.evidence })) {
        learned.push({ address: addr, ...r });
        emit('status', { message: `学习到新的火币地址：${addr}（${r.label}）`, level: 'warn' });
      }
    },
  });

  async function loadData(addr) {
    if (!cache.has(addr)) {
      const max = addr === root ? opts.rootMax : opts.perNode;
      cache.set(
        addr,
        mod.fetchTransfers(addr, { max }).then((d) => {
          requests++;
          Object.assign(tags, Object.fromEntries(Object.entries(d.tags || {}).map(([a, v]) => [a, [...new Set([...(tags[a] || []), ...v])]])));
          (d.scam || []).forEach((a) => scam.add(a));
          (d.contracts || []).forEach((a) => contracts.add(a));
          return d;
        }),
      );
    }
    return cache.get(addr);
  }

  function upsertNode(addr, patch) {
    const prev = nodes.get(addr);
    const node = { id: addr, ...(prev || {}), ...patch };
    if (prev && prev.hop !== undefined && patch.hop !== undefined && prev.hop <= patch.hop) {
      node.hop = prev.hop;
      node.dir = prev.dir;
    }
    node.tags = tags[addr] || [];
    node.isContract = contracts.has(addr);
    node.isScam = scam.has(addr);
    nodes.set(addr, node);
    emit('node', node);
    return node;
  }

  function upsertEdge(from, to, group) {
    const key = `${from}>${to}`;
    const amounts = Object.entries(group.amounts).map(([sym, a]) => `${formatAmount(a.raw, a.decimals)} ${sym}`);
    const edge = { id: key, from, to, count: group.count, amounts, first: group.first, last: group.last, sample: group.sample };
    edges.set(key, edge);
    emit('edge', edge);
  }

  async function riskOf(addr) {
    const node = nodes.get(addr);
    if (node?.flags) return node;
    const [gp, onchain, tagInfo] = await Promise.all([
      goplus(() => goplusCheck(addr, mod.goplusChainId)).catch(() => ({ flags: [] })),
      addr === root ? mod.onchainChecks(addr) : Promise.resolve({}),
      tronTags ? tronTags(() => mod.fetchTag(addr)).catch(() => null) : null,
    ]);
    if (tagInfo?.label) tags[addr] = [tagInfo.label];
    const flags = [...gp.flags, ...(tronTags ? mod.tagRiskFlags(tagInfo) : [])];
    if (onchain.chainalysisSanctioned) flags.push({ key: 'chainalysis', label: 'Chainalysis 制裁名单', weight: 100, source: 'Chainalysis Oracle' });
    if (onchain.usdtFrozen) flags.push({ key: 'usdt_frozen', label: 'USDT 已被 Tether 冻结', weight: 80, source: 'USDT 合约' });
    return upsertNode(addr, { flags, score: scoreFromFlags(flags), onchain: addr === root ? onchain : undefined });
  }

  function groupPeers(addr, transfers, dir, bound) {
    const groups = new Map();
    for (const t of transfers) {
      const incoming = t.to === addr;
      if (dir === 'up' ? !incoming || t.time > bound : incoming || t.time < bound) continue;
      const peer = incoming ? t.from : t.to;
      if (!peer || peer === addr || isPoison(t)) continue;
      let g = groups.get(peer);
      if (!g) groups.set(peer, (g = { peer, count: 0, mainCount: 0, amounts: {}, first: Infinity, last: 0, sample: t.hash }));
      g.count++;
      if (isMainAsset(t) && !isDust(t)) g.mainCount++;
      g.amounts[t.symbol] = g.amounts[t.symbol] || { raw: 0n, decimals: t.decimals };
      g.amounts[t.symbol].raw += BigInt(t.value);
      g.first = Math.min(g.first, t.time);
      g.last = Math.max(g.last, t.time);
    }
    return [...groups.values()];
  }

  const core = (a) => a.replace(/^0x|^T/, '').toLowerCase();
  const lookalikeCache = new Map();
  /** 同一地址的对手方里首尾 4 位相同的一组，最早出现的视为真地址（投毒总在真实交互之后），其余为仿冒：{ 仿冒地址: 被仿冒地址 } */
  function findLookalikes(addr, transfers) {
    if (lookalikeCache.has(addr)) return lookalikeCache.get(addr);
    const stats = new Map();
    for (const t of transfers) {
      const peer = t.to === addr ? t.from : t.to;
      if (!peer || peer === addr) continue;
      const s = stats.get(peer) || { peer, real: 0, first: Infinity, total: 0 };
      s.total++;
      if (!isPoison(t) && isMainAsset(t) && !isDust(t)) {
        s.real++;
        s.first = Math.min(s.first, t.time);
      }
      stats.set(peer, s);
    }
    const byKey = new Map();
    for (const s of stats.values()) {
      const c = core(s.peer);
      const key = c.slice(0, 4) + c.slice(-4);
      byKey.set(key, [...(byKey.get(key) || []), s]);
    }
    const fakes = {};
    for (const list of byKey.values()) {
      if (list.length < 2) continue;
      list.sort((a, b) => (b.real > 0) - (a.real > 0) || a.first - b.first || b.total - a.total);
      for (const s of list.slice(1)) fakes[s.peer] = list[0].peer;
    }
    lookalikeCache.set(addr, fakes);
    return fakes;
  }

  /** 被查地址最近 N 笔有效交易（排除投毒、假币、粉尘，不限币种）里，属于该方向的对手方 */
  function recentCounterparties(addr, transfers, dir, n = RECENT_MUST_CHECK) {
    const recent = transfers
      .filter((t) => !isPoison(t) && !isDust(t) && t.from && t.to && t.from !== t.to)
      .sort((a, b) => b.time - a.time)
      .slice(0, n);
    return [...new Set(recent.filter((t) => (dir === 'up' ? t.to === addr : t.from === addr)).map((t) => (dir === 'up' ? t.from : t.to)))];
  }

  function stopReason(addr) {
    if (huobiLabel(addr)) return '火币地址';
    if ((tags[addr] || []).length) return '已标记实体';
    if (contracts.has(addr)) return '合约';
    if (scam.has(addr)) return '诈骗标记';
    return null;
  }

  /** 已知的火币判定：学习名单 > 标签/名单 > 本次行为识别（含递归中顺带识别的） */
  function huobiOf(addr) {
    const rec = learnedRecords[addr];
    if (rec) return { kind: rec.kind, label: rec.label, confidence: 'high', evidence: [...(rec.evidence || []), `（${rec.learnedAt} 行为识别后收录）`] };
    const label = huobiLabel(addr);
    if (label) return { kind: 'labeled', label, confidence: 'high', evidence: [`标签：${label}`] };
    return behaviorHuobi.get(addr) || null;
  }

  function recordHuobiHit(dir, hop, address, path, cls, g, side = null) {
    const hit = {
      dir,
      hop,
      address,
      label: cls.label,
      kind: cls.kind,
      confidence: cls.confidence,
      evidence: cls.evidence,
      side,
      path,
      count: g?.count ?? 0,
      first: g?.first,
      last: g?.last,
      sample: g?.sample,
    };
    if (huobiHits.some((h) => h.address === address && h.dir === dir)) return;
    huobiHits.push(hit);
    emit('huobi', hit);
  }

  /**
   * 链路收起：一个地址和它下面所有分支都查完、且没有任何火币命中经过它时，通知前端把这一支隐藏。
   * BFS 按跳推进，子分支总在父地址处理完之后才处理，所以用“待完成子分支数”倒数即可。
   */
  const tree = { up: new Map(), down: new Map() };
  function settle(dir, addr, children) {
    const t = tree[dir].get(addr);
    if (!t) return;
    t.processed = true;
    t.pending += children;
    if (t.pending <= 0) finish(dir, addr);
  }
  function finish(dir, addr) {
    const t = tree[dir].get(addr);
    if (!t || t.done) return;
    t.done = true;
    if (addr !== root) emit('checked', { id: addr, dir, hop: t.item.hop, clean: !huobiHits.some((h) => h.path.includes(addr)) });
    const parent = t.item.path[t.item.path.length - 2];
    const pt = parent !== undefined && tree[dir].get(parent);
    if (!pt) return;
    pt.pending--;
    if (pt.pending <= 0 && pt.processed) finish(dir, parent);
  }

  /** 链路上的地址在反方向和火币有往来：上游资金方往火币充值、下游收款方从火币提币 */
  function checkSideBranch(item, dir, data) {
    const sideDir = dir === 'up' ? 'down' : 'up';
    for (const g of groupPeers(item.addr, data.transfers, sideDir, sideDir === 'up' ? Infinity : 0)) {
      if (g.peer === root || item.path.includes(g.peer)) continue;
      const cls = huobiOf(g.peer);
      if (!cls || huobiHits.some((h) => h.address === g.peer)) continue;
      const [from, to] = sideDir === 'up' ? [g.peer, item.addr] : [item.addr, g.peer];
      upsertNode(g.peer, { hop: item.hop + 1, dir, expanded: false, huobi: cls.label, huobiKind: cls.kind, huobiConfidence: cls.confidence, huobiEvidence: cls.evidence });
      upsertEdge(from, to, g);
      const note = sideDir === 'down' ? `第 ${item.hop} 跳地址曾向火币转出（它是火币用户）` : `第 ${item.hop} 跳地址曾从火币收款（它是火币用户）`;
      recordHuobiHit(dir, item.hop, g.peer, [...item.path, g.peer], cls, g, note);
    }
  }

  emit('status', { message: `链：${chain.toUpperCase()}，开始查询根地址风险…` });
  upsertNode(root, { hop: 0, dir: 'root', expanded: true });
  await riskOf(root);
  emit('status', { message: '判断被查地址本身是不是火币的归集 / 充值 / 出金钱包…' });
  const rootHuobi = await huobi.classify(root);
  if (rootHuobi) upsertNode(root, { huobi: rootHuobi.label, huobiKind: rootHuobi.kind, huobiConfidence: rootHuobi.confidence, huobiEvidence: rootHuobi.evidence });

  const rootData = await loadData(root).catch(() => ({ transfers: [] }));
  const recentTxs = rootData.transfers
    .filter((t) => !isPoison(t) && !isDust(t) && t.from && t.to && t.from !== t.to)
    .sort((a, b) => b.time - a.time)
    .slice(0, RECENT_MUST_CHECK)
    .map((t) => ({
      hash: t.hash,
      time: t.time,
      dir: t.to === root ? 'up' : 'down',
      peer: t.to === root ? t.from : t.to,
      amount: `${formatAmount(t.value, t.decimals)} ${t.symbol}`,
    }));
  emit('recent', { txs: recentTxs });

  for (const dir of ['up', 'down']) {
    const visited = new Set([root]);
    let frontier = [{ addr: root, hop: 0, bound: dir === 'up' ? Infinity : 0, path: [root] }];
    tree[dir].set(root, { item: frontier[0], pending: 0, processed: false, done: false });
    let expandedCount = 0;

    for (let hop = 1; hop <= opts.hops + 1 && frontier.length && !signal?.aborted; hop++) {
      const expand = hop <= opts.hops;
      emit('status', {
        message: expand
          ? `${dir === 'up' ? '上游' : '下游'}第 ${hop} 跳：识别并展开 ${frontier.length} 个地址…`
          : `${dir === 'up' ? '上游' : '下游'}第 ${hop - 1} 跳：识别末端 ${frontier.length} 个地址是否属于火币…`,
      });
      const next = [];

      /** 处理一个地址，返回新排进下一跳的分支数 */
      const processItem = async (item) => {
        let data;
        try {
          data = await loadData(item.addr);
        } catch (e) {
          emit('status', { message: `拉取 ${item.addr} 失败：${e.message}`, level: 'warn' });
          return;
        }
        if (item.addr !== root && data.truncated) upsertNode(item.addr, { hub: true });

        if (item.addr !== root) {
          const cls = await huobi.classify(item.addr);
          if (cls) {
            upsertNode(item.addr, { huobi: cls.label, huobiKind: cls.kind, huobiConfidence: cls.confidence, huobiEvidence: cls.evidence });
            recordHuobiHit(dir, item.hop, item.addr, item.path, cls, item.group);
            return;
          }
          checkSideBranch(item, dir, data);
        }
        if (!expand) return;

        const fakes = findLookalikes(item.addr, data.transfers);
        const groups = groupPeers(item.addr, data.transfers, dir, item.bound);
        if (item.addr === root) {
          for (const g of groups.filter((x) => fakes[x.peer])) {
            const [from, to] = dir === 'up' ? [g.peer, root] : [root, g.peer];
            upsertNode(g.peer, { hop: 1, dir, poison: fakes[g.peer], expanded: false });
            upsertEdge(from, to, g);
            const prev = poisonPeers.find((p) => p.address === g.peer);
            const entry = prev || { address: g.peer, imitates: fakes[g.peer], count: 0, paidTo: null };
            entry.count += g.count;
            if (dir === 'down') entry.paidTo = Object.entries(g.amounts).map(([sym, a]) => `${formatAmount(a.raw, a.decimals)} ${sym}`);
            if (!prev) poisonPeers.push(entry);
          }
        }
        for (const g of groups) {
          if (g.peer === root || item.path.includes(g.peer)) continue;
          const cls = huobiOf(g.peer);
          if (!cls && !scam.has(g.peer)) continue;
          const [from, to] = dir === 'up' ? [g.peer, item.addr] : [item.addr, g.peer];
          upsertNode(g.peer, {
            hop,
            dir,
            expanded: false,
            ...(cls && { huobi: cls.label, huobiKind: cls.kind, huobiConfidence: cls.confidence, huobiEvidence: cls.evidence }),
          });
          upsertEdge(from, to, g);
          if (cls) recordHuobiHit(dir, hop, g.peer, [...item.path, g.peer], cls, g);
        }

        const mustPeers = new Set(item.addr === root ? recentCounterparties(root, data.transfers, dir) : []);
        for (const peer of mustPeers) {
          const reason = stopReason(peer);
          if (!reason || huobiOf(peer) || scam.has(peer) || fakes[peer]) continue;
          const g = groups.find((x) => x.peer === peer);
          if (!g) continue;
          const [from, to] = dir === 'up' ? [peer, root] : [root, peer];
          upsertNode(peer, { hop: 1, dir, expanded: false, stop: reason });
          upsertEdge(from, to, g);
          emit('checked', { id: peer, dir, hop: 1, clean: true });
        }

        const eligible = groups.filter((g) => !fakes[g.peer] && !visited.has(g.peer) && !behaviorHuobi.has(g.peer) && !stopReason(g.peer));
        const must = eligible.filter((g) => mustPeers.has(g.peer));
        const rest = eligible.filter((g) => !mustPeers.has(g.peer) && g.mainCount > 0).sort((a, b) => b.mainCount - a.mainCount || b.last - a.last);
        const limit = Math.max(0, Math.min(Math.max(opts.fanout, must.length), opts.maxNodes - expandedCount));
        const candidates = [...must, ...rest].slice(0, limit);
        for (const g of candidates) visited.add(g.peer);
        expandedCount += candidates.length;

        for (const g of candidates) {
          const [from, to] = dir === 'up' ? [g.peer, item.addr] : [item.addr, g.peer];
          upsertNode(g.peer, { hop, dir, expanded: true });
          upsertEdge(from, to, g);
          const node = await riskOf(g.peer);
          if (node.flags.length) {
            const hit = { dir, hop, address: g.peer, flags: node.flags, score: node.score, path: [...item.path, g.peer] };
            riskHits.push(hit);
            emit('risk', hit);
          }
          const child = { addr: g.peer, hop, group: g, bound: dir === 'up' ? g.last : g.first, path: [...item.path, g.peer] };
          tree[dir].set(g.peer, { item: child, pending: 0, processed: false, done: false });
          next.push(child);
        }
        return candidates.length;
      };

      await pool(
        frontier,
        chain === 'eth' ? 3 : 2,
        async (item) => settle(dir, item.addr, (await processItem(item).catch(() => 0)) || 0),
        signal,
      );

      frontier = next;
    }
  }

  const rootNode = nodes.get(root);
  const directScore = rootNode.score || 0;
  const indirectScore = Math.round(Math.max(0, ...riskHits.map((h) => h.score * DECAY[h.hop])));
  const score = Math.max(directScore, indirectScore);
  const nearestHuobi = huobiHits.reduce((m, h) => (m && m.hop <= h.hop ? m : h), null);

  const reasons = [];
  if (rootHuobi) reasons.push(`火币嫌疑：该地址本身被判定为${rootHuobi.label}`);
  else if (nearestHuobi) {
    const where = `${nearestHuobi.dir === 'up' ? '上游' : '下游'}第 ${nearestHuobi.hop} 跳${nearestHuobi.side ? '（旁支）' : ''}`;
    reasons.push(`火币嫌疑：${where}发现${nearestHuobi.label}，共 ${huobiHits.length} 处火币关联`);
  }
  if (score >= 50) reasons.push(`风险评分 ${score}（${riskLevel(score)}风险）`);
  const verdict = { pass: reasons.length === 0, text: reasons.length ? '不通过' : '通过', reasons };

  const summary = {
    address: root,
    chain,
    verdict,
    score,
    level: riskLevel(score),
    directScore,
    indirectScore,
    flags: rootNode.flags,
    onchain: rootNode.onchain,
    selfHuobi: rootHuobi,
    huobi: { contacted: huobiHits.length > 0 || !!rootHuobi, nearestHop: nearestHuobi?.hop ?? null, hits: huobiHits, learned },
    riskHits,
    poisonPeers,
    recent: recentTxs.map((tx) => ({
      ...tx,
      status: huobiHits.some((h) => h.path[1] === tx.peer) || huobiOf(tx.peer) ? 'huobi' : nodes.has(tx.peer) ? 'clean' : 'skipped',
    })),
    stats: { nodes: nodes.size, edges: edges.size, fetched: requests, aborted: !!signal?.aborted },
    opts,
    tronTagEnabled: chain === 'tron' && !!process.env.TRONSCAN_API_KEY,
    huobiListSize: Object.keys(huobiList).length,
  };
  emit('done', summary);
  return summary;
}
