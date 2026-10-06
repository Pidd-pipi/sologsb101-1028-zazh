/**
 * IndexedDB 持久化层（Dexie 封装）
 * - 数据库名 gbstudiotake-db，数据结构版本号与 upgrade() 迁移逻辑
 * - 项目 / 曲目 / 场次 / Take / 优选 / 补录 六张表分表存储
 * - 首次打开自动播种互相引用的演示数据，保证每个页面打开都有内容
 */
import Dexie, { type Table } from 'dexie';
import type { Project } from '../types/project';
import type { Song } from '../types/song';
import type { Session, SessionPeriod } from '../types/session';
import type { Take } from '../types/take';
import type { Pick } from '../types/pick';
import type { Retake, RetakeState } from '../types/retake';
import { normalizeRetake } from '../types/retake';
import { nowIso } from './uuid';
import { seedDatabase } from './seed';
import { ROW_REVISION } from './revision';
import {
  countMusicians,
  describeShortages,
  evaluateBooking,
  retakeToEntry,
  sessionToEntry,
  type BookingEntry
} from './ledger';

/** 数据库名 */
export const DB_NAME = 'gbstudiotake-db';

/** 当前数据结构版本号（每次调整字段结构必须 +1 并补迁移） */
export const DB_SCHEMA_VERSION = 2;

/** 行结构修订号（定义在叶子模块 ./revision，避免与 ./seed 形成循环依赖） */
export { ROW_REVISION };

export interface Revisioned {
  revision: number;
  createdAt: number;
  updatedAt: number;
}

export type ProjectRow = Project & Revisioned;
export type SongRow = Song & Revisioned;
export type SessionRow = Session & Revisioned;
export type TakeRow = Take & Revisioned;
export type PickRow = Pick & Revisioned;
export type RetakeRow = Retake & Revisioned;

export class GbStudioTakeDatabase extends Dexie {
  projects!: Table<ProjectRow, string>;
  songs!: Table<SongRow, string>;
  sessions!: Table<SessionRow, string>;
  takes!: Table<TakeRow, string>;
  picks!: Table<PickRow, string>;
  retakes!: Table<RetakeRow, string>;

  constructor() {
    super(DB_NAME);

    this.version(1)
      .stores({
        projects: 'id, name, client, state, startDate, updatedAt',
        songs: 'id, projectId, title, arrangement, state, updatedAt',
        sessions: 'id, songId, date, period, roomNo, engineer, state, updatedAt',
        takes: 'id, sessionId, takeNo, grade, startTc, updatedAt',
        picks: 'id, takeId, usage, order, updatedAt',
        retakes: 'id, songId, planDate, state, updatedAt'
      })
      .upgrade(async (tx) => {
        // v1 结构迁移：为历史行补齐行修订号与时间戳；新建库时各表为空，迁移天然幂等
        const tableNames = ['projects', 'songs', 'sessions', 'takes', 'picks', 'retakes'];
        for (const name of tableNames) {
          await tx
            .table(name)
            .toCollection()
            .modify((row: Record<string, unknown>) => {
              row.revision = ROW_REVISION;
              if (typeof row.createdAt !== 'number') row.createdAt = Date.now();
              if (typeof row.updatedAt !== 'number') row.updatedAt = row.createdAt;
            });
        }
      });

    // v2：补录计划补上棚号 / 时段 / 乐手 / 待排差额，与场次共用一本棚时段账
    this.version(2)
      .stores({
        retakes: 'id, songId, planDate, roomNo, period, state, updatedAt'
      })
      .upgrade(async (tx) => {
        const sessions = (await tx.table('sessions').toArray()) as SessionRow[];
        const retakes = (await tx.table('retakes').toArray()) as RetakeRow[];

        // 1) 为缺棚号 / 时段的旧补录计划补字段
        retakes.forEach((retake) => {
          if (typeof retake.roomNo !== 'string' || retake.roomNo.length === 0) retake.roomNo = 'A 棚';
          if (!retake.period) retake.period = '上午' as SessionPeriod;
          if (typeof retake.musicians !== 'string') retake.musicians = '';
          if (typeof retake.shortageNote !== 'string') retake.shortageNote = '';
        });

        // 2) 与场次对同一本账：排不下的旧「已排期」补录降级为「待排」并写清差额
        const entries: BookingEntry[] = sessions.map(sessionToEntry);
        retakes.forEach((retake) => {
          if (retake.state !== '已排期') return;
          const result = evaluateBooking(entries, {
            date: retake.planDate,
            period: retake.period,
            roomNo: retake.roomNo,
            musicianCount: countMusicians(retake.musicians ?? '')
          });
          if (result.allowed) {
            entries.push(retakeToEntry(retake));
          } else {
            retake.state = '待排' as RetakeState;
            retake.shortageNote = describeShortages(result.shortages);
          }
        });

        await tx.table('retakes').clear();
        await tx.table('retakes').bulkPut(retakes);

        // 3) 行修订号升到 v2
        const tableNames = ['projects', 'songs', 'sessions', 'takes', 'picks', 'retakes'];
        for (const name of tableNames) {
          await tx
            .table(name)
            .toCollection()
            .modify((row: Record<string, unknown>) => {
              row.revision = ROW_REVISION;
            });
        }
      });
  }
}

