import { useEffect, useRef, useState } from "react";
import {
  AccountSummary,
  Action,
  Fact,
  Intro,
  Plan,
  TaskTabs,
  TicketStrip,
  useTaskView,
} from "../components/common";
import { LaneBoard } from "../components/lanes";
import { useWallet } from "../lib/state";
import {
  RULE,
  compromisedPayments,
  errorText,
  fireTranches,
  formatWei,
  maxLossWei,
  shortHex,
  trancheWei,
  type SendAnswer,
} from "../lib/api";
import { agentScene } from "../domain/scenes.js";
import { changePct, createMockMarket, ruleFires } from "../domain/market.js";
import { setAside, setAsideText, statusOf } from "../domain/lanes.js";

export function AgentPage() {
  const s = useWallet();
  const w = s.wallet!;
  const [view, setView] = useTaskView("agent", [
    "agent",
    "allowance",
    "activity",
  ]);
  const [market] = useState(() => createMockMarket({ now: Date.now() }));
  const [tick, redraw] = useState(0);
  const [armed, setArmed] = useState(false);
  const armedRef = useRef(false);
  const [log, setLog] = useState<{ id: number; time: string; text: string }[]>(
    [],
  );
  const sequence = useRef(0);
  const seen = useRef(new Map<string, string>());
  const tranche = trancheWei(w);
  const disabled = s.hotDisabled || !!s.busy || tranche === null;
  const addLog = (text: string) =>
    setLog((old) =>
      [
        {
          id: ++sequence.current,
          time: new Date().toLocaleTimeString([], { hour12: false }),
          text,
        },
        ...old,
      ].slice(0, 60),
    );
  const disarm = () => {
    armedRef.current = false;
    setArmed(false);
  };
  const recordResults = (results: PromiseSettledResult<SendAnswer>[]) => {
    const accepted = results.filter((r) => r.status === "fulfilled").length;
    for (const r of results)
      addLog(
        r.status === "fulfilled"
          ? `Admitted: leaf ${r.value.leaf}, lane ${r.value.nonceKeys[0]}.`
          : errorText(r.reason),
      );
    s.notify(
      `${accepted} of ${results.length} tranches admitted${accepted < results.length ? "; inspect the refused or unknown outcomes on the board" : ""}.`,
      accepted < results.length,
    );
  };
  const fire = async () => {
    if (disabled || tranche === null) return;
    disarm();
    addLog("Fire: four tranches on separate lanes.");
    const results = await s.run("fire", () =>
      fireTranches(s.api, w, { tranche, mempool: s.mempool }),
    );
    if (results) recordResults(results);
  };
  const latest = useRef({ fire, disabled });
  latest.current = { fire, disabled };
  useEffect(() => {
    const timer = setInterval(() => {
      const now = Date.now();
      market.tick(now);
      redraw((n) => n + 1);
      if (
        armedRef.current &&
        !latest.current.disabled &&
        ruleFires(market.history, now, RULE)
      ) {
        armedRef.current = false;
        setArmed(false);
        void latest.current.fire();
      }
    }, 1_000);
    return () => {
      clearInterval(timer);
      armedRef.current = false;
    };
  }, [market]);
  useEffect(() => {
    const changes: string[] = [];
    for (const r of s.records) {
      const old = seen.current.get(r.txHash);
      if (old && old !== r.status)
        changes.push(`Lane ${r.nonceKey}: ${statusOf(r).label}.`);
      seen.current.set(r.txHash, r.status);
    }
    changes.forEach(addLog);
  }, [s.records]);
  const drop = () => {
    market.drop(3, Date.now());
    redraw((n) => n + 1);
    addLog(
      "Mock price dropped 3 %. This is a simulated price, not a market feed.",
    );
    if (armedRef.current && !disabled) {
      disarm();
      void fire();
    }
  };
  return (
    <>
      <Intro
        title="Agent"
        description="Give an agent a finite allowance. See every action and its limits."
      />
      <AccountSummary />
      <main id="workspace">
        <TaskTabs
          view={view}
          onChange={setView}
          tabs={[
            ["agent", "Run agent", "market-pane"],
            ["allowance", "Allowance", "allowance-pane"],
            ["activity", "Activity", "lane-board"],
          ]}
        />
        <div className="panes agent-panes">
          <section
            className="pane market"
            id="market-pane"
            aria-labelledby="market-title"
          >
            <div className="pane-head">
              <h2 id="market-title">Market</h2>
              <p>Mock price, simulated in this page</p>
            </div>
            <div className="rule-box">
              <p className="rule-label">Agent rule</p>
              <p className="rule-text">
                If price falls more than 2 % in 30 s, buy in 4 tranches
                {tranche ? ` of ${formatWei(tranche)}` : ""}.
              </p>
            </div>
            <fieldset id="agent-fields" disabled={disabled}>
              <label className="toggle">
                <input
                  type="checkbox"
                  checked={armed}
                  onChange={(e) => {
                    armedRef.current = e.target.checked;
                    setArmed(e.target.checked);
                    addLog(
                      e.target.checked
                        ? "Rule armed by you. It may submit once when the mock trigger fires."
                        : "Rule disarmed.",
                    );
                  }}
                />{" "}
                Rule armed
              </label>
              <div className="row">
                <Action
                  primary
                  id="fire"
                  onClick={() => void fire()}
                  pending={s.busy === "fire"}
                >
                  Fire 4 tranches
                </Action>
              </div>
            </fieldset>
            <p className="hint">
              {s.deviceFault ??
                (w.tickets.left === 0
                  ? "No tickets left. Prepare tickets on the cold device."
                  : tranche === null
                    ? "The balance cannot cover four tranches and their fee caps."
                    : `${w.tickets.left} tickets left. Each tranche takes one ticket; every outcome stays on the board.`)}
            </p>
            <Plan
              query={
                tranche
                  ? {
                      n: 4,
                      mode: "hot",
                      valueWei: tranche.toString(),
                      to: w.allowedTarget,
                    }
                  : null
              }
            />
            <details className="market-detail">
              <summary>Mock market</summary>
              <div className="group">
                <Action onClick={drop} disabled={!!s.busy}>
                  Drop the mock price 3 %
                </Action>
                <p className="hint">Mock ETH price · no real market feed</p>
                <p className="price-line">
                  <span className="price">
                    {market
                      .price()
                      .toLocaleString("en-US", { minimumFractionDigits: 2 })}
                  </span>
                  <span className="change">
                    {changePct(
                      market.history,
                      Date.now(),
                      RULE.windowMs,
                    ).toFixed(2)}{" "}
                    % in 30 s
                  </span>
                </p>
                <Sparkline history={[...market.history]} />
              </div>
            </details>
          </section>
          <section
            className="pane allowance"
            id="allowance-pane"
            aria-labelledby="allowance-title"
          >
            <div className="pane-head">
              <h2 id="allowance-title">Allowance</h2>
              <p>The agent’s hot tickets</p>
            </div>
            <div className="group">
              <p className="count">
                <span>{w.tickets.left}</span>
                <span>of {w.tickets.exported}</span>
              </p>
              <p className="hint">
                Tickets left; each signature takes a fresh lane
              </p>
              {s.deviceFault && <p className="warning">{s.deviceFault}</p>}
              <TicketStrip />
            </div>
            <dl className="facts-inline">
              <Fact label="value cap">{formatWei(w.hotValueCapWei)}</Fact>
              <Fact label="fee cap">{formatWei(w.hotFeeCapWei)}</Fact>
              <Fact label="allowed target">
                <span title={w.allowedTarget} className="mono">
                  {shortHex(w.allowedTarget)}
                </span>
              </Fact>
            </dl>
            <div className="total">
              <p className="total-line">
                <span className="total-label">Max loss</span>
                <span className="total-fig">{formatWei(maxLossWei(w))}</span>
              </p>
              <p className="hint">
                Unused tickets × (value cap + fee cap). Payments only to the
                allowed target.
              </p>
            </div>
            {setAside(s.records, w).lanes > 0 && (
              <p className="set-aside">
                {setAsideText(setAside(s.records, w))}
              </p>
            )}
            <details className="upcoming">
              <summary>Proposed expiry controls</summary>
              <div className="group expiry">
                <p className="expires">Expires in —</p>
                <div className="row">
                  <Action disabled>Renew from cold device</Action>
                  <Action disabled>Stop renewing</Action>
                </div>
                <p className="proposed">
                  Recent-root expiry is proposed (Level B), not built. Today
                  authority ends when the tickets run out or the cold device
                  sets the value cap to 0.
                </p>
              </div>
            </details>
            <details className="policy-test">
              <summary>Test policy enforcement</summary>
              <div className="group">
                <Action
                  id="compromised"
                  disabled={s.hotDisabled || !!s.busy}
                  onClick={() =>
                    void s.run("compromise", async () => {
                      disarm();
                      addLog(
                        "Server compromised: two payments outside the policy.",
                      );
                      const sent = await compromisedPayments(
                        s.api,
                        w,
                        s.mempool,
                      );
                      sent.forEach((x) =>
                        addLog(
                          x.result.status === "fulfilled"
                            ? `Compromised payment admitted on leaf ${x.result.value.leaf}.`
                            : errorText(x.result.reason),
                        ),
                      );
                      s.notify(
                        sent
                          .map((x) =>
                            x.result.status === "fulfilled"
                              ? "admitted"
                              : errorText(x.result.reason),
                          )
                          .join("; "),
                      );
                      return sent;
                    })
                  }
                >
                  Server compromised
                </Action>
                <p className="hint">
                  Sends two payments outside the hot policy. The account should
                  refuse both, burning one ticket for each refusal.
                </p>
              </div>
            </details>
          </section>
          <section
            className="pane daybook"
            id="agent-log"
            aria-labelledby="log-title"
          >
            <div className="pane-head">
              <h2 id="log-title">Event log</h2>
              <p>Triggers, lanes, inclusions</p>
            </div>
            {log.length ? (
              <ol className="log" aria-live="polite">
                {log.map((e) => (
                  <li key={e.id}>
                    <span className="when">{e.time}</span>
                    <span>{e.text}</span>
                  </li>
                ))}
              </ol>
            ) : (
              <p className="hint">
                No entries yet. Fire, or arm the rule and drop the mock price.
              </p>
            )}
          </section>
        </div>
        <LaneBoard
          disabled={s.unavailable || !!s.deviceFault}
          scene={() => {
            disarm();
            void s.run("scene", () =>
              agentScene(s.api, w.address, {
                step: (text) => {
                  s.notify(text);
                  addLog(text);
                },
                mempool: s.setMempool,
                trigger: drop,
                fired: recordResults,
                compromised: (sent) =>
                  sent.forEach((x) =>
                    addLog(
                      x.result.status === "fulfilled"
                        ? "Compromised payment admitted."
                        : errorText(x.result.reason),
                    ),
                  ),
              }),
            );
          }}
          guide="Cuts tickets if fewer than six remain, drops the mock price, fires four parallel tranches on alt, then tries two payments outside the account’s policy. Admission and refusal evidence remain visible."
        />
      </main>
    </>
  );
}

