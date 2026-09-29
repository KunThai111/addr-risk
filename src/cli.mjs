#!/usr/bin/env node
import { cfg } from './config.mjs';
import { fmtTime } from './util.mjs';
import { trace, learnAddress, DEFAULTS } from './trace.mjs';
import { updateEthLabels, updateTronLabels, useStore } from './labels.mjs';
import { nodeStore } from './store-node.mjs';
import { searchTaggedAddresses } from './chains/tron.mjs';

const HELP = `用法:
  node src/cli.mjs <地址> [选项]          风险评分 + 火币关联追踪（默认上下各 1 跳）
  node src/cli.mjs update-labels [eth|tron] 刷新火币种子名单（tron 需要 TRONSCAN_API_KEY）
  node src/cli.mjs learn <地址> [备注]      确认某地址是火币，并顺着它的归集去向学习新地址

支持链: ETH（0x 开头）、TRON（T 开头），按地址格式自动识别

选项:
  --hops <n>       上下游各追踪几跳（1-5，默认 1）
  --fanout <n>     每跳继续追踪的对手方数（默认 ${DEFAULTS.fanout}）
  --per-node <n>   每个中间地址拉取的记录数（默认 ${DEFAULTS.perNode}）
  --max-nodes <n>  上下游各自最多展开的地址数（默认 ${DEFAULTS.maxNodes}）
  --json           输出 JSON

环境变量（放在 .env 里，用 npm run check -- <地址> 会自动加载）:
  TRONSCAN_API_KEY   TRON 走 Tronscan（自带标签、风险标记），强烈建议配置
  TRONGRID_API_KEY   没有 Tronscan Key 时，提高 TronGrid 速度
  ETH_RPC_URL        自定义 ETH RPC
`;

function parseArgs(argv) {
  const opts = { hops: 1, json: false, _: [] };
  const num = { '--hops': 'hops', '--fanout': 'fanout', '--per-node': 'perNode', '--max-nodes': 'maxNodes' };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--json') opts.json = true;
    else if (num[a]) opts[num[a]] = Number(argv[++i]);
    else if (a === '-h' || a === '--help') opts.help = true;
    else opts._.push(a);
  }
  return opts;
}

const short = (a) => `${a.slice(0, 6)}…${a.slice(-4)}`;
const dirText = (d) => (d === 'up' ? '上游' : '下游');
const confText = (c) => (c === 'high' ? '高' : '中');