export const db = new GbStudioTakeDatabase();

/** 打开数据库：首次使用时灌入演示数据（幂等：表非空不播） */
export async function initDatabase(): Promise<void> {
  await db.open();
  if ((await db.projects.count()) === 0) {
    await seedDatabase(db);
  }
}

/* ------------------------------ 项目 ------------------------------ */

export async function listProjects(): Promise<ProjectRow[]> {
  const rows = await db.projects.toArray();
  return rows.sort((a, b) => b.startDate.localeCompare(a.startDate));
}

export async function putProject(row: ProjectRow): Promise<void> {
  await db.projects.put(row);
}

export async function updateProject(id: string, patch: Partial<Project>): Promise<void> {
  await db.projects.update(id, { ...patch, updatedAt: Date.now() } as never);
}

/** 删除项目：级联删除曲目、场次、Take、优选与补录 */
export async function removeProject(id: string): Promise<void> {
  await db.transaction('rw', [db.projects, db.songs, db.sessions, db.takes, db.picks, db.retakes], async () => {
    const songs = await db.songs.where('projectId').equals(id).toArray();
    for (const song of songs) {
      await cascadeRemoveSong(song.id);
    }
    await db.projects.delete(id);
  });
}

/* ------------------------------ 曲目 ------------------------------ */

export async function listSongs(): Promise<SongRow[]> {
  const rows = await db.songs.toArray();
  return rows.sort((a, b) => a.title.localeCompare(b.title, 'zh-Hans-CN'));
}

export async function putSong(row: SongRow): Promise<void> {
  await db.songs.put(row);
}

export async function updateSong(id: string, patch: Partial<Song>): Promise<void> {
  await db.songs.update(id, { ...patch, updatedAt: Date.now() } as never);
}

async function cascadeRemoveSong(songId: string): Promise<void> {
  const sessions = await db.sessions.where('songId').equals(songId).toArray();
  const sessionIds = sessions.map((item) => item.id);
  if (sessionIds.length > 0) {
    const takes = await db.takes.where('sessionId').anyOf(sessionIds).toArray();
    const takeIds = takes.map((item) => item.id);
    if (takeIds.length > 0) {
      await db.picks.where('takeId').anyOf(takeIds).delete();
    }
    await db.takes.where('sessionId').anyOf(sessionIds).delete();
    await db.sessions.where('songId').equals(songId).delete();
  }
  await db.retakes.where('songId').equals(songId).delete();
  await db.songs.delete(songId);
}

export async function removeSong(id: string): Promise<void> {
  await db.transaction('rw', [db.songs, db.sessions, db.takes, db.picks, db.retakes], async () => {
    await cascadeRemoveSong(id);
  });
}

/* ------------------------------ 场次 ------------------------------ */

export async function listSessions(): Promise<SessionRow[]> {
  const rows = await db.sessions.toArray();
  return rows.sort((a, b) => a.date.localeCompare(b.date));
}

export async function putSession(row: SessionRow): Promise<void> {
  await db.sessions.put(row);
}

export async function getSession(id: string): Promise<SessionRow | undefined> {
  return db.sessions.get(id);
}

export async function updateSession(id: string, patch: Partial<Session>): Promise<void> {
  await db.sessions.update(id, { ...patch, updatedAt: Date.now() } as never);
}

/** 组装当前账本全部占有条目：有效场次 + 已排期补录，二者抢同一本账 */
export async function listBookingEntries(): Promise<BookingEntry[]> {
  const [sessions, retakes] = await Promise.all([db.sessions.toArray(), db.retakes.toArray()]);
  return [...sessions.map(sessionToEntry), ...retakes.map(retakeToEntry)];
}

/** 删除场次：级联删除其 Take 与对应优选 */
export async function removeSession(id: string): Promise<void> {
  await db.transaction('rw', [db.sessions, db.takes, db.picks], async () => {
    const takes = await db.takes.where('sessionId').equals(id).toArray();
    const takeIds = takes.map((item) => item.id);
    if (takeIds.length > 0) {
      await db.picks.where('takeId').anyOf(takeIds).delete();
    }
    await db.takes.where('sessionId').equals(id).delete();
    await db.sessions.delete(id);
  });
}

