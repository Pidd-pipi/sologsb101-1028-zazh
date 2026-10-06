import type { SessionPeriod } from './session';

/** 补录状态 */
export type RetakeState = '待安排' | '待排' | '已排期' | '已完成';

/** 补录计划：针对问题段落重新录制 */
export interface Retake {
  id: string;
  /** 所属曲目 */
  songId: string;
  /** 补录原因 */
  reason: string;
  /** 计划日期 YYYY-MM-DD */
  planDate: string;
  /** 计划棚号（与场次抢同一本棚时段账） */
  roomNo: string;
  /** 计划时段 */
  period: SessionPeriod;
  /** 参与乐手（顿号分隔），用于校验棚席位容量 */
  musicians: string;
  /**
   * 待排差额说明：安排进棚排不下时（state='待排'）写清差多少；
   * 成功排期后清空。
   */
  shortageNote: string;
  /** 状态 */
  state: RetakeState;
}

export const RETAKE_STATES: RetakeState[] = ['待安排', '待排', '已排期', '已完成'];

export function createEmptyRetake(): Omit<Retake, 'id'> {
  return {
    songId: '',
    reason: '',
    planDate: new Date().toISOString().slice(0, 10),
    roomNo: 'A 棚',
    period: '上午',
    musicians: '',
    shortageNote: '',
    state: '待安排'
  };
}

/**
 * 旧版补录行（v1）只有计划日期，没有棚号 / 时段 / 乐手 / 待排差额。
 * 导入 v1 备份时用此函数补齐字段，避免脏行进账。
 */
export function normalizeRetake(input: Partial<Retake>): Omit<Retake, 'id'> & { id?: string } {
  return {
    id: input.id,
    songId: input.songId ?? '',
    reason: input.reason ?? '',
    planDate: input.planDate ?? new Date().toISOString().slice(0, 10),
    roomNo: typeof input.roomNo === 'string' && input.roomNo.length > 0 ? input.roomNo : 'A 棚',
    period: input.period ?? '上午',
    musicians: input.musicians ?? '',
    shortageNote: input.shortageNote ?? '',
    state: input.state ?? '待安排'
  };
}
