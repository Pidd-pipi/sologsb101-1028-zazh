/**
 * 场次 store：维护场次排期、棚位账本校验与筛选条件。
 * 排号规则集中在 utils/ledger：同时段冲突、棚位容量、当日时段额度任一不过即拒绝。
 */
import { create } from 'zustand';
import type { FilterModel } from '@/types/filter';
import type { Session, SessionPeriod } from '@/types/session';
import { getRoomDayLoad, getSession, putSession, removeSession, updateSession } from '@/utils/db';
import { checkSessionPlacement } from '@/utils/ledger';
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
  /** 校验场次能否排入棚位账本（时段冲突 / 容量 / 额度），排不下抛出写明差多少的错误 */
  assertSessionPlacable: (
    payload: { roomNo: string; date: string; period: SessionPeriod; musicians: string },
    selfId: string | null
  ) => Promise<void>;
}

export const useSessionStore = create<SessionState>()((set, get) => ({
  filters: { keyword: '', rooms: [], periods: [], states: [] },
  currentSessionId: null,
  setFilters: (next) => set({ filters: next }),
  resetFilters: () => set({ filters: { keyword: '', rooms: [], periods: [], states: [] } }),
  selectSession: (id) => set({ currentSessionId: id }),
  assertSessionPlacable: async (payload, selfId) => {
    const { sessions, retakes } = await getRoomDayLoad(payload.roomNo, payload.date);
    const check = checkSessionPlacement({ ...payload, sessions, retakes, selfId });
    if (!check.ok) {
      throw new Error(check.reason);
    }
  },
  createSession: async (payload) => {
    if (payload.state !== '已取消') {
      await get().assertSessionPlacable(payload, null);
    }
    const row = buildRow(payload, 'session');
    await putSession(row);
    set({ currentSessionId: row.id });
    return row.id;
  },
  editSession: async (id, patch) => {
    const current = await getSession(id);
    if (!current) {
      throw new Error('场次不存在');
    }
    const merged = { ...current, ...patch };
    if (merged.state !== '已取消') {
      await get().assertSessionPlacable(
        { roomNo: merged.roomNo, date: merged.date, period: merged.period, musicians: merged.musicians },
        id
      );
    }
    await updateSession(id, { ...patch });
  },
  deleteSession: async (id) => {
    await removeSession(id);
    if (get().currentSessionId === id) set({ currentSessionId: null });
  }
}));
