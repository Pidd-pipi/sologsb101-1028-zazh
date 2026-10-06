/**
 * 棚时段账本（纯函数，不触碰 IndexedDB）。
 *
 * 同一本账的两个占有方：
 * - 场次（Session，state !== '已取消'）
 * - 补录安排（Retake，state === '已排期'）
 *
 * 记账规则：
 * 1. 同天同棚同一时段只放一个号（互斥占用）；
 * 2. 每个棚每天有总额度，普通时段（上午/下午/晚上）占 1 份，通宵占 2 份，
 *    同天同棚剩余额度不足时不放号；
 * 3. 参与乐手人数超过棚席位容量时不放号。
 *
 * 场次放号失败直接拒绝；补录放号失败记为「待排」并写清差多少。
 */
import type { Session, SessionPeriod } from '@/types/session';
import type { Retake } from '@/types/retake';
import { getRoomConfig, roomDailyQuota, roomMusicianCapacity } from '@/types/room';

/** 账本里的一个占有条目（场次或补录安排） */
export interface BookingEntry {
  id: string;
  kind: 'session' | 'retake';
  date: string;
  period: SessionPeriod;
  roomNo: string;
  /** 参与乐手人数 */
  musicianCount: number;
  /** 是否参与记账（已取消的场次、待安排/待排的补录不占额度） */
  active: boolean;
}

/** 一次放号请求（尚未入账） */
export interface BookingRequest {
  date: string;
  period: SessionPeriod;
  roomNo: string;
  musicianCount: number;
}

/** 差额类型：时段撞号 / 额度不足 / 席位不足 */
export type ShortageCode = 'slot' | 'quota' | 'capacity';

/** 一笔差额说明 */
export interface Shortage {
  code: ShortageCode;
  /** 人类可读的差额描述，写进待排原因 */
  detail: string;
}

/** 放号评估结果：allowed=false 时 shortages 非空 */
export interface BookingResult {
  allowed: boolean;
  /** 该请求自身占用的额度份数 */
  needShares: number;
  /** 不含自身时同天同棚已用份额 */
  usedShares: number;
  /** 该棚每日总额度 */
  quota: number;
  /** 不含自身时同天同棚剩余份额 */
  remaining: number;
  /** 棚席位容量 */
  capacity: number;
  shortages: Shortage[];
}

/** 乐手人数：与场次页席位统计一致，按顿号/中英文逗号拆分非空项 */
export function countMusicians(musicians: string): number {
  return musicians
    .split(/[、,，]/)
    .map((name) => name.trim())
    .filter((name) => name.length > 0).length;
}

/** 某时段占用的额度份数：通宵占 2 份，其余时段占 1 份 */
export function periodShares(period: SessionPeriod): number {
  return period === '通宵' ? 2 : 1;
}

/** 场次 → 账本条目 */
export function sessionToEntry(session: Pick<Session, 'id' | 'date' | 'period' | 'roomNo' | 'musicians' | 'state'>): BookingEntry {
  return {
    id: session.id,
    kind: 'session',
    date: session.date,
    period: session.period,
    roomNo: session.roomNo,
    musicianCount: countMusicians(session.musicians),
    active: session.state !== '已取消'
  };
}

/** 补录 → 账本条目（仅「已排期」占额度） */
export function retakeToEntry(
  retake: Pick<Retake, 'id' | 'planDate' | 'period' | 'roomNo' | 'musicians' | 'state'>
): BookingEntry {
  return {
    id: retake.id,
    kind: 'retake',
    date: retake.planDate,
    period: retake.period,
    roomNo: retake.roomNo,
    musicianCount: countMusicians(retake.musicians ?? ''),
    active: retake.state === '已排期'
  };
}

function entryLabel(entry: BookingEntry): string {
  return entry.kind === 'session' ? `场次 ${entry.id}` : `补录安排 ${entry.id}`;
}

/**
 * 评估一次放号请求能否入账。
 * @param entries 当前账本全部条目（场次 + 补录）
 * @param request 本次放号请求
 * @param selfId 编辑/重排自身时排除的条目 id
 */
