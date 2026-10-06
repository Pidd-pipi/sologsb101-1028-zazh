/**
 * 场次 store：维护场次排期与筛选条件。
 * 放号校验走「棚时段账本」：同棚同时段互斥、同棚当天份额额度（通宵 2 份）、
 * 乐手席位容量；补录安排占有同一本账，任一条件不满足都拒绝排号。
 */
import { create } from 'zustand';
import type { FilterModel } from '@/types/filter';
import type { Session } from '@/types/session';
import {
  getSession,
  listBookingEntries,
  putSession,
  removeSession,
  updateSession
} from '@/utils/db';
import { countMusicians, describeShortages, evaluateBooking } from '@/utils/ledger';
import { buildRow } from '@/hooks/useIdbTable';

export const SESSION_FILTER_KEYS = ['rooms', 'periods', 'states'];

interface SessionState {
  filters: FilterModel;
  currentSessionId: string | null;
  setFilters: (next: FilterModel) => void;
  resetFilters: () => void;
  selectSession: (id: string | null) => void;
  createSession: (payload: Omit<Session, 'id'>) => Promise<string>;
  editSession: (id: string, patch: Partial<Session>) => Promise<void>;
  deleteSession: (id: string) => Promise<void>;
  /** 校验能否放号：撞号 / 额度不足 / 席位不足都抛出可读错误；取消场次不校验 */
  assertBookable: (booking: Omit<Session, 'id'>, selfId: string | null) => Promise<void>;
}

export const useSessionStore = create<SessionState>()((set, get) => ({
  filters: { keyword: '', rooms: [], periods: [], states: [] },
  currentSessionId: null,
  setFilters: (next) => set({ filters: next }),
  resetFilters: () => set({ filters: { keyword: '', rooms: [], periods: [], states: [] } }),
  selectSession: (id) => set({ currentSessionId: id }),
  assertBookable: async (booking, selfId) => {
    if (booking.state === '已取消') return;
    const entries = await listBookingEntries();
    const result = evaluateBooking(
      entries,
      {
        date: booking.date,
        period: booking.period,
        roomNo: booking.roomNo,
        musicianCount: countMusicians(booking.musicians)
      },
      selfId
    );
    if (!result.allowed) {
      throw new Error(describeShortages(result.shortages));
    }
  },
  createSession: async (payload) => {
    await get().assertBookable(payload, null);
    const row = buildRow(payload, 'session');
    await putSession(row);
    set({ currentSessionId: row.id });
    return row.id;
  },
  editSession: async (id, patch) => {
    // 编辑可能只改部分字段（如改成已取消），先与库中现存行合并再对整本账校验
    const existing = await getSession(id);
    if (!existing) throw new Error('场次不存在或已被删除');
    const merged: Omit<Session, 'id'> = {
      songId: patch.songId ?? existing.songId,
      date: patch.date ?? existing.date,
      period: patch.period ?? existing.period,
      engineer: patch.engineer ?? existing.engineer,
      roomNo: patch.roomNo ?? existing.roomNo,
      musicians: patch.musicians ?? existing.musicians,
      state: patch.state ?? existing.state
    };
    await get().assertBookable(merged, id);
    await updateSession(id, patch);
  },
  deleteSession: async (id) => {
    await removeSession(id);
    if (get().currentSessionId === id) set({ currentSessionId: null });
  }
}));
