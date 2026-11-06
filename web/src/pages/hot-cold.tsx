import { useState } from "react";
import { useForm } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import { z } from "zod";
import { MoreHorizontal, ArrowUpRight } from "lucide-react";
import {
  AccountSummary,
  Action,
  Fact,
  Field,
  InfoDialog,
  Intro,
  KeyRegister,
  TaskTabs,
  TicketStrip,
  nextLeaf,
  useTaskView,
} from "../components/common";
import { LaneBoard } from "../components/lanes";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogTitle,
} from "../components/ui/dialog";
import { useWallet } from "../lib/state";
import {
  checkHotAmount,
  coldTransferBody,
  cutTickets,
  formatWei,
  formatWeiExact,
  isAddress,
  parseEth,
  payBody,
  rotateRoot,
  setPolicy,
  shortHex,
  stuckBody,
  uncutHotLeaves,
  weiToEthInput,
} from "../lib/api";
import { hotColdScene } from "../domain/scenes.js";
import { setAside, setAsideText, statusOf } from "../domain/lanes.js";

export function HotColdPage() {
  const state = useWallet();
  const w = state.wallet!;
  const [view, setView] = useTaskView("pay", ["pay", "cold", "activity"]);
  const [offline, setOffline] = useState(false);
  const cap = BigInt(w.hotValueCapWei);
  const paySchema = z.object({
    amount: z.string().superRefine((s, ctx) => {
      const result = checkHotAmount(s, w);
      if (!result.ok) ctx.addIssue({ code: "custom", message: result.error });
    }),
  });
  const pay = useForm<{ amount: string }>({
    resolver: zodResolver(paySchema),
    mode: "onChange",
    defaultValues: { amount: weiToEthInput(cap / 10n || 1n) },
  });
  const amount = pay.watch("amount");
  const checked = checkHotAmount(amount, w);
  const disabled = state.hotDisabled || !!state.busy;
  const latest = state.records.find(
    (r) => r.kind === "send" && r.mode === "hot",
  );
  const leaf = nextLeaf(w, state.records);
  return (
    <>
      <Intro
        title="Hot and cold"
        description="Keep the seed on the cold device. Give the phone only what it can spend."
      />
      <AccountSummary />
      <main id="workspace">
        <TaskTabs
          view={view}
          onChange={setView}
          tabs={[
            ["pay", "Pay", "phone-pane"],
            ["cold", "Cold device", "cold-pane"],
            ["activity", "Activity", "lane-board"],
          ]}
        />
        <div className="panes instrument">
          <section
            className="pane"
            id="phone-pane"
            aria-labelledby="phone-title"
          >
            <div className="pane-head">
              <h2 id="phone-title">Pay from phone</h2>
              <p
                className="count"
                aria-label={`${w.tickets.left} of ${w.tickets.exported} tickets left`}
              >
                <span>{w.tickets.left}</span>
                <span>of {w.tickets.exported}</span>
              </p>
              <InfoDialog
                title="Payment details"
                trigger={
                  <button
                    className="icon-button payment-menu"
                    aria-label="Payment details"
                  >
                    <MoreHorizontal aria-hidden="true" />
                  </button>
                }
              >
                <details className="ticket-context" open>
                  <summary>
                    One-time keys &amp; policy{" "}
                    <span className="ticket-serial">{leaf ?? "—"}</span>
                  </summary>
                  <p className="machine">
                    Each signature burns one ticket on a fresh lane.
                  </p>
                  <p className="hint">
                    Value cap {formatWeiExact(w.hotValueCapWei)}; fee cap{" "}
                    {formatWeiExact(w.hotFeeCapWei)}; recipient{" "}
                    {w.allowedTarget}.
                  </p>
                </details>
                <details className="payment-explainer">
                  <summary>Expiry and retry</summary>
                  <div className="group">
                    <Action
                      disabled={disabled || !checked.ok || w.tickets.left < 2}
                      onClick={() => {
                        if (checked.ok)
                          void state.run(
                            "stuck",
                            () =>
                              state.api.send(
                                w.address,
                                stuckBody({
                                  wallet: w,
                                  valueWei: checked.wei,
                                  mempool: state.mempool,
                                }),
                              ),
                            "Stuck payment submitted. Follow its expiry and fresh-lane retry on the board.",
                          );
                      }}
                    >
                      Simulate stuck payment
                    </Action>
                    <p className="hint">
                      The first attempt has a 4-second deadline; the normal
                      deadline is 90 seconds. It may still land before expiry.
                      After expiry the backend tries once on a fresh leaf and
                      lane. The original leaf is never re-signed or fee-bumped.
                      Both attempts offer the market’s fee.
                    </p>
                  </div>
                </details>
              </InfoDialog>
              <TicketStrip />
            </div>
            {state.deviceFault && (
              <p className="warning" role="status">
                {state.deviceFault}
              </p>
            )}
            {w.tickets.left === 0 && !state.deviceFault && (
              <div className="readiness">
                <p>No tickets left on the phone.</p>
                <button
                  className="link"
                  onClick={() => {
                    setView("cold");
                    requestAnimationFrame(() => {
                      const fold = document.getElementById(
                        "fold-cut",
                      ) as HTMLDetailsElement | null;
                      if (fold) {
                        fold.open = true;
                        fold.scrollIntoView({ block: "nearest" });
                        fold.querySelector("input")?.focus();
                      }
                    });
                  }}
                >
                  Prepare tickets on the cold device
                </button>
              </div>
            )}
            <fieldset id="phone-fields" disabled={disabled}>
              <form
                id="pay-form"
                className="group"
                noValidate
                onSubmit={pay.handleSubmit((values) => {
                  const c = checkHotAmount(values.amount, w);
                  if (c.ok && !disabled)
                    void state.run(
                      "pay",
                      () =>
                        state.api.send(
                          w.address,
                          payBody({
                            wallet: w,
                            valueWei: c.wei,
                            mempool: state.mempool,
                          }),
                        ),
                      "Payment submitted. Its receipt will appear on the lane board.",
                    );
                })}
              >
                <div className="paper ticket">
                  <label className="field" htmlFor="pay-amount">
                    <span>Amount, ETH</span>
                    <span className="amount-box">
                      <input
                        id="pay-amount"
                        type="text"
                        inputMode="decimal"
                        autoComplete="off"
                        spellCheck={false}
                        className="num"
                        {...pay.register("amount")}
                        aria-invalid={
                          !!pay.formState.errors.amount || undefined
                        }
                        aria-describedby="pay-problem"
                      />
                      <span className="unit" aria-hidden="true">
                        <svg viewBox="0 0 16 24" fill="currentColor">
                          <path d="M8 0L1 12l7 4 7-4L8 0zm0 18l-7-4 7 10 7-10-7 4z" />
                        </svg>
                        ETH
                      </span>
                    </span>
                    <span className="problem" id="pay-problem">
                      {pay.formState.errors.amount?.message}
                    </span>
                  </label>
                  <div className="amount-presets">
                    <span>Of value cap</span>
                    {[
                      [4n, "25%"],
                      [2n, "50%"],
                      [1n, "Full cap"],
                    ].map(([divisor, label]) => (
                      <button
                        type="button"
                        key={String(label)}
                        onClick={() =>
                          pay.setValue(
                            "amount",
                            weiToEthInput(cap / (divisor as bigint)),
                            { shouldValidate: true, shouldDirty: true },
                          )
                        }
                      >
                        {label as string}
                      </button>
                    ))}
                  </div>
                  <Field
                    label="To"
                    aria-label="To the allowed recipient"
                    fieldClassName="recipient-field"
                    readOnly
                    value={w.allowedTarget}
                  />
                </div>
                {checked.ok && (
                  <div className="payment-preview">
                    <dl>
                      <div>
                        <dt>Tickets after signing</dt>
                        <dd>
                          {w.tickets.left} → {Math.max(0, w.tickets.left - 1)}
                        </dd>
                      </div>
                      <div>
                        <dt>Payment + fee ceiling</dt>
                        <dd>
                          {formatWei(checked.wei + BigInt(w.hotFeeCapWei))}
                        </dd>
                      </div>
                    </dl>
                  </div>
                )}
                <div className="row">
                  <Action
                    id="pay"
                    type="submit"
                    primary
                    disabled={!checked.ok}
                    pending={state.busy === "pay"}
                  >
                    Pay {checked.ok ? formatWei(checked.wei) : "with a ticket"}
                  </Action>
                </div>
              </form>
            </fieldset>
            {latest && (
              <section
                className="live-activity"
                role="status"
                aria-label="Latest payment"
              >
                <span className="activity-label">Latest payment</span>
                <strong>{statusOf(latest).label}</strong>
                <span className="hint">
                  Leaf {latest.leaf} · {shortHex(latest.txHash)}
                </span>
              </section>
            )}
            {setAside(state.records, w).lanes > 0 && (
              <p className="set-aside">
                {setAsideText(setAside(state.records, w))}
              </p>
            )}
          </section>
          <section
            className={`pane ${offline ? "offline" : ""}`}
            id="cold-pane"
            aria-labelledby="cold-title"
          >
            <div className="pane-head">
              <h2 id="cold-title">Cold device</h2>
              <label className="toggle">
                <input
                  type="checkbox"
                  checked={offline}
                  onChange={(e) => setOffline(e.target.checked)}
                  disabled={!!state.busy}
                />{" "}
                Offline
              </label>
            </div>
            <ColdForms offline={offline} />
          </section>
        </div>
        <LaneBoard
          disabled={state.unavailable || !!state.deviceFault}
          scene={() =>
            void state.run("scene", () =>
              hotColdScene(state.api, w.address, {
                step: state.notify,
                mempool: state.setMempool,
                offline: setOffline,
              }),
            )
          }
          guide="Cuts tickets if fewer than seven remain, takes the cold device offline, sends three alt-mempool payments including one short-deadline attempt, then submits three public-mempool payments. Every outcome comes from the backend."
        />
      </main>
    </>
  );
}

