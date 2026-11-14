/** dashboard.ts — the /stats live activity page: per-day × category × client
 *  request stats, straight from request_log (real-time — a conversation that
 *  just triggered memory activity shows up on the next refresh). */

export function dashboardPage(): string {
	return `<!doctype html>
<html lang="zh">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>ruyi · 活动面板</title>
<style>
  :root { color-scheme: dark; }
  * { box-sizing: border-box; }
  body { margin: 0; background: #0d1117; color: #e6edf3; font: 14px/1.6 -apple-system, "PingFang SC", "Microsoft YaHei", sans-serif; }
  .wrap { max-width: 1080px; margin: 0 auto; padding: 24px 16px 60px; }
  h1 { font-size: 20px; margin: 0 0 4px; }
  .sub { color: #8b949e; font-size: 13px; margin-bottom: 20px; }
  .sub b { color: #58a6ff; font-weight: 600; }
  .card { background: #161b22; border: 1px solid #30363d; border-radius: 10px; padding: 16px 18px; margin-bottom: 18px; }
  h2 { font-size: 15px; margin: 0 0 12px; color: #c9d1d9; }
  table { width: 100%; border-collapse: collapse; font-variant-numeric: tabular-nums; }
  th, td { text-align: right; padding: 6px 8px; border-bottom: 1px solid #21262d; white-space: nowrap; }
  th:first-child, td:first-child { text-align: left; }
  th { color: #8b949e; font-weight: 500; font-size: 12px; }
  tr.today td { color: #3fb950; font-weight: 600; }
  .cat { display: inline-block; padding: 1px 8px; border-radius: 10px; font-size: 12px; }
  .cat-probe { background: #1f3a5f; color: #79c0ff; }
  .cat-recall { background: #2c1f5f; color: #d2a8ff; }
  .cat-inject { background: #0f3d2e; color: #56d4aa; }
  .cat-remember { background: #4d3a0f; color: #e3b341; }
  .cat-sync { background: #4d1f1f; color: #ff7b72; }
  .cat-other { background: #21262d; color: #8b949e; }
  .muted { color: #6e7681; }
  #gate { max-width: 420px; margin: 15vh auto; text-align: center; }
  #gate input { width: 100%; padding: 10px 12px; border-radius: 8px; border: 1px solid #30363d; background: #0d1117; color: #e6edf3; font-size: 14px; }
  #gate button { margin-top: 12px; padding: 8px 22px; border-radius: 8px; border: 0; background: #238636; color: #fff; font-size: 14px; cursor: pointer; }
  .feed td { white-space: normal; word-break: break-all; }
  .err { color: #ff7b72; }
</style>
</head>
<body>
<div id="gate" class="wrap">
  <h1>ruyi · 活动面板</h1>
  <p class="sub">输入服务 token 查看（只存在本浏览器 localStorage）</p>
  <input id="tok" type="password" placeholder="authToken" autofocus>
  <br><button onclick="saveTok()">进入</button>
  <p id="gateErr" class="err"></p>
</div>
<div id="main" class="wrap" style="display:none">
  <h1>ruyi · 活动面板</h1>
  <div class="sub">实时数据 · 每 <b>30s</b> 自动刷新 · <span id="stamp"></span> · <a href="#" onclick="logout();return false" style="color:#58a6ff">退出</a></div>
  <div class="card"><h2>按天 × 类别（次数 / 数据量）</h2><div id="byDay">加载中…</div></div>
  <div class="card"><h2>按客户端汇总</h2><div id="byClient"></div></div>
  <div class="card"><h2>最近 30 条事件（刚才的对话触发了吗？看这里）</h2><div id="recent"></div></div>
</div>
<script>
const CATS = ["probe", "recall", "inject", "remember", "sync", "other"];
const CN = { probe: "查询·probe", recall: "召回·recall", inject: "注入·inject", remember: "写入·remember", sync: "同步·sync", other: "其他" };
function fmt(b) { if (!b) return "—"; if (b < 1024) return b + "B"; if (b < 1048576) return (b/1024).toFixed(1) + "K"; if (b < 1073741824) return (b/1048576).toFixed(1) + "M"; return (b/1073741824).toFixed(2) + "G"; }
function saveTok() { localStorage.ruyiTok = document.getElementById("tok").value.trim(); boot(); }
function logout() { delete localStorage.ruyiTok; location.reload(); }
async function boot() {
  const tok = localStorage.ruyiTok;
  if (!tok) return;
  try { await load(); } catch (e) {
    document.getElementById("gateErr").textContent = "token 不对或服务不可达：" + e.message;
    return;
  }
  document.getElementById("gate").style.display = "none";
  document.getElementById("main").style.display = "";
  setInterval(load, 30000);
}
async function load() {
  const r = await fetch("/activity?days=14", { headers: { authorization: "Bearer " + localStorage.ruyiTok } });
  if (r.status === 401 || r.status === 403) throw new Error("401 未授权");
  if (!r.ok) throw new Error("HTTP " + r.status);
  const d = await r.json();
  render(d);
  document.getElementById("stamp").textContent = "更新于 " + new Date().toLocaleTimeString("zh-CN");
}
function cell(c) { if (!c) return '<td class="muted">·</td>'; return "<td>" + c.n + " 次 · " + fmt(c.res || c.req) + "</td>"; }
function render(d) {
  const days = Object.keys(d.byDay).sort().reverse();
  const today = new Date().toISOString().slice(0, 10);
  let h = "<table><tr><th>日期</th>" + CATS.map(c => "<th>" + CN[c] + "</th>").join("") + "</tr>";
  for (const day of days) {
    h += '<tr class="' + (day === today ? "today" : "") + '"><td>' + day + (day === today ? "（今天）" : "") + "</td>" + CATS.map(c => cell(d.byDay[day][c])).join("") + "</tr>";
  }
  document.getElementById("byDay").innerHTML = h + "</table>";
  let h2 = "<table><tr><th>客户端</th>" + CATS.map(c => "<th>" + CN[c] + "</th>").join("") + "<th>合计</th></tr>";
  for (const cl of Object.keys(d.byClient).sort((a, b) => sum(d.byClient[b]) - sum(d.byClient[a]))) {
    h2 += "<tr><td>" + esc(cl) + "</td>" + CATS.map(c => cell(d.byClient[cl][c])).join("") + "<td>" + sum(d.byClient[cl]) + " 次</td></tr>";
  }
  document.getElementById("byClient").innerHTML = h2 + "</table>";
  let h3 = '<table class="feed"><tr><th>时间</th><th>类别</th><th>路由</th><th>客户端</th><th>数据</th><th>耗时</th></tr>';
  for (const e of d.recent) {
    h3 += "<tr><td>" + e.at.slice(5, 19).replace("T", " ") + '</td><td><span class="cat cat-' + e.category + '">' + e.category + '</span></td><td class="muted">' + esc(e.route) + "</td><td>" + esc(e.client || "—") + "</td><td>" + fmt(e.resBytes || e.reqBytes) + "</td><td>" + (e.ms > 1000 ? (e.ms/1000).toFixed(1) + "s" : e.ms + "ms") + "</td></tr>";
  }
  document.getElementById("recent").innerHTML = h3 + "</table>";
}
function sum(o) { return Object.values(o).reduce((a, c) => a + c.n, 0); }
function esc(s) { return String(s).replace(/[&<>"]/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c])); }
boot();
</script>
</body>
</html>`;
}
