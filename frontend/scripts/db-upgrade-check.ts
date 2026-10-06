import 'fake-indexeddb/auto';
import Dexie from 'dexie';

/** 先按 v1 结构造一个旧库（缺补录棚号/时段字段） */
async function buildV1Database(): Promise<Dexie> {
  const v1 = new Dexie('gbstudiotake-db');
  v1.version(1).stores({
    projects: 'id, name, client, state, startDate, updatedAt',
    songs: 'id, projectId, title, arrangement, state, updatedAt',
    sessions: 'id, songId, date, period, roomNo, engineer, state, updatedAt',
    takes: 'id, sessionId, takeNo, grade, startTc, updatedAt',
    picks: 'id, takeId, usage, order, updatedAt',
    retakes: 'id, songId, planDate, state, updatedAt'
  });
  await v1.open();
  const now = Date.now();
  await v1.table('projects').bulkPut([
    { id: 'p1', name: '旧项目', client: 'c', startDate: '2024-01-01', deliverDate: '2024-02-01', state: '录制中', revision: 1, createdAt: now, updatedAt: now }
  ]);
  await v1.table('songs').bulkPut([
    { id: 'g1', projectId: 'p1', title: '旧曲', durationSec: 100, arrangement: '乐队', state: '录制中', revision: 1, createdAt: now, updatedAt: now }
  ]);
  // 3 月 25 日 A 棚两场占 2 份
  await v1.table('sessions').bulkPut([
    { id: 's1', songId: 'g1', date: '2024-03-25', period: '上午', engineer: '赵', roomNo: 'A 棚', musicians: '甲', state: '已排期', revision: 1, createdAt: now, updatedAt: now },
    { id: 's2', songId: 'g1', date: '2024-03-25', period: '下午', engineer: '赵', roomNo: 'A 棚', musicians: '乙', state: '已排期', revision: 1, createdAt: now, updatedAt: now },
    // 同棚同时段的历史脏数据：用于验证迁移时补录撞号能识别（这是场次，迁移不动它）
    { id: 's3', songId: 'g1', date: '2024-03-26', period: '上午', engineer: '赵', roomNo: 'B 棚', musicians: '丙', state: '已排期', revision: 1, createdAt: now, updatedAt: now }
  ]);
  // v1 补录：无 roomNo / period / musicians / shortageNote
  await v1.table('retakes').bulkPut([
    { id: 'r1', songId: 'g1', reason: '排得下的旧补录', planDate: '2024-04-02', state: '已排期', revision: 1, createdAt: now, updatedAt: now },
    // 有时段（通宵）但缺棚号/乐手：A 棚 3-25 已占 2 份，通宵需 2 份 → 差 1 份
    { id: 'r2', songId: 'g1', reason: '通宵但额度差 1 份', planDate: '2024-03-25', period: '通宵', state: '已排期', revision: 1, createdAt: now, updatedAt: now },
    { id: 'r3', songId: 'g1', reason: '待安排旧补录', planDate: '2024-04-05', state: '待安排', revision: 1, createdAt: now, updatedAt: now },
    // 缺时段 → 默认补上午，恰好撞 s3（B 棚 3-26 上午）→ 降级待排
    { id: 'r4', songId: 'g1', reason: '缺时段补上午后撞号', planDate: '2024-03-26', roomNo: 'B 棚', state: '已排期', revision: 1, createdAt: now, updatedAt: now }
  ]);
  v1.close();
  return v1;
}

let failures = 0;
function check(name: string, cond: boolean, extra = ''): void {
  if (cond) console.log(`PASS ${name}`);
  else {
    failures += 1;
    console.error(`FAIL ${name} ${extra}`);
  }
}

