import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, cpSync, rmSync, existsSync, appendFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openLedger, LedgerError, FERMENT_DAYS } from "../lib/ledger.js";

const fixture = join(process.cwd(), "data", "paper-pulp-fermentation.json");

async function freshDir(withLegacy = false) {
  const dir = mkdtempSync(join(tmpdir(), "vat-ledger-"));
  if (withLegacy) cpSync(fixture, join(dir, "paper-pulp-fermentation.json"));
  return dir;
}
async function catchError(fn) {
  try {
    await fn();
  } catch (e) {
    return e;
  }
  return null;
}

test("旧数据升级：迁移后仍可查，天数按观察日期重算，重开不重复入账", async () => {
  const dir = await freshDir(true);
  const ledger = await openLedger(dir);
  const b = await ledger.getBatch("PF-001");
  assert.equal(b.migrated, true);
  // 旧文件有 2026-06-15 日志一条 + 2026-06-21 观察一条 → 2 个观察日（旧文件 days=6 不再被信任）
  assert.deepEqual(b.observationDates, ["2026-06-15", "2026-06-21"]);
  assert.equal(b.days, 2);
  const legacy = await ledger.legacy();
  assert.equal(legacy.available, true);
  assert.equal(legacy.batches[0].code, "PF-001");
  assert.equal(existsSync(join(dir, "paper-pulp-fermentation.json")), false);

  // 断电重启：再打开一次，不能重复迁移
  const again = await openLedger(dir);
  const list = await again.listBatches();
  assert.equal(list.length, 1);
  assert.equal((await again.getBatch("PF-001")).days, 2);
});

test("观察带现场单号：重复补传只认第一次，重放不多计一天", async () => {
  const dir = await freshDir();
  const ledger = await openLedger(dir);
  await ledger.configureVat({ id: "一号缸", capacity: 2 });
  await ledger.registerBatch({ code: "PF-A", vatId: "一号缸" });
  const payload = { ticket: "YC-1", date: "2026-10-01", smell: "微酸", abnormal: "" };
  const r1 = await ledger.recordObservation("PF-A", payload);
  assert.equal(r1.duplicate, false);
  const r2 = await ledger.recordObservation("PF-A", payload); // 回网重放
  const r3 = await ledger.recordObservation("PF-A", payload); // 再次重放
  assert.equal(r2.duplicate, true);
  assert.equal(r3.duplicate, true);
  const b = await ledger.getBatch("PF-A");
  assert.equal(b.days, 1); // 没有多记一天
  assert.equal(b.observations.length, 1);
});

test("同单号不同内容冲突；改动旧记录走更正，天数与状态按同一事件流重算", async () => {
  const dir = await freshDir();
  const ledger = await openLedger(dir);
  await ledger.configureVat({ id: "一号缸", capacity: 2 });
  await ledger.registerBatch({ code: "PF-A", vatId: "一号缸" });
  await ledger.recordObservation("PF-A", { ticket: "YC-1", date: "2026-10-01", smell: "微酸" });
  const err = await catchError(() =>
    ledger.recordObservation("PF-A", { ticket: "YC-1", date: "2026-10-01", smell: "酸臭", abnormal: "是" }),
  );
  assert.ok(err instanceof LedgerError && err.http === 409);

  // 乱序先补 10-03，再补 10-02，再更正 10-01
  await ledger.recordObservation("PF-A", { ticket: "YC-3", date: "2026-10-03" });
  await ledger.recordObservation("PF-A", { ticket: "YC-2", date: "2026-10-02" });
  let b = await ledger.getBatch("PF-A");
  assert.deepEqual(b.observationDates, ["2026-10-01", "2026-10-02", "2026-10-03"]);

  await ledger.recordObservation("PF-A", {
    ticket: "YC-1B", amendOf: "YC-1", date: "2026-10-01", abnormal: "有霉点",
  });
  b = await ledger.getBatch("PF-A");
  assert.equal(b.days, 3); // 更正不改天数，只改最新异常状态
  assert.equal(b.status, "异常观察");
  assert.equal(b.readyForPapermaking, false);
  const voided = b.observations.find((o) => o.ticket === "YC-1");
  assert.equal(voided.voided, true);

  // 旧单号已失效
  const replay = await catchError(() =>
    ledger.recordObservation("PF-A", { ticket: "YC-1", date: "2026-10-01", smell: "微酸" }),
  );
  assert.equal(replay.code, "ticket_superseded");
});

