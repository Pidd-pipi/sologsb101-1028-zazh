import {
  periodShares,
  countMusicians,
  evaluateBooking,
  auditLedger,
  sessionToEntry,
  retakeToEntry,
  describeShortages,
  type BookingEntry
} from '../src/utils/ledger';
import type { Session } from '../src/types/session';
import type { Retake } from '../src/types/retake';

let failures = 0;
function check(name: string, cond: boolean, extra = ''): void {
  if (cond) {
    console.log(`PASS ${name}`);
  } else {
    failures += 1;
    console.error(`FAIL ${name} ${extra}`);
  }
}

// 基础规则
check('通宵占 2 份', periodShares('通宵') === 2);
check('上午占 1 份', periodShares('上午') === 1 && periodShares('下午') === 1 && periodShares('晚上') === 1);
check('乐手按顿号/逗号计数', countMusicians('鼓：许峰、贝斯：黎川，吉他:程野') === 3);

function session(
  id: string,
  roomNo: string,
  date: string,
  period: Session['period'],
  musicians: string,
  state: Session['state'] = '已排期'
): BookingEntry {
  return sessionToEntry({ id, roomNo, date, period, musicians, state });
}

// 场景 1：A 棚当天占 2 份、还空 1 份（通宵要 2 份，差 1 份但时段本身空着）
let entries: BookingEntry[] = [
  session('s1', 'A 棚', '2024-03-25', '上午', '甲'),
  session('s2', 'A 棚', '2024-03-25', '下午', '乙')
];

let r = evaluateBooking(entries, { date: '2024-03-25', period: '通宵', roomNo: 'A 棚', musicianCount: 1 });
check('通宵在只剩 1 份时拒绝', !r.allowed, describeShortages(r.shortages));
check('通宵差额写清差 1 份', r.shortages.some((s) => s.code === 'quota' && s.detail.includes('还差 1 份')));
check('通宵不报撞号（时段空着）', !r.shortages.some((s) => s.code === 'slot'));

// 三场占满 3 份时通宵缺 2 份
entries.push(session('s3', 'A 棚', '2024-03-25', '晚上', '丙'));
r = evaluateBooking(entries, { date: '2024-03-25', period: '通宵', roomNo: 'A 棚', musicianCount: 1 });
check('三场占满时通宵缺 2 份', r.shortages.some((s) => s.code === 'quota' && s.detail.includes('还差 2 份')));

// 场景 2：同棚同时段撞号
entries = [session('s1', 'B 棚', '2024-03-26', '上午', '甲')];
r = evaluateBooking(entries, { date: '2024-03-26', period: '上午', roomNo: 'B 棚', musicianCount: 1 });
check('同棚同时段撞号拒绝', !r.allowed && r.shortages[0].code === 'slot', describeShortages(r.shortages));
check('撞号描述点名占用方', r.shortages[0].detail.includes('场次 s1'));

// 场景 3：席位容量不足（C 棚 3 席）
entries = [];
r = evaluateBooking(entries, { date: '2024-03-26', period: '上午', roomNo: 'C 棚', musicianCount: 5 });
check('乐手超 C 棚 3 席拒绝', !r.allowed && r.shortages.some((s) => s.code === 'capacity'));
check('席位差额写清差 2 席', r.shortages.some((s) => s.code === 'capacity' && s.detail.includes('还差 2 个席位')));
check('空棚时额度仍充足', r.remaining === 3);

// 正常放号
r = evaluateBooking([], { date: '2024-03-26', period: '通宵', roomNo: '大排练厅', musicianCount: 10 });
check('大排练厅通宵 10 人可放', r.allowed, describeShortages(r.shortages));
check('空棚通宵后账面剩余 1 份', r.remaining === 3 && r.needShares === 2);
check('普通时段占 1 份', evaluateBooking([], { date: '2024-03-26', period: '上午', roomNo: 'A 棚', musicianCount: 1 }).remaining === 3);

// 已取消场次不占账
entries = [session('s1', 'A 棚', '2024-03-26', '上午', '甲', '已取消')];
r = evaluateBooking(entries, { date: '2024-03-26', period: '上午', roomNo: 'A 棚', musicianCount: 1 });
check('已取消场次不占账', r.allowed);

