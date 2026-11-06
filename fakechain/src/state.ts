// World state of the fake chain: balance, nonce, code and storage per address. Blocks keep whole copies.
// Written with Claude Code (AI) for Vicky.
import type { Address, Hex } from "viem";

export interface AccountState {
  balance: bigint;
  nonce: bigint;
  code: Hex;
  storage: Map<bigint, bigint>;
}

const k = (a: string) => a.toLowerCase();

export class WorldState {
  private readonly accounts = new Map<string, AccountState>();

  private touch(a: string): AccountState {
    let acc = this.accounts.get(k(a));
    if (!acc) {
      acc = { balance: 0n, nonce: 0n, code: "0x", storage: new Map() };
      this.accounts.set(k(a), acc);
    }
    return acc;
  }

  balance(a: string): bigint { return this.accounts.get(k(a))?.balance ?? 0n; }
  nonce(a: string): bigint { return this.accounts.get(k(a))?.nonce ?? 0n; }
  code(a: string): Hex { return this.accounts.get(k(a))?.code ?? "0x"; }
  sload(a: string, slot: bigint): bigint { return this.accounts.get(k(a))?.storage.get(slot) ?? 0n; }

  setBalance(a: string, v: bigint) {
    if (v < 0n) throw new Error(`internal: negative balance for ${a}`);
    this.touch(a).balance = v;
  }
  addBalance(a: string, delta: bigint) { this.setBalance(a, this.balance(a) + delta); }
  setNonce(a: string, v: bigint) { this.touch(a).nonce = v; }
  setCode(a: string, code: Hex) { this.touch(a).code = code.toLowerCase() as Hex; }
  sstore(a: string, slot: bigint, v: bigint) {
    const s = this.touch(a).storage;
    if (v === 0n) s.delete(slot);
    else s.set(slot, v);
  }

  /** EIP-161: an account with no balance, no nonce and no code is empty; value sent to it creates it. */
  isEmpty(a: string): boolean {
    const acc = this.accounts.get(k(a));
    return !acc || (acc.balance === 0n && acc.nonce === 0n && acc.code === "0x");
  }

  storageOf(a: string): [bigint, bigint][] { return [...(this.accounts.get(k(a))?.storage ?? new Map()).entries()]; }
  addresses(): Address[] { return [...this.accounts.keys()] as Address[]; }

  clone(): WorldState {
    const c = new WorldState();
    for (const [a, acc] of this.accounts) c.accounts.set(a, { ...acc, storage: new Map(acc.storage) });
    return c;
  }
}
