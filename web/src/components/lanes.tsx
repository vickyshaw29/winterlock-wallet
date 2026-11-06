import { Fragment, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { useWallet } from "../lib/state";
import {
  LANE_LIMITS_TEXT,
  errorText,
  formatWeiExact,
  shortHex,
  type TxRecord,
} from "../lib/api";
import {
  laneRows,
  setAside,
  setAsideText,
  stampOf,
  amountMark,
  epochRule,
} from "../../public/lanes.js";
import {
  Dialog,
  DialogContent,
  DialogTitle,
  DialogDescription,
} from "./ui/dialog";
import { Action, Fact } from "./common";

export function LaneBoard({
  scene,
  guide,
  disabled = false,
}: {
  scene: () => void;
  guide: string;
  disabled?: boolean;
}) {
  const { wallet, records, recordsQuery, busy } = useWallet();
  const [selected, setSelected] = useState<string | null>(null);
  const rows = laneRows(records);
  return (
    <section className="board" id="lane-board" aria-labelledby="board-title">
      <div className="board-head">
        <div>
          <h2 id="board-title">Lane board</h2>
          <p className="set-aside">{setAsideText(setAside(records, wallet))}</p>
        </div>
        <fieldset className="scene" disabled={!!busy || disabled}>
          <Action id="play" onClick={scene} pending={busy === "scene"}>
            Play scene
          </Action>
          <details className="scene-guide">
            <summary>What this scene does</summary>
            <p className="hint">{guide}</p>
          </details>
        </fieldset>
        <details className="lane-rules">
          <summary>Lane rules</summary>
          <p className="lane-limits">{LANE_LIMITS_TEXT}</p>
        </details>
      </div>
      <div id="lanes" role="region" aria-label="Lane history" tabIndex={0}>
        {recordsQuery.error && (
          <p className="warning" role="status">
            History could not refresh: {errorText(recordsQuery.error)}.
            Previously loaded rows remain visible.
          </p>
        )}
        <table className="lanes">
          <colgroup>
            <col className="w-lane" />
            <col className="w-leaf" />
            <col />
            <col className="w-amount" />
            <col className="w-gas" />
            <col className="w-status" />
          </colgroup>
          <thead>
            <tr>
              {["Lane", "Leaf", "Action", "Amount", "Gas", "Status"].map(
                (h) => (
                  <th
                    scope="col"
                    key={h}
                    className={h === "Amount" || h === "Gas" ? "r" : undefined}
                  >
                    {h}
                  </th>
                ),
              )}
            </tr>
          </thead>
          <tbody>
            {rows.length === 0 && (
              <tr>
                <td colSpan={6} className="empty">
                  {recordsQuery.isPending
                    ? "Loading lanes…"
                    : "No lane yet. Each transaction will appear here with its admission and receipt."}
                </td>
              </tr>
            )}
            {rows.map((row, i) => {
              const stamp = stampOf(row);
              const rule = epochRule(rows, i);
              return (
                <Fragment key={row.hash}>
                  {rule && (
                    <tr className="ruled">
                      <td colSpan={6}>{rule}</td>
                    </tr>
                  )}
                  <tr className="lane-row">
                    <td className="lane">
                      <button
                        className="sn lane-inspect"
                        aria-label={`Inspect lane ${row.lane}`}
                        onClick={() => setSelected(row.hash)}
                      >
                        {row.lane.length > 14 ? shortHex(row.lane) : row.lane}
                      </button>
                    </td>
                    <td className="leaf">
                      <span className="sn">{row.leaf}</span>
                      {row.mode === "hot" && (
                        <span className="tag hot">hot</span>
                      )}
                    </td>
                    <td>
                      <span className="cell-flex">
                        {row.action}
                        {row.mempool && (
                          <span className={`tag tag-${row.mempool}`}>
                            {row.mempool}
                          </span>
                        )}
                      </span>
                      {row.retryOfLane && (
                        <p className="hint">
                          Fresh lane after {shortHex(row.retryOfLane)}
                        </p>
                      )}
                      {row.retriedAsLane && (
                        <p className="hint">
                          Retried on {shortHex(row.retriedAsLane)}; never
                          re-signed.
                        </p>
                      )}
                    </td>
                    <td className="amount num">
                      <span
                        title={row.amountExact}
                        className={`amt ${amountMark(row.record) ?? ""}`}
                      >
                        {row.amount}
                      </span>
                    </td>
                    <td className="gas num">{row.gas}</td>
                    <td className="status-cell">
                      <div className="st">
                        <div className="st-main">
                          <div className="st-words">
                            <span className="row-status">
                              {row.status.label}
                            </span>
                            {safeExplorer(row.explorerUrl) && (
                              <a
                                className="explorer"
                                href={row.explorerUrl}
                                target="_blank"
                                rel="noopener noreferrer"
                              >
                                explorer
                              </a>
                            )}
                          </div>
                          {row.refusal && (
                            <p className="refusal">{row.refusal.words}</p>
                          )}
                          <ol className="steps">
                            {row.steps.map((step, j) => (
                              <li
                                className={`step step-${step.key} ${j === row.steps.length - 1 ? "current" : ""}`}
                                key={step.key}
                              >
                                <i className="dot" aria-hidden="true" />
                                <span className="step-label">{step.label}</span>
                                <span className="when">
                                  +{(step.at / 1000).toFixed(1)} s
                                </span>
                              </li>
                            ))}
                          </ol>
                        </div>
                        {stamp && (
                          <span className="stamp">
                            burned<small>{stamp.words}</small>
                          </span>
                        )}
                      </div>
                    </td>
                  </tr>
                </Fragment>
              );
            })}
          </tbody>
        </table>
      </div>
      <Dialog
        open={selected !== null}
        onOpenChange={(open) => {
          if (!open) setSelected(null);
        }}
      >
        <DialogContent className="app-dialog lane-dialog">
          <DialogTitle>Lane evidence</DialogTitle>
          <DialogDescription>
            Admission, key consumption, receipt and the exact transaction.
          </DialogDescription>
          {selected && (
            <LaneEvidence
              hash={selected}
              fallback={records.find((r) => r.txHash === selected)}
            />
          )}
        </DialogContent>
      </Dialog>
    </section>
  );
}
function safeExplorer(url: string) {
  try {
    return ["http:", "https:"].includes(new URL(url).protocol);
  } catch {
    return false;
  }
}
function LaneEvidence({
  hash,
  fallback,
}: {
  hash: string;
  fallback?: TxRecord;
}) {
  const { api } = useWallet();
  const detail = useQuery({
    queryKey: ["tx", hash],
    queryFn: () => api.tx(hash),
    refetchInterval: 2_000,
  });
  const r = detail.data ?? fallback;
  if (!r)
    return (
      <p>{detail.error ? errorText(detail.error) : "Loading evidence…"}</p>
    );
  const gas = r.gas;
  return (
    <div className="group lane-inspector">
      {detail.error && <p className="warning">{errorText(detail.error)}</p>}
      <dl className="facts">
        <Fact label="Transaction">
          <span className="mono">{r.txHash}</span>
        </Fact>
        <Fact label="Lane">{r.nonceKey}</Fact>
        <Fact label="Leaf / sequence">
          {r.leaf} / {r.nonceSeq}
        </Fact>
        <Fact label="Value">
          {r.valueWei === null ? "Unknown" : formatWeiExact(r.valueWei)}
        </Fact>
        <Fact label="Status">{r.status}</Fact>
        <Fact label="Key mode">{r.mode}</Fact>
      </dl>
      {r.detail && <p className="warning">{r.detail}</p>}
      {r.retryOf && (
        <p>Retry of {r.retryOf}. This transaction uses a fresh leaf.</p>
      )}
      {r.retriedAs && (
        <p>Retried as {r.retriedAs}; the old leaf stays burned.</p>
      )}
      <h3>Gas, as reported</h3>
      <dl className="gas-columns">
        {[
          ["Declared verify", gas?.declaredVerifyGas],
          ["Used verify", gas?.verifyGas ?? r.simulation.verifyGas],
          ["Calldata floor", gas?.floorGas],
          ["Receipt gas", gas?.gasUsed],
        ].map(([label, value]) => (
          <Fact label={label!} key={label}>
            {value === null || value === undefined
              ? "Unknown"
              : BigInt(value).toLocaleString()}
          </Fact>
        ))}
      </dl>
      {gas?.declaredVerifyGas && gas.verifyGas && (
        <div className="gas-gauge">
          <label htmlFor="verify-gauge">
            Used verification gas / declared budget
          </label>
          <meter
            id="verify-gauge"
            min="0"
            max={Number(gas.declaredVerifyGas)}
            value={Number(gas.verifyGas)}
          />
        </div>
      )}
      {r.grind && (
        <p className="hint">
          Signer grinding: {r.grind.steps} of {r.grind.maxSteps} steps, changing{" "}
          {r.grind.field}; {r.grind.tries.length} message attempts. One
          signature is made after grinding.
        </p>
      )}
      <h3>Admission report</h3>
      {r.admission ? (
        <>
          <p>{r.admission.summary}</p>
          <ul className="checks">
            {r.admission.checks.map((c, i) => (
              <li key={i} className={`check check-${c.verdict}`}>
                <strong>{c.verdict}</strong> {c.rule}
                {c.detail ? `: ${c.detail}` : ""}
              </li>
            ))}
          </ul>
        </>
      ) : (
        <p className="hint">No admission report available.</p>
      )}
      <h3>Status timeline</h3>
      <ol className="raw-timeline">
        {r.timeline.map((t, i) => (
          <li key={i}>
            <time dateTime={t.at}>{new Date(t.at).toLocaleTimeString()}</time>{" "}
            {t.status}
          </li>
        ))}
      </ol>
      <details>
        <summary>Receipt</summary>
        <pre className="raw-json">
          {r.receipt
            ? JSON.stringify(r.receipt, null, 2)
            : "Receipt not available. Inclusion alone does not establish execution success."}
        </pre>
      </details>
      <details>
        <summary>Exact wire payload</summary>
        <pre className="raw-json">
          {r.wire
            ? JSON.stringify(r.wire, null, 2)
            : "Wire payload not available."}
        </pre>
      </details>
    </div>
  );
}