// 补录与场次抢同一本账
function retake(id: string, roomNo: string, date: string, period: Retake['period'], state: Retake['state']): BookingEntry {
  return retakeToEntry({ id, roomNo, planDate: date, period, musicians: '甲', state });
}
entries = [
  session('s1', 'A 棚', '2024-03-27', '上午', '甲'),
  retake('rt1', 'A 棚', '2024-03-27', '下午', '已排期')
];
r = evaluateBooking(entries, { date: '2024-03-27', period: '晚上', roomNo: 'A 棚', musicianCount: 1 });
check('补录占 1 份后晚上仍可放', r.allowed);
r = evaluateBooking(entries, { date: '2024-03-27', period: '通宵', roomNo: 'A 棚', musicianCount: 1 });
check('补录占账后通宵差 1 份', !r.allowed && r.shortages.some((s) => s.code === 'quota' && s.detail.includes('还差 1 份')));

// 待排/待安排/已完成补录不占账
entries = [
  retake('rt1', 'A 棚', '2024-03-28', '上午', '待排'),
  retake('rt2', 'A 棚', '2024-03-28', '上午', '待安排'),
  retake('rt3', 'A 棚', '2024-03-28', '上午', '已完成')
];
r = evaluateBooking(entries, { date: '2024-03-28', period: '上午', roomNo: 'A 棚', musicianCount: 1 });
check('待排/待安排/已完成补录不占账', r.allowed);

// 编辑自身排除
entries = [session('s1', 'A 棚', '2024-03-29', '上午', '甲')];
r = evaluateBooking(entries, { date: '2024-03-29', period: '上午', roomNo: 'A 棚', musicianCount: 1 }, 's1');
check('编辑自身不与自己冲突', r.allowed);

// 审计：历史超额数据能列出
entries = [
  session('s1', 'A 棚', '2024-03-30', '上午', '甲'),
  retake('rt1', 'A 棚', '2024-03-30', '上午', '已排期'),
  session('s2', 'C 棚', '2024-03-30', '上午', '甲、乙、丙、丁、戊')
];
const issues = auditLedger(entries);
check('审计能发现撞号', issues.some((i) => i.detail.includes('撞号')));
check('审计能发现席位超额', issues.some((i) => i.detail.includes('超过席位容量')));

// 迁移场景模拟：旧已排期补录顺序入账，排不下的降级待排（与 db.upgrade 同构）
const legacySessions = [
  session('s1', 'A 棚', '2024-03-25', '上午', '甲'),
  session('s2', 'A 棚', '2024-03-25', '下午', '乙')
];
const legacyRetakes: Array<{ id: string; date: string; period: Retake['period']; roomNo: string; musicians: string; state: Retake['state']; note: string }> = [
  { id: 'rt-old', date: '2024-03-25', period: '通宵', roomNo: 'A 棚', musicians: '甲', state: '已排期', note: '' }
];
const ledger: BookingEntry[] = [...legacySessions];
for (const item of legacyRetakes) {
  const result = evaluateBooking(ledger, {
    date: item.date,
    period: item.period,
    roomNo: item.roomNo,
    musicianCount: countMusicians(item.musicians)
  });
  if (result.allowed) {
    ledger.push(retakeToEntry({ id: item.id, planDate: item.date, period: item.period, roomNo: item.roomNo, musicians: item.musicians, state: item.state }));
  } else {
    item.state = '待排';
    item.note = describeShortages(result.shortages);
  }
}
check('迁移：排不下的旧补录降级待排', legacyRetakes[0].state === '待排');
check('迁移：待排差额已写明', legacyRetakes[0].note.includes('还差 1 份'), legacyRetakes[0].note);

// 重开后接着排：先释放一场，再排同一条待排补录应成功（账本状态由 DB 持久化，此处模拟账本重建）
const afterRelease = legacySessions.filter((e) => e.id !== 's2');
r = evaluateBooking(afterRelease, { date: '2024-03-25', period: '通宵', roomNo: 'A 棚', musicianCount: 1 });
check('释放一场后通宵补录可重新排进', r.allowed, describeShortages(r.shortages));

if (failures > 0) {
  console.error(`\n${failures} 个用例失败`);
  process.exit(1);
}
console.log('\n全部账本用例通过');
