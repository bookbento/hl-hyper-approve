// Batched GET /api/users/basic-info: every user label on the memo page used to
// ask for its own id (one request per approver). Ids requested in the same
// tick are now collected into a single ?ids=1,2,3 call.
import { api } from "./api";

export type UserBasicInfo = {
  id: number;
  name?: string | null;
  lastname?: string | null;
  nickname?: string | null;
  [key: string]: unknown;
};

type Waiter = { resolve: (u: UserBasicInfo | null) => void; reject: (e: unknown) => void };

const BATCH_WINDOW_MS = 10;
let queue = new Map<number, Waiter[]>();
let timer: ReturnType<typeof setTimeout> | null = null;

async function flush(): Promise<void> {
  const batch = queue;
  queue = new Map();
  timer = null;
  const ids = [...batch.keys()];
  try {
    const { data } = await api.get(`/api/users/basic-info`, {
      params: { ids: ids.join(",") },
      withCredentials: true,
    });
    const list: UserBasicInfo[] = Array.isArray(data) ? data : data ? [data] : [];
    for (const id of ids) {
      const u = list.find((x) => x?.id === id) ?? null;
      batch.get(id)!.forEach((w) => w.resolve(u));
    }
  } catch (err) {
    batch.forEach((waiters) => waiters.forEach((w) => w.reject(err)));
  }
}

export function getUserBasicInfo(id: number): Promise<UserBasicInfo | null> {
  return new Promise((resolve, reject) => {
    const waiters = queue.get(id) ?? [];
    waiters.push({ resolve, reject });
    queue.set(id, waiters);
    timer ??= setTimeout(() => void flush(), BATCH_WINDOW_MS);
  });
}
