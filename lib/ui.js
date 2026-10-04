export function page({ fermentDays = 7 } = {}) {
  return `<!doctype html>
<html lang="zh-CN">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>古法纸浆入缸账</title>
  <style>
    :root { --bg:#f1f3ef; --panel:#fff; --ink:#20241f; --muted:#687066; --line:#d4ddd0; --accent:#526f43; --warn:#9b4937; --ok:#3c6b3a; }
    * { box-sizing:border-box; } body { margin:0; background:var(--bg); color:var(--ink); font-family:Arial,"PingFang SC",sans-serif; }
    header { padding:22px 28px; background:#fff; border-bottom:1px solid var(--line); display:flex; justify-content:space-between; gap:16px; align-items:center; }
    h1 { margin:0; font-size:26px; } h2 { margin:0 0 12px; font-size:18px; } main { display:grid; grid-template-columns:400px 1fr; gap:22px; padding:22px 28px; }
    form,.panel,.card,.stat,.vatcard { background:var(--panel); border:1px solid var(--line); border-radius:8px; padding:16px; }
    label { display:block; margin:10px 0 5px; color:var(--muted); font-size:13px; } input,select,textarea { width:100%; border:1px solid var(--line); border-radius:6px; padding:9px; font:inherit; background:#fff; }
    button { border:0; border-radius:6px; background:var(--accent); color:#fff; padding:10px 13px; font-weight:700; cursor:pointer; margin-top:12px; } button.secondary { background:#69736a; } button.warn { background:var(--warn); }
    .stats { display:grid; grid-template-columns:repeat(auto-fit,minmax(110px,1fr)); gap:10px; margin-bottom:14px; } .stat strong { display:block; font-size:24px; }
    .toolbar { display:flex; gap:10px; flex-wrap:wrap; margin-bottom:14px; } .toolbar select,.toolbar input { width:auto; min-width:160px; }
    .grid { display:grid; grid-template-columns:repeat(auto-fill,minmax(300px,1fr)); gap:12px; } .card { display:grid; gap:6px; }
    .meta { color:var(--muted); font-size:13px; } .pill { display:inline-block; border:1px solid var(--line); border-radius:999px; padding:3px 10px; font-size:12px; }
    .pill.ok { color:var(--ok); border-color:var(--ok); font-weight:700; } .pill.bad { color:var(--warn); border-color:var(--warn); font-weight:700; }
    .blockers { color:var(--warn); font-size:13px; margin:4px 0; padding-left:18px; }
    .logs { border-top:1px solid var(--line); padding-top:8px; max-height:140px; overflow:auto; font-size:13px; }
    .dup { color:var(--accent); font-size:13px; margin-top:8px; display:none; }
    .vats { display:grid; grid-template-columns:repeat(auto-fill,minmax(180px,1fr)); gap:10px; margin-top:10px; }
    .bar { height:8px; background:#e7ece4; border-radius:99px; overflow:hidden; margin:6px 0; } .bar i { display:block; height:100%; background:var(--accent); } .bar i.full { background:var(--warn); }
    .row2 { display:grid; grid-template-columns:1fr 1fr; gap:8px; }
    @media (max-width:900px){ header{display:block;padding:18px 16px;} main{grid-template-columns:1fr;padding:16px;} }
  </style>
</head>
<body>
  <header><div><h1>古法纸浆入缸账</h1><div class="meta">只追加事件账：观察补录、换缸占用、断电可重算 · 满 ${fermentDays} 个观察日且无未决异常/冲突才可抄纸</div></div><button id="reload">刷新</button></header>
  <main>
    <section>
      <form id="vatForm"><h2>登记浸泡缸</h2>
        <div class="row2"><div><label>缸号</label><input name="id" placeholder="如：三号缸" required></div>
        <div><label>容量（可容批数）</label><input name="capacity" type="number" min="1" value="1" required></div></div>
        <div><label>名称（可空）</label><input name="name"></div>
        <button>登记 / 调整缸容量</button><span class="dup" data-f="vatForm"></span>
      </form>

      <form id="createForm" style="margin-top:14px"><h2>新增纸浆批次（入缸即占缸）</h2>
        <label>批次编号</label><input name="code" required>
        <div class="row2"><div><label>原料来源</label><input name="source"></div><div><label>负责人</label><input name="owner"></div></div>
        <label>入缸</label><select name="vatId" id="createVat" required></select>
        <button>保存入缸批次</button><span class="dup" data-f="createForm"></span>
      </form>

      <form id="actionForm" style="margin-top:14px"><h2>观察补录（必须带现场单号）</h2>
        <div class="row2"><div><label>批次</label><select name="batch" id="itemSelect"></select></div>
        <div><label>观察日期</label><input name="date" type="date" required></div></div>
        <label>现场单号（重复补传只认第一次）</label><input name="ticket" required placeholder="如：YC-20260621-03-01">
        <div class="row2"><div><label>温度</label><input name="temperature"></div><div><label>气味状态</label><input name="smell"></div></div>
        <div class="row2"><div><label>纤维松散度</label><input name="fiber"></div><div><label>是否换水</label><input name="changedWater" placeholder="是 / 否"></div></div>
        <label>异味或霉点（异常）</label><select name="abnormal"><option value="">正常</option><option value="是">有异常</option></select>
        <button>提交观察</button><span class="dup" data-f="actionForm"></span>
      </form>

      <form id="transferForm" style="margin-top:14px"><h2>换缸（占用目标缸容量）</h2>
        <div class="row2"><div><label>批次</label><select name="batch" id="transferSelect"></select></div>
        <div><label>目标缸</label><select name="targetVatId" id="targetVat" required></select></div></div>
        <label>换缸单号（可空，自动生成）</label><input name="ticket">
        <button class="warn">换缸</button><span class="dup" data-f="transferForm"></span>
      </form>
    </section>
    <section>
      <div class="stats" id="stats"></div>
      <div class="panel"><h2>缸位占用</h2><div class="vats" id="vats"></div></div>
      <div class="toolbar" style="margin-top:14px">
        <select id="statusFilter"><option value="">全部状态</option><option>入缸</option><option>发酵中</option><option>可抄纸</option><option>异常观察</option><option>换缸冲突</option></select>
        <input id="search" placeholder="搜索编号 / 原料 / 负责人">
      </div>
      <div class="panel"><div class="grid" id="cards"></div></div>
    </section>
  </main>
  <script>
    const stages = ["入缸","发酵中","可抄纸","异常观察","换缸冲突"];
    const cards = document.querySelector('#cards');
    const statsEl = document.querySelector('#stats');
    const itemSelect = document.querySelector('#itemSelect');
    const transferSelect = document.querySelector('#transferSelect');
    const createVat = document.querySelector('#createVat');
    const targetVat = document.querySelector('#targetVat');
    let batches = [], vats = [];

    async function api(path, options) {
      const res = await fetch(path, options && options.body ? { ...options, headers:{'Content-Type':'application/json'} } : options);
      const data = await res.json();
      if (!res.ok) throw Object.assign(new Error(data.message || data.error || '请求失败'), { data, status: res.status });
      return data;
    }
    function genTicket(prefix) {
      const d = new Date();
      const p = n => String(n).padStart(2,'0');
      return prefix + '-' + d.getFullYear() + p(d.getMonth()+1) + p(d.getDate()) + '-' + p(d.getHours()) + p(d.getMinutes()) + '-' + Math.floor(Math.random()*90+10);
    }
    function markDup(formId, text) {
      const el = document.querySelector('.dup[data-f="'+formId+'"]');
      el.style.display = 'block'; el.textContent = text;
      setTimeout(() => { el.style.display = 'none'; }, 6000);
    }
    async function submitForm(form, path, prefix, label, method='POST') {
      const input = Object.fromEntries(new FormData(form).entries());
      if (!input.ticket && form.id === 'transferForm') input.ticket = genTicket('HG');
      try {
        const out = await api(path, { method, body: JSON.stringify(input) });
        if (out.duplicate) markDup(form.id, '重复补传：只认第一次的记录，未重复计天');
        else if (out.ticket) markDup(form.id, '已入账，事件单号：' + out.ticket);
        form.reset();
        await load();
      } catch (e) {
        if (e.status === 409) alert('占用冲突：' + (e.data.message || e.message) + '\\n原批次保留，可换缸后重试。');
        else alert((e.data && e.data.message) || e.message);
      }
    }

    function render() {
      const opts = vats.map(v => '<option value="'+v.id+'">'+v.name+'（'+v.occupied+'/'+v.capacity+'）</option>').join('');
      createVat.innerHTML = opts; targetVat.innerHTML = opts;
      const bopts = batches.map(b => '<option value="'+b.code+'">'+b.code+' · '+b.source+' · '+b.vatId+'</option>').join('');
      itemSelect.innerHTML = bopts; transferSelect.innerHTML = bopts;
      const stats = Object.fromEntries(stages.map(s => [s, batches.filter(i => i.status === s).length]));
      statsEl.innerHTML = stages.map(k => '<div class="stat"><span>'+k+'</span><strong>'+stats[k]+'</strong></div>').join('');
      vatsRender();
      const status = document.querySelector('#statusFilter').value;
      const q = document.querySelector('#search').value.trim();
      const visible = batches.filter(b => (!status || b.status === status) && (!q || JSON.stringify(b).includes(q)));
      cards.innerHTML = visible.map(cardHtml).join('') || '<div class="meta">暂无批次</div>';
    }
    function vatsRender() {
      document.querySelector('#vats').innerHTML = vats.map(v => {
        const pct = Math.min(100, Math.round(v.occupied / v.capacity * 100));
        const full = v.occupied >= v.capacity;
        return '<div class="vatcard"><b>'+v.name+'</b><div class="meta">'+v.id+' · '+(full?'已满':'有余位')+'</div>'
          + '<div class="bar"><i class="'+(full?'full':'')+'" style="width:'+pct+'%"></i></div>'
          + '<div class="meta">占用 '+v.occupied+'/'+v.capacity+'</div>'
          + '<div class="meta">'+(v.occupants.join('、') || '空缸')+'</div></div>';
      }).join('');
    }
    function cardHtml(b) {
      const ready = b.readyForPapermaking;
      const pill = ready ? '<span class="pill ok">可抄纸</span>' : '<span class="pill bad">'+b.status+' · 暂不可抄纸</span>';
      const blockers = b.blockers.map(x => '<li>'+x+'</li>').join('');
      const obs = b.observations.filter(o => !o.voided).slice(-5).map(o =>
        '<div>'+o.date+' '+(o.abnormal?'<b style="color:var(--warn)">异常</b>':'正常')+' · '+(o.smell||'')+' '+(o.temperature||'')+' <span class="meta">['+o.ticket+']'+(o.migrated?' 旧数据迁入':'')+'</span></div>').join('');
      const transfers = b.transfers.map(t => '<div class="meta">换缸：'+t.fromVatId+' → '+t.toVatId+' ['+t.ticket+']</div>').join('');
      const conflict = b.conflict ? '<div class="meta warn" style="color:var(--warn)">换缸冲突：'+b.conflict.targetVatId+' 已满（'+new Date(b.conflict.ts).toLocaleString()+'），请重试换缸</div>' : '';
      return '<article class="card"><h3>'+b.code+' '+pill+'</h3>'
        + '<div><b>原料</b> '+b.source+' · <b>负责人</b> '+b.owner+'</div>'
        + '<div><b>当前缸</b> '+b.vatId+' · <b>发酵天数</b> '+b.days+'/'+${fermentDays}+'（'+b.observationDates.join('、')+'）</div>'
        + (ready ? '' : '<ul class="blockers">'+blockers+'</ul>')
        + conflict + transfers
        + '<div class="logs"><b>观察事件</b><br>'+(obs||'暂无观察')+'</div>'
        + (b.migrated?'<div class="meta">含升级前旧批次数据，可在 /api/legacy 查阅原件</div>':'')
        + '</article>';
    }
    async function load() {
      [batches, vats] = await Promise.all([api('/api/batches'), api('/api/vats')]);
      render();
    }
    document.querySelector('#vatForm').onsubmit = e => { e.preventDefault(); submitForm(e.target, '/api/vats', 'GT', '缸'); };
    document.querySelector('#createForm').onsubmit = e => { e.preventDefault(); submitForm(e.target, '/api/batches', 'RG', '批次'); };
    document.querySelector('#actionForm').onsubmit = e => { e.preventDefault(); const f=e.target; submitForm(f, '/api/batches/'+new FormData(f).get('batch')+'/observations', 'YC', '观察'); };
    document.querySelector('#transferForm').onsubmit = e => { e.preventDefault(); const f=e.target; submitForm(f, '/api/batches/'+new FormData(f).get('batch')+'/transfer', 'HG', '换缸'); };
    document.querySelector('#statusFilter').onchange = render;
    document.querySelector('#search').oninput = render;
    document.querySelector('#reload').onclick = load;
    document.querySelector('input[name="date"]').value = new Date().toISOString().slice(0,10);
    document.querySelector('input[name="ticket"]').value = genTicket('YC');
    load();
  </script>
</body>
</html>`;
}
