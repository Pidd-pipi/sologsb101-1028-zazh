/**
 * 棚位账本（纯函数，不触碰 IndexedDB）
 * 每个棚每天一本账：普通时段占 1 份额度、通宵占 2 份，额度用完不再放号；
 * 场次与已排期补录抢同一本账，乐手人数超过棚位容量即拒绝排号。
 * 账目口径集中在此文件，页面与 store 不得各自另算。
 */
import {
  countMusicians,
  periodWeight,
  studioRoomConfig,
  type Session,
  type SessionPeriod
} from '@/types/session';
import type { Retake } from '@/types/retake';

/** 账本里的一笔占用 */
export interface LedgerEntry {
  /** 来源：场次或补录 */
  kind: '场次' | '补录';
  id: string;
  period: SessionPeriod;
  /** 占用份额（通宵 2 份，其余 1 份） */
  weight: number;
}

/** 某天某棚的账目 */
export interface RoomDayLedger {
  roomNo: string;
  date: string;
  /** 当日额度总量 */
  quota: number;
  /** 已用份额 */
  used: number;
  /** 剩余份额（为负说明历史数据超额） */
  remaining: number;
  entries: LedgerEntry[];
}

/** 排号校验结果：ok=false 时 reason 写清差多少 */
export interface PlacementCheck {
  ok: boolean;
  reason: string;
}

/** 占用额度的补录状态（待安排 / 待排不占账） */
const RETAKE_BOOKED_STATES: Retake['state'][] = ['已排期', '已完成'];

/**
 * 汇总某天某棚的账目：未取消的场次 + 已排期/已完成的补录。
 * @param excludeIds 编辑自身时排除，避免把自己算成占用
 */
export function buildRoomDayLedger(
  roomNo: string,
  date: string,
  sessions: Session[],
  retakes: Retake[],
  excludeIds: string[] = []
): RoomDayLedger {
  const excluded = new Set(excludeIds);
  const entries: LedgerEntry[] = [];
  for (const session of sessions) {
    if (session.roomNo !== roomNo || session.date !== date || session.state === '已取消' || excluded.has(session.id)) {
      continue;
    }
    entries.push({ kind: '场次', id: session.id, period: session.period, weight: periodWeight(session.period) });
  }
  for (const retake of retakes) {
    if (retake.roomNo !== roomNo || retake.planDate !== date || excluded.has(retake.id)) continue;
    if (!RETAKE_BOOKED_STATES.includes(retake.state)) continue;
    entries.push({ kind: '补录', id: retake.id, period: retake.period, weight: periodWeight(retake.period) });
  }
  const used = entries.reduce((sum, entry) => sum + entry.weight, 0);
  const quota = studioRoomConfig(roomNo).dailyQuota;
  return { roomNo, date, quota, used, remaining: quota - used, entries };
}

/** 校验场次能否排入：同时段冲突 → 棚位容量 → 时段额度，任一不过即拒绝 */
export function checkSessionPlacement(input: {
  roomNo: string;
  date: string;
  period: SessionPeriod;
  musicians: string;
  sessions: Session[];
  retakes: Retake[];
  selfId?: string | null;
}): PlacementCheck {
  const { roomNo, date, period, musicians, sessions, retakes, selfId = null } = input;
  const conflict = sessions.find(
    (item) =>
      item.roomNo === roomNo &&
      item.date === date &&
      item.period === period &&
      item.state !== '已取消' &&
      item.id !== selfId
  );
  if (conflict) {
    return { ok: false, reason: `${roomNo} 在 ${date} ${period} 已被场次占用（场次 ${conflict.id}），请换棚或换时段` };
  }
  const config = studioRoomConfig(roomNo);
  const headcount = countMusicians(musicians);
  if (headcount > config.capacity) {
    return {
      ok: false,
      reason: `${roomNo} 棚位容量 ${config.capacity} 人，本场乐手 ${headcount} 人，超出 ${headcount - config.capacity} 人，请换大棚或分批录制`
    };
  }
  const ledger = buildRoomDayLedger(roomNo, date, sessions, retakes, selfId ? [selfId] : []);
  const need = periodWeight(period);
  if (ledger.remaining < need) {
    return {
      ok: false,
      reason: `${roomNo} ${date} 时段额度不足：本场需 ${need} 份，仅剩 ${ledger.remaining} 份（差 ${need - ledger.remaining} 份），请换日期或换棚`
    };
  }
  return { ok: true, reason: '' };
}

/** 校验补录能否排入：同时段被场次/补录占用 → 时段额度；排不下时由调用方记成待排 */
export function checkRetakePlacement(input: {
  roomNo: string;
  date: string;
  period: SessionPeriod;
  sessions: Session[];
  retakes: Retake[];
  selfId?: string | null;
}): PlacementCheck {
  const { roomNo, date, period, sessions, retakes, selfId = null } = input;
  const sessionConflict = sessions.find(
    (item) => item.roomNo === roomNo && item.date === date && item.period === period && item.state !== '已取消'
  );
  if (sessionConflict) {
    return { ok: false, reason: `${roomNo} 在 ${date} ${period} 已被场次占用（场次 ${sessionConflict.id}），补录需换时段` };
  }
  const retakeConflict = retakes.find(
    (item) =>
      item.id !== selfId &&
      item.roomNo === roomNo &&
      item.planDate === date &&
      item.period === period &&
      RETAKE_BOOKED_STATES.includes(item.state)
  );
  if (retakeConflict) {
    return { ok: false, reason: `${roomNo} 在 ${date} ${period} 已被补录占用（补录 ${retakeConflict.id}），请换时段` };
  }
  const ledger = buildRoomDayLedger(roomNo, date, sessions, retakes, selfId ? [selfId] : []);
  const need = periodWeight(period);
  if (ledger.remaining < need) {
    return {
      ok: false,
      reason: `${roomNo} ${date} 时段额度不足：补录需 ${need} 份，仅剩 ${ledger.remaining} 份（差 ${need - ledger.remaining} 份）`
    };
  }
  return { ok: true, reason: '' };
}
