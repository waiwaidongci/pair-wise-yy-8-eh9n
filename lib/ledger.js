import { createHash } from "node:crypto";
import {
  mkdir,
  open,
  readFile,
  rename,
  writeFile,
  unlink,
  stat,
} from "node:fs/promises";
import { existsSync } from "node:fs";
import { join } from "node:path";

// 发酵满多少个观察日方可抄纸
export const FERMENT_DAYS = 7;
const GENESIS = "GENESIS";
const LEGACY_FILE = "paper-pulp-fermentation.json";

export class LedgerError extends Error {
  constructor(code, message, http = 400, details = {}) {
    super(message);
    this.name = "LedgerError";
    this.code = code;
    this.http = http;
    this.details = details;
  }
}

// 稳定序列化：对象键排序，保证同一笔补传在任何终端算出相同摘要
function canonical(value) {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value !== null && typeof value === "object") {
    return `{${Object.keys(value)
      .sort()
      .map((k) => `${JSON.stringify(k)}:${canonical(value[k])}`)
      .join(",")}}`;
  }
  return JSON.stringify(value ?? null);
}

function digest(kind, material) {
  return createHash("sha256").update(`${kind}|${canonical(material)}`).digest("hex");
}

function hashEvent(prev, ev) {
  const body = canonical({
    seq: ev.seq,
    id: ev.id,
    ts: ev.ts,
    type: ev.type,
    ticket: ev.ticket,
    payload: ev.payload,
  });
  return createHash("sha256").update(`${prev}|${body}`).digest("hex");
}

function newEventId() {
  return "EVT-" + Date.now().toString(36) + "-" + Math.random().toString(36).slice(2, 8);
}

function isValidDate(s) {
  if (typeof s !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(s)) return false;
  const d = new Date(`${s}T00:00:00Z`);
  return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === s;
}

function todayUTC() {
  return new Date().toISOString().slice(0, 10);
}

function isAbnormal(v) {
  if (v === true) return true;
  if (v === false || v == null || v === "") return false;
  return /是|有|霉|异味|异常/.test(String(v));
}

/**
 * 入缸账：只追加事件日志（events.jsonl）+ 内存投影。
 * 投影随时可以从事件完整重算，断电重启后状态与记录必然一致。
 */
export class Ledger {
  constructor(dir) {
    this.dir = dir;
    this.eventsPath = join(dir, "events.jsonl");
    this.snapshotPath = join(dir, "snapshot.json");
    this.legacyPath = join(dir, `${LEGACY_FILE}.legacy.json`);
    this.migratingPath = join(dir, `${LEGACY_FILE}.migrating.json`);
    this.legacyOriginalPath = join(dir, LEGACY_FILE);
    this.#resetState();
  }

