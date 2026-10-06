/** 时段 */
export type SessionPeriod = '上午' | '下午' | '晚上' | '通宵';
/** 场次状态 */
export type SessionState = '已排期' | '已完成' | '已取消';

/** 录制场次：某曲目某天的录制安排 */
export interface Session {
  id: string;
  /** 所属曲目 */
  songId: string;
  /** 日期 YYYY-MM-DD */
  date: string;
  /** 时段 */
  period: SessionPeriod;
  /** 录音师 */
  engineer: string;
  /** 棚号 */
  roomNo: string;
  /** 参与乐手（顿号分隔） */
  musicians: string;
  /** 场次状态 */
  state: SessionState;
}

export const SESSION_PERIODS: SessionPeriod[] = ['上午', '下午', '晚上', '通宵'];
export const SESSION_STATES: SessionState[] = ['已排期', '已完成', '已取消'];

export function createEmptySession(): Omit<Session, 'id'> {
  return {
    songId: '',
    date: new Date().toISOString().slice(0, 10),
    period: '上午',
    engineer: '',
    roomNo: 'A 棚',
    musicians: '',
    state: '已排期'
  };
}

/** 棚位配置：每个棚每天一本账——时段额度总量与乐手容量 */
export interface StudioRoomConfig {
  /** 棚号 */
  roomNo: string;
  /** 每日时段额度（普通时段占 1 份，通宵占 2 份），用完不再放号 */
  dailyQuota: number;
  /** 棚位容量（乐手人数上限），超过即拒绝排号 */
  capacity: number;
}

/** 各棚的账本配置 */
export const STUDIO_ROOM_CONFIGS: StudioRoomConfig[] = [
  { roomNo: 'A 棚', dailyQuota: 3, capacity: 6 },
  { roomNo: 'B 棚', dailyQuota: 3, capacity: 4 },
  { roomNo: 'C 棚', dailyQuota: 2, capacity: 2 },
  { roomNo: '大排练厅', dailyQuota: 4, capacity: 24 }
];

/** 棚号候选 */
export const STUDIO_ROOMS: string[] = STUDIO_ROOM_CONFIGS.map((item) => item.roomNo);

/** 查棚位配置；未知棚号给一份保守默认值，保证账本始终有数 */
export function studioRoomConfig(roomNo: string): StudioRoomConfig {
  return STUDIO_ROOM_CONFIGS.find((item) => item.roomNo === roomNo) ?? { roomNo, dailyQuota: 3, capacity: 4 };
}

/** 时段权重：通宵跨昼夜占两份额度，其余时段占一份 */
export function periodWeight(period: SessionPeriod): number {
  return period === '通宵' ? 2 : 1;
}

/** 解析参与乐手人数（顿号 / 逗号分隔） */
export function countMusicians(musicians: string): number {
  return musicians.split(/[、,，]/).filter((name) => name.trim().length > 0).length;
}
