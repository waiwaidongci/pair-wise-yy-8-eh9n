import http from "node:http";
import { mkdir, readFile, writeFile, rename } from "node:fs/promises";
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const dbPath = join(__dirname, "data", "paper-pulp-fermentation.json");
const port = Number(process.env.PORT || 3039);

const SCHEMA_VERSION = 2;
const STAGES = ["入缸", "发酵中", "可抄纸", "异常观察"];
const READY_DAYS = 7;
const DEFAULT_VATS = [
  { code: "一号缸", capacity: 1 },
  { code: "二号缸", capacity: 1 },
  { code: "三号缸", capacity: 1 },
  { code: "四号缸", capacity: 1 },
];

const seed = {
  schemaVersion: SCHEMA_VERSION,
  vats: DEFAULT_VATS.map(v => ({ ...v })),
  batches: [
    {
      id: "PF-001",
      code: "PF-001",
      source: "构树皮",
      owner: "林素",
      createdAt: "2026-06-15T00:00:00.000Z",
      events: [
        {
          type: "batch.created",
          at: "2026-06-15T00:00:00.000Z",
          data: { code: "PF-001", source: "构树皮", vat: "三号缸", owner: "林素" },
        },
        {
          type: "observation",
          at: "2026-06-15T00:00:00.000Z",
          serial: "PF-001-obs-1",
          data: { temperature: "24.6", smell: "微酸", fiber: "开始松散", changedWater: "", abnormal: false, note: "温度24.6，气味微酸，纤维开始松散" },
        },
      ],
    },
  ],
};

const str = v => (v === undefined || v === null) ? "" : String(v);
const truthy = v => v === true || v === "是" || v === "有" || v === "on" || v === "true";

function httpError(status, error, extra) {
  const e = new Error(error);
  e.status = status;
  if (extra) Object.assign(e, extra);
  return e;
}

// 串行化所有读-改-写，避免两个终端同时提交互相覆盖
let queue = Promise.resolve();
function withLock(fn) {
  const run = queue.then(fn, fn);
  queue = run.then(() => undefined, () => undefined);
  return run;
}

// ---- 迁移：旧的 items 单文件记录升级为事件账 ----
function migrate(raw) {
  if (raw && raw.schemaVersion === SCHEMA_VERSION && Array.isArray(raw.batches)) {
    raw.vats = Array.isArray(raw.vats) && raw.vats.length ? raw.vats : DEFAULT_VATS.map(v => ({ ...v }));
    return raw;
  }
  const vats = Array.isArray(raw?.vats) && raw.vats.length ? raw.vats : DEFAULT_VATS.map(v => ({ ...v }));
  const batches = [];
  for (const item of (raw?.items || [])) {
    const events = [];
    const createdLog = (item.logs || []).find(l => l.step === "建档") || (item.logs || [])[0];
    const createdAt = createdLog?.at || new Date(0).toISOString();
    events.push({
      type: "batch.created",
      at: createdAt,
      data: { code: str(item.code), source: str(item.source), vat: str(item.vat), owner: str(item.owner) },
      migrated: true,
    });
    const obsAts = new Set();
    let n = 0;
    for (const o of (item.observations || [])) {
      n += 1;
      obsAts.add(o.at);
      events.push({
        type: "observation",
        at: o.at,
        serial: str(item.code) + "-mig-obs-" + n,
        data: { temperature: str(o.temperature), smell: str(o.smell), fiber: str(o.fiber), changedWater: str(o.changedWater), abnormal: truthy(o.abnormal), note: str(o.note) },
        migrated: true,
      });
    }
    for (const l of (item.logs || [])) {
      if (l.step === "观察") {
        if (!obsAts.has(l.at)) {
          n += 1;
          events.push({
            type: "observation",
            at: l.at,
            serial: str(item.code) + "-mig-log-" + n,
            data: { note: str(l.note), abnormal: truthy(l.abnormal), temperature: "", smell: "", fiber: "", changedWater: "" },
            migrated: true,
          });
        }
      } else {
        events.push({ type: "log", at: l.at, data: { step: str(l.step), note: str(l.note) }, migrated: true });
      }
    }
    events.sort((a, b) => String(a.at).localeCompare(String(b.at)));
    batches.push({
      id: str(item.id || item.code || "PF-" + Date.now()),
      code: str(item.code),
      source: str(item.source),
      owner: str(item.owner),
      createdAt: events[0]?.at || new Date().toISOString(),
      migrated: true,
      legacy: { days: item.days, status: item.status },
      events,
    });
  }
  return { schemaVersion: SCHEMA_VERSION, vats, batches, migratedFrom: 1 };
}

