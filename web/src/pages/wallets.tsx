import { useForm } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import { z } from "zod";
import { Link, useNavigate } from "react-router";
import { Action, Fact, Field, Intro } from "../components/common";
import { useWallet } from "../lib/state";
import {
  createWalletBody,
  formatWei,
  isAddress,
  parseEth,
  errorText,
  shortHex,
} from "../lib/api";

const schema = z
  .object({
    height: z
      .string()
      .refine(
        (s) => /^\d+$/.test(s) && Number(s) >= 2 && Number(s) <= 12,
        "Use a height from 2 to 12.",
      ),
    valueCap: z
      .string()
      .refine(
        (s) => parseEth(s) !== null,
        "Enter ETH with at most 18 decimals.",
      ),
    feeCap: z
      .string()
      .refine(
        (s) => !s.trim() || parseEth(s) !== null,
        "Enter a valid fee cap in ETH.",
      ),
    allowedTarget: z
      .string()
      .refine(
        (s) => !s.trim() || isAddress(s.trim()),
        "Enter a 0x address with 40 hex digits.",
      ),
    hotStart: z
      .string()
      .refine(
        (s) => !s.trim() || /^\d+$/.test(s),
        "Enter a whole leaf number.",
      ),
  })
  .superRefine((v, ctx) => {
    const start = Number(v.hotStart);
    if (v.hotStart && (start < 2 || start >= 2 ** Number(v.height)))
      ctx.addIssue({
        code: "custom",
        path: ["hotStart"],
        message: "Leave at least two cold leaves and one hot leaf.",
      });
  });
type Values = z.infer<typeof schema>;
export function WalletsPage() {
  const { wallets, run, api, busy, unavailable, status, stall } = useWallet();
  const navigate = useNavigate();
  const {
    register,
    handleSubmit,
    formState: { errors },
  } = useForm<Values>({
    resolver: zodResolver(schema),
    defaultValues: {
      height: "10",
      valueCap: "0.01",
      feeCap: "",
      allowedTarget: "",
      hotStart: "",
    },
  });
  return (
    <main id="workspace">
      <Intro
        title="Your wallets"
        description="Create a post-quantum account or continue with an existing wallet."
      />
      <div className="panes start">
        <section className="pane" aria-labelledby="wallets-title">
          <div className="pane-head">
            <h2 id="wallets-title">Wallets</h2>
            <p>Accounts available on this device</p>
          </div>
          <ul className="wallets">
            {wallets.isPending ? (
              <li className="muted">Loading wallets…</li>
            ) : wallets.error ? (
              <li className="warning">{errorText(wallets.error)}</li>
            ) : wallets.data?.length === 0 ? (
              <li className="empty-state">
                Create your first wallet to begin.
              </li>
            ) : (
              wallets.data?.map((w) => (
                <li key={w.address}>
                  <dl className="summary">
                    <Fact label="wallet">
                      <span className="mono" title={w.address}>
                        {shortHex(w.address)}
                      </span>
                    </Fact>
                    <Fact label="balance" lead>
                      {formatWei(w.balanceWei)}
                    </Fact>
                    <Fact label="epoch">{w.epoch}</Fact>
                    <Fact label="tree height">{w.height}</Fact>
                  </dl>
                  <div className="links">
                    {[
                      ["hot-cold", "Pay"],
                      ["agent", "Agent"],
                      ["session", "Session"],
                    ].map(([path, label]) => (
                      <Link
                        key={path}
                        to={`/${path}.html?wallet=${encodeURIComponent(w.address)}`}
                      >
                        {label}
                      </Link>
                    ))}
                  </div>
                </li>
              ))
            )}
          </ul>
        </section>
        <section className="pane" aria-labelledby="create-title">
          <div className="pane-head">
            <h2 id="create-title">Create a wallet</h2>
            <p>A fresh seed, a key tree, and an account on the devnet.</p>
          </div>
          <div className="create-path">
            <span>Key tree</span>
            <i />
            <span>Account</span>
            <i />
            <span>Tickets</span>
          </div>
          <form
            className="create"
            noValidate
            onSubmit={handleSubmit(async (values) => {
              const result = await run(
                "create",
                () => api.createWallet(createWalletBody(values)),
                "Wallet created.",
              );
              if (result)
                navigate(
                  `/hot-cold.html?wallet=${encodeURIComponent(result.address)}`,
                );
            })}
          >
            <fieldset disabled={!!busy || !!stall || !!status?.stalled}>
              <details
                className="create-advanced"
                open={errors.height ? true : undefined}
              >
                <summary>Key tree settings</summary>
                <div className="group">
                  <Field
                    label="Tree height"
                    type="number"
                    min="2"
                    max="12"
                    {...register("height")}
                    error={errors.height?.message}
                    help="2ʰ leaves per chain"
                  />
                </div>
              </details>
              <hr className="rule" />
              <div className="group">
                <h3>Hot policy</h3>
                <div className="row">
                  <Field
                    label="Value cap, ETH"
                    inputMode="decimal"
                    {...register("valueCap")}
                    error={errors.valueCap?.message}
                  />
                  <Field
                    label="Fee cap, ETH (optional)"
                    inputMode="decimal"
                    placeholder="0.002"
                    {...register("feeCap")}
                    error={errors.feeCap?.message}
                  />
                </div>
                <Field
                  label="Allowed ticket recipient (optional)"
                  placeholder="0x… (defaults to the devnet genesis account)"
                  {...register("allowedTarget")}
                  error={errors.allowedTarget?.message}
                />
                <Field
                  label="Hot start (optional)"
                  type="number"
                  placeholder="2^h − 16"
                  {...register("hotStart")}
                  error={errors.hotStart?.message}
                  help="The first hot leaf: the hot band runs from it to the last leaf."
                />
              </div>
              <div className="row submit">
                <Action primary type="submit" pending={busy === "create"}>
                  Create wallet
                </Action>
                <span className="hint">
                  Waits for the EOA’s transaction to be mined.
                </span>
              </div>
            </fieldset>
          </form>
        </section>
      </div>
    </main>
  );
}
