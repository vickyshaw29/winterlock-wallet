# Rules for every agent working on this repo

Two local files define this project. Read both in full before doing any work, and follow them:

- `.claude/spec.md`: the Nonce-Bound PQ Wallet Spec (rev Nov 3). What we build and how: design, interfaces, numbers.
- `.claude/plan.md`: the technical plan for Nov 4 to 7. Who builds what, when, and the hackathon rules.

## When they disagree

- Design and interfaces: the spec wins.
- Owners, timing, scope cuts and event rules: the plan wins. It says it replaces the spec's owner columns in "Feature levels" and its "Work split and milestones" section.
- If the two files contradict each other, the code, or the vendored code, stop and ask Vicky. Never pick one silently.

## Rules

1. Don't deviate from either file without Vicky's explicit approval. If you think something in them is wrong, say so and ask.
2. Before building on a fact from the spec, check it against the vendored source (`vendor/`, `contracts/lib/`). The EIPs are drafts and change.
3. Hackathon rules (plan, sections 1 and 11): Vicky drives every AI tool and authors every commit, and the work must not be AI alone. Never rewrite git history. Keep the README's AI-attribution section up to date with which files AI wrote.
4. Never commit, push or open a pull request unless Vicky asks. Never commit anything under `.claude/`, or this file.
5. When you hand work to a subagent, tell it to read `.claude/spec.md` and `.claude/plan.md` first. Some subagents (Claude Code's Explore and Plan) start without these instructions.
