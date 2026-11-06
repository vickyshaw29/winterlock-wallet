// React owns lifecycle and read caching; signing remains an explicit, non-retried action.
import {
  createContext,
  useContext,
  useEffect,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useSearchParams } from "react-router";
import {
  ApiError,
  createApi,
  deviceIssue,
  deviceIssueOf,
  errorText,
  isStalled,
  readStatus,
  statusBanner,
  stalledBanner,
  type WalletView,
} from "./api";

const client = createApi();
type Api = ReturnType<typeof createApi>;
const Context = createContext<ReturnType<typeof useWalletState> | null>(null);
function saved(key: string) {
  try {
    return localStorage.getItem(key);
  } catch {
    return null;
  }
}
export function remember(key: string, value: string) {
  try {
    localStorage.setItem(key, value);
  } catch {
    /* storage is optional */
  }
}

function useWalletState() {
  const cache = useQueryClient();
  const [params] = useSearchParams();
  const requested = params.get("wallet");
  const wallets = useQuery({
    queryKey: ["wallets"],
    queryFn: () => client.listWallets(),
    refetchInterval: 10_000,
  });
  const remembered = saved("winterlock-wallet");
  const address =
    requested ??
    wallets.data?.find(
      (w) => w.address.toLowerCase() === remembered?.toLowerCase(),
    )?.address ??
    wallets.data?.[0]?.address ??
    null;
  const walletQuery = useQuery({
    queryKey: ["wallet", address],
    queryFn: () => client.wallet(address!),
    enabled: !!address,
    refetchInterval: 6_000,
  });
  const recordsQuery = useQuery({
    queryKey: ["txs", address],
    queryFn: () => client.txs(address!),
    enabled: !!address,
    refetchInterval: 2_000,
  });
  const statusQuery = useQuery({
    queryKey: ["status"],
    queryFn: () => client.status(),
    refetchInterval: 10_000,
  });
  const config = useQuery({
    queryKey: ["config"],
    queryFn: () => client.config(),
    staleTime: Infinity,
  });
  const status = readStatus(statusQuery.data ?? null);
  const [mempool, setMempool] = useState<"alt" | "public">("alt");
  const [notice, setNotice] = useState<{ text: string; bad: boolean } | null>(
    null,
  );
  const [busy, setBusy] = useState<string | null>(null);
  const lock = useRef(false);
  const moves = useRef(new Set<string>());
  const [fault, setFault] = useState<{
    address: string;
    text: string;
    at: number;
  } | null>(null);
  const [stalled, setStalled] = useState<{ text: string; at: number } | null>(
    null,
  );
  const wallet = walletQuery.data ?? null;
  const issue = deviceIssue(wallet);
  const deviceFault =
    issue?.text ??
    (fault?.address === address && walletQuery.dataUpdatedAt <= fault.at
      ? fault.text
      : null);
  const stall =
    statusBanner(status) ??
    (stalled &&
    !(statusQuery.dataUpdatedAt > stalled.at && status?.stalled === false)
      ? stalled.text
      : null);
  const unavailable =
    !!stall ||
    !!walletQuery.error ||
    !!statusQuery.error ||
    !wallet ||
    wallet.locked ||
    wallet.rotationPending;
  const hotDisabled =
    unavailable ||
    !!deviceFault ||
    !wallet ||
    wallet.tickets.left < 1 ||
    wallet.hotValueCapWei === "0";
  useEffect(() => {
    if (wallet) remember("winterlock-wallet", wallet.address);
  }, [wallet?.address]);

  function observe(error: unknown) {
    const text = deviceIssueOf(error);
    if (text && address) setFault({ address, text: text.text, at: Date.now() });
    if (isStalled(error))
      setStalled({ text: stalledBanner(error)!, at: Date.now() });
  }
  // A failed member of a concurrent batch must also update the signing gate immediately.
  async function watched<T>(f: () => Promise<T>): Promise<T> {
    try {
      return await f();
    } catch (e) {
      observe(e);
      throw e;
    }
  }
  const api: Api = {
    ...client,
    send: (...args) => watched(() => client.send(...args)),
    tickets: (...args) => watched(() => client.tickets(...args)),
    rotate: (...args) => watched(() => client.rotate(...args)),
    hotPolicy: (...args) => watched(() => client.hotPolicy(...args)),
    createWallet: (...args) => watched(() => client.createWallet(...args)),
  };
  function notify(text: string, bad = false) {
    setNotice({ text, bad });
  }
  async function refresh() {
    await Promise.allSettled([
      cache.invalidateQueries({ queryKey: ["wallet", address] }),
      cache.invalidateQueries({ queryKey: ["txs", address] }),
      cache.invalidateQueries({ queryKey: ["wallets"] }),
      cache.invalidateQueries({ queryKey: ["plan", address] }),
      cache.invalidateQueries({ queryKey: ["status"] }),
    ]);
  }
  async function run<T>(
    label: string,
    f: () => Promise<T>,
    success?: string,
  ): Promise<T | undefined> {
    if (lock.current || moves.current.size > 0) return undefined;
    lock.current = true;
    setBusy(label);
    try {
      const result = await f();
      if (success) notify(success);
      return result;
    } catch (e) {
      observe(e);
      notify(
        `${errorText(e)}${e instanceof ApiError && (e.status === 0 || e.status === 502) ? " The result is unknown; a key may already have been spent. Check the lane board before submitting another action." : ""}`,
        true,
      );
      return undefined;
    } finally {
      // A 422 may have burned a key. Always reconcile both journals after any outcome.
      await refresh();
      lock.current = false;
      setBusy(null);
    }
  }
  // Different dapp cells may submit in parallel; each cell still has a synchronous
  // duplicate fence. Cold mutations and demo scenes stay exclusive with these sends.
  async function runMove<T>(
    key: string,
    f: () => Promise<T>,
  ): Promise<T | undefined> {
    const operation = `${address}:${key}`;
    if (lock.current || moves.current.has(operation)) return undefined;
    moves.current.add(operation);
    setBusy("moves");
    try {
      return await f();
    } catch (e) {
      observe(e);
      notify(
        `${errorText(e)}${e instanceof ApiError && (e.status === 0 || e.status === 502) ? " The result is unknown; a key may already have been spent. Check the lane board before another move." : ""}`,
        true,
      );
      return undefined;
    } finally {
      await refresh();
      moves.current.delete(operation);
      if (moves.current.size === 0) setBusy(null);
    }
  }
  return {
    api,
    address,
    wallets,
    wallet,
    walletQuery,
    records: recordsQuery.data ?? [],
    recordsQuery,
    status,
    statusQuery,
    config,
    busy,
    run,
    runMove,
    refresh,
    mempool,
    setMempool,
    notice,
    notify,
    dismiss: () => setNotice(null),
    unavailable,
    hotDisabled,
    deviceFault,
    stall,
  };
}

export function WalletProvider({ children }: { children: ReactNode }) {
  const state = useWalletState();
  return <Context.Provider value={state}>{children}</Context.Provider>;
}
export function useWallet() {
  const state = useContext(Context);
  if (!state) throw new Error("WalletProvider is missing");
  return state;
}
export function usePlan(query: import("./api").PlanQuery | null) {
  const { api, address, wallet, deviceFault } = useWallet();
  return useQuery({
    queryKey: [
      "plan",
      address,
      query,
      wallet?.epoch,
      wallet?.tickets.left,
      wallet?.tickets.exported,
    ],
    queryFn: () => api.lanesPlan(address!, query!),
    enabled: !!address && !!query && !deviceFault,
    refetchInterval: 30_000,
  });
}
export type { WalletView };
