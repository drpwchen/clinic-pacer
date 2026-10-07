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

// 東基站點設定（r1007-52：最晚離開改成使用者給的實際值 17:15；r1007-39 原本是 441 17:46 − 15 − 6 ＝ 17:25）
const TCH = { id: 'tch', name: '東基', start: '14:00', trainLabel: '441', train: '17:46', leaveLabel: '計程車', leave: '17:15', taxiLead: 5, N: 25, prior: 8, alts: '445 18:35, 447 20:00' };
const YULI = { id: 'yuli', name: '玉里', start: '13:00', trainLabel: '441', train: '18:29', leaveLabel: '派車', leave: '17:30', leave2Label: '自己走', leave2: '18:00', taxiLead: 5, N: 30, prior: 8, alts: '445 19:29, 447 20:53' };
const GS = { id: 'gs', name: '關山', start: '08:30', trainLabel: '472', train: '12:42', leaveLabel: '派車', leave: '12:20', taxiLead: 5, N: 23, prior: 8, alts: '' };
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

// r1007-39 兩個範例，離開時間 17:25 → 17:15 後照新參數重算（原 ▼ −19／6.5、▲ +9／7.5）
test('r1007-39 範例 1（17:15 離開）：東基 16:00 已看 12 位、最近 5 位 8 分 → ▼ −29、每位 5.8、改 445', () => {
  const s = session(12, 16, 0, 8);
  const r = C.compute(TCH, s, at(16, 0));
  assert.equal(r.n, 12);
  assert.equal(r.R, 13);
  assert.equal(C.fmtHM(r.deadline), '17:15');
  assert.equal(r.target.label, '計程車');
  assert.equal(C.fmtHM(r.callTaxi), '17:10');
  assert.equal(r.avail, 75);
  assert.equal(C.fmtBudget(r.budget), '5.8');
  assert.equal(r.pace, 8);
  assert.equal(C.fmtHM(r.finishEst), '17:44');
  assert.equal(Math.round(r.slack), -29);
  assert.equal(C.fmtSlack(r.slack), '▼ −29');
  assert.equal(r.level, 'behind');
  assert.ok(r.warn, '要跳改票預警');
  assert.equal(C.warnText(r.warn), '照速度趕不上 441 → 現在改 445（18:35）');
});