// ---- 事件重算：同一份事件日志 fold 出全部派生状态 ----
function effectiveObservations(batch) {
  const map = new Map();
  for (const e of batch.events) {
    if (e.type === "observation") {
      map.set(e.serial, { ...e.data, serial: e.serial, at: e.at });
    } else if (e.type === "observation.corrected") {
      const prev = map.get(e.serial);
      if (prev) map.set(e.serial, { ...prev, ...e.data, serial: e.serial, at: prev.at, correctedAt: e.at });
    }
  }
  return [...map.values()].sort((a, b) => String(a.at).localeCompare(String(b.at)));
}

function fold(batch) {
  let vat = "";
  for (const e of batch.events) {
    if (e.type === "batch.created") vat = e.data.vat || vat;
    else if (e.type === "vat.changed") vat = e.data.to || vat;
  }
  const observations = effectiveObservations(batch);
  return { vat, days: observations.length, abnormal: observations.some(o => o.abnormal), observations };
}

function vatCapacity(db, vatCode) {
  const v = db.vats.find(v => v.code === vatCode);
  return v ? v.capacity : 1;
}

function recomputeAll(db) {
  for (const b of db.batches) {
    const f = fold(b);
    b.vat = f.vat;
    b.days = f.days;
    b.abnormal = f.abnormal;
    b.observations = f.observations;
    b.conflicts = [];
  }
  // 缸位容量：同一口缸的在养批数超过容量 → 涉及批次全部标冲突
  const occupants = new Map();
  for (const b of db.batches) {
    if (!b.vat) continue;
    if (!occupants.has(b.vat)) occupants.set(b.vat, []);
    occupants.get(b.vat).push(b);
  }
  for (const [vat, list] of occupants) {
    const cap = vatCapacity(db, vat);
    if (list.length > cap) {
      for (const b of list) {
        b.conflicts.push({ type: "vat_capacity", vat, capacity: cap, occupants: list.map(x => x.code) });
      }
    }
  }
  // 现场单号跨批次重复 → 冲突
  const serialOwners = new Map();
  for (const b of db.batches) {
    for (const e of b.events) {
      if (!e.serial) continue;
      if (!serialOwners.has(e.serial)) serialOwners.set(e.serial, []);
      serialOwners.get(e.serial).push(b);
    }
  }
  for (const [serial, owners] of serialOwners) {
    if (new Set(owners.map(b => b.id)).size > 1) {
      for (const b of owners) {
        if (!b.conflicts.some(c => c.type === "serial_duplicate" && c.serial === serial)) {
          b.conflicts.push({ type: "serial_duplicate", serial });
        }
      }
    }
  }
  // 状态派生：有冲突 → 异常观察；资料不全 → 锁定；满 7 天且无异常才允许可抄纸
  for (const b of db.batches) {
    b.complete = Boolean(b.source && b.owner && b.vat);
    b.blocked = b.conflicts.length > 0 || !b.complete;
    if (b.conflicts.length > 0 || b.abnormal) b.status = "异常观察";
    else if (b.complete && b.days >= READY_DAYS) b.status = "可抄纸";
    else if (b.days === 0) b.status = "入缸";
    else b.status = "发酵中";
    b.ready = b.status === "可抄纸";
  }
  return db;
}

async function loadDb() {
  if (!existsSync(dbPath)) {
    await mkdir(dirname(dbPath), { recursive: true });
    await writeFile(dbPath, JSON.stringify(seed, null, 2));
  }
  const raw = JSON.parse(await readFile(dbPath, "utf8"));
  const db = migrate(raw);
  recomputeAll(db); // 每次启动/写入都从事件重算，断电后状态与事件账始终一致
  return db;
}

