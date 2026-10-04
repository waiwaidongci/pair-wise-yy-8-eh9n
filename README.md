# 古法纸浆入缸账

浸泡缸、纸浆批次、观察补录统一记入一份**只追加事件账**。当前缸位、发酵天数、批次状态
不再单独保存，任何时候都从事件重算，因此不会出现「记录与状态对不上」。

## 运行

```bash
npm start          # http://localhost:3039
npm test           # 核心账本测试（Node 内置 test runner，零依赖）
```

数据目录可用 `DATA_DIR` 覆盖（默认 `./data`）。

## 解决的问题

| 旧问题 | 做法 |
| --- | --- |
| 夜班/白班同改一份批次文件，天数、异常、缸位互相盖掉 | 浸泡缸、批次、观察拆成独立事件，只追加不覆盖；所有写命令进同一串行队列 |
| 回网重放多记一天 | 观察必须带**现场单号**；同单号补传只认第一次并原样返回；天数 = 不重复观察日期数，而非累加 |
| 机器断电后当前状态和事件记录对不上 | 每条事件带哈希链并 `fsync`；重启一律从 `events.jsonl` 重算投影，末尾写坏的半截自动截除 |
| 换缸两终端同抢一缸 | 换缸在串行队列内占用目标缸容量；满缸时整笔失败（409），只一批成功 |
| 旧数据升级 | 首次启动自动迁移旧 `paper-pulp-fermentation.json` 为事件，原件归档为 `*.legacy.json`，`/api/legacy` 可查 |
| 异常批次被误看为可抄纸 | 最近观察异常 → `异常观察`；换缸被拒 → `换缸冲突`；未满 7 个观察日 → 未完成。三者任一存在都 `readyForPapermaking=false` |

## 可抄纸判定（全部派生，不可手工改）

- 发酵天数 ≥ 7（按**不重复观察日期**计；同一天白班夜班只算一天）
- 最近一次观察无未决异常（异常后补一条正常观察即恢复）
- 无未解决的换缸冲突（换缸成功即解除；冲突期间批次保留在原缸，可重试）

## 事件类型（`data/events.jsonl`）

- `vat_configured` 登记缸与容量
- `batch_registered` 批次入缸（入缸即占缸，满缸拒绝建档，不留半成品）
- `observation_recorded` 观察（幂等键 = 现场单号；同号不同内容返回 409）
- `observation_amended` 更正旧观察（`amendOf` 指向旧单号，旧记录标记作废但保留）
- `vat_transferred` 换缸成功并占用目标缸
- `vat_transfer_blocked` 换缸因目标缸满而失败，批次挂冲突标记、保留可重试

## HTTP API

```
POST /api/vats                      {id, capacity, name?}
GET  /api/vats                      缸位占用/在缸批次
POST /api/batches                   {code, vatId, source?, owner?, ticket?}
GET  /api/batches                   派生后的全部批次
GET  /api/batches/:code
POST /api/batches/:code/observations {ticket, date?, temperature?, smell?, fiber?, changedWater?, abnormal?, amendOf?}
POST /api/batches/:code/transfer    {targetVatId, ticket?}
GET  /api/events?batchCode=...
GET  /api/stats
GET  /api/legacy                    升级前旧批次原件
```

冲突返回 `409`，批次/缸不存在返回 `404`。