const eth = z
  .string()
  .refine(
    (s) => parseEth(s) !== null,
    "Enter an amount in ETH, up to 18 decimals.",
  );
const address = z
  .string()
  .refine((s) => isAddress(s.trim()), "Enter a valid 0x address.");
function ColdForms({ offline }: { offline: boolean }) {
  const s = useWallet();
  const w = s.wallet!;
  const disabled = offline || s.unavailable || !!s.busy;
  const transfer = useForm({
    resolver: zodResolver(
      z.object({
        to: address,
        amount: eth.refine(
          (v) => (parseEth(v) ?? 0n) > 0n,
          "Enter more than 0 ETH.",
        ),
      }),
    ),
    defaultValues: { to: "", amount: "" },
  });
  const policy = useForm({
    resolver: zodResolver(
      z.object({
        valueCap: eth,
        feeCap: eth,
        allowedTarget: address,
        hotStart: z
          .string()
          .refine(
            (v) => /^\d+$/.test(v) && Number(v) >= 1 && Number(v) <= w.hotStart,
            "Keep or lower the hot start; it cannot increase this epoch.",
          ),
      }),
    ),
    defaultValues: {
      valueCap: weiToEthInput(w.hotValueCapWei),
      feeCap: weiToEthInput(w.hotFeeCapWei),
      allowedTarget: w.allowedTarget,
      hotStart: String(w.hotStart),
    },
  });
  const available = uncutHotLeaves(w);
  const cut = useForm({
    resolver: zodResolver(
      z.object({
        count: z
          .string()
          .refine(
            (v) =>
              /^\d+$/.test(v) &&
              Number(v) >= 1 &&
              Number(v) <= Math.min(64, available),
            `Choose 1 to ${Math.min(64, available)} uncut tickets.`,
          ),
      }),
    ),
    defaultValues: { count: String(Math.min(10, available) || 1) },
  });
  const rotate = useForm({
    resolver: zodResolver(
      z.object({
        height: z
          .string()
          .refine(
            (v) => /^\d+$/.test(v) && Number(v) >= 2 && Number(v) <= 12,
            "Use a height from 2 to 12.",
          ),
      }),
    ),
    defaultValues: { height: String(w.height) },
  });
  const [confirmation, setConfirmation] = useState<number | null>(null);
  return (
    <fieldset disabled={disabled} id="cold-fields">
      <div className="group tree cold-vault">
        <p className="vault-note">Seed stays here</p>
        <h3>{w.leafCount.toLocaleString()} one-time keys</h3>
        <KeyRegister />
        <dl className="facts-inline">
          <Fact label="height">{w.height}</Fact>
          <Fact label="epoch">{w.epoch}</Fact>
          <Fact label="leaves used">
            {w.leavesUsed} of {w.leafCount}
          </Fact>
          <Fact label="hot band">
            leaves {w.hotStart} to {w.leafCount - 1}
          </Fact>
          <Fact label="root">
            <span title={w.root} className="mono">
              {shortHex(w.root)}
            </span>
          </Fact>
        </dl>
      </div>
      <div className="forms">
        <details className="fold" name="cold-actions" id="fold-transfer" open>
          <summary>
            <h3>
              Send from cold
              <span className="fold-hint">
                Any recipient, signed by the cold device
              </span>
            </h3>
          </summary>
          <form
            className="group"
            noValidate
            onSubmit={transfer.handleSubmit((v) => {
              if (!disabled)
                void s.run(
                  "transfer",
                  () =>
                    s.api.send(
                      w.address,
                      coldTransferBody({
                        to: v.to.trim(),
                        valueWei: parseEth(v.amount)!,
                        mempool: s.mempool,
                      }),
                    ),
                  "Cold transfer submitted.",
                );
            })}
          >
            <p className="hint">
              A keyed lane on the next cold leaf, to any address, without the
              hot value cap.
            </p>
            <Field
              label="To"
              {...transfer.register("to")}
              error={transfer.formState.errors.to?.message}
              placeholder="0x…"
            />
            <div className="row">
              <Field
                label="Amount, ETH"
                inputMode="decimal"
                {...transfer.register("amount")}
                error={transfer.formState.errors.amount?.message}
              />
              <Action type="submit" primary>
                Send from cold
              </Action>
            </div>
          </form>
        </details>
        <details className="fold" name="cold-actions" id="fold-policy">
          <summary>
            <h3>
              Hot policy
              <span className="fold-hint">
                Set the recipient and spending caps
              </span>
            </h3>
          </summary>
          <form
            className="group"
            noValidate
            onSubmit={policy.handleSubmit((v) => {
              if (!disabled)
                void s.run(
                  "policy",
                  () => setPolicy(s.api, w.address, v),
                  "Policy submitted. The current policy remains until inclusion.",
                );
            })}
          >
            <div className="row">
              <Field
                label="Value cap, ETH"
                inputMode="decimal"
                {...policy.register("valueCap")}
                error={policy.formState.errors.valueCap?.message}
              />
              <Field
                label="Fee cap, ETH"
                inputMode="decimal"
                {...policy.register("feeCap")}
                error={policy.formState.errors.feeCap?.message}
              />
            </div>
            <Field
              label="Allowed target"
              {...policy.register("allowedTarget")}
              error={policy.formState.errors.allowedTarget?.message}
            />
            <Field
              label="Hot start (first hot leaf)"
              type="number"
              {...policy.register("hotStart")}
              error={policy.formState.errors.hotStart?.message}
              help="Kept or lowered, never raised within an epoch."
            />
            <div className="row">
              <Action type="submit" primary>
                Set policy
              </Action>
              <span className="hint">
                A value cap of 0 is the kill switch for every ticket.
              </span>
            </div>
          </form>
        </details>
        <details className="fold" name="cold-actions" id="fold-cut">
          <summary>
            <h3>
              Tickets for the phone
              <span className="fold-hint">
                Delegate a finite set of one-time keys
              </span>
            </h3>
          </summary>
          <form
            className="group"
            noValidate
            onSubmit={cut.handleSubmit((v) => {
              if (!disabled && !s.deviceFault)
                void s.run(
                  "cut",
                  () => cutTickets(s.api, w.address, Number(v.count)),
                  "Tickets cut to the phone.",
                );
            })}
          >
            <p className="hint">
              {available} hot leaves not cut yet. Every exported leaf is
              reserved immediately.
            </p>
            {s.deviceFault && <p className="warning">{s.deviceFault}</p>}
            <div className="row">
              <Field
                label="Count"
                type="number"
                min="1"
                max={Math.min(64, available)}
                {...cut.register("count")}
                error={cut.formState.errors.count?.message}
              />
              <Action
                type="submit"
                disabled={!!s.deviceFault || available === 0}
              >
                Cut tickets
              </Action>
            </div>
          </form>
        </details>
        <details className="fold" name="cold-actions" id="fold-rotate">
          <summary>
            <h3>
              Rotate the key tree
              <span className="fold-hint">Replace the current generation</span>
            </h3>
          </summary>
          <form
            className="group"
            noValidate
            onSubmit={rotate.handleSubmit((v) => {
              if (!disabled && w.lanesInFlight === 0)
                setConfirmation(Number(v.height));
            })}
          >
            <p className="warning">Rotation invalidates every pending lane.</p>
            <div className="row">
              <Field
                label="New tree height"
                type="number"
                min="2"
                max="12"
                {...rotate.register("height")}
                error={rotate.formState.errors.height?.message}
              />
              <Action type="submit" disabled={w.lanesInFlight > 0}>
                Rotate root
              </Action>
            </div>
            <p className="hint">
              Wait for all lanes to settle. The wallet moves to the new epoch
              after inclusion.
            </p>
          </form>
        </details>
      </div>
      <Dialog
        open={confirmation !== null}
        onOpenChange={(open) => {
          if (!open) setConfirmation(null);
        }}
      >
        <DialogContent className="app-dialog">
          <DialogTitle>Rotate this key tree?</DialogTitle>
          <DialogDescription>
            Rotation invalidates every pending lane and replaces the current
            ticket authority. The backend will refuse while a lane is in flight.
          </DialogDescription>
          <p>
            New tree: {confirmation === null ? "" : 2 ** confirmation} leaves.
            Existing tickets will no longer authorize payments after inclusion.
          </p>
          <div className="row">
            <Action onClick={() => setConfirmation(null)}>Cancel</Action>
            <Action
              primary
              disabled={disabled || w.lanesInFlight > 0}
              onClick={() => {
                const height = confirmation;
                setConfirmation(null);
                if (height !== null)
                  void s.run(
                    "rotate",
                    () => rotateRoot(s.api, w.address, height),
                    "Rotation submitted. Waiting for inclusion before changing epochs.",
                  );
              }}
            >
              Confirm rotation
            </Action>
          </div>
        </DialogContent>
      </Dialog>
    </fieldset>
  );
}
