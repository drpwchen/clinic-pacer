// 算法測試：直接從 clinic-pace.html 抽出 <script id="pace-core"> 來跑，確保測的就是會用的那一份。
// 執行：node --test（在 repo 根目錄）
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const html = fs.readFileSync(path.join(__dirname, '..', 'clinic-pace.html'), 'utf8');
const src = /<script id="pace-core">([\s\S]*?)<\/script>/.exec(html)[1];
const ctx = { globalThis: null };
ctx.globalThis = ctx;
vm.createContext(ctx);
vm.runInContext(src, ctx);
const C = ctx.PaceCore;

// r1007-39 的東基站點設定
const TCH = { id: 'tch', name: '東基', start: '14:00', trainLabel: '441', train: '17:46', travel: 15, buffer: 6, taxiLead: 5, N: 25, prior: 8, alts: '445 18:35, 447 20:00' };
const at = (h, m) => new Date(2026, 10, 4, h, m, 0, 0).getTime();  // 2026-11-04（東基門診日），本機時區
const done = t => ({ t, type: 'done' });

// 依序產生「看完」時間：先 k 位分散在前面，最後 6 下等距（→ 最近 5 個間隔都是 gap 分）
function session(nDone, endH, endM, gap, extra = {}) {
  const end = at(endH, endM);
  const tail = Array.from({ length: 6 }, (_, i) => end - (5 - i) * gap * C.MIN);
  const headCount = nDone - 6;
  const head = Array.from({ length: headCount }, (_, i) => at(14, 0) + (i + 1) * 9 * C.MIN);
  assert.ok(head.length === 0 || head[head.length - 1] < tail[0], 'head 要在 tail 之前');
  return { N: 25, openAt: at(14, 0), closedAt: null, events: [...head, ...tail].map(done), ...extra };
}

test('r1007-39 範例 1：東基 16:00 已看 12 位、最近 5 位平均 8 分 → ▼ −19、每位 6.5、改 445', () => {
  const s = session(12, 16, 0, 8);
  const r = C.compute(TCH, s, at(16, 0));
  assert.equal(r.n, 12);
  assert.equal(r.R, 13);
  assert.equal(C.fmtHM(r.deadline), '17:25');
  assert.equal(C.fmtHM(r.callTaxi), '17:20');
  assert.equal(r.avail, 85);
  assert.equal(C.fmtBudget(r.budget), '6.5');
  assert.equal(r.pace, 8);
  assert.equal(C.fmtHM(r.finishEst), '17:44');
  assert.equal(Math.round(r.slack), -19);
  assert.equal(C.fmtSlack(r.slack), '▼ −19');
  assert.equal(r.level, 'behind');
  assert.ok(r.warn, '要跳改票預警');
  assert.equal(C.warnText(r.warn), '照速度趕不上 441 → 現在改 445（18:35）');
});

test('r1007-39 範例 2：東基 16:40 已看 19 位、最近 5 位 6 分 → ▲ +9、每位 7.5、預警消失', () => {
  const s = session(19, 16, 40, 6);
  const r = C.compute(TCH, s, at(16, 40));
  assert.equal(r.R, 6);
  assert.equal(r.avail, 45);
  assert.equal(C.fmtBudget(r.budget), '7.5');
  assert.equal(r.pace, 6);
  assert.equal(C.fmtHM(r.finishEst), '17:16');
  assert.equal(C.fmtSlack(r.slack), '▲ +9');
  assert.equal(r.level, 'ahead');
  assert.equal(r.warn, null);
});

test('空檔：按過「空檔」的那一段不算進速度', () => {
  const s = { N: 25, openAt: at(14, 0), closedAt: null, events: [
    done(at(14, 8)), done(at(14, 16)), { t: at(14, 17), type: 'idle' }, done(at(14, 50)), done(at(14, 58)),
  ] };
  assert.deepEqual([...C.intervals(s)], [8, 8, 8]);  // 14:16→14:50 那段（34 分）被排除
});