async function saveDb(db) {
  recomputeAll(db);
  const tmp = dbPath + ".tmp";
  await writeFile(tmp, JSON.stringify(db, null, 2));
  await rename(tmp, dbPath); // 原子替换，断电不产生半文件
}

function findBatch(db, id) {
  return db.batches.find(b => String(b.id) === String(id) || b.code === id);
}

function publicBatch(b) {
  return { ...b, eventCount: b.events.length };
}

async function body(req) {
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  return chunks.length ? JSON.parse(Buffer.concat(chunks).toString("utf8")) : {};
}
function send(res, status, data) {
  res.writeHead(status, { "Content-Type": "application/json; charset=utf-8" });
  res.end(JSON.stringify(data, null, 2));
}
function html(res, text) {
  res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
  res.end(text);
}

function computeStats(db) {
  const stats = Object.fromEntries(STAGES.map(s => [s, 0]));
  let conflicts = 0;
  for (const b of db.batches) {
    if (stats[b.status] !== undefined) stats[b.status] += 1;
    if (b.conflicts.length) conflicts += 1;
  }
  stats.conflicts = conflicts;
  return stats;
}

// 观察补录入账：现场单号幂等，重复补传只认第一次
async function submitObservation(db, batch, input) {
  const serial = str(input.serial).trim();
  if (!serial) throw httpError(400, "serial_required");
  if (batch.events.some(e => e.serial === serial)) {
    return { idempotent: true, batch: publicBatch(batch) }; // 回网重放：原样返回，不追加事件、不增加天数
  }
  const other = db.batches.find(b => b.id !== batch.id && b.events.some(e => e.serial === serial));
  if (other) throw httpError(409, "serial_conflict", { retryable: false, serial, other: other.code });
  const at = input.at ? new Date(input.at).toISOString() : new Date().toISOString();
  batch.events.push({
    type: "observation",
    at,
    serial,
    data: {
      temperature: str(input.temperature),
      smell: str(input.smell),
      fiber: str(input.fiber),
      changedWater: str(input.changedWater),
      abnormal: truthy(input.abnormal),
      note: str(input.note),
    },
  });
  await saveDb(db);
  return { idempotent: false, batch: publicBatch(batch) };
}

// 换缸入账：目标缸容量校验，冲突时原批次保留不动
async function submitVatChange(db, batch, input) {
  if (batch.conflicts.length > 0) {
    throw httpError(409, "batch_conflict", { retryable: false, batch: publicBatch(batch), conflicts: batch.conflicts });
  }
  const to = str(input.to).trim();
  if (!to) throw httpError(400, "to_required");
  if (to === batch.vat) return { idempotent: true, batch: publicBatch(batch) };
  const serial = str(input.serial).trim();
  if (serial && batch.events.some(e => e.type === "vat.changed" && e.serial === serial)) {
    return { idempotent: true, batch: publicBatch(batch) };
  }
  const cap = vatCapacity(db, to);
  const occupants = db.batches.filter(b => b.id !== batch.id && b.vat === to);
  if (occupants.length >= cap) {
    // 失败不落事件：原批次缸位不变，响应可重试
    throw httpError(409, "vat_occupied", { retryable: true, vat: to, capacity: cap, occupants: occupants.map(b => b.code), batch: publicBatch(batch) });
  }
  const from = batch.vat;
  batch.events.push({ type: "vat.changed", at: new Date().toISOString(), serial: serial || undefined, data: { from, to } });
  if (!db.vats.some(v => v.code === to)) db.vats.push({ code: to, capacity: 1 });
  await saveDb(db);
  return { idempotent: false, batch: publicBatch(batch) };
}