test("换缸占用目标缸容量：两个终端同时换入只有一批成功，失败方保留批次并可重试", async () => {
  const dir = await freshDir();
  const ledger = await openLedger(dir);
  await ledger.configureVat({ id: "一号缸", capacity: 2 });
  await ledger.configureVat({ id: "二号缸", capacity: 1 });
  await ledger.registerBatch({ code: "PF-A", vatId: "一号缸" });
  await ledger.registerBatch({ code: "PF-B", vatId: "一号缸" });

  // 并发：A、B 同时抢容量为 1 的二号缸
  const [ra, rb] = await Promise.allSettled([
    ledger.transferVat("PF-A", { targetVatId: "二号缸", ticket: "T-A" }),
    ledger.transferVat("PF-B", { targetVatId: "二号缸", ticket: "T-B" }),
  ]);
  const ok = [ra, rb].filter((r) => r.status === "fulfilled");
  const fail = [ra, rb].filter((r) => r.status === "rejected");
  assert.equal(ok.length, 1);
  assert.equal(fail.length, 1);
  assert.equal(fail[0].reason.code, "vat_full");

  // 失败批次保留，仍在原缸，带冲突标记，不可抄纸
  const loserCode = fail[0].reason.details ? null : null;
  const a = await ledger.getBatch("PF-A");
  const b2 = await ledger.getBatch("PF-B");
  const loser = a.conflictOpen ? a : b2;
  const winner = a.conflictOpen ? b2 : a;
  assert.equal(loser.vatId, "一号缸");
  assert.equal(loser.conflictOpen, true);
  assert.equal(loser.readyForPapermaking, false);
  assert.equal(winner.vatId, "二号缸");

  // 腾出缸（赢家换到别的缸）后，冲突方重试成功并清除冲突
  await ledger.configureVat({ id: "三号缸", capacity: 1 });
  await ledger.transferVat(winner.code, { targetVatId: "三号缸" });
  await ledger.transferVat(loser.code, { targetVatId: "二号缸" });
  const loserAfter = await ledger.getBatch(loser.code);
  assert.equal(loserAfter.vatId, "二号缸");
  assert.equal(loserAfter.conflictOpen, false);
});

test("换缸冲突重放结论一致：同一单号再次提交仍是失败，不产生新事件", async () => {
  const dir = await freshDir();
  const ledger = await openLedger(dir);
  await ledger.configureVat({ id: "一号缸", capacity: 1 });
  await ledger.configureVat({ id: "二号缸", capacity: 1 });
  await ledger.registerBatch({ code: "PF-A", vatId: "一号缸" });
  await ledger.registerBatch({ code: "PF-B", vatId: "二号缸" }); // 二号缸已被占
  const first = await catchError(() =>
    ledger.transferVat("PF-A", { targetVatId: "二号缸", ticket: "T-RETRY" }),
  );
  assert.equal(first.code, "vat_full");
  const eventsBefore = (await ledger.listEvents()).length;
  const second = await catchError(() =>
    ledger.transferVat("PF-A", { targetVatId: "二号缸", ticket: "T-RETRY" }),
  );
  assert.equal(second.code, "vat_full");
  assert.equal((await ledger.listEvents()).length, eventsBefore);
});

test("入缸即占缸：满缸不能建档，不存在半成品批次", async () => {
  const dir = await freshDir();
  const ledger = await openLedger(dir);
  await ledger.configureVat({ id: "一号缸", capacity: 1 });
  await ledger.registerBatch({ code: "PF-A", vatId: "一号缸" });
  const err = await catchError(() => ledger.registerBatch({ code: "PF-B", vatId: "一号缸" }));
  assert.equal(err.code, "vat_full");
  const err2 = await catchError(() => ledger.getBatch("PF-B"));
  assert.equal(err2.code, "batch_not_found");
});