export function evaluateBooking(
  entries: BookingEntry[],
  request: BookingRequest,
  selfId: string | null = null
): BookingResult {
  const need = periodShares(request.period);
  const quota = roomDailyQuota(request.roomNo);
  const capacity = roomMusicianCapacity(request.roomNo);

  const peers = entries.filter(
    (entry) => entry.active && entry.id !== selfId && entry.roomNo === request.roomNo && entry.date === request.date
  );

  // 规则 1：同天同棚同一时段互斥
  const occupant = peers.find((entry) => entry.period === request.period);

  // 规则 2：同天同棚份额总额度
  const usedShares = peers.reduce((sum, entry) => sum + periodShares(entry.period), 0);
  const remaining = Math.max(quota - usedShares, 0);
  const quotaLack = Math.max(need - remaining, 0);

  // 规则 3：乐手席位容量
  const capacityLack = Math.max(request.musicianCount - capacity, 0);

  const shortages: Shortage[] = [];
  if (occupant) {
    shortages.push({
      code: 'slot',
      detail: `${request.roomNo} 在 ${request.date} ${request.period} 已被${entryLabel(occupant)}占用，需换棚或换时段`
    });
  }
  if (quotaLack > 0) {
    const overnightHint = request.period === '通宵' ? '（通宵占 2 份）' : '';
    shortages.push({
      code: 'quota',
      detail: `${request.roomNo} 在 ${request.date} 剩余额度 ${remaining} 份，本次需 ${need} 份${overnightHint}，还差 ${quotaLack} 份`
    });
  }
  if (capacityLack > 0) {
    shortages.push({
      code: 'capacity',
      detail: `乐手 ${request.musicianCount} 人超过 ${request.roomNo} 席位容量 ${capacity} 人，还差 ${capacityLack} 个席位`
    });
  }

  return {
    allowed: shortages.length === 0,
    needShares: need,
    usedShares,
    quota,
    remaining,
    capacity,
    shortages
  };
}

/** 差额描述拼成一句（供拒绝提示与待排原因使用） */
export function describeShortages(shortages: Shortage[]): string {
  return shortages.map((item) => item.detail).join('；');
}

/** 账本审计问题（历史脏数据 / 已存在超额时提示） */
export interface LedgerIssue {
  roomNo: string;
  date: string;
  detail: string;
}

/**
 * 审计既有账本：列出同棚同时段撞号、份额超额、席位超额的棚·天。
 * 新规则上线后用于页面提示历史数据问题（不做静默修改）。
 */
export function auditLedger(entries: BookingEntry[]): LedgerIssue[] {
  const issues: LedgerIssue[] = [];
  const groups = new Map<string, BookingEntry[]>();
  for (const entry of entries) {
    if (!entry.active) continue;
    const key = `${entry.roomNo}|${entry.date}`;
    const group = groups.get(key) ?? [];
    group.push(entry);
    groups.set(key, group);
  }

  for (const [key, group] of groups) {
    const [roomNo, date] = key.split('|');
    const periodOwners = new Map<SessionPeriod, BookingEntry[]>();
    for (const entry of group) {
      const owners = periodOwners.get(entry.period) ?? [];
      owners.push(entry);
      periodOwners.set(entry.period, owners);
    }
    for (const [period, owners] of periodOwners) {
      if (owners.length > 1) {
        issues.push({
          roomNo,
          date,
          detail: `${roomNo} · ${date} · ${period} 撞号：${owners.map(entryLabel).join('、')}`
        });
      }
    }

    const quota = getRoomConfig(roomNo).dailyQuota;
    const usedShares = group.reduce((sum, entry) => sum + periodShares(entry.period), 0);
    if (usedShares > quota) {
      issues.push({
        roomNo,
        date,
        detail: `${roomNo} · ${date} 额度超额：已用 ${usedShares} 份 / 上限 ${quota} 份（通宵按 2 份计）`
      });
    }

    for (const entry of group) {
      const capacity = roomMusicianCapacity(roomNo);
      if (entry.musicianCount > capacity) {
        issues.push({
          roomNo,
          date,
          detail: `${roomNo} · ${date} ${entryLabel(entry)}乐手 ${entry.musicianCount} 人，超过席位容量 ${capacity} 人`
        });
      }
    }
  }
  return issues;
}
