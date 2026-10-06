/**
 * 棚配置：每个棚每日放号总额度与乐手席位数上限。
 * 棚号本身在 types/session.ts 的 STUDIO_ROOMS 中维护，这里只放额度账参数，
 * 保持「常量 + 纯函数」，供 utils/ledger 与页面引用，不反向依赖 db。
 */

/** 一个棚的额度配置 */
export interface RoomConfig {
  /** 棚号（与 STUDIO_ROOMS 一致） */
  roomNo: string;
  /** 每日放号总额度（普通时段占 1 份，通宵占 2 份） */
  dailyQuota: number;
  /** 乐手席位容量上限 */
  musicianCapacity: number;
}

/**
 * 各棚每日账本参数。
 * 4 个时段（上午/下午/晚上）各 1 份、通宵 2 份，故每日总额度定为 3 份：
 * 额度按份放完即止；大排练厅额度与席位均更大。
 */
export const ROOM_CONFIGS: RoomConfig[] = [
  { roomNo: 'A 棚', dailyQuota: 3, musicianCapacity: 6 },
  { roomNo: 'B 棚', dailyQuota: 3, musicianCapacity: 4 },
  { roomNo: 'C 棚', dailyQuota: 3, musicianCapacity: 3 },
  { roomNo: '大排练厅', dailyQuota: 3, musicianCapacity: 12 }
];

const ROOM_CONFIG_MAP = new Map<string, RoomConfig>(ROOM_CONFIGS.map((item) => [item.roomNo, item]));

/** 未登记棚号时的兜底配置（额度按 3 份、席位 6 人） */
export const DEFAULT_ROOM_CONFIG: RoomConfig = { roomNo: '', dailyQuota: 3, musicianCapacity: 6 };

/** 取某个棚的额度配置；未登记的棚号返回兜底配置 */
export function getRoomConfig(roomNo: string): RoomConfig {
  return ROOM_CONFIG_MAP.get(roomNo) ?? { ...DEFAULT_ROOM_CONFIG, roomNo };
}

/** 棚的每日放号总额度 */
export function roomDailyQuota(roomNo: string): number {
  return getRoomConfig(roomNo).dailyQuota;
}

/** 棚的乐手席位容量 */
export function roomMusicianCapacity(roomNo: string): number {
  return getRoomConfig(roomNo).musicianCapacity;
}
