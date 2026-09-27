#!/bin/zsh
# R9 对局的落库侧证：真人座位（seat 0）的搜证选择、线索公开/私藏结果、投票与结算。
# 只读查询；连接串取自 .e2e/up.json（隔离 e2e 库），不打印座位 token。
# 用法：node scripts/e2e/up.mjs 之后 zsh scripts/e2e/db-proof.sh <gameId> [...]
set -e
cd "$(dirname "$0")/../.."
[[ -f .e2e/up.json ]] || { echo "缺少 .e2e/up.json：先跑 npm run e2e:up（e2e:down 会删掉它）" >&2; exit 1; }
DB=$(node -e "process.stdout.write(JSON.parse(require('fs').readFileSync('.e2e/up.json','utf8')).db)")
for G in $@; do
  if ! [[ $G =~ ^[0-9a-z]{8,40}$ ]]; then echo "跳过非法 gameId: $G" >&2; continue; fi
  echo "=== game $G ==="
  psql $DB -At -c "select 'choose|seq'||seq||'|r'||round||'|'||split_part(split_part(content::text,'「',2),'」',1) from game_events where \"gameId\"='$G' and type='system' and visibility='seat:0' and content::text like '%你选择了%' order by seq;"
  psql $DB -At -c "
  select 'clue|seq'||e.seq||'|r'||e.round||'|'||coalesce(e.content::jsonb->>'clueName','?')||'|公开次数='||(
    select count(*) from game_events p where p.\"gameId\"=e.\"gameId\" and p.type='clue' and p.visibility='public'
      and p.content::jsonb->>'clueId'=e.content::jsonb->>'clueId')
  from game_events e where e.\"gameId\"='$G' and e.type='clue' and e.visibility='seat:0' order by e.seq;"
  psql $DB -At -c "select 'notice|'||type||'|'||visibility||'|'||count(*)||'条/'||count(distinct content::text)||'种文案 from game_events where \"gameId\"='$G' and content::text like '%尚未绑定模型%' group by 1,2;"
  psql $DB -At -c "select 'vote|seat'||\"seatIndex\"||'->'||\"targetIndex\"||'|'||left(coalesce(reason,''),16) from votes where \"gameId\"='$G' order by \"seatIndex\";"
  psql $DB -At -c "select 'state|'||phase||'|r'||round||'|'||status||'|'||coalesce(state::jsonb->>'voteResult','null') from games where id='$G';"
done