function page() {
  return `<!doctype html>
<html lang="zh-CN">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>古法纸浆入缸账</title>
  <style>
    :root { --bg:#f1f3ef; --panel:#fff; --ink:#20241f; --muted:#687066; --line:#d4ddd0; --accent:#526f43; --warn:#9b4937; --amber:#8a6d1f; }
    * { box-sizing:border-box; } body { margin:0; background:var(--bg); color:var(--ink); font-family:Arial,"PingFang SC",sans-serif; }
    header { padding:22px 28px; background:#fff; border-bottom:1px solid var(--line); display:flex; justify-content:space-between; gap:16px; align-items:center; }
    h1 { margin:0; font-size:26px; } h2 { margin:0 0 12px; font-size:18px; } main { display:grid; grid-template-columns:380px 1fr; gap:22px; padding:22px 28px; }
    form,.panel,.card,.stat { background:var(--panel); border:1px solid var(--line); border-radius:8px; padding:16px; }
    label { display:block; margin:10px 0 5px; color:var(--muted); font-size:13px; } input,select,textarea { width:100%; border:1px solid var(--line); border-radius:6px; padding:9px; font:inherit; background:#fff; } textarea { min-height:68px; }
    button { border:0; border-radius:6px; background:var(--accent); color:#fff; padding:10px 13px; font-weight:700; cursor:pointer; } button.secondary { background:#69736a; } button.small { padding:6px 10px; font-size:13px; }
    .stats { display:grid; grid-template-columns:repeat(auto-fit,minmax(120px,1fr)); gap:10px; margin-bottom:14px; } .stat strong { display:block; font-size:24px; }
    .toolbar { display:flex; gap:10px; flex-wrap:wrap; margin-bottom:14px; } .toolbar select,.toolbar input { width:auto; min-width:160px; }
    .grid { display:grid; grid-template-columns:repeat(auto-fill,minmax(320px,1fr)); gap:12px; } .card { display:grid; gap:8px; align-content:start; }
    .meta { color:var(--muted); font-size:13px; } .pill { display:inline-block; border:1px solid var(--line); border-radius:999px; padding:3px 8px; font-size:12px; }
    .pill.warn { color:var(--warn); border-color:var(--warn); font-weight:700; } .pill.ok { color:var(--accent); border-color:var(--accent); font-weight:700; }
    .logs { border-top:1px solid var(--line); padding-top:8px; max-height:160px; overflow:auto; font-size:13px; display:grid; gap:4px; }
    .warn { color:var(--warn); font-weight:700; } .amber { color:var(--amber); font-weight:700; }
    .row { display:flex; gap:8px; } .row > * { flex:1; }
    .vats { display:grid; grid-template-columns:repeat(auto-fill,minmax(180px,1fr)); gap:10px; }
    .vat-full { color:var(--warn); font-weight:700; }
    @media (max-width:900px){ header{display:block;padding:18px 16px;} main{grid-template-columns:1fr;padding:16px;} }
  </style>
</head>
<body>
  <header><div><h1>古法纸浆入缸账</h1><div class="meta">事件溯源 · 现场单号幂等 · 缸位容量锁定 · 状态由事件重算</div></div><button id="reload">刷新</button></header>
  <main>
    <section>
      <form id="createForm"><h2>新增纸浆批次</h2>
        <label>批次编号</label><input name="code" required placeholder="PF-002">
        <label>原料来源</label><input name="source" required placeholder="构树皮">
        <label>浸泡缸</label><select name="vat" id="createVat" required></select>
        <label>负责人</label><input name="owner" placeholder="林素">
        <button>保存批次（占用缸位）</button>
      </form>
      <form id="obsForm" style="margin-top:14px"><h2>每日观察补录</h2>
        <label>纸浆批次</label><select name="id" id="obsBatch"></select>
        <label>现场单号（补传幂等，重复提交只认第一次）</label>
        <div class="row"><input name="serial" id="obsSerial" required><button type="button" class="secondary small" id="genSerial">生成</button></div>
        <label>观察时间</label><input name="at" type="datetime-local" id="obsAt">
        <label>温度</label><input name="temperature" placeholder="25.1">
        <label>气味状态</label><input name="smell" placeholder="微酸">
        <label>纤维松散度</label><input name="fiber" placeholder="松散">
        <label>是否换水</label><select name="changedWater"><option value="">未记录</option><option>是</option><option>否</option></select>
        <label>异常（异味或霉点）</label><input name="abnormal" type="checkbox" style="width:auto">
        <label>备注</label><textarea name="note"></textarea>
        <button>提交补录（入账）</button>
      </form>
      <form id="vatForm" style="margin-top:14px"><h2>换缸</h2>
        <label>纸浆批次</label><select name="id" id="vatBatch"></select>
        <label>目标缸位</label><select name="to" id="vatTarget"></select>
        <button>换入目标缸（占满则失败，原批次不动）</button>
      </form>
    </section>
    <section>
      <div class="stats" id="stats"></div>
      <div class="panel" style="margin-bottom:14px"><h2>缸位容量</h2><div class="vats" id="vats"></div></div>
      <div class="toolbar"><select id="statusFilter"><option value="">全部状态</option>${STAGES.map(s => '<option>'+s+'</option>').join('')}</select><input id="search" placeholder="搜索编号或关键词"></div>
      <div class="panel"><h2>状态全部由事件重算：天数=观察条数，乱序/更正后自动重算；未完成或冲突批次锁为异常观察，不可抄纸。</h2><div class="grid" id="cards"></div></div>
    </section>
  </main>
  <script>
    var STAGES = ${JSON.stringify(STAGES)};
    var batches = [], vats = [];
    function api(path, options) {
      return fetch(path, options && options.body ? Object.assign({ headers: { 'Content-Type': 'application/json' } }, options) : options)
        .then(function (res) { return res.json().then(function (data) { if (!res.ok) { var e = new Error(data.error || '请求失败'); e.data = data; throw e; } return data; }); });
    }
    function genSerial() {
      var d = new Date();
      var shift = (d.getHours() >= 6 && d.getHours() < 18) ? '白班' : '夜班';
      var date = d.toISOString().slice(0, 10).replace(/-/g, '');
      return 'YP-' + date + '-' + shift + '-' + Math.floor(1000 + Math.random() * 9000);
    }
    function nowInput() {
      var d = new Date(Date.now() - new Date().getTimezoneOffset() * 60000);
      return d.toISOString().slice(0, 16);
    }
    function load() {
      return Promise.all([api('/api/items'), api('/api/vats')]).then(function (r) {
        batches = r[0]; vats = r[1]; render();
      });
    }
    function renderVatSelects() {
      var opts = vats.map(function (v) {
        var full = v.occupants.length >= v.capacity;
        return '<option value="' + v.code + '"' + (full ? ' disabled' : '') + '>' + v.code + '（' + v.occupants.length + '/' + v.capacity + '）' + (full ? ' 已满' : '') + '</option>';
      }).join('');
      document.querySelector('#createVat').innerHTML = '<option value="">（未入缸，资料不完整）</option>' + opts;
      document.querySelector('#vatTarget').innerHTML = opts;
    }
    function render() {
      renderVatSelects();
      var batchOpts = batches.map(function (b) {
        return '<option value="' + b.id + '">' + b.code + ' · ' + b.source + ' · ' + b.vat + '</option>';
      }).join('');
      document.querySelector('#obsBatch').innerHTML = batchOpts;
      document.querySelector('#vatBatch').innerHTML = batchOpts;
      var stats = { '入缸': 0, '发酵中': 0, '可抄纸': 0, '异常观察': 0 };
      var conflicts = 0;
      batches.forEach(function (b) { stats[b.status] += 1; if (b.conflicts && b.conflicts.length) conflicts += 1; });
      stats['冲突'] = conflicts;
      document.querySelector('#stats').innerHTML = Object.keys(stats).map(function (k) {
        return '<div class="stat"><span>' + k + '</span><strong>' + stats[k] + '</strong></div>';
      }).join('');
      document.querySelector('#vats').innerHTML = vats.map(function (v) {
        var full = v.occupants.length >= v.capacity;
        return '<div class="pill' + (full ? ' warn' : '') + '">' + v.code + '：' + v.occupants.length + '/' + v.capacity + (full ? ' <span class="vat-full">已满</span>' : '') + '</div>';
      }).join('');
      var status = document.querySelector('#statusFilter').value;
      var q = document.querySelector('#search').value.trim();
      var visible = batches.filter(function (b) {
        return (!status || b.status === status) && (!q || JSON.stringify(b).includes(q));
      });
      document.querySelector('#cards').innerHTML = visible.map(cardHtml).join('');
      document.querySelectorAll('[data-vat-btn]').forEach(function (btn) {
        btn.onclick = function () {
          var id = btn.dataset.vatBtn;
          var to = document.querySelector('[data-vat-target="' + id + '"]').value;
          if (!to) return;
          api('/api/items/' + id + '/vat', { method: 'POST', body: JSON.stringify({ to: to, serial: genSerial() }) })
            .then(function (r) {
              if (r.idempotent) alert('重复换缸请求已忽略，未重复入账');
              return load();
            })
            .catch(function (e) {
              var d = e.data || {};
              alert('换缸未生效，原批次保留在 ' + (d.batch ? d.batch.vat : '原缸位') + '（' + e.message + '）' + (d.retryable ? '，可重试' : ''));
              load();
            });
        };
      });
    }
    function cardHtml(b) {
      var badges = '';
      if (b.ready) badges += ' <span class="pill ok">可抄纸</span>';
      if (b.blocked && !b.conflicts.length) badges += ' <span class="pill warn">资料不完整·锁定</span>';
      if (b.conflicts && b.conflicts.length) badges += ' <span class="pill warn">冲突·锁定</span>';
      var conflicts = (b.conflicts || []).map(function (c) {
        if (c.type === 'vat_capacity') return '<div class="warn">缸位超容：' + c.vat + ' 容量 ' + c.capacity + '，在养 ' + c.occupants.join('、') + '</div>';
        return '<div class="warn">现场单号跨批次重复：' + c.serial + '</div>';
      }).join('');
      var obs = (b.observations || []).slice(-6).map(function (o) {
        return '<div>' + o.at.slice(0, 16).replace('T', ' ') + ' · ' + o.serial + '：温度' + (o.temperature || '-') + ' 气味' + (o.smell || '-') + ' 纤维' + (o.fiber || '-') + ' 换水' + (o.changedWater || '-') + (o.abnormal ? ' <span class="warn">异常</span>' : '') + '</div>';
      }).join('');
      var vatChanges = b.events.filter(function (e) { return e.type === 'vat.changed'; }).map(function (e) {
        return '<div class="meta">换缸 ' + (e.data.from || '未入缸') + ' → ' + e.data.to + '</div>';
      }).join('');
      var logs = b.events.filter(function (e) { return e.type === 'log'; }).map(function (e) {
        return '<div class="meta">' + e.data.step + '：' + (e.data.note || '') + '</div>';
      }).join('');
      var vatOpts = vats.map(function (v) {
        var full = v.occupants.length >= v.capacity;
        return '<option value="' + v.code + '"' + (full ? ' disabled' : '') + '>' + v.code + (full ? '（满）' : '') + '</option>';
      }).join('');
      return '<article class="card"><h3>' + b.code + '</h3><div><span class="pill">' + b.status + '</span>' + badges + '</div>'
        + '<div><b>原料</b> ' + (b.source || '<span class="warn">缺</span>') + ' · <b>负责人</b> ' + (b.owner || '<span class="warn">缺</span>') + '</div>'
        + '<div><b>当前缸位</b> ' + (b.vat || '<span class="warn">未入缸</span>') + ' · <b>发酵天数</b> ' + b.days + ' 天（' + (b.observations || []).length + ' 条观察）</div>'
        + conflicts
        + '<div class="logs">' + (obs || '<div class="meta">暂无观察记录</div>') + vatChanges + logs + '</div>'
        + '<div class="row"><select data-vat-target="' + b.id + '">' + vatOpts + '</select><button class="secondary small" data-vat-btn="' + b.id + '">换缸</button></div>'
        + '</article>';
    }
    document.querySelector('#genSerial').onclick = function () { document.querySelector('#obsSerial').value = genSerial(); };
    document.querySelector('#reload').onclick = load;
    document.querySelector('#statusFilter').onchange = render;
    document.querySelector('#search').oninput = render;
    document.querySelector('#createForm').onsubmit = function (ev) {
      ev.preventDefault();
      var data = Object.fromEntries(new FormData(this).entries());
      if (!data.vat) data.vat = '';
      api('/api/items', { method: 'POST', body: JSON.stringify(data) }).then(function () {
        ev.target.reset();
        return load();
      }).catch(function (e) { alert('建档失败：' + e.message + (e.data && e.data.retryable ? '，可重试' : '')); });
    };
    document.querySelector('#obsForm').onsubmit = function (ev) {
      ev.preventDefault();
      var data = Object.fromEntries(new FormData(this).entries());
      data.abnormal = !!data.abnormal;
      if (!data.serial) data.serial = genSerial();
      if (!data.at) data.at = new Date().toISOString();
      api('/api/items/' + data.id + '/observations', { method: 'POST', body: JSON.stringify(data) })
        .then(function (r) {
          if (r.idempotent) alert('该现场单号已补录过，未重复入账（天数不变）');
          ev.target.reset();
          document.querySelector('#obsSerial').value = genSerial();
          document.querySelector('#obsAt').value = nowInput();
          return load();
        })
        .catch(function (e) {
          alert('补录未生效，原批次保留不变（' + e.message + '）' + (e.data && e.data.retryable ? '，可重试' : ''));
          load();
        });
    };
    document.querySelector('#vatForm').onsubmit = function (ev) {
      ev.preventDefault();
      var data = Object.fromEntries(new FormData(this).entries());
      api('/api/items/' + data.id + '/vat', { method: 'POST', body: JSON.stringify({ to: data.to, serial: genSerial() }) })
        .then(function (r) {
          if (r.idempotent) alert('重复换缸请求已忽略');
          return load();
        })
        .catch(function (e) {
          alert('换缸未生效，原批次保留在 ' + (e.data && e.data.batch ? e.data.batch.vat : '原缸位') + '（' + e.message + '）' + (e.data && e.data.retryable ? '，可重试' : ''));
          load();
        });
    };
    document.querySelector('#obsSerial').value = genSerial();
    document.querySelector('#obsAt').value = nowInput();
    load();
  </script>
</body>
</html>`;
}

