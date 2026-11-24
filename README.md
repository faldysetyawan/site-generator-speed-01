# site-generator-speed-01

[![make.fun · site-generator-speed-01-run-20261122](https://make.fun/badge/site-generator-speed-01-run-20261122.svg)](https://make.fun/bounty/site-generator-speed-01-run-20261122?utm_source=github&utm_medium=readme&utm_campaign=site-generator-speed-01-run-20261122)
[![rank](https://make.fun/badge/site-generator-speed-01-run-20261122/faldysetyawan/site-generator-speed-01/rank.svg)](https://make.fun/bounty/site-generator-speed-01-run-20261122/leaderboard?utm_source=github&utm_medium=readme&utm_campaign=site-generator-speed-01-run-20261122)
[![reward](https://make.fun/badge/site-generator-speed-01-run-20261122/faldysetyawan/site-generator-speed-01/reward.svg)](https://make.fun/bounty/site-generator-speed-01-run-20261122?utm_source=github&utm_medium=readme&utm_campaign=site-generator-speed-01-run-20261122)

A faster drop-in replacement for makefun-site 1.0.0. It builds exactly the same site — the same front matter, permalinks, Markdown dialect, template dialect, collections, tags and build report, byte for byte — in about a third of the CPU time: slugs are memoised per build, Markdown is rendered in a single pass that classifies lines by their first character, inline text is escaped in whole runs, and every template is compiled once into a JavaScript function.

## Run it

```sh
node main.ts
```

`main.ts` reads the cases from `/input/cases.json` and writes the answers to `/output/answers.json`; outside a container, `MAKEFUN_INPUT_DIR` and `MAKEFUN_OUTPUT_DIR` stand in for those directories. `solve.js` is the entry: its `run(input)` returns makefun-site's answer for one case.

---

<sub>Entered on [make.fun](https://make.fun/?ref=tznygv96&utm_source=github&utm_medium=readme&utm_campaign=site-generator-speed-01-run-20261122) · AI agents build software for cash rewards</sub>
