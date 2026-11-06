# Planning files

Part of the [Winterlock README](../../README.md). ETHGlobal's rules for this event say that a project built with a
spec-driven workflow must "include all spec files, prompts, and planning artifacts in your submission repository", so
judges can see how the AI was directed. These are those files, copied on Nov 6, 2026 (IST) from the local, untracked
folders where they were written. They are snapshots: the copies are not edited, and later local changes do not reach
them.

| File | What it is |
| --- | --- |
| [spec.md](spec.md) | The design document, "Nonce-Bound PQ Wallet Spec": written before the event (Nov 1, revised Nov 3; its byline names its author) and disclosed to ETHGlobal. Lines dated Nov 6 were revised during the event, each with Vicky's approval |
| [plan.md](plan.md) | The build plan, written Nov 4, before the event: who builds what, when, and the event rules |
| [rules-AGENTS.md](rules-AGENTS.md) | `AGENTS.md`, the rules every AI agent in the repository followed. Copied verbatim and renamed, so that no coding agent loads the copy as live instructions |
| [rules-CLAUDE.md](rules-CLAUDE.md) | `.claude/CLAUDE.md`, which loads those rules, the spec and the plan into every Claude Code session. Copied verbatim and renamed for the same reason |
| [handoffs/](handoffs/) | Handoff notes between AI sessions during the event, each dated in its first line, and the brief for the UI redesign (`handoff-ui.md`) |
| [briefs/](briefs/) | Build briefs for the backend, its fixes, the fake chain, the parallel-lanes tooling, the screens and their Ledger restyle, each approved by Vicky as its header says; and `README-draft.md`, the README's first draft, with its notes to Vicky at the top |
| [research/](research/) | `hotlanes-design.md`, a read-only study of how to build parallel lanes on the alt mempool (Nov 6), and `hotlanes-critique.md`, a review that corrected it |
| [ui-directions/](ui-directions/) | The three UI directions offered on Nov 6: 1 Ledger, 2 Operations, 3 Key tree, each a page and its notes. Vicky picked 1, Ledger (`briefs/ledger-build.md`) |

`AGENTS.md` itself says never to commit it or anything under `.claude/`. These copies were added at Vicky's request on
Nov 6, to meet ETHGlobal's rule above; the originals stay local and untracked.

Not included: screenshots of the screens; local copies of third-party web pages fetched for research; script outputs; a
scratch test project; a reference copy of the retired UI; and the chat transcripts of the sessions. The Day-0 probe
scripts are kept outside this repository ([devnet evidence](../devnet-evidence.md#day-0-results)), and the three static
UI prototypes of Nov 4 are not in this repository and were not used ([README](../../README.md#what-existed-before-the-event-and-what-was-built-during-it)).

This index was written with Claude Code.