const server = http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url, `http://${req.headers.host}`);
    if (req.method === "GET" && url.pathname === "/") return html(res, page());

    if (req.method === "GET" && url.pathname === "/api/items") {
      const db = await loadDb();
      return send(res, 200, db.batches.map(publicBatch));
    }

    if (req.method === "GET" && url.pathname === "/api/vats") {
      const db = await loadDb();
      return send(res, 200, db.vats.map(v => ({
        ...v,
        occupants: db.batches.filter(b => b.vat === v.code).map(b => b.code),
      })));
    }

    if (req.method === "GET" && url.pathname === "/api/stats") {
      const db = await loadDb();
      return send(res, 200, computeStats(db));
    }

    if (req.method === "POST" && url.pathname === "/api/items") {
      const input = await body(req);
      const result = await withLock(async () => {
        const db = await loadDb();
        const code = str(input.code).trim();
        if (!code) throw httpError(400, "code_required");
        if (db.batches.some(b => b.code === code)) throw httpError(409, "code_exists", { retryable: false });
        const vat = str(input.vat).trim();
        if (vat) {
          const cap = vatCapacity(db, vat);
          const occupants = db.batches.filter(b => b.vat === vat);
          if (occupants.length >= cap) {
            throw httpError(409, "vat_occupied", { retryable: true, vat, capacity: cap, occupants: occupants.map(b => b.code) });
          }
        }
        const now = new Date().toISOString();
        const batch = {
          id: "PF-" + Date.now(),
          code,
          source: str(input.source).trim(),
          owner: str(input.owner).trim(),
          createdAt: now,
          events: [{
            type: "batch.created",
            at: now,
            data: { code, source: str(input.source).trim(), vat, owner: str(input.owner).trim() },
          }],
        };
        db.batches.push(batch);
        if (vat && !db.vats.some(v => v.code === vat)) db.vats.push({ code: vat, capacity: 1 });
        await saveDb(db);
        return publicBatch(batch);
      });
      return send(res, 201, result);
    }

    const one = url.pathname.match(/^\/api\/items\/([^/]+)$/);
    if (one && req.method === "GET") {
      const db = await loadDb();
      const batch = findBatch(db, one[1]);
      if (!batch) return send(res, 404, { error: "item_not_found" });
      return send(res, 200, publicBatch(batch));
    }

    const obsMatch = url.pathname.match(/^\/api\/items\/([^/]+)\/observations$/);
    if (obsMatch && req.method === "POST") {
      const input = await body(req);
      const result = await withLock(async () => {
        const db = await loadDb();
        const batch = findBatch(db, obsMatch[1]);
        if (!batch) throw httpError(404, "item_not_found");
        return submitObservation(db, batch, input);
      });
      return send(res, result.idempotent ? 200 : 201, result);
    }

    const corrMatch = url.pathname.match(/^\/api\/items\/([^/]+)\/observations\/([^/]+)\/correct$/);
    if (corrMatch && req.method === "POST") {
      const input = await body(req);
      const result = await withLock(async () => {
        const db = await loadDb();
        const batch = findBatch(db, corrMatch[1]);
        if (!batch) throw httpError(404, "item_not_found");
        const serial = corrMatch[2];
        if (!batch.events.some(e => e.serial === serial)) throw httpError(404, "serial_not_found");
        batch.events.push({
          type: "observation.corrected",
          at: new Date().toISOString(),
          serial,
          data: {
            temperature: str(input.temperature),
            smell: str(input.smell),
            fiber: str(input.fiber),
            changedWater: str(input.changedWater),
            abnormal: truthy(input.abnormal),
            note: str(input.note),
          },
        });
        await saveDb(db);
        return { idempotent: false, batch: publicBatch(batch) };
      });
      return send(res, 200, result);
    }

    const vatMatch = url.pathname.match(/^\/api\/items\/([^/]+)\/vat$/);
    if (vatMatch && req.method === "POST") {
      const input = await body(req);
      const result = await withLock(async () => {
        const db = await loadDb();
        const batch = findBatch(db, vatMatch[1]);
        if (!batch) throw httpError(404, "item_not_found");
        return submitVatChange(db, batch, input);
      });
      return send(res, result.idempotent ? 200 : 201, result);
    }

    // 兼容旧版接口：action 视为补录观察（可用 serial 幂等），logs 视为备注
    const action = url.pathname.match(/^\/api\/items\/([^/]+)\/action$/);
    if (action && req.method === "POST") {
      const input = await body(req);
      const result = await withLock(async () => {
        const db = await loadDb();
        const batch = findBatch(db, action[1]);
        if (!batch) throw httpError(404, "item_not_found");
        return submitObservation(db, batch, {
          serial: str(input.serial).trim() || ("legacy-" + Date.now() + "-" + Math.random().toString(36).slice(2, 7)),
          at: input.at,
          temperature: input.temperature,
          smell: input.smell,
          fiber: input.fiber,
          changedWater: input.changedWater,
          abnormal: input.abnormal,
          note: input.note,
        });
      });
      return send(res, result.idempotent ? 200 : 201, result);
    }

    const log = url.pathname.match(/^\/api\/items\/([^/]+)\/logs$/);
    if (log && req.method === "POST") {
      const input = await body(req);
      const result = await withLock(async () => {
        const db = await loadDb();
        const batch = findBatch(db, log[1]);
        if (!batch) throw httpError(404, "item_not_found");
        batch.events.push({ type: "log", at: new Date().toISOString(), data: { step: str(input.step) || "备注", note: str(input.note) } });
        await saveDb(db);
        return publicBatch(batch);
      });
      return send(res, 201, result);
    }

    send(res, 404, { error: "not_found" });
  } catch (error) {
    const status = error.status || 500;
    send(res, status, {
      error: error.message,
      retryable: error.retryable || false,
      ...(error.vat ? { vat: error.vat } : {}),
      ...(error.occupants ? { occupants: error.occupants } : {}),
      ...(error.conflicts ? { conflicts: error.conflicts } : {}),
      ...(error.batch ? { batch: error.batch } : {}),
      ...(error.serial ? { serial: error.serial } : {}),
    });
  }
});

server.listen(port, () => console.log("古法纸浆入缸账 listening on http://localhost:" + port));
