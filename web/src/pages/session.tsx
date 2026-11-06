import { Fragment, useRef, useState } from "react";
import {
  AccountSummary,
  Action,
  Fact,
  InfoDialog,
  Intro,
  Plan,
  TaskTabs,
  TicketStrip,
  useTaskView,
} from "../components/common";
import { LaneBoard } from "../components/lanes";
import { useWallet } from "../lib/state";
import {
  ApiError,
  SESSION_REQUEST,
  cutTickets,
  errorText,
  formatWei,
  grantCount,
  moveBody,
  shortHex,
  type SendAnswer,
} from "../lib/api";
import { sessionScene } from "../../public/scenes.js";
import { statusOf } from "../../public/lanes.js";

type Cell = { hash?: string; leaf?: number; state: string; words: string };
export function SessionPage() {
  const s = useWallet();
  const w = s.wallet!;
  const [view, setView] = useTaskView("session", [
    "session",
    "dapp",
    "activity",
  ]);
  const [declined, setDeclined] = useState(false);
  const [requestOpen, setRequestOpen] = useState(w.tickets.left === 0);
  const [cells, setCells] = useState<Record<number, Cell>>({});
  const locks = useRef(new Set<number>());
  const count = grantCount(w);
  const disabled =
    s.hotDisabled || (!!s.busy && s.busy !== "moves") || declined;
  const outcome = (i: number, answer: SendAnswer | null, error: unknown) => {
    if (answer)
      setCells((old) => ({
        ...old,
        [i]: {
          hash: answer.txHash,
          leaf: answer.leaf,
          state: "admitted",
          words: "admitted",
        },
      }));
    else if (
      error instanceof ApiError &&
      typeof error.body?.txHash === "string"
    )
      setCells((old) => ({
        ...old,
        [i]: {
          hash: error.body.txHash,
          leaf: error.body.leaf,
          state: error.status === 422 ? "refused" : "unknown",
          words: errorText(error),
        },
      }));
    else
      setCells((old) => ({
        ...old,
        [i]: { state: "unknown", words: errorText(error) },
      }));
  };
  const sendMove = async (i: number) => {
    if (disabled || locks.current.has(i)) return;
    locks.current.add(i);
    await s.runMove(`move-${i}`, async () => {
      setCells((old) => ({
        ...old,
        [i]: { state: "sending", words: "signing" },
      }));
      try {
        const result = await s.api.send(w.address, moveBody(w, s.mempool));
        outcome(i, result, null);
        s.notify(`Move ${labelOf(i)} admitted on leaf ${result.leaf}.`);
        return result;
      } catch (e) {
        outcome(i, null, e);
        throw e;
      }
    });
    locks.current.delete(i);
  };
  const cellView = (i: number): Cell | undefined => {
    const cell = cells[i];
    if (!cell?.hash) return cell;
    const record = s.records.find((r) => r.txHash === cell.hash);
    if (!record) return cell;
    const st = statusOf(record);
    // A reverted execution consumed its key, but must never look like a successful move.
    const state =
      record.status === "OnChain"
        ? "included"
        : record.status === "Reverted"
          ? "refused"
          : record.status === "Included"
            ? "unknown"
            : st.key === "unknown"
              ? "unknown"
              : st.key;
    return { ...cell, state, words: st.label };
  };
  const stats = Object.keys(cells)
    .map(Number)
    .map(cellView)
    .filter(Boolean) as Cell[];
  return (
    <>
      <Intro
        title="Session"
        description="One action, one ticket, one fresh lane. Keep moving while blocks arrive."
      />
      <AccountSummary />
      <main id="workspace">
        <TaskTabs
          view={view}
          onChange={setView}
          tabs={[
            ["session", "Session", "session-pane"],
            ["dapp", "Dapp", "dapp-pane"],
            ["activity", "Activity", "lane-board"],
          ]}
        />
        <div className="panes session">
          <section
            className="pane wallet"
            id="session-pane"
            aria-labelledby="wallet-title"
          >
            <div className="pane-head">
              <h2 id="wallet-title">Wallet</h2>
              <p>The session the dapp asked for</p>
            </div>
            <details
              className="session-request"
              open={requestOpen}
              onToggle={(e) => setRequestOpen(e.currentTarget.open)}
            >
              <summary>Grant session tickets</summary>
              <fieldset disabled={s.unavailable || !!s.busy || !!s.deviceFault}>
                <div className="sheet">
                  <h3>Session request</h3>
                  <dl className="facts-inline">
                    <Fact label="requested actions">{SESSION_REQUEST}</Fact>
                    <Fact label="value per action">0 ETH</Fact>
                    <Fact label="contract">
                      <span title={w.allowedTarget} className="mono">
                        {shortHex(w.allowedTarget)}
                      </span>
                    </Fact>
                  </dl>
                  <p className="hint">
                    {count} tickets can be granted from this hot band. The
                    requested two-hour expiry is proposed; it is not enforced by
                    this version.
                  </p>
                  <Plan
                    query={
                      !declined && count > 0
                        ? {
                            n: count,
                            mode: "hot",
                            valueWei: "0",
                            to: w.allowedTarget,
                          }
                        : null
                    }
                  />
                  <div className="row">
                    <Action
                      primary
                      disabled={count === 0}
                      pending={s.busy === "grant"}
                      onClick={() =>
                        void s.run(
                          "grant",
                          async () => {
                            const result = await cutTickets(
                              s.api,
                              w.address,
                              count,
                            );
                            setDeclined(false);
                            setRequestOpen(false);
                            setView("dapp");
                            requestAnimationFrame(() =>
                              document.getElementById("dapp-title")?.focus(),
                            );
                            return result;
                          },
                          `${count} session tickets granted.`,
                        )
                      }
                    >
                      Grant {count} tickets
                    </Action>
                    <Action
                      onClick={() => {
                        setDeclined(true);
                        setRequestOpen(false);
                        s.notify(
                          "Session request declined. No new tickets were cut.",
                        );
                      }}
                    >
                      Decline
                    </Action>
                  </div>
                </div>
              </fieldset>
            </details>
            <div className="group card">
              <h3>Session</h3>
              <p className="count">
                <span>{w.tickets.left}</span>
                <span>of {w.tickets.exported}</span>
              </p>
              <p className="hint">
                Tickets left; the chain burns each one on use
              </p>
              {s.deviceFault && <p className="warning">{s.deviceFault}</p>}
              {declined && (
                <p className="hint">
                  Session request declined. Open the request to grant tickets.
                </p>
              )}
              <TicketStrip />
              <dl className="facts-inline">
                <Fact label="move value">0 ETH</Fact>
                <Fact label="fee cap">{formatWei(w.hotFeeCapWei)}</Fact>
                <Fact label="allowed contract">
                  <span className="mono" title={w.allowedTarget}>
                    {shortHex(w.allowedTarget)}
                  </span>
                </Fact>
              </dl>
              <details className="upcoming">
                <summary>Proposed session controls</summary>
                <div className="row expires">
                  <span className="hint">Expires in —</span>
                  <Action disabled>End session</Action>
                </div>
                <p className="proposed">
                  Ending a session by burning unused tickets is not built.
                  Two-hour recent-root expiry is proposed (Level B).
                </p>
              </details>
            </div>
          </section>
          <section
            className="pane dapp"
            id="dapp-pane"
            aria-labelledby="dapp-title"
          >
            <div className="pane-head">
              <h2 id="dapp-title" tabIndex={-1}>
                Dapp
              </h2>
              <InfoDialog
                title="Move details"
                trigger={<button className="btn">Move details</button>}
                description="Each cell sends a transaction using one session ticket."
              >
                <p className="hint comparison">
                  An ordinary session key is one key with a policy around it.
                  Here each move uses one of a finite set of one-time keys. A
                  leak costs at most the tickets left, inside the caps.
                </p>
                <dl className="facts-inline tally">
                  <Fact label="moves">{stats.length}</Fact>
                  <Fact label="included successfully">
                    {stats.filter((c) => c.state === "included").length}
                  </Fact>
                  <Fact label="refused or expired">
                    {
                      stats.filter((c) =>
                        ["refused", "expired"].includes(c.state),
                      ).length
                    }
                  </Fact>
                </dl>
                <p className="hint">
                  A move is a hot ticket of 0 wei to the allowed target, without
                  calldata. Its leaf is printed under the cell. A filled cell
                  has a successful receipt; a dashed cell is pending or unknown;
                  a slash means refusal, expiry or reverted execution.
                </p>
              </InfoDialog>
            </div>
            <fieldset disabled={disabled}>
              <div
                className="grid6 paper"
                role="group"
                aria-label="6 by 6 board: each cell sends one move"
              >
                <span aria-hidden="true" />
                {[..."ABCDEF"].map((c) => (
                  <span key={c} className="head" aria-hidden="true">
                    {c}
                  </span>
                ))}
                {Array.from({ length: 36 }, (_, i) => {
                  const cell = cellView(i);
                  const held =
                    cell && !["refused", "expired"].includes(cell.state);
                  return (
                    <Fragment key={i}>
                      {i % 6 === 0 && (
                        <span className="head row-n" aria-hidden="true">
                          {i / 6 + 1}
                        </span>
                      )}
                      <button
                        type="button"
                        className="cell"
                        disabled={!!held || locks.current.has(i)}
                        data-state={cell?.state}
                        aria-label={`Move ${labelOf(i)}${cell ? `, ${cell.words}${cell.leaf === undefined ? "" : `, leaf ${cell.leaf}`}` : ""}`}
                        onClick={() => void sendMove(i)}
                      >
                        <span className="hole" aria-hidden="true" />
                        <span className="punch-sn" aria-hidden="true">
                          {cell?.leaf}
                        </span>
                      </button>
                    </Fragment>
                  );
                })}
              </div>
            </fieldset>
            <p className="hint">
              Each click sends one transaction.{" "}
              {w.tickets.left === 0
                ? "Grant tickets in Session to begin."
                : `${w.tickets.left} tickets available.`}
            </p>
          </section>
        </div>
        <LaneBoard
          disabled={s.unavailable || !!s.deviceFault || declined}
          scene={() =>
            void s.run("scene", () =>
              sessionScene(s.api, w.address, {
                mempool: s.mempool,
                step: s.notify,
                moved: (k, result) => outcome(k, result.answer, result.error),
              }),
            )
          }
          guide="Grants tickets if none remain, then submits eight moves in two seconds. Each takes a fresh lane. Switch mempool mode to compare the actual admission outcomes. Blocks and refusals always come from the backend."
        />
      </main>
    </>
  );
}
function labelOf(i: number) {
  return `${"ABCDEF"[i % 6]}${Math.floor(i / 6) + 1}`;
}