test('沒按開診：從第一次看完開始算間隔', () => {
  const s = { N: 25, openAt: null, closedAt: null, events: [done(at(14, 10)), done(at(14, 18))] };
  assert.deepEqual([...C.intervals(s)], [8]);
});

test('前 5 位以前：速度用 prior 補（w = 有效間隔數 / 5）', () => {
  const s = { N: 25, openAt: at(14, 0), closedAt: null, events: [done(at(14, 4)), done(at(14, 8))] };  // 兩個 4 分
  assert.equal(C.pace(s, 8), 0.4 * 4 + 0.6 * 8);
  assert.equal(C.pace({ N: 25, openAt: null, closedAt: null, events: [] }, 8), 8);
});

test('單一極端值（打針）權重上限 0.3', () => {
  const xs = [8, 8, 8, 8, 40];
  assert.equal(C.ewma(xs, 8), 0.3 * 40 + 0.7 * 8);
  assert.equal(C.ewma([8, 8, 8, 8, 10], 8), 0.4 * 10 + 0.6 * 8);  // 一般值權重 0.4
});

test('只看最近 5 個間隔', () => {
  assert.equal(C.ewma([30, 30, 30, 6, 6, 6, 6, 6], 8), 6);
});

test('門檻：▲ ≥ +5、● 中間、▼ ≤ −5', () => {
  assert.equal(C.fmtSlack(5), '▲ +5');
  assert.equal(C.fmtSlack(4.4), '● +4');
  assert.equal(C.fmtSlack(0.2), '● ±0');
  assert.equal(C.fmtSlack(-4), '● −4');
  assert.equal(C.fmtSlack(-5), '▼ −5');
});

test('改票預警：開車前 60 分以後就不再跳（來不及改）', () => {
  const s = session(12, 16, 50, 12);  // 落後很多
  const r = C.compute(TCH, s, at(16, 50));  // 441 17:46 前 56 分
  assert.ok(r.slack < -10);
  assert.equal(r.warn, null);
});

test('改票預警：445 也趕不上就建議下一班；全都趕不上就說要想備案', () => {
  const s = session(7, 16, 0, 20);  // 剩 18 位 × 20 分 → 22:00 才看完
  const r = C.compute(TCH, s, at(16, 0));
  assert.equal(C.warnText(r.warn), '照速度連 447 都趕不上 → 現在想備案');
  const s2 = session(7, 16, 0, 11);  // 剩 18 × 11 = 198 分 → 19:18；445 要 18:14 前離開 ✗、447 19:39 ✓
  assert.equal(C.warnText(C.compute(TCH, s2, at(16, 0)).warn), '照速度趕不上 441 → 現在改 447（20:00）');
  const noAlt = { ...TCH, alts: '' };
  assert.equal(C.warnText(C.compute(noAlt, s2, at(16, 0)).warn), '照速度趕不上 441 → 現在改票或想備案');
});

test('叫車提示：17:20 起「叫車」、17:25 起「該走了」', () => {
  const s = session(20, 17, 0, 6);
  assert.equal(C.compute(TCH, s, at(17, 19)).taxi, null);
  assert.equal(C.compute(TCH, s, at(17, 20)).taxi, 'call');
  assert.equal(C.compute(TCH, s, at(17, 25)).taxi, 'go');
  assert.equal(C.compute({ ...TCH, taxiLead: 0 }, s, at(17, 21)).taxi, null);
});

test('總人數比已看少時以已看為準；全部看完 R = 0', () => {
  const s = session(12, 16, 0, 8, { N: 10 });
  const r = C.compute(TCH, s, at(16, 0));
  assert.equal(r.N, 12);
  assert.equal(r.R, 0);
  assert.equal(r.budget, null);
});

test('備選車次解析', () => {
  assert.deepEqual(JSON.parse(JSON.stringify(C.parseAlts('447 20:53，445 19:29'))), [{ label: '445', min: 19 * 60 + 29 }, { label: '447', min: 20 * 60 + 53 }]);
  assert.deepEqual(JSON.parse(JSON.stringify(C.parseAlts(''))), []);
});