function Sparkline({ history }: { history: { t: number; price: number }[] }) {
  const [hover, setHover] = useState<number | null>(null);
  const values = history.map((h) => h.price);
  const low = Math.min(...values);
  const range = Math.max(...values) - low || 1;
  const x = (i: number) => 10 + (i / Math.max(1, history.length - 1)) * 380;
  const y = (price: number) => 90 - ((price - low) / range) * 80;
  const index = Math.min(hover ?? history.length - 1, history.length - 1);
  const point = history[index]!;
  return (
    <>
      <svg
        className="sparkline"
        viewBox="0 0 400 100"
        role="img"
        tabIndex={0}
        aria-label="Mock ETH price over the last minute. Use arrow keys to inspect prices."
        aria-describedby="spark-readout"
        onPointerMove={(e) => {
          const box = e.currentTarget.getBoundingClientRect();
          setHover(
            Math.max(
              0,
              Math.min(
                history.length - 1,
                Math.round(
                  ((e.clientX - box.left) / box.width) * (history.length - 1),
                ),
              ),
            ),
          );
        }}
        onPointerLeave={() => setHover(null)}
        onKeyDown={(e) => {
          if (e.key === "ArrowRight" || e.key === "ArrowLeft") {
            e.preventDefault();
            setHover(
              Math.max(
                0,
                Math.min(
                  history.length - 1,
                  index + (e.key === "ArrowRight" ? 1 : -1),
                ),
              ),
            );
          }
        }}
      >
        <path
          className="spark-line"
          d={history
            .map((h, i) => `${i === 0 ? "M" : "L"}${x(i)},${y(h.price)}`)
            .join(" ")}
        />
        <circle
          className="spark-hover"
          cx={x(index)}
          cy={y(point.price)}
          r="4"
        />
      </svg>
      <p className="hint" id="spark-readout">
        {new Date(point.t).toLocaleTimeString()} · {point.price.toFixed(2)} USD
        (mock)
      </p>
    </>
  );
}