test("异常批次不能显示为可抄纸；复测正常后恢复", async () => {
  const dir = await freshDir();
  const ledger = await openLedger(dir);
  await ledger.configureVat({ id: "一号缸", capacity: 2 });
  await ledger.registerBatch({ code: "PF-A", vatId: "一号缸" });
  for (let i = 1; i <= FERMENT_DAYS - 1; i++) {
    await ledger.recordObservation("PF-A", { ticket: `YC-${i}`, date: `2026-10-0${i}` });
  }
  await ledger.recordObservation("PF-A", { ticket: "YC-7", date: "2026-10-07", abnormal: "是" });
  let b = await ledger.getBatch("PF-A");
  assert.equal(b.days, FERMENT_DAYS);
  assert.equal(b.status, "异常观察");
  assert.equal(b.readyForPapermaking, false);
  assert.deepEqual(b.blockers[0], "最近观察仍有异常，需复测正常");

  await ledger.recordObservation("PF-A", { ticket: "YC-8", date: "2026-10-08" });
  b = await ledger.getBatch("PF-A");
  assert.equal(b.readyForPapermaking, true);
  assert.equal(b.status, "可抄纸");
});

test("未完成批次不可抄纸；满天数且无异常才可", async () => {
  const dir = await freshDir();
  const ledger = await openLedger(dir);
  await ledger.configureVat({ id: "一号缸", capacity: 2 });
  await ledger.registerBatch({ code: "PF-A", vatId: "一号缸" });
  for (let i = 1; i <= FERMENT_DAYS - 1; i++) {
    await ledger.recordObservation("PF-A", { ticket: `YC-${i}`, date: `2026-10-0${i}` });
  }
  const b = await ledger.getBatch("PF-A");
  assert.equal(b.complete, false);
  assert.equal(b.status, "发酵中");
  assert.equal(b.readyForPapermaking, false);
});

test("断电恢复：日志末尾写坏半截会被截掉并按事件重算；重启后状态一致", async () => {
  const dir = await freshDir();
  const ledger = await openLedger(dir);
  await ledger.configureVat({ id: "一号缸", capacity: 2 });
  await ledger.registerBatch({ code: "PF-A", vatId: "一号缸" });
  await ledger.recordObservation("PF-A", { ticket: "YC-1", date: "2026-10-01" });

  // 模拟断电：追加一行写了一半的 JSON（没有对应 fsync 的事件）
  appendFileSync(join(dir, "events.jsonl"), '{"seq":3,"id":"EVT-torn","type":"obser');
  const restarted = await openLedger(dir);
  const b = await restarted.getBatch("PF-A");
  assert.equal(b.days, 1);
  assert.equal(b.vatId, "一号缸");
  const events = await restarted.listEvents();
  assert.equal(events.length, 3); // vat_configured / batch_registered / observation_recorded

  // 截掉坏尾巴后账本继续可写，哈希链接得上
  await restarted.recordObservation("PF-A", { ticket: "YC-2", date: "2026-10-02" });
  assert.equal((await restarted.getBatch("PF-A")).days, 2);
});

test("同一天多笔观察只算一个发酵日", async () => {
  const dir = await freshDir();
  const ledger = await openLedger(dir);
  await ledger.configureVat({ id: "一号缸", capacity: 2 });
  await ledger.registerBatch({ code: "PF-A", vatId: "一号缸" });
  await ledger.recordObservation("PF-A", { ticket: "YC-1", date: "2026-10-01", note: "白班" });
  await ledger.recordObservation("PF-A", { ticket: "YC-2", date: "2026-10-01", note: "夜班" });
  const b = await ledger.getBatch("PF-A");
  assert.equal(b.days, 1);
  assert.deepEqual(b.observationDates, ["2026-10-01"]);
});
