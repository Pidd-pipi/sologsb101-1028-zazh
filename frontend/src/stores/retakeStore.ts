/**
 * 补录 store：补录安排与场次抢同一本棚时段账。
 * - 保存 / 编辑（非已完成）时自动尝试排进账本：排得下记「已排期」并清空差额，
 *   排不下记「待排」并写清差多少（差几份额度 / 几个席位 / 被谁撞号）；
 * - 「待排」条目可反复重新安排（arrange），重开应用后依然有效；
 * - 「已排期」可释放回「待排」，释放后即不再占用额度。
 */
import { create } from 'zustand';
import type { Retake } from '@/types/retake';
import { arrangeRetake, putRetake, releaseRetake, removeRetake, updateRetake } from '@/utils/db';
import { buildRow } from '@/hooks/useIdbTable';

export interface ArrangeOutcome {
  scheduled: boolean;
  note: string;
}

interface RetakeStateStore {
  saveDraft: (payload: Omit<Retake, 'id'>) => Promise<ArrangeOutcome>;
  editDraft: (id: string, patch: Partial<Retake>) => Promise<ArrangeOutcome>;
  arrange: (id: string) => Promise<ArrangeOutcome>;
  release: (id: string) => Promise<void>;
  deleteRetake: (id: string) => Promise<void>;
}

/** 非已完成的草稿保存：与场次抢同一本账，自动落「已排期」或「待排」 */
function draftPayload(payload: Omit<Retake, 'id'>): Omit<Retake, 'id'> {
  // 新建入口（待安排）没有差额信息，统一先清掉再交给账本判定
  return { ...payload, shortageNote: '' };
}

export const useRetakeStore = create<RetakeStateStore>()(() => ({
  saveDraft: async (payload) => {
    const row = buildRow(draftPayload(payload), 'retake');
    await putRetake(row);
    if (payload.state === '已完成') {
      return { scheduled: true, note: '补录已完成' };
    }
    return arrangeRetake(row.id);
  },
  editDraft: async (id, patch) => {
    await updateRetake(id, patch);
    if (patch.state === '已完成') {
      return { scheduled: true, note: '补录已完成' };
    }
    return arrangeRetake(id);
  },
  arrange: async (id) => arrangeRetake(id),
  release: async (id) => {
    await releaseRetake(id);
  },
  deleteRetake: async (id) => {
    await removeRetake(id);
  }
}));
