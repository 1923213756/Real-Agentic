#!/bin/bash
# 卡死抓现场：找到高 CPU 的子 CLI，dump 它崩溃前的日志尾部
echo "=== 高 CPU (>50%) 的子 CLI ==="
hit=0
for c in $(pgrep -f "\-\-session-id"); do
  cpu=$(ps -o %cpu= -p $c | tr -d ' ')
  [ -z "$cpu" ] && continue
  # 整数比较
  if [ "${cpu%.*}" -ge 50 ] 2>/dev/null; then
    hit=1
    sid=$(ps -o command= -p $c | grep -oE "session_[a-f0-9]+" | head -1)
    safe=$(echo "$sid" | tr -c 'a-zA-Z0-9_-' '_')
    echo "  ⚠️ pid=$c cpu=${cpu}% session=$sid"
    log=$(ls -t /tmp/claude/bridge-session-*"${safe#session_}"*.log 2>/dev/null | head -1)
    [ -z "$log" ] && log=$(ls -t /tmp/claude/bridge-session-*.log 2>/dev/null | head -1)
    if [ -n "$log" ]; then
      echo "  --- 日志: $log（最后 40 行）---"
      tail -40 "$log"
      echo "  --- 保存副本到 /tmp/claude/WEDGE-${safe}-$(date +%H%M%S).log ---"
      cp "$log" "/tmp/claude/WEDGE-${safe}-$(date +%H%M%S).log"
    else
      echo "  （没找到对应 log，可能 USER_TYPE=ant 没生效）"
    fi
  fi
done
[ $hit -eq 0 ] && echo "  当前没有卡死的子进程（一切正常）"