  #resetState() {
    this.state = {
      events: [], // 只追加、哈希成链
      batches: new Map(), // code -> 批次原始投影（派生值在 deriveBatch 计算）
      vats: new Map(), // id -> {id,name,capacity}
      tickets: new Map(), // 现场单号/幂等单号 -> 首次受理记录
    };
  }

  // 所有命令串行化：两个终端同时换入同一口缸，也只有一笔能成功
  #chain = Promise.resolve();

  // 所有命令串行化：两个终端同时换入同一口缸，也只有一笔能成功
  #enqueue(fn) {
    const run = this.#chain.then(() => fn());
    this.#chain = run.catch(() => {});
    return run;
  }

  async init() {
    await mkdir(this.dir, { recursive: true });
    await this.#loadJournal();
    await this.#migrateLegacy();
    await this.#writeSnapshot();
  }

  // ---------- 事件日志读写 ----------

  async #loadJournal() {
    let raw = "";
    if (existsSync(this.eventsPath)) raw = await readFile(this.eventsPath, "utf8");
    const lines = raw.split("\n");
    const good = [];
    let prev = GENESIS;
    let offset = 0; // 已验证通过内容的字节末尾
    let badLine = null;

    for (const line of lines) {
      const seg = line + "\n";
      if (line.trim() === "") {
        offset += Buffer.byteLength(seg);
        continue;
      }
      let ev;
      try {
        ev = JSON.parse(line);
      } catch {
        ev = null;
      }
      const ok =
        ev &&
        typeof ev.seq === "number" &&
        ev.hash === hashEvent(prev, ev) &&
        ev.seq === good.length + 1;
      if (!ok) {
        badLine = line;
        break;
      }
      good.push(ev);
      prev = ev.hash;
      offset += Buffer.byteLength(seg);
    }

    if (badLine !== null) {
      // 只允许日志末尾因断电写坏半截；坏行之后还有合法 JSON 行说明中段损坏，哈希链断裂
      const after = raw
        .slice(offset + Buffer.byteLength(badLine + "\n"))
        .split("\n")
        .some((l) => l.trim().startsWith("{"));
      if (after)
        throw new LedgerError("journal_corrupt", "事件日志中间记录损坏，哈希链断裂", 500);
      // 截掉写坏的半截尾巴（fsync 前断电的唯一可能现场）
      const fh = await open(this.eventsPath, "r+");
      try {
        await fh.truncate(offset);
        await fh.sync();
      } finally {
        await fh.close();
      }
    }

    this.#resetState();
    for (const ev of good) this.#apply(ev);
  }

  async #append(type, payload, ticket = null) {
    const ev = {
      seq: this.state.events.length + 1,
      id: newEventId(),
      ts: new Date().toISOString(),
      type,
      ticket,
      payload,
    };
    const prev = this.state.events.at(-1)?.hash ?? GENESIS;
    ev.hash = hashEvent(prev, ev);
    const line = JSON.stringify(ev) + "\n";

    // 单个追加句柄 + fsync：落盘后才更新投影，断电最多丢最后一笔未确认写入
    const fh = await open(this.eventsPath, "a");
    try {
      await fh.writeFile(line);
      await fh.sync();
    } finally {
      await fh.close();
    }
    this.#apply(ev);
    await this.#writeSnapshot();
    return ev;
  }

  #apply(ev) {
    const { batches, vats, tickets } = this.state;
    switch (ev.type) {
      case "vat_configured": {
        vats.set(ev.payload.id, {
          id: ev.payload.id,
          name: ev.payload.name || ev.payload.id,
          capacity: Number(ev.payload.capacity),
        });
        break;
      }
      case "batch_registered": {
        if (!batches.has(ev.payload.code)) {
          batches.set(ev.payload.code, {
            code: ev.payload.code,
            source: ev.payload.source || "",
            owner: ev.payload.owner || "",
            vatId: ev.payload.vatId,
            registeredAt: ev.payload.registeredAt || ev.ts,
            observations: [],
            transfers: [],
            conflict: null,
            legacy: ev.payload.legacy || null,
          });
        }
        break;
      }
      case "observation_recorded": {
        const b = batches.get(ev.payload.batchCode);
        if (b) {
          b.observations.push({
            ticket: ev.ticket,
            seq: ev.seq,
            date: ev.payload.date,
            ts: ev.ts,
            temperature: ev.payload.temperature || "",
            smell: ev.payload.smell || "",
            fiber: ev.payload.fiber || "",
            changedWater: ev.payload.changedWater || "",
            abnormal: !!ev.payload.abnormal,
            migrated: !!ev.payload.migrated,
            voided: false,
          });
        }
        break;
      }
      case "observation_amended": {
        const b = batches.get(ev.payload.batchCode);
        if (b) {
          const old = b.observations.find((o) => o.ticket === ev.payload.amendOf);
          if (old) old.voided = true;
          b.observations.push({
            ticket: ev.ticket,
            seq: ev.seq,
            date: ev.payload.date,
            ts: ev.ts,
            temperature: ev.payload.temperature || "",
            smell: ev.payload.smell || "",
            fiber: ev.payload.fiber || "",
            changedWater: ev.payload.changedWater || "",
            abnormal: !!ev.payload.abnormal,
            migrated: false,
            voided: false,
            amendedFrom: ev.payload.amendOf,
          });
          const oldTicket = tickets.get(ev.payload.amendOf);
          if (oldTicket) oldTicket.supersededBy = ev.ticket;
        }
        break;
      }
      case "vat_transferred": {
        const b = batches.get(ev.payload.batchCode);
        if (b) {
          b.vatId = ev.payload.toVatId;
          b.conflict = null; // 换缸成功即解除之前的占用冲突
          b.transfers.push({
            seq: ev.seq,
            ts: ev.ts,
            fromVatId: ev.payload.fromVatId,
            toVatId: ev.payload.toVatId,
            ticket: ev.ticket,
          });
        }
        break;
      }
      case "vat_transfer_blocked": {
        const b = batches.get(ev.payload.batchCode);
        if (b) {
          b.conflict = {
            seq: ev.seq,
            ts: ev.ts,
            targetVatId: ev.payload.toVatId,
            reason: ev.payload.reason,
            ticket: ev.ticket,
          };
        }
        break;
      }
      default:
        break;
    }

    if (ev.ticket) {
      // 只记录第一次受理：重复补传永远返回第一笔，不会再产生事件
      if (!tickets.has(ev.ticket)) {
        tickets.set(ev.ticket, {
          seq: ev.seq,
          type: ev.type,
          batchCode: ev.payload.batchCode || null,
          supersededBy: null,
        });
      }
    }
    this.state.events.push(ev);
  }

  async #writeSnapshot() {
    // 快照只是便于人读/排障的派生副本，启动时一律以事件日志重算为准
    const snap = {
      rebuiltAt: new Date().toISOString(),
      lastSeq: this.state.events.length,
      lastHash: this.state.events.at(-1)?.hash ?? GENESIS,
      vats: [...this.state.vats.values()],
      batches: [...this.state.batches.keys()].map((code) => this.deriveBatch(code)),
    };
    const tmp = `${this.snapshotPath}.tmp`;
    await writeFile(tmp, JSON.stringify(snap, null, 2));
    await rename(tmp, this.snapshotPath);
  }

  // ---------- 旧数据升级 ----------

  async #migrateLegacy() {
    // 先改名，迁移中途断电重启也能从中断点继续，且不会重复入账
    if (existsSync(this.legacyOriginalPath)) {
      try {
        await rename(this.legacyOriginalPath, this.migratingPath);
      } catch {
        /* 另一进程已改名则忽略 */
      }
    }
    const stage = existsSync(this.migratingPath)
      ? this.migratingPath
      : existsSync(this.legacyPath)
        ? this.legacyPath
        : null;
    if (!stage || !existsSync(stage)) return;

    let raw;
    try {
      raw = JSON.parse(await readFile(stage, "utf8"));
    } catch {
      return;
    }
    const items = Array.isArray(raw.items) ? raw.items : [];

    for (const item of items) {
      const code = String(item.code || item.id || "").trim();
      if (!code || this.state.batches.has(code)) continue; // 已迁过则跳过
      const vatId = String(item.vat || "未分缸").trim() || "未分缸";
      if (!this.state.vats.has(vatId)) {
        await this.#append("vat_configured", {
          id: vatId,
          name: vatId,
          capacity: 1,
          migratedVat: true,
        });
      }
      await this.#append(
        "batch_registered",
        {
          code,
          source: item.source || "",
          owner: item.owner || "",
          vatId,
          registeredAt: null,
          legacy: item, // 原批次内容原样保留，旧数据升级后仍可查
        },
        null,
      );

      // 旧 logs 与 observations 按日期合并去重，重放不再多加天数
      const byDate = new Map();
      const takeDate = (at) => {
        if (typeof at === "string" && /^\d{4}-\d{2}-\d{2}/.test(at)) return at.slice(0, 10);
        return null;
      };
      for (const log of item.logs || []) {
        const date = takeDate(log.at);
        if (!date) continue;
        byDate.set(date, {
          date,
          temperature: "",
          smell: "",
          fiber: "",
          changedWater: "",
          abnormal: !!log.abnormal,
          note: log.note || "",
        });
      }
      for (const ob of item.observations || []) {
        const date = takeDate(ob.at);
        if (!date) continue;
        byDate.set(date, {
          date,
          temperature: ob.temperature || "",
          smell: ob.smell || "",
          fiber: ob.fiber || "",
          changedWater: ob.changedWater || "",
          abnormal: !!ob.abnormal,
          note: "",
        });
      }
      let n = 0;
      for (const ob of [...byDate.values()].sort((a, b) => a.date.localeCompare(b.date))) {
        n += 1;
        await this.#append(
          "observation_recorded",
          {
            batchCode: code,
            date: ob.date,
            temperature: ob.temperature,
            smell: ob.smell,
            fiber: ob.fiber,
            changedWater: ob.changedWater,
            abnormal: ob.abnormal,
            note: ob.note,
            migrated: true,
          },
          `MIG-${code}-${n}`,
        );
      }
    }

    if (stage === this.migratingPath) {
      if (existsSync(this.legacyPath)) await unlink(this.legacyPath);
      await rename(this.migratingPath, this.legacyPath);
    }
  }

  // ---------- 派生投影：天数/状态全部从事件重算 ----------

  #vatOccupancy(exceptCode = null) {
    const occ = new Map();
    for (const b of this.state.batches.values()) {
      if (b.code === exceptCode) continue;
      occ.set(b.vatId, (occ.get(b.vatId) || 0) + 1);
    }
    return occ;
  }

  deriveBatch(code) {
    const b = this.state.batches.get(code);
    if (!b) return null;
    const live = b.observations.filter((o) => !o.voided);
    const dates = [...new Set(live.map((o) => o.date))].sort();
    const days = dates.length;
    const last = live.at(-1);
    const abnormalOpen = !!last?.abnormal;
    const conflictOpen = !!b.conflict;

    const blockers = [];
    if (conflictOpen) blockers.push(`换缸冲突未解决（目标缸 ${b.conflict.targetVatId} 已满）`);
    if (abnormalOpen) blockers.push("最近观察仍有异常，需复测正常");
    if (days < FERMENT_DAYS) blockers.push(`发酵天数不足（${days}/${FERMENT_DAYS}）`);
    const readyForPapermaking = blockers.length === 0;

    let status;
    if (conflictOpen) status = "换缸冲突";
    else if (abnormalOpen) status = "异常观察";
    else if (readyForPapermaking) status = "可抄纸";
    else if (days === 0) status = "入缸";
    else status = "发酵中";

    return {
      code: b.code,
      source: b.source,
      owner: b.owner,
      vatId: b.vatId,
      registeredAt: b.registeredAt,
      status,
      days,
      observationDates: dates,
      abnormalOpen,
      conflictOpen,
      readyForPapermaking,
      blockers,
      complete: days >= FERMENT_DAYS,
      observations: b.observations,
      transfers: b.transfers,
      conflict: b.conflict,
      migrated: !!b.legacy,
      legacy: b.legacy,
    };
  }

  // ---------- 命令 ----------

  #requireBatch(code) {
    const b = this.state.batches.get(code);
    if (!b) throw new LedgerError("batch_not_found", `批次 ${code} 不存在`, 404);
    return b;
  }

  #checkTicket(ticket, kind, material) {
    const known = this.state.tickets.get(ticket);
    if (!known) return null;
    if (known.supersededBy) {
      throw new LedgerError(
        "ticket_superseded",
        `现场单号 ${ticket} 的记录已被 ${known.supersededBy} 更正`,
        409,
        { supersededBy: known.supersededBy },
      );
    }
    return known; // 重复补传：交给调用方返回第一笔结果
  }

  async configureVat(input = {}) {
    return this.#enqueue(async () => {
      const id = String(input.id || "").trim();
      if (!id) throw new LedgerError("vat_id_required", "缸号必填");
      const capacity = Number(input.capacity);
      if (!Number.isInteger(capacity) || capacity < 1)
        throw new LedgerError("bad_capacity", "缸容量必须是正整数");
      const existing = this.state.vats.get(id);
      const payload = { id, name: String(input.name || id).trim(), capacity };
      if (existing && existing.name === payload.name && existing.capacity === capacity) {
        return { vat: existing, duplicate: true };
      }
      await this.#append("vat_configured", payload, input.ticket || null);
      return { vat: this.state.vats.get(id), duplicate: false };
    });
  }

  async registerBatch(input = {}) {
    return this.#enqueue(async () => {
      const code = String(input.code || "").trim();
      if (!code) throw new LedgerError("code_required", "批次编号必填");
      if (this.state.batches.has(code))
        throw new LedgerError("batch_exists", `批次 ${code} 已存在`, 409);
      const vatId = String(input.vatId || "").trim();
      if (!vatId) throw new LedgerError("vat_required", "入缸缸号必填");
      if (!this.state.vats.has(vatId))
        throw new LedgerError("vat_not_found", `缸 ${vatId} 未登记`, 404);

      const material = {
        code,
        source: String(input.source || "").trim(),
        owner: String(input.owner || "").trim(),
        vatId,
      };
      if (input.ticket) {
        const known = this.#checkTicket(input.ticket, "register", material);
        if (known) return { batch: this.deriveBatch(known.batchCode), duplicate: true };
      }

      // 入缸即占用缸容量：满缸时整笔失败，不留半成品批次
      const occ = this.#vatOccupancy();
      const vat = this.state.vats.get(vatId);
      if ((occ.get(vatId) || 0) >= vat.capacity)
        throw new LedgerError("vat_full", `缸 ${vatId} 容量已满（${vat.capacity} 批）`, 409, {
          vatId,
          capacity: vat.capacity,
          occupied: occ.get(vatId) || 0,
        });

      const payload = { ...material, registeredAt: new Date().toISOString(), legacy: null };
      await this.#append("batch_registered", payload, input.ticket || null);
      return { batch: this.deriveBatch(code), duplicate: false };
    });
  }

  async recordObservation(code, input = {}) {
    return this.#enqueue(async () => {
      this.#requireBatch(code);
      const ticket = String(input.ticket || "").trim();
      if (!ticket) throw new LedgerError("ticket_required", "观察必须带现场单号");
      const date = String(input.date || todayUTC()).trim();
      if (!isValidDate(date)) throw new LedgerError("bad_date", "日期格式应为 YYYY-MM-DD");

      const material = {
        batchCode: code,
        date,
        temperature: String(input.temperature || "").trim(),
        smell: String(input.smell || "").trim(),
        fiber: String(input.fiber || "").trim(),
        changedWater: String(input.changedWater || "").trim(),
        abnormal: isAbnormal(input.abnormal),
      };

      const known = this.state.tickets.get(ticket);
      if (known) {
        if (known.supersededBy)
          throw new LedgerError(
            "ticket_superseded",
            `现场单号 ${ticket} 已被 ${known.supersededBy} 更正`,
            409,
            { supersededBy: known.supersededBy },
          );
        if (known.batchCode !== code)
          throw new LedgerError("ticket_conflict", `现场单号 ${ticket} 已属于其他批次`, 409);
        const firstEv = this.state.events[known.seq - 1];
        const same =
          firstEv.type === "observation_recorded" &&
          digest("observation", firstEv.payload) === digest("observation", material);
        if (!same)
          throw new LedgerError(
            "ticket_conflict",
            `现场单号 ${ticket} 已有不同内容的记录；如需改动旧记录请按更正提交`,
            409,
          );
        // 重复补传：只认第一次，原样返回，不增加天数
        return { batch: this.deriveBatch(code), duplicate: true, ticket };
      }

      const amendOf = input.amendOf ? String(input.amendOf).trim() : null;
      if (amendOf) {
        const oldTicket = this.state.tickets.get(amendOf);
        if (!oldTicket || oldTicket.batchCode !== code)
          throw new LedgerError("amend_target_missing", "要更正的现场单号不存在", 404);
        if (oldTicket.supersededBy)
          throw new LedgerError("ticket_superseded", "该记录已被更正过", 409);
        await this.#append(
          "observation_amended",
          { ...material, amendOf },
          ticket,
        );
      } else {
        await this.#append("observation_recorded", material, ticket);
      }
      // 乱序补录或改动旧记录后，天数与状态在此随整份事件自然重算
      return { batch: this.deriveBatch(code), duplicate: false, ticket };
    });
  }

  async transferVat(code, input = {}) {
    return this.#enqueue(async () => {
      const b = this.#requireBatch(code);
      const toVatId = String(input.targetVatId || "").trim();
      if (!toVatId) throw new LedgerError("target_vat_required", "目标缸必填");
      if (!this.state.vats.has(toVatId))
        throw new LedgerError("vat_not_found", `缸 ${toVatId} 未登记`, 404);
      if (toVatId === b.vatId)
        throw new LedgerError("same_vat", "批次已在该缸中", 409);

      const material = { batchCode: code, targetVatId: toVatId };
      if (input.ticket) {
        const known = this.#checkTicket(input.ticket, "transfer", material);
        if (known) {
          // 重放此前的冲突/成功结果，保证重试结论一致
          const ev = this.state.events[known.seq - 1];
          if (ev.type === "vat_transfer_blocked")
            throw new LedgerError("vat_full", `缸 ${toVatId} 容量已满，换缸未成功`, 409, {
              replayed: true,
              vatId: toVatId,
            });
          return { batch: this.deriveBatch(code), duplicate: true, ticket: input.ticket };
        }
      }

      const occ = this.#vatOccupancy(code); // 本批仍占着原缸，不计入目标缸
      const vat = this.state.vats.get(toVatId);
      if ((occ.get(toVatId) || 0) >= vat.capacity) {
        // 占用失败也要留痕：批次保留，标记冲突，不得显示为可抄纸，可重试
        const ticket = input.ticket || `TB-${code}-${Date.now().toString(36)}`;
        await this.#append(
          "vat_transfer_blocked",
          {
            batchCode: code,
            fromVatId: b.vatId,
            toVatId,
            reason: "vat_full",
            capacity: vat.capacity,
          },
          ticket,
        );
        throw new LedgerError("vat_full", `缸 ${toVatId} 容量已满，换缸未成功`, 409, {
          vatId: toVatId,
          capacity: vat.capacity,
          ticket,
        });
      }

      const ticket = input.ticket || `TR-${code}-${Date.now().toString(36)}`;
      await this.#append(
        "vat_transferred",
        { batchCode: code, fromVatId: b.vatId, toVatId },
        ticket,
      );
      return { batch: this.deriveBatch(code), duplicate: false, ticket };
    });
  }

  // ---------- 查询 ----------

  async listBatches() {
    return this.#enqueue(() =>
      [...this.state.batches.keys()].map((code) => this.deriveBatch(code)),
    );
  }

  async getBatch(code) {
    return this.#enqueue(() => {
      const batch = this.deriveBatch(String(code));
      if (!batch) throw new LedgerError("batch_not_found", `批次 ${code} 不存在`, 404);
      return batch;
    });
  }

  async listVats() {
    return this.#enqueue(() => {
      const occ = this.#vatOccupancy();
      return [...this.state.vats.values()].map((v) => ({
        ...v,
        occupied: occ.get(v.id) || 0,
        occupants: [...this.state.batches.values()]
          .filter((b) => b.vatId === v.id)
          .map((b) => b.code),
      }));
    });
  }

  async listEvents(filter = {}) {
    return this.#enqueue(() => {
      let events = [...this.state.events];
      if (filter.batchCode)
        events = events.filter((ev) => ev.payload.batchCode === filter.batchCode);
      return events.map(({ hash, prev, ...rest }) => rest);
    });
  }

  async stats() {
    return this.#enqueue(() => {
      const stats = {
        入缸: 0,
        发酵中: 0,
        可抄纸: 0,
        异常观察: 0,
        换缸冲突: 0,
      };
      for (const code of this.state.batches.keys()) {
        stats[this.deriveBatch(code).status] += 1;
      }
      stats.lastSeq = this.state.events.length;
      return stats;
    });
  }

  async legacy() {
    return this.#enqueue(async () => {
      const path = existsSync(this.legacyPath)
        ? this.legacyPath
        : existsSync(this.legacyOriginalPath)
          ? this.legacyOriginalPath
          : null;
      if (!path) return { available: false, batches: [] };
      let raw;
      try {
        raw = JSON.parse(await readFile(path, "utf8"));
      } catch {
        return { available: false, batches: [] };
      }
      return {
        available: true,
        archivedAt: (await stat(path)).mtime.toISOString(),
        batches: Array.isArray(raw.items) ? raw.items : [],
      };
    });
  }
}

export async function openLedger(dir) {
  const ledger = new Ledger(dir);
  await ledger.init();
  return ledger;
}

// 仅供测试使用
export const _internals = { canonical, digest, hashEvent, isValidDate, isAbnormal, LEGACY_FILE };
