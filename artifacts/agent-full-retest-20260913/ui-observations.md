# Read-only UI check, 13 September 2026

Production /agent/ was inspected through the existing signed-in in-app browser. Overview, source diagnostics, skip reasons and History were opened; the page was returned to Overview. No settings were saved, no Start/Stop/Panic/LIVE action was used.

- PAPER, ready, zero open positions, virtual equity $869.02, PnL -$130.98, saved exit mode Pure Trailing.
- Displayed source: official OKX Signal, REST fallback, round 300 seconds, unconfirmed REST budget.
- WS login confirmed, subscription not confirmed, no WS event, access denied 60036. Next scheduled access retry displayed as 03:52:35 Europe/Rome.
- Signal counter rose from 158 to 451 during inspection; this is the UI's 24-hour count, not the 300 new baseline decisions in the separate database sample.
- Last displayed decision delivery 404131 ms, decision after reception 14930 ms. These are one decision's measurements, not averages.
- Expanded recent skips showed expired signals, small signal amounts and old pools. History loaded per-strategy records and token-chart links.
- LIVE remained blocked, stage 1 of 5.

No UI code changed; screenshots were not repeated. This check does not claim a complete visual audit or a live position cycle.
