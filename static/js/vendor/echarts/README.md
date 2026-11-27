# Apache ECharts (vendored)

`echarts.min.js` is the unmodified `dist/echarts.min.js` (the full build) from
the npm package `echarts@6.0.0`.

- Source: https://registry.npmjs.org/echarts/-/echarts-6.0.0.tgz
- Tarball SHA-256: `5776a250a33c375f794d796f661d7b88ca36ec5fb16dbff374dd25bf5a64b26b`
- File SHA-256: `baa8dfe7e1d9336b98e8986ba7e20ea15e7cdbea1ef42a59d59478632fa45a1d`
- License: Apache-2.0 (`LICENSE`, `NOTICE`); includes d3 code under `LICENSE-d3`

It is vendored, not loaded from a CDN, because the app is offline and its CSP
is `script-src 'self'`. There is no bundler, so a custom tree-shaken build is
not an option. The full build is used rather than the smaller "common" one
because the app draws Sankey diagrams (Reports → Cash Flow, Plan → Analyze),
which only the full build includes.

Every chart in the app is drawn by ECharts through
`static/js/widgets/echart-kit.js`, which takes all colours from the active
theme's tokens. The pages with charts load it: Dashboard, Reports, Budgets and
Plan.

To upgrade, replace the file with the same build from a newer release, then
update the version and hashes above.
