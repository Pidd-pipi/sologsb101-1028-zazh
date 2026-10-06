/**
 * 补录 store：补录排号与场次抢同一本棚位账（utils/ledger）。
 * 排得下 → 已排期并占额度；排不下 → 记成待排并把差多少写进 shortfall，
 * 待排条目持久化在本地库，重开后仍可接着排（retryPending 逐条重试）。
 */
import { create } from 'zustand';
import type { Retake } from '@/types/retake';
import {
  completeRetake as dbCompleteRetake,
  getRetake,
  getRoomDayLoad,
  listRetakes,
  putRetake,
  removeRetake,
  updateRetake
} from '@/utils/db';
import { checkRetakePlacement } from '@/utils/ledger';
import { buildRow } from '@/hooks/useIdbTable';

interface RetakeState {
  createRetake: (payload: Omit<Retake, 'id'>) => Promise<string>;
  editRetake: (id: string, patch: Partial<Retake>) => Promise<void>;
  deleteRetake: (id: string) => Promise<void>;
  completeRetake: (id: string) => Promise<void>;
  /** 尝试把补录排进其 计划日期/棚号/时段：成功转已排期，失败转待排并写清差多少 */
  scheduleRetake: (id: string) => Promise<boolean>;
  /** 重试全部待排条目（例如场次取消释放出额度后），返回排上的条数 */
  retryPending: () => Promise<number>;
}

export const useRetakeStore = create<RetakeState>()((_set, get) => ({
  createRetake: async (payload) => {
    const row = buildRow(payload, 'retake');
    await putRetake(row);
    if (row.state === '已排期') {
      await get().scheduleRetake(row.id);
    }
    return row.id;
  },
  editRetake: async (id, patch) => {
    await updateRetake(id, patch);
    const merged = await getRetake(id);
    if (merged && merged.state === '已排期') {
      // 已排期的条目改了日期/棚号/时段后重新占账，排不下会回落为待排
      await get().scheduleRetake(id);
    }
  },
  deleteRetake: async (id) => {
    await removeRetake(id);
  },
  completeRetake: async (id) => {
    await dbCompleteRetake(id);
  },
  scheduleRetake: async (id) => {
    const row = await getRetake(id);
    if (!row) {
      throw new Error('补录条目不存在');
    }
    const { sessions, retakes } = await getRoomDayLoad(row.roomNo, row.planDate);
    const check = checkRetakePlacement({
      roomNo: row.roomNo,
      date: row.planDate,
      period: row.period,
      sessions,
      retakes,
      selfId: id
    });
    if (check.ok) {
      await updateRetake(id, { state: '已排期', shortfall: '' });
      return true;
    }
    await updateRetake(id, { state: '待排', shortfall: check.reason });
    return false;
  },
  retryPending: async () => {
    const rows = await listRetakes();
    const pending = rows.filter((item) => item.state === '待排');
    let placed = 0;
    for (const row of pending) {
      if (await get().scheduleRetake(row.id)) {
        placed += 1;
      }
    }
    return placed;
  }
}));