/* ------------------------------ Take ------------------------------ */

export async function listTakes(): Promise<TakeRow[]> {
  return db.takes.toArray();
}

export async function putTake(row: TakeRow): Promise<void> {
  await db.takes.put(row);
}

export async function updateTake(id: string, patch: Partial<Take>): Promise<void> {
  await db.takes.update(id, { ...patch, updatedAt: Date.now() } as never);
}

/** 批量改评级 */
export async function bulkUpdateGrade(ids: string[], grade: Take['grade']): Promise<void> {
  await db.transaction('rw', [db.takes], async () => {
    for (const id of ids) {
      await db.takes.update(id, { grade, updatedAt: Date.now() } as never);
    }
  });
}

export async function removeTake(id: string): Promise<void> {
  await db.transaction('rw', [db.takes, db.picks], async () => {
    await db.picks.where('takeId').equals(id).delete();
    await db.takes.delete(id);
  });
}

/* ------------------------------ 优选 ------------------------------ */

export async function listPicks(): Promise<PickRow[]> {
  const rows = await db.picks.toArray();
  return rows.sort((a, b) => a.order - b.order);
}

export async function putPick(row: PickRow): Promise<void> {
  await db.picks.put(row);
}

export async function updatePick(id: string, patch: Partial<Pick>): Promise<void> {
  await db.picks.update(id, { ...patch, updatedAt: Date.now() } as never);
}

/** 拖拽 / 上下移后按新顺序批量写回 */
export async function reorderPicks(orderedIds: string[]): Promise<void> {
  await db.transaction('rw', [db.picks], async () => {
    for (let index = 0; index < orderedIds.length; index += 1) {
      await db.picks.update(orderedIds[index], { order: index + 1, updatedAt: Date.now() } as never);
    }
  });
}

export async function nextPickOrder(): Promise<number> {
  const rows = await db.picks.toArray();
  return rows.reduce((max, row) => Math.max(max, row.order), 0) + 1;
}

export async function removePick(id: string): Promise<void> {
  await db.picks.delete(id);
}

/* ------------------------------ 补录 ------------------------------ */

export async function listRetakes(): Promise<RetakeRow[]> {
  const rows = await db.retakes.toArray();
  return rows.sort((a, b) => a.planDate.localeCompare(b.planDate));
}

export async function putRetake(row: RetakeRow): Promise<void> {
  await db.retakes.put(row);
}

export async function updateRetake(id: string, patch: Partial<Retake>): Promise<void> {
  await db.retakes.update(id, { ...patch, updatedAt: Date.now() } as never);
}

/**
 * 尝试把补录排进棚时段账本：
 * - 排得下 → state='已排期' 并清空待排差额；
 * - 排不下 → state='待排' 并写清差多少（不占额度，重开后可再排）。
 */
export async function arrangeRetake(id: string): Promise<{ scheduled: boolean; note: string }> {
  return db.transaction('rw', [db.retakes, db.sessions], async () => {
    const retake = await db.retakes.get(id);
    if (!retake) throw new Error('补录条目不存在');
    if (retake.state === '已完成') return { scheduled: true, note: '补录已完成' };

    const [sessions, retakes] = await Promise.all([db.sessions.toArray(), db.retakes.toArray()]);
    const entries: BookingEntry[] = [
      ...sessions.map(sessionToEntry),
      ...retakes.filter((item) => item.id !== id).map(retakeToEntry)
    ];
    const result = evaluateBooking(entries, {
      date: retake.planDate,
      period: retake.period,
      roomNo: retake.roomNo,
      musicianCount: countMusicians(retake.musicians ?? '')
    });

    if (result.allowed) {
      await db.retakes.update(id, { state: '已排期', shortageNote: '', updatedAt: Date.now() } as never);
      return { scheduled: true, note: '已排进棚时段账' };
    }
    const note = describeShortages(result.shortages);
    await db.retakes.update(id, { state: '待排', shortageNote: note, updatedAt: Date.now() } as never);
    return { scheduled: false, note };
  });
}

/** 释放已排期的补录安排：退回待排（不占额度），可重新安排 */
export async function releaseRetake(id: string): Promise<void> {
  await db.retakes.update(id, { state: '待排', shortageNote: '', updatedAt: Date.now() } as never);
}