test('r1007-39 範例 2（17:15 離開）：東基 16:40 已看 19 位、最近 5 位 6 分 → ● −1、每位 5.8、預警消失', () => {
  const s = session(19, 16, 40, 6);
  const r = C.compute(TCH, s, at(16, 40));
  assert.equal(r.R, 6);
  assert.equal(r.avail, 35);
  assert.equal(C.fmtBudget(r.budget), '5.8');
  assert.equal(r.pace, 6);
  assert.equal(C.fmtHM(r.finishEst), '17:16');
  assert.equal(C.fmtSlack(r.slack), '● −1');
  assert.equal(r.level, 'on');
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

test('自動開診（UI 存的狀態：openAt＝第一次看完）不會多一段 0 分間隔', () => {
  const t1 = at(14, 10);
  const s = { N: 25, openAt: t1, closedAt: null, events: [done(t1), done(at(14, 17))] };
  assert.deepEqual([...C.intervals(s)], [7]);
  assert.equal(C.pace(s, 8), 0.2 * 7 + 0.8 * 8);
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
  const s2 = session(7, 16, 0, 11);  // 剩 18 × 11 = 198 分 → 19:18；留 31 分（17:15→17:46）：445 要 18:04 前離開 ✗、447 19:29 ✓
  assert.equal(C.warnText(C.compute(TCH, s2, at(16, 0)).warn), '照速度趕不上 441 → 現在改 447（20:00）');
  const noAlt = { ...TCH, alts: '' };
  assert.equal(C.warnText(C.compute(noAlt, s2, at(16, 0)).warn), '照速度趕不上 441 → 現在改票或想備案');
});

test('叫車提示：17:10 起「叫車」、17:15 起「該走了」', () => {
  const s = session(20, 17, 0, 6);
  assert.equal(C.compute(TCH, s, at(17, 9)).taxi, null);
  assert.equal(C.compute(TCH, s, at(17, 10)).taxi, 'call');
  assert.equal(C.compute(TCH, s, at(17, 15)).taxi, 'go');
  assert.equal(C.compute({ ...TCH, taxiLead: 0 }, s, at(17, 11)).taxi, null);
});

// 玉里：派車 17:30 為目標，派車過了或照速度會晚 ≥ 5 分 → 改跟「自己走 18:00」比
const yuli = (n, h, m, gap, N = 30) => {
  const end = at(h, m);
  const tail = Array.from({ length: 6 }, (_, i) => end - (5 - i) * gap * C.MIN);
  const head = Array.from({ length: n - 6 }, (_, i) => at(13, 0) + (i + 1) * 7 * C.MIN);
  assert.ok(head.length === 0 || head[head.length - 1] < tail[0], 'head 要在 tail 之前');
  return { N, openAt: at(13, 0), closedAt: null, events: [...head, ...tail].map(done) };
};

test('玉里：照速度趕得上派車 → 跟 17:30 比，備案顯示自己走 18:00', () => {
  const s = yuli(20, 16, 0, 8);  // 剩 10 × 8 = 80 → 17:20
  const r = C.compute(YULI, s, at(16, 0));
  assert.equal(r.target.label, '派車');
  assert.equal(C.fmtHM(r.deadline), '17:30');
  assert.equal(C.fmtSlack(r.slack), '▲ +10');
  assert.equal(r.fallback, null);
  assert.equal(r.next.label, '自己走');
  assert.equal(r.next.min, 18 * 60);
});

test('玉里：派車會晚 4 分還是跟派車比（●），晚 5 分以上改跟自己走比', () => {
  const r1 = C.compute(YULI, yuli(20, 16, 14, 8), at(16, 14));  // 剩 10 × 8 → 17:34：派車 −4
  assert.equal(r1.target.label, '派車');
  assert.equal(C.fmtSlack(r1.slack), '● −4');
  const r2 = C.compute(YULI, yuli(20, 16, 15, 8), at(16, 15));  // → 17:35：派車 −5 → 改自己走：+25
  assert.equal(r2.target.label, '自己走');
  assert.equal(r2.fallback.label, '派車');
  assert.equal(C.fmtHM(r2.deadline), '18:00');
  assert.equal(C.fmtSlack(r2.slack), '▲ +25');
  assert.equal(r2.warn, null);  // 自己走趕得上 → 不跳改票
});

test('玉里：17:30 派車時間過了 → 改跟 18:00 比；17:55 準備走、18:00 該走了', () => {
  const s = yuli(28, 17, 25, 6, 29);  // 剩 1 位：17:31 看完，派車只晚 1 分 → 仍以派車為目標
  assert.equal(C.compute(YULI, s, at(17, 25)).taxi, 'call');  // 派車前 5 分
  const r = C.compute(YULI, s, at(17, 30));
  assert.equal(r.target.label, '自己走');
  assert.equal(r.taxi, null);
  assert.equal(C.compute(YULI, s, at(17, 55)).taxi, 'call');
  assert.equal(C.compute(YULI, s, at(18, 0)).taxi, 'go');
});

test('玉里：改票預警跟自己走 18:00 比（留 29 分到 441 18:29）', () => {
  const s = yuli(10, 16, 0, 10);  // 剩 20 × 10 → 19:20：自己走 −80
  const r = C.compute(YULI, s, at(16, 0));
  assert.equal(r.target.label, '自己走');
  // 445 19:29 − 29 ＝ 19:00 ✗；447 20:53 − 29 ＝ 20:24 ✓
  assert.equal(C.warnText(r.warn), '照速度趕不上 441 → 現在改 447（20:53）');
});

test('關山：派車 12:20；收工時算比哪個離開時間早', () => {
  const s = { N: 23, openAt: at(8, 30), closedAt: null, events: [] };
  const r = C.compute(GS, s, at(8, 30));
  assert.equal(C.fmtHM(r.deadline), '12:20');
  assert.equal(C.fmtHM(r.callTaxi), '12:15');
  assert.equal(r.next, null);
  assert.equal(C.targetAt(YULI, at(17, 0), at(17, 20)).label, '派車');
  assert.equal(C.targetAt(YULI, at(17, 0), at(17, 40)).label, '自己走');
  assert.equal(C.targetAt(YULI, at(17, 0), at(18, 10)).label, '自己走');
});

test('沒填最晚離開：退回舊算法 車次 − 交通 − 進站', () => {
  const old = { train: '17:46', travel: 15, buffer: 6 };
  assert.deepEqual(JSON.parse(JSON.stringify(C.leaves(old))), [{ label: '離開', min: 17 * 60 + 25 }]);
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
