import {
  useId,
  useLayoutEffect,
  useRef,
  useState,
  type ReactNode,
  type InputHTMLAttributes,
} from "react";
import { Link, useLocation, useSearchParams } from "react-router";
import { Moon, Sun, Copy, MoreHorizontal } from "lucide-react";
import { Button } from "./ui/button";
import { Input } from "./ui/input";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogTitle,
  DialogTrigger,
} from "./ui/dialog";
import { remember, usePlan, useWallet } from "../lib/state";
import {
  formatWei,
  shortHex,
  errorText,
  statusWords,
  readPlan,
  planWords,
  planWarningText,
  planFailureText,
  type PlanQuery,
} from "../lib/api";
import {
  LEAF_WORDS,
  countStates,
  leafStates,
  nextTicket,
  stubsOf,
} from "../domain/register.js";

export { Button, Input };
export function Action({
  children,
  primary = false,
  pending = false,
  ...props
}: React.ComponentProps<typeof Button> & {
  primary?: boolean;
  pending?: boolean;
}) {
  return (
    <Button
      variant="outline"
      {...props}
      className={`btn ${primary ? "primary" : ""} ${props.className ?? ""}`}
      aria-busy={pending || undefined}
      disabled={props.disabled || pending}
    >
      {children}
    </Button>
  );
}
export function Field({
  label,
  help,
  error,
  children,
  fieldClassName = "",
  ...props
}: InputHTMLAttributes<HTMLInputElement> & {
  label: string;
  help?: string;
  error?: string;
  children?: ReactNode;
  fieldClassName?: string;
}) {
  const id = useId();
  return (
    <div className={`field ${fieldClassName}`}>
      <label htmlFor={props.id ?? id}>{label}</label>
      <Input
        {...props}
        id={props.id ?? id}
        className={`num ${props.className ?? ""}`}
        aria-invalid={!!error || undefined}
        aria-describedby={
          error ? `${id}-error` : help ? `${id}-help` : undefined
        }
      />
      {help && (
        <span className="hint" id={`${id}-help`}>
          {help}
        </span>
      )}
      {error && (
        <span className="problem" id={`${id}-error`}>
          {error}
        </span>
      )}
      {children}
    </div>
  );
}
export function Fact({
  label,
  children,
  lead = false,
}: {
  label: string;
  children: ReactNode;
  lead?: boolean;
}) {
  return (
    <div className={`kv ${lead ? "lead" : ""}`}>
      <dt>{label}</dt>
      <dd>{children}</dd>
    </div>
  );
}

