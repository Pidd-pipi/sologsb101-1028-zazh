import type { SessionPeriod } from './session';

/** 补录状态：待安排 →（排号成功）已排期 /（排不下）待排 → 已完成 */
export type RetakeState = '待安排' | '待排' | '已排期' | '已完成';

/** 补录计划：针对问题段落重新录制，排号后与场次抢同一本棚位账 */
export interface Retake {
  id: string;
  /** 所属曲目 */
  songId: string;
  /** 补录原因 */
  reason: string;
  /** 计划日期 */
  planDate: string;
  /** 棚号（v2 起必填；旧数据由迁移补默认值） */
  roomNo: string;
  /** 时段（v2 起必填；旧数据由迁移补默认值） */
  period: SessionPeriod;
  /** 状态 */
  state: RetakeState;
  /** 排号失败说明（差几份额度 / 被谁占用），排上号后清空 */
  shortfall: string;
}

export const RETAKE_STATES: RetakeState[] = ['待安排', '待排', '已排期', '已完成'];

/** 可手工流转的状态（「待排」只能由排号失败产生） */
export const RETAKE_MANUAL_STATES: RetakeState[] = ['待安排', '已排期', '已完成'];

export function createEmptyRetake(): Omit<Retake, 'id'> {
  return {
    songId: '',
    reason: '',
    planDate: new Date().toISOString().slice(0, 10),
    roomNo: 'A 棚',
    period: '上午',
    state: '待安排',
    shortfall: ''
  };
}
