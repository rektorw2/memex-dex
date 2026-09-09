#!/usr/bin/env bash
# Наблюдение за агентом ≥ 24 часов: одна строка CSV в минуту.
#
# Запускать с машины, у которой есть доступ к API (Mac владельца):
#   bash observe-24h.sh https://memex-api.onrender.com observe.csv
# Остановить — Ctrl+C. Проверить итог — bash summarize-24h.sh observe.csv
#
# Что пишется: время, HTTP-код /health, HTTP-код и state /health/agent,
# возраст последнего успешно завершённого прохода, серия ошибок,
# RSS/heap процесса (из ответа /health/agent после публикации),
# состояние источника сигналов и возраст последнего сигнала.
# Ничего не меняет, секретов не требует: оба маршрута публичные.
set -u
BASE="${1:-https://memex-api.onrender.com}"
OUT="${2:-observe.csv}"
if [ ! -f "$OUT" ]; then
  echo "ts,health_http,agent_http,state,reason,completed_age_ms,consecutive_failures,rss_mb,heap_mb,uptime_sec,source_state,source_code,signal_age_ms,queued" > "$OUT"
fi
while true; do
  ts=$(date -u +%Y-%m-%dT%H:%M:%SZ)
  h=$(curl -s -o /dev/null -w '%{http_code}' --max-time 20 "$BASE/health")
  body=$(curl -s --max-time 20 -w '\n%{http_code}' "$BASE/health/agent")
  code=$(printf '%s' "$body" | tail -n1)
  json=$(printf '%s' "$body" | sed '$d')
  line=$(printf '%s' "$json" | node -e '
    let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{
      try{const j=JSON.parse(s);const a=j.agent||{};const hb=a.heartbeat||{};const p=j.process||{};const src=j.source||{};
        console.log([j.state,j.reason,a.lastTickCompletedAgeMs??hb.lastTickCompletedAgeMs??"",a.consecutiveTickFailures??hb.consecutiveFailures??"",p.rssMb??"",p.heapUsedMb??"",p.uptimeSec??"",src.state??"",src.code??"",src.lastSignalAgeMs??"",a.queued??""].join(","));}
      catch{console.log(",,,,,,,,,,");}});' 2>/dev/null)
  echo "$ts,$h,$code,$line" >> "$OUT"
  sleep 60
done
