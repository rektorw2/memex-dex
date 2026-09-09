import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { parseObservation, summarizeObservation as sum } from './agent-observation.mjs';
const start = Date.parse('2026-09-09T00:00:00Z');
const rows = () => Array.from({length:1441}, (_,i) => ({ts:new Date(start+i*60_000).toISOString(),health_http:'200',agent_http:'200',state:'healthy',completed_age_ms:'500',consecutive_failures:'0',rss_mb:'400',heap_mb:'200',uptime_sec:String(100+i*60),source_state:'available',source_code:'OK_REST_ONLY',signal_age_ms:'1000',queued:'0'}));
test('continuous 24h fixture passes, not a production observation', () => assert.equal(sum(rows()).verdict,'PASS'));
for (const file of ['two-observations','restarts-every-ten-minutes']) test(file, () => assert.equal(sum(parseObservation(fs.readFileSync(`artifacts/agent-paper-readiness/independent-review/fixtures/${file}.csv`,'utf8'))).verdict,'NOT_CONFIRMED'));
test('two otherwise valid observations cannot pass', () => {const r=rows();assert.equal(sum([r[0],r.at(-1)]).verdict,'NOT_CONFIRMED');});
test('gap, duplicate and reverse time fail', () => {for (const change of [r=>r.splice(60,10),r=>r[2]=r[1],r=>r.reverse()]) {const r=rows();change(r);assert.equal(sum(r).verdict,'NOT_CONFIRMED');}});
test('blank/absent metrics fail', () => {for (const key of ['rss_mb','heap_mb','uptime_sec','completed_age_ms','source_state','signal_age_ms']) {const r=rows();r[10][key]='';assert.equal(sum(r).verdict,'NOT_CONFIRMED');}});
test('restarts and uptime zero fail', () => {const r=rows();r.forEach((row,i)=>row.uptime_sec=String((i%10)*60));assert.equal(sum(r).workerVerdict,'NOT_CONFIRMED');});
test('worker health is independent of source failure', () => {const r=rows();r.forEach(row=>row.source_state='unavailable');assert.equal(sum(r).workerVerdict,'PASS');assert.equal(sum(r).sourceVerdict,'NOT_CONFIRMED');});
test('health endpoint failure and missing completed ticks fail', () => {for(const key of ['health_http','completed_age_ms']) {const r=rows();r.forEach(row=>row[key]=key==='health_http'?'503':'70000');assert.equal(sum(r).workerVerdict,'NOT_CONFIRMED');}});
test('memory windows are time based with uneven sampling', () => {
  const template=rows()[0], r=[];
  for(let t=0;t<=24*3600;t+=t<6*3600?30:60) r.push({...template,ts:new Date(start+t*1000).toISOString(),uptime_sec:String(100+t),rss_mb:t<6*3600?'100':'140'});
  assert.equal(sum(r).rssMedianFirst6h,100);assert.equal(sum(r).rssMedianLast6h,140);assert.equal(sum(r).workerVerdict,'NOT_CONFIRMED');
});
test('unknown source does not imply broken worker', () => {const r=rows();r.forEach(row=>row.source_state='');assert.equal(sum(r).workerVerdict,'PASS');assert.equal(sum(r).sourceVerdict,'NOT_CONFIRMED');});

test('actual duration, not row count controls outage', () => {const r=rows();for(let i=1;i<=4;i++) r[i].agent_http='503';assert.equal(sum(r).longestUnhealthyMin,5);assert.equal(sum(r).workerVerdict,'NOT_CONFIRMED');});