export function Shell({
  screen,
  children,
}: {
  screen: string;
  children: ReactNode;
}) {
  const {
    address,
    status,
    notice,
    dismiss,
    stall,
    refresh,
    walletQuery,
    statusQuery,
    config,
  } = useWallet();
  const location = useLocation();
  const [theme, setTheme] = useState(() => {
    const forced = new URLSearchParams(window.location.search).get("theme");
    if (forced === "dark" || forced === "light") return forced;
    try {
      return (
        localStorage.getItem("winterlock-theme") ??
        (matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light")
      );
    } catch {
      return "light";
    }
  });
  useLayoutEffect(() => {
    document.documentElement.dataset.theme = theme;
    remember("winterlock-theme", theme);
  }, [theme]);
  useLayoutEffect(() => {
    document.body.dataset.screen = screen;
    document.title = `${screen === "index" ? "Wallets" : screen === "hot-cold" ? "Hot and cold" : screen === "agent" ? "Agent" : "Session"} · Winterlock`;
  }, [screen]);
  const href = (path: string) =>
    `${path}${address ? `?wallet=${encodeURIComponent(address)}` : ""}`;
  const banner =
    stall ??
    (walletQuery.error
      ? errorText(walletQuery.error)
      : statusQuery.error
        ? `Network status unavailable: ${errorText(statusQuery.error)}`
        : null);
  return (
    <>
      <a className="skip-link" href="#workspace">
        Skip to content
      </a>
      <header className="top">
        <Link className="brand" to={href("/")}>
          <svg
            className="brand-mark"
            viewBox="0 0 32 32"
            fill="none"
            aria-hidden="true"
          >
            <path
              d="M4 9l6 15 6-15 6 15 6-15M10 9l6 15 6-15"
              stroke="currentColor"
              strokeWidth="2.5"
              strokeLinejoin="round"
            />
          </svg>
          <span>Winterlock</span>
        </Link>
        <nav className="screens" aria-label="Screens">
          {[
            ["/", "Wallets"],
            ["/hot-cold.html", "Pay"],
            ["/agent.html", "Agent"],
            ["/session.html", "Session"],
          ].map(([path, label]) => {
            const active =
              location.pathname === path ||
              (path === "/" && location.pathname === "/index.html");
            return (
              <Link
                key={path}
                to={href(path!)}
                aria-current={active ? "page" : undefined}
              >
                {label}
              </Link>
            );
          })}
          <a href="http://localhost:15190">Flask</a>
        </nav>
        <div className="rail-foot">
          <span
            className="network-pill"
            data-state={stall || status?.stalled ? "stalled" : undefined}
          >
            {status?.chainId
              ? `Chain ${status.chainId}${status.head === null ? "" : ` · block ${status.head.toLocaleString("en-US")}`}`
              : "Checking network"}
          </span>
          {screen !== "index" && <MempoolSwitch />}
          <button
            type="button"
            className="theme-toggle"
            aria-label={`Use ${theme === "dark" ? "light" : "dark"} theme`}
            aria-pressed={theme === "dark"}
            onClick={() => setTheme(theme === "dark" ? "light" : "dark")}
          >
            {theme === "dark" ? (
              <Sun aria-hidden="true" />
            ) : (
              <Moon aria-hidden="true" />
            )}
          </button>
        </div>
      </header>
      {status?.fake && (
        <p className="sim-bar">
          <span className="badge-fake">Local simulation · no EVM</span>
        </p>
      )}
      {banner && (
        <div className="banner-wrap">
          <div className="banner" role="alert">
            <span>{banner}</span>
            <Action onClick={() => void refresh()}>Try again</Action>
          </div>
        </div>
      )}
      <div className="react-workspace">{children}</div>
      {notice && (
        <p className={`notice-line ${notice.bad ? "error" : ""}`} role="status">
          <span>{notice.text}</span>
          <button className="notice-dismiss" onClick={dismiss}>
            Dismiss
          </button>
        </p>
      )}
      <footer className="status-line" aria-label="Status">
        {status ? (
          statusWords(status).map((word) => <span key={word}>{word}</span>)
        ) : (
          <span>Network status unavailable</span>
        )}
        <span>
          {config.data?.backendUrl
            ? `Backend ${config.data.backendUrl}`
            : "Connecting to local backend"}
        </span>
      </footer>
    </>
  );
}
export function Intro({
  title,
  description,
}: {
  title: string;
  description: string;
}) {
  return (
    <section className="page-intro" aria-labelledby="page-title">
      <h1 id="page-title">{title}</h1>
      <p>{description}</p>
    </section>
  );
}
function MempoolSwitch() {
  const state = useWallet();
  return (
    <div className="controls">
      <span id="mempool-label">Mempool</span>
      <div className="segmented" role="radiogroup" aria-labelledby="mempool-label">
        {(["alt", "public"] as const).map((mode) => (
          <label key={mode}>
            <input
              type="radio"
              name="mempool"
              value={mode}
              checked={state.mempool === mode}
              onChange={() => state.setMempool(mode)}
            />
            <span>{mode}</span>
          </label>
        ))}
      </div>
    </div>
  );
}
export function AccountSummary() {
  const { wallet: w, notify } = useWallet();
  if (!w)
    return (
      <section className="wallet-head">
        <p className="muted">Loading the wallet…</p>
      </section>
    );
  const facts = (
    <>
      <Fact label="epoch">{w.epoch}</Fact>
      <Fact label="leaves used">
        {w.leavesUsed} of {w.leafCount}
      </Fact>
      <Fact label="lanes in flight">{w.lanesInFlight}</Fact>
      <Fact label="tickets">
        {w.tickets.left} of {w.tickets.exported}
      </Fact>
    </>
  );
  return (
    <section className="wallet-head" aria-label="Account summary">
      <dl className="summary">
        <Fact label="wallet">
          <button
            className="wallet-address"
            title={w.address}
            onClick={() =>
              void navigator.clipboard.writeText(w.address).then(
                () => notify("Wallet address copied."),
                () => notify("Copy is unavailable in this browser.", true),
              )
            }
          >
            {shortHex(w.address)}
            <Copy size={15} aria-hidden="true" />
          </button>
        </Fact>
        <Fact label="balance" lead>
          {formatWei(w.balanceWei)}
        </Fact>
        {facts}
      </dl>
      {w.rotationPending ? (
        <p className="warning" role="status">
          Root rotation is pending. Signing resumes after the backend confirms
          inclusion.
        </p>
      ) : w.locked ? (
        <p className="warning" role="status">
          The backend has locked this wallet. Signing is unavailable until it is
          released.
        </p>
      ) : w.hotValueCapWei === "0" ? (
        <p className="warning" role="status">
          Hot tickets are off: the value cap is 0. Change the policy on the cold
          device to enable them.
        </p>
      ) : null}
      <InfoDialog
        trigger={
          <button
            className="account-menu icon-button"
            aria-label="Account details"
          >
            <MoreHorizontal />
          </button>
        }
        title="Account details"
      >
        <dl className="facts-inline">
          {facts}
          <Fact label="root">
            <span className="mono">{w.root}</span>
          </Fact>
        </dl>
      </InfoDialog>
    </section>
  );
}
export function InfoDialog({
  trigger,
  title,
  children,
  description,
}: {
  trigger: React.ReactElement;
  title: string;
  children: ReactNode;
  description?: string;
}) {
  return (
    <Dialog>
      <DialogTrigger render={trigger} />
      <DialogContent className="dialog-surface app-dialog">
        <DialogTitle>{title}</DialogTitle>
        <DialogDescription>
          {description ?? "Details for the selected wallet."}
        </DialogDescription>
        <div className="group">{children}</div>
      </DialogContent>
    </Dialog>
  );
}
export function TicketStrip() {
  const { wallet: w, records } = useWallet();
  if (!w) return null;
  const stubs = stubsOf(w, leafStates(w, records));
  return (
    <ol className="stubs" aria-label="Tickets cut to the phone">
      {stubs.map((s) => (
        <li
          key={s.leaf}
          className={`stub is-${s.state} ${s.next ? "next" : ""}`}
          title={`Leaf ${s.leaf}: ${LEAF_WORDS[s.state]}${s.next ? ", next ticket" : ""}`}
        >
          <span className="visually-hidden">
            Leaf {s.leaf}: {LEAF_WORDS[s.state]}
          </span>
        </li>
      ))}
    </ol>
  );
}
const SHEET_ORDER = ["unused", "onchain", "hot", "phone", "flight", "burned"] as const;
export function KeyRegister() {
  const { wallet: w, records } = useWallet();
  const [at, setAt] = useState<number | null>(null);
  if (!w) return null;
  const states = leafStates(w, records);
  const counts = countStates(states);
  const move = (to: number) => setAt(Math.max(0, Math.min(states.length - 1, to)));
  return (
    <section className="key-sheet" aria-labelledby="key-sheet-title">
      <h4 id="key-sheet-title">
        Key register<span>Every leaf, by state</span>
      </h4>
      <div className="sheet-body">
        <div
          className="register"
          role="img"
          tabIndex={0}
          aria-label={`${w.leafCount} one-time keys, ${w.leavesUsed} reserved or used`}
          aria-describedby="key-readout"
          onPointerOver={(e) => {
            const leaf = (e.target as HTMLElement).dataset.leaf;
            if (leaf) setAt(Number(leaf));
          }}
          onPointerLeave={() => setAt(null)}
          onBlur={() => setAt(null)}
          onKeyDown={(e) => {
            const step = {
              ArrowRight: 1,
              ArrowLeft: -1,
              ArrowDown: 32,
              ArrowUp: -32,
            }[e.key];
            if (step === undefined) return;
            e.preventDefault();
            move((at ?? -step) + step);
          }}
        >
          {states.map((s, i) => (
            <span
              key={i}
              data-leaf={i}
              className={`leaf-cell is-${s}${i >= w.hotStart ? " in-hot" : ""}${i === at ? " at" : ""}`}
              title={`Leaf ${i}: ${LEAF_WORDS[s]}`}
            />
          ))}
        </div>
        <div className="sheet-side">
          <p className="sheet-readout" id="key-readout">
            {at === null ? (
              "Point at a key, or focus the sheet and use the arrow keys."
            ) : (
              <>
                <span className="mono">Leaf {at}</span>
                {` · ${LEAF_WORDS[states[at]!]}${at >= w.hotStart ? ", hot band" : ""}`}
              </>
            )}
          </p>
          <ul className="legend">
            {SHEET_ORDER.map((s) => (
              <li key={s}>
                <i className={`leaf-cell is-${s}`} aria-hidden="true" />
                <span>{LEAF_WORDS[s]}</span>
                <span className="mono">{counts[s].toLocaleString("en-US")}</span>
              </li>
            ))}
          </ul>
        </div>
      </div>
    </section>
  );
}
export function nextLeaf(
  w: import("../lib/api").WalletView,
  records: import("../lib/api").TxRecord[],
) {
  return nextTicket(w, leafStates(w, records));
}
export function TaskTabs({
  tabs,
  view,
  onChange,
}: {
  tabs: [string, string, string][];
  view: string;
  onChange: (view: string) => void;
}) {
  const refs = useRef<(HTMLButtonElement | null)[]>([]);
  return (
    <div className="workspace-tabs" role="tablist" aria-label="Wallet view">
      {tabs.map(([id, label, panel], index) => (
        <button
          type="button"
          role="tab"
          key={id}
          id={`view-${id}`}
          aria-controls={panel}
          aria-selected={view === id}
          tabIndex={view === id ? 0 : -1}
          ref={(node) => {
            refs.current[index] = node;
          }}
          onClick={() => onChange(id)}
          onKeyDown={(event) => {
            let at = index;
            if (event.key === "ArrowRight") at = (index + 1) % tabs.length;
            else if (event.key === "ArrowLeft")
              at = (index + tabs.length - 1) % tabs.length;
            else if (event.key === "Home") at = 0;
            else if (event.key === "End") at = tabs.length - 1;
            else return;
            event.preventDefault();
            onChange(tabs[at]![0]);
            refs.current[at]?.focus();
          }}
        >
          {label}
        </button>
      ))}
    </div>
  );
}
export function useTaskView(initial: string, allowed: string[]) {
  const [params, setParams] = useSearchParams();
  const value = params.get("view");
  const view = value && allowed.includes(value) ? value : initial;
  useLayoutEffect(() => {
    document.documentElement.dataset.walletView = view;
  }, [view]);
  const set = (next: string) => {
    const p = new URLSearchParams(params);
    p.set("view", next);
    setParams(p);
  };
  return [view, set] as const;
}
export function Plan({ query }: { query: PlanQuery | null }) {
  const { wallet, deviceFault } = useWallet();
  const plan = usePlan(query);
  if (!query || !wallet || deviceFault) return null;
  if (plan.error)
    return <p className="query-stale">{planFailureText(plan.error)}</p>;
  const parsed = readPlan(plan.data ?? null);
  if (!parsed)
    return plan.isPending ? null : (
      <p className="hint">
        Parallel-lanes preview is not offered by this backend.
      </p>
    );
  const words = planWords(parsed, query.n, wallet.balanceWei);
  return (
    <aside className="plan">
      <h3>Before these lanes</h3>
      <p>{words.line}</p>
      {words.warnings.length > 0 && (
        <ul className="plan-warnings">
          {words.warnings.map((word) => (
            <li key={word}>{word}</li>
          ))}
        </ul>
      )}
    </aside>
  );
}
export function WalletGate({ children }: { children: ReactNode }) {
  const { wallet, address, wallets, walletQuery } = useWallet();
  if (wallet) return children;
  return (
    <main id="workspace">
      <div className="content-error">
        {walletQuery.error || wallets.error ? (
          <p role="alert">{errorText(walletQuery.error ?? wallets.error)}</p>
        ) : (
          <p>
            {address || wallets.isPending
              ? "Loading wallet…"
              : "Create a wallet to begin."}
          </p>
        )}
        <Link className="btn" to="/">
          Go to wallets
        </Link>
      </div>
    </main>
  );
}