/** 补录完成：联动曲目状态 */
export async function completeRetake(id: string): Promise<void> {
  await db.transaction('rw', [db.retakes, db.songs], async () => {
    const retake = await db.retakes.get(id);
    if (!retake) throw new Error('补录条目不存在');
    await db.retakes.update(id, { state: '已完成', updatedAt: Date.now() } as never);
    const pending = await db.retakes
      .where('songId')
      .equals(retake.songId)
      .filter((item) => item.state !== '已完成' && item.id !== id)
      .count();
    await db.songs.update(retake.songId, { state: pending === 0 ? '已完成' : '录制中', updatedAt: Date.now() } as never);
  });
}

export async function removeRetake(id: string): Promise<void> {
  await db.retakes.delete(id);
}

/* --------------------------- 整库导入导出 --------------------------- */

export interface DatabaseSnapshot {
  name: string;
  schemaVersion: number;
  exportedAt: string;
  projects: Project[];
  songs: Song[];
  sessions: Session[];
  takes: Take[];
  picks: Pick[];
  retakes: Retake[];
}

function stripRow<T extends Revisioned>(row: T): Omit<T, keyof Revisioned> {
  const copy = { ...row } as Record<string, unknown>;
  delete copy.revision;
  delete copy.createdAt;
  delete copy.updatedAt;
  return copy as Omit<T, keyof Revisioned>;
}

export async function exportSnapshot(): Promise<DatabaseSnapshot> {
  const [projects, songs, sessions, takes, picks, retakes] = await Promise.all([
    db.projects.toArray(),
    db.songs.toArray(),
    db.sessions.toArray(),
    db.takes.toArray(),
    db.picks.toArray(),
    db.retakes.toArray()
  ]);
  return {
    name: DB_NAME,
    schemaVersion: DB_SCHEMA_VERSION,
    exportedAt: nowIso(),
    projects: projects.map(stripRow),
    songs: songs.map(stripRow),
    sessions: sessions.map(stripRow),
    takes: takes.map(stripRow),
    picks: picks.map(stripRow),
    retakes: retakes.map(stripRow)
  };
}

function stamp<T>(row: T): T & Revisioned {
  const now = Date.now();
  return { ...row, revision: ROW_REVISION, createdAt: now, updatedAt: now };
}

/**
 * 导入整库备份：
 * - v1 备份的补录缺棚号 / 时段，先归一补齐；
 * - 归一后再与场次对同一本账，排不下的补录降级为「待排」并写清差额。
 */
export async function importSnapshot(snapshot: DatabaseSnapshot): Promise<void> {
  const sessions = snapshot.sessions;
  const retakes = snapshot.retakes.map((retake) => normalizeRetake(retake) as Retake);

  const entries: BookingEntry[] = sessions.map(sessionToEntry);
  retakes.forEach((retake) => {
    if (retake.state !== '已排期') return;
    const result = evaluateBooking(entries, {
      date: retake.planDate,
      period: retake.period,
      roomNo: retake.roomNo,
      musicianCount: countMusicians(retake.musicians)
    });
    if (result.allowed) {
      entries.push(retakeToEntry(retake));
    } else {
      retake.state = '待排';
      retake.shortageNote = describeShortages(result.shortages);
    }
  });

  await db.transaction('rw', [db.projects, db.songs, db.sessions, db.takes, db.picks, db.retakes], async () => {
    await Promise.all([
      db.projects.clear(),
      db.songs.clear(),
      db.sessions.clear(),
      db.takes.clear(),
      db.picks.clear(),
      db.retakes.clear()
    ]);
    await db.projects.bulkPut(snapshot.projects.map(stamp));
    await db.songs.bulkPut(snapshot.songs.map(stamp));
    await db.sessions.bulkPut(sessions.map(stamp));
    await db.takes.bulkPut(snapshot.takes.map(stamp));
    await db.picks.bulkPut(snapshot.picks.map(stamp));
    await db.retakes.bulkPut(retakes.map(stamp));
  });
}

/** 清空全部数据并重新灌入演示数据 */
export async function resetDatabase(): Promise<void> {
  await db.transaction('rw', [db.projects, db.songs, db.sessions, db.takes, db.picks, db.retakes], async () => {
    await Promise.all([
      db.projects.clear(),
      db.songs.clear(),
      db.sessions.clear(),
      db.takes.clear(),
      db.picks.clear(),
      db.retakes.clear()
    ]);
  });
  await seedDatabase(db);
}

/** 各表行数统计 */
export async function countAll(): Promise<Record<string, number>> {
  const [projects, songs, sessions, takes, picks, retakes] = await Promise.all([
    db.projects.count(),
    db.songs.count(),
    db.sessions.count(),
    db.takes.count(),
    db.picks.count(),
    db.retakes.count()
  ]);
  return { projects, songs, sessions, takes, picks, retakes };
}
