# addr-risk

链上地址风险评估工具：输入一个 ETH 或 TRON 地址，向上游（资金来源）和下游（资金去向）各追踪最多 5 跳，判断它是否和**火币（HTX）**有资金关联，并给出风险评分和“通过 / 不通过”结论。

零依赖（只用 Node 内置模块），自带网页版和命令行版。

## 功能

- **评估结论**：发现任何火币关联（地址本身、资金路径、旁支）即判 **不通过（火币嫌疑）**；风险评分 ≥ 50 也判不通过。
- **多跳资金追踪**：上下游各 1～5 跳，每跳默认 20 个分支；被查地址最近 20 笔交易的对手方逐笔必检。
- **火币地址识别**（每个钱包都会先判断一遍）：
  1. 种子名单（ETH 86 个、TRON 13 个）+ Blockscout / Tronscan 实时实体标签
  2. **归集钱包**：按金额 90% 以上转给火币，且有很多不同地址向它转入
  3. **充值地址**：每次收到钱就清空余额，且只归集到 1～3 个去向，其中之一是火币
  4. **出金钱包**：80% 以上的钱来自火币，且向大量不同地址打款
  5. 主要去向没有标签时递归判断（最多 2 层）；高置信度结果自动写入学习名单
- **风险评分**：GoPlus 风险标签、Chainalysis 制裁预言机（ETH）、USDT 冻结状态、Tronscan 风险标签，链路上的风险地址按跳数衰减传导。
- **地址投毒检测**：首尾相同的仿冒地址、0 金额转账、形近字符假币（如 `ÚЅDС`、`U5DC`）。
- **网页可视化**：实时资金关系图；每条链路检测通过后第 1 跳标绿常驻、更远的跳收起，只保留通向火币的链路；最近 20 笔交易逐笔显示检测状态。

## 快速开始

需要 Node.js ≥ 22.9。

```bash
git clone https://github.com/KunThai111/addr-risk.git
cd addr-risk
cp .env.example .env      # 可选：填入 TRONSCAN_API_KEY
npm run web               # 打开 http://localhost:5178
```

命令行：

```bash
npm run check -- <地址>                 # 默认上下各 1 跳
npm run check -- <地址> --hops 5        # 上下各 5 跳
npm run check -- <地址> --json          # 输出 JSON
npm run check -- learn <地址> [备注]    # 确认某地址是火币，并顺着它的归集去向学习新地址
npm run update-labels                  # 刷新火币种子名单（TRON 需要 TRONSCAN_API_KEY）
```

## 配置

见 [`.env.example`](.env.example)。全部可选，但 **TRON 强烈建议配置 `TRONSCAN_API_KEY`**：没有它时只能走 TronGrid（每秒 1 次，且无地址标签）。

## 数据文件

| 文件 | 内容 |
|---|---|
| `data/huobi-eth.json` | ETH 火币种子名单（来自开源 etherscan-labels） |
| `data/huobi-tron.json` | TRON 火币种子名单（来自 Tronscan 标签搜索） |
| `data/learned-huobi.json` | 行为识别学到的火币地址及证据 |
| `data/custom.json` | 用户确认的火币地址 |

## 数据来源

Blockscout（ETH 交易与实体标签）、Tronscan / TronGrid（TRON）、GoPlus Security、Chainalysis Sanctions Oracle、USDT 合约黑名单、[etherscan-labels](https://github.com/brianleect/etherscan-labels)。

## 局限

- 这是**抽样追踪**：每跳只追资金往来最多的分支，高频地址只拉取最近的记录。“未发现火币”只代表在已追踪范围内没有发现。
- 行为识别偏保守：连不到有标签火币地址（2 层内）的交易所式钱包不会被判为火币。
- “疑似充值地址”（只往火币转钱但归集节奏不明显）也会判不通过，可能是只往火币充值的个人钱包，建议人工复核。

## 免责声明

本工具的结论基于公开链上数据和启发式规则，仅供风控参考，不构成任何法律或合规意见。
