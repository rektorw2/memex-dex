import fs from 'node:fs';
import { pathToFileURL } from 'node:url';
const MINUTE = 60_000, HOUR = 60 * MINUTE;
const numeric = v => v != null && String(v).trim() !== '' && Number.isFinite(Number(v)) && Number(v) >= 0 ? Number(v) : null;
export function parseObservation(csv) {
  const [header, ...lines] = csv.trim().split(/\r?\n/);
  const keys = header.split(',');
  return lines.filter(Boolean).map(line => Object.fromEntries(keys.map((k, i) => [k, line.split(',')[i]])));
}
function weightedMedian(parts) {
  const ordered = parts.filter(p => p.weight > 0).sort((a,b) => a.value - b.value);
  const half = ordered.reduce((s,p) => s + p.weight, 0) / 2;
  let sum = 0;
  for (const p of ordered) { sum += p.weight; if (sum >= half) return p.value; }
  return null;
}
export function summarizeObservation(rows) {
  const times = rows.map(r => Date.parse(r.ts));
  const ordered = rows.length >= 2 && times.every((t,i) => Number.isFinite(t) && (i === 0 || t > times[i-1]));
  const span = ordered ? times.at(-1) - times[0] : 0;
  const required = ['completed_age_ms','consecutive_failures','rss_mb','heap_mb','uptime_sec','queued'];
  const workerMissing = r => required.some(k => numeric(r[k]) == null) || !['200','503'].includes(r.agent_http) || !/^\d{3}$/.test(r.health_http ?? '') || !['healthy','unhealthy','unknown'].includes(r.state);
  const sourceMissing = r => numeric(r.signal_age_ms) == null || !['available','unavailable'].includes(r.source_state) || !r.source_code;
  const missing = rows.filter(r => workerMissing(r) || sourceMissing(r)).length;
  const missingWorker = rows.filter(workerMissing).length, missingSource = rows.filter(sourceMissing).length;
  const workerOk = r => r.health_http === '200' && r.agent_http === '200' && r.state === 'healthy' && numeric(r.completed_age_ms) != null && +r.completed_age_ms < MINUTE && numeric(r.consecutive_failures) === 0;
  const sourceOk = r => r.source_state === 'available' && ['OK','OK_REST_ONLY'].includes(r.source_code);
  let covered = 0, gap = 0, workerGood = 0, sourceGood = 0, workerRun = 0, workerWorst = 0, sourceRun = 0, sourceWorst = 0, resets = 0, signalRun = 0, signalWorst = 0;
  const first = [], last = [];
  if (ordered) for (let i = 1; i < rows.length; i++) {
    const a = rows[i-1], b = rows[i], dt = times[i] - times[i-1];
    const observed = dt <= 90_000;
    gap = Math.max(gap, dt);
    if (observed) covered += dt;
    const wa = numeric(a.uptime_sec), wb = numeric(b.uptime_sec);
    // A reboot may still have higher uptime than the preceding observation.
    if (wa != null && wb != null && (wb < wa || Math.abs((wb-wa)*1000-dt) > 5_000)) resets++;
    const healthy = observed && workerOk(a) && workerOk(b);
    if (healthy) workerGood += dt;
    workerRun = healthy ? 0 : workerRun + dt;
    workerWorst = Math.max(workerWorst, workerRun);
    const available = observed && sourceOk(a) && sourceOk(b);
    if (available) sourceGood += dt;
    sourceRun = available ? 0 : sourceRun + dt;
    sourceWorst = Math.max(sourceWorst, sourceRun);
    const fresh = observed && numeric(a.signal_age_ms) != null && numeric(b.signal_age_ms) != null && +a.signal_age_ms <= 15*MINUTE && +b.signal_age_ms <= 15*MINUTE;
    signalRun = fresh ? 0 : signalRun + dt;
    signalWorst = Math.max(signalWorst, signalRun);
    if (observed && numeric(a.rss_mb) != null) {
      first.push({value:+a.rss_mb, weight:Math.max(0, Math.min(times[i], times[0]+6*HOUR)-times[i-1])});
      last.push({value:+a.rss_mb, weight:Math.max(0, times[i]-Math.max(times[i-1], times.at(-1)-6*HOUR))});
    }
  }
  const rssFirst = weightedMedian(first), rssLast = weightedMedian(last);
  const coverageOk = ordered && span >= 24*HOUR && covered === span;
  const workerPass = coverageOk && missingWorker === 0 && resets === 0 && workerGood/span >= .99 && workerWorst <= 3*MINUTE && rssFirst > 0 && rssLast != null && rssLast <= rssFirst*1.2;
  const sourcePass = coverageOk && missingSource === 0 && sourceGood/span >= .99 && sourceWorst <= 3*MINUTE && signalWorst <= HOUR;
  return {
    samples:rows.length, timestampsOrdered:ordered, coverageHours:span/HOUR, observedHours:covered/HOUR,
    largestSampleGapSeconds:gap/1000, missingMetricRows:missing, uptimeResets:resets,
    healthyPct:span ? workerGood/span*100 : 0, longestUnhealthyMin:workerWorst/MINUTE,
    sourceAvailablePct:span ? sourceGood/span*100 : 0, longestSourceUnavailableMin:sourceWorst/MINUTE,
    longestSignalGapOver15min_minutes:signalWorst/MINUTE,
    rssMedianFirst6h:rssFirst, rssMedianLast6h:rssLast,
    workerVerdict:workerPass ? 'PASS' : 'NOT_CONFIRMED', sourceVerdict:sourcePass ? 'PASS' : 'NOT_CONFIRMED',
    verdict:workerPass && sourcePass ? 'PASS' : 'NOT_CONFIRMED',
  };
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const result = summarizeObservation(parseObservation(fs.readFileSync(process.argv[2], 'utf8')));
  console.log(JSON.stringify(result, null, 2));
  process.exitCode = result.verdict === 'PASS' ? 0 : 1;
}