function printReport(r) {
  const color = { 严重: 31, 高: 31, 中: 33, 低: 32 }[r.level];
  const L = [];
  L.push('');
  L.push(`地址：${r.address}（${r.chain.toUpperCase()}）`);
  L.push(
    r.verdict.pass
      ? '评估结论：\x1b[42;30m 通过 \x1b[0m'
      : `评估结论：\x1b[41;97m 不通过 \x1b[0m  ${r.verdict.reasons.join('；')}`,
  );
  L.push(`风险评分：\x1b[${color}m${r.score} / 100（${r.level}风险）\x1b[0m   自身 ${r.directScore} · 链路传导 ${r.indirectScore}`);

  L.push('');
  L.push('■ 自身风险标签');
  if (!r.flags.length) L.push('  无命中');
  for (const f of r.flags) L.push(`  - ${f.label}（${f.source}）`);
  if (r.chain === 'eth') L.push(`  Chainalysis 制裁：${r.onchain?.chainalysisSanctioned ? '是' : '否'}`);
  L.push(`  USDT 冻结：${r.onchain?.usdtFrozen ? '是' : '否'}`);

  L.push('');
  L.push(`■ 是否接触过火币（HTX）：${r.huobi.contacted ? '\x1b[33m是\x1b[0m' : '否'}`);
  if (r.selfHuobi) {
    L.push(`  该地址本身判定为：${r.selfHuobi.label}（置信度${confText(r.selfHuobi.confidence)}）`);
    for (const e of r.selfHuobi.evidence) L.push(`    · ${e}`);
  }
  for (const h of [...r.huobi.hits].sort((a, b) => a.hop - b.hop)) {
    const arrow = h.dir === 'up' ? ' ← ' : ' → ';
    const sideArrow = h.dir === 'up' ? ' → ' : ' ← ';
    const path = h.path.map((a, i) => (i ? (h.side && i === h.path.length - 1 ? sideArrow : arrow) : '') + short(a)).join('');
    L.push(`  - ${dirText(h.dir)}第 ${h.hop} 跳${h.side ? '（旁支）' : ''}  ${h.label}（置信度${confText(h.confidence)}）  ${h.address}`);
    if (h.side) L.push(`      ${h.side}`);
    L.push(`      路径：${path}`);
    for (const e of h.evidence.filter((e) => !e.startsWith('标签：'))) L.push(`      · ${e}`);
    if (h.first) L.push(`      时间 ${fmtTime(h.first)} ~ ${fmtTime(h.last)}   样例 ${h.sample}`);
  }
  if (r.huobi.learned.length) L.push(`  本次新学习到 ${r.huobi.learned.length} 个火币地址，已写入 data/learned-huobi.json`);

  L.push('');
  L.push(`■ 最近 ${r.recent.length} 笔交易逐笔检测`);
  for (const tx of r.recent) {
    const st = { huobi: '\x1b[33m⚠ 火币\x1b[0m', clean: '\x1b[32m✓ 无火币\x1b[0m', skipped: '— 未追踪' }[tx.status];
    L.push(`  ${fmtTime(tx.time)}  ${tx.dir === 'up' ? '转入' : '转出'}  ${tx.amount.padEnd(22)} ${short(tx.peer)}  ${st}`);
  }

  L.push('');
  L.push('■ 链路上的风险地址');
  if (!r.riskHits.length) L.push('  未发现');
  for (const h of r.riskHits) L.push(`  - ${dirText(h.dir)}第 ${h.hop} 跳 ${h.address}  ${h.flags.map((f) => f.label).join('、')}（${h.score}）`);

  if (r.poisonPeers.length) {
    L.push('');
    L.push(`■ 投毒仿冒地址：${r.poisonPeers.length} 个`);
    for (const p of r.poisonPeers.filter((p) => p.paidTo)) L.push(`  \x1b[31m⚠ 曾向仿冒地址 ${p.address} 转出 ${p.paidTo.join('，')}\x1b[0m`);
    for (const p of r.poisonPeers.slice(0, 5)) L.push(`  - ${p.address} 仿冒 ${p.imitates}`);
  }

  L.push('');
  L.push(`追踪范围：上下各 ${r.opts.hops} 跳，每跳 ${r.opts.fanout} 个分支；节点 ${r.stats.nodes} 个，拉取地址 ${r.stats.fetched} 个${r.stats.aborted ? '（已中断）' : ''}`);
  console.log(L.join('\n'));
}

useStore(nodeStore);
const opts = parseArgs(process.argv.slice(2));
if (opts.help || !opts._.length) {
  console.log(HELP);
  process.exit(opts._.length ? 0 : 1);
}

try {
  if (opts._[0] === 'learn') {
    if (!opts._[1]) throw new Error('用法：learn <地址> [备注]');
    const r = await learnAddress(opts._[1].trim(), opts._[2] || '火币地址（用户确认）');
    console.log(`已写入 custom.json：${r.address}（${r.label}）`);
    const patternText = {
      deposit: `充值地址（${r.sweep.outs} 次转出中 ${r.sweep.empties} 次清空余额），归集去向都属于火币`,
      internal: `火币内部钱包（${Math.round(r.knownShare * 100)}% 的转出已流向有标签的火币钱包），其余主要去向也属于火币`,
      other: `资金去向分散（仅 ${Math.round(r.knownShare * 100)}% 流向已知火币钱包），不顺藤学习，避免误判`,
    }[r.pattern];
    console.log(`资金模式：${patternText}`);
    for (const d of r.destinations) console.log(`  归集去向 ${d.address}  占转出 ${Math.round(d.share * 100)}%  ${d.label || ''}`);
    console.log(r.learned.length ? `新学习 ${r.learned.length} 个火币地址：` : '没有新地址需要学习');
    for (const l of r.learned) console.log(`  + ${l.address}  ${l.label}  · ${l.evidence[0]}`);
  } else if (opts._[0] === 'update-labels') {
    const which = opts._[1] || 'all';
    if (which === 'eth' || which === 'all') console.log(`ETH 火币名单：${await updateEthLabels()} 个`);
    if (which === 'tron' || which === 'all') {
      if (!cfg('TRONSCAN_API_KEY')) console.log('TRON：跳过（未配置 TRONSCAN_API_KEY）');
      else console.log(`TRON 火币名单：${await updateTronLabels(searchTaggedAddresses)} 个`);
    }
  } else {
    const log = (type, data) => {
      if (opts.json || type !== 'status') return;
      process.stderr.write(`\x1b[2m${data.message}\x1b[0m\n`);
    };
    const result = await trace(opts._[0].trim(), opts, log);
    if (opts.json) console.log(JSON.stringify(result, null, 2));
    else printReport(result);
  }
} catch (e) {
  console.error(`错误：${e.message}`);
  process.exit(1);
}