async function main(): Promise<void> {
  await buildV1Database();

  // 重新以 v2 打开（走 upgrade 迁移）
  const { db, DB_SCHEMA_VERSION } = await import('../src/utils/db');
  await db.open();
  check('结构版本 = 2', DB_SCHEMA_VERSION === 2, `got ${DB_SCHEMA_VERSION}`);
  check('库实际版本 = 2', db.verno === 2, `got ${db.verno}`);

  const retakes = await db.retakes.toArray();
  const r1 = retakes.find((x) => x.id === 'r1');
  const r2 = retakes.find((x) => x.id === 'r2');
  const r3 = retakes.find((x) => x.id === 'r3');
  const r4 = retakes.find((x) => x.id === 'r4');

  check('缺棚号补录默认 A 棚', r1?.roomNo === 'A 棚');
  check('缺时段补录默认上午', r1?.period === '上午');
  check('缺乐手字段补为空串', typeof r1?.musicians === 'string' && r1.musicians === '');
  check('排得下的旧补录保持已排期', r1?.state === '已排期');
  check('排得下差额说明为空', r1?.shortageNote === '');

  check('通宵差 1 份 → 降级待排', r2?.state === '待排', `got ${r2?.state}`);
  check('待排差额写明缺 1 份', typeof r2?.shortageNote === 'string' && r2.shortageNote.includes('还差 1 份'), r2?.shortageNote ?? '');
  check('待排保留原时段并补棚号', r2?.roomNo === 'A 棚' && r2?.period === '通宵', `${r2?.roomNo} ${r2?.period}`);

  check('待安排补录补齐字段且状态不变', r3?.state === '待安排' && r3.roomNo === 'A 棚' && r3.period === '上午');
  check('撞号旧补录 → 降级待排', r4?.state === '待排' && r4.shortageNote.includes('占用'), r4?.shortageNote ?? '');

  check('行修订号升到 2', r1?.revision === 2 && (await db.sessions.get('s1'))?.revision === 2);

  // 重开后待排条目接着排：释放一场（删 s2，下午），r2 通宵需 2 份：剩上午 1 份 → 删除后剩 2 份，可排
  await db.sessions.delete('s2');
  const outcome = await (await import('../src/utils/db')).arrangeRetake('r2');
  check('释放一场后待排补录可排进', outcome.scheduled === true, JSON.stringify(outcome));
  const r2again = await db.retakes.get('r2');
  check('重排成功后状态已排期', r2again?.state === '已排期');
  check('重排成功后差额清空', r2again?.shortageNote === '');

  // 场次放号仍然走账本：A 棚 3-25 现有 s1(上午 1) + r2(通宵 2) = 3 份满
  const { evaluateBooking, sessionToEntry, retakeToEntry } = await import('../src/utils/ledger');
  const [allSessions, allRetakes] = await Promise.all([db.sessions.toArray(), db.retakes.toArray()]);
  const entries = [...allSessions.map(sessionToEntry), ...allRetakes.map(retakeToEntry)];
  const blocked = evaluateBooking(entries, { date: '2024-03-25', period: '晚上', roomNo: 'A 棚', musicianCount: 1 });
  check('补录已占账：晚上场次被额度拒绝', !blocked.allowed && blocked.shortages.some((s) => s.code === 'quota'));

  // 席位校验：C 棚 3 席放 5 人拒绝
  const cap = evaluateBooking(entries, { date: '2024-05-01', period: '上午', roomNo: 'C 棚', musicianCount: 5 });
  check('席位不足拒绝放号', !cap.allowed && cap.shortages.some((s) => s.code === 'capacity'));

  // 释放补录后额度回来
  await (await import('../src/utils/db')).releaseRetake('r2');
  const [s2after, r2after] = await Promise.all([db.sessions.toArray(), db.retakes.toArray()]);
  const entries2 = [...s2after.map(sessionToEntry), ...r2after.map(retakeToEntry)];
  const now2 = evaluateBooking(entries2, { date: '2024-03-25', period: '晚上', roomNo: 'A 棚', musicianCount: 1 });
  check('释放补录后晚上场次可放', now2.allowed);

  db.close();
  await new Promise((resolve) => {
    indexedDB.deleteDatabase('gbstudiotake-db').onsuccess = () => resolve(null);
  });

  // 导入 v1 备份（缺字段）归一
  const { importSnapshot, db: db2 } = await import('../src/utils/db');
  await db2.open();
  await importSnapshot({
    name: 'gbstudiotake-db',
    schemaVersion: 1,
    exportedAt: new Date().toISOString(),
    projects: [],
    songs: [],
    sessions: [],
    takes: [],
    picks: [],
    // 故意只给 v1 字段
    retakes: [
      { id: 'x1', songId: 'g1', reason: '导入旧备份', planDate: '2024-06-01', state: '待安排' } as never
    ]
  });
  const imported = await db2.retakes.get('x1');
  check('导入 v1 备份自动补棚号时段', imported?.roomNo === 'A 棚' && imported.period === '上午' && imported.musicians === '');
  db2.close();

  if (failures > 0) {
    console.error(`\n${failures} 个用例失败`);
    process.exit(1);
  }
  console.log('\n全部迁移/导入/抢账用例通过');
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
