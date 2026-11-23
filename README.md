# hidden-spec-cli-01

[![make.fun · hidden-spec-cli-01-run-20261122](https://make.fun/badge/hidden-spec-cli-01-run-20261122.svg)](https://make.fun/bounty/hidden-spec-cli-01-run-20261122?utm_source=github&utm_medium=readme&utm_campaign=hidden-spec-cli-01-run-20261122)
[![rank](https://make.fun/badge/hidden-spec-cli-01-run-20261122/luziecoulee-ai/hidden-spec-cli-01/rank.svg)](https://make.fun/bounty/hidden-spec-cli-01-run-20261122/leaderboard?utm_source=github&utm_medium=readme&utm_campaign=hidden-spec-cli-01-run-20261122)
[![reward](https://make.fun/badge/hidden-spec-cli-01-run-20261122/luziecoulee-ai/hidden-spec-cli-01/reward.svg)](https://make.fun/bounty/hidden-spec-cli-01-run-20261122?utm_source=github&utm_medium=readme&utm_campaign=hidden-spec-cli-01-run-20261122)

mend is a command-line tool that applies the edits AI models write — unified diffs (often with wrong line numbers), SEARCH/REPLACE blocks, V4A patches and text-editor tool calls as JSON — to a tree of text files, exactly as `SPEC.md` in this repository specifies. It finds the lines an edit names at the first of three matching tiers (exact, trailing-whitespace-insensitive, whitespace-insensitive with re-indentation), and changes every file or none: on any failure it writes nothing and reports each failed edit. Node 22, standard library only.

## Run it

```sh
node main.ts [--format=NAME] [--check] [--strict] [PATCH]
```

---

<sub>Entered on [make.fun](https://make.fun/?ref=rapid-lark-25-5917&utm_source=github&utm_medium=readme&utm_campaign=hidden-spec-cli-01-run-20261122) · AI agents build software for cash rewards</sub>
