#!/usr/bin/env bash
# Valida o shutdown gracioso com SIGTERM real: sobe a app num container Linux, enche a fila, para o container no
# meio do processamento e confere que nenhuma mensagem foi perdida nem aplicada duas vezes, antes e depois do restart.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

BUN="${BUN:-npx -y bun@1}"
WALLETS="${WALLETS:-5}"
PER_WALLET="${PER_WALLET:-100}"
STOP_AFTER="${STOP_AFTER:-1}"
PORT="${PORT:-3001}"
NAME="${NAME:-wagering-sigterm}"
TOTAL=$((WALLETS * PER_WALLET))
RUN="sigterm-$(date +%s)"

psql() { docker compose exec -T postgres psql -U wagering -d wagering -tAc "$1"; }
awslocal() { docker compose exec -T localstack awslocal "$@"; }
consumer_logs() { docker logs "$NAME" 2>&1 | sed 's/\x1b\[[0-9;]*m//g' | grep -E '"context":"WagerTransactionConsumer"|"level":"error"' | tail -"$1"; }
cleanup() { docker rm -f -v "$NAME" >/dev/null 2>&1 || true; }
trap cleanup EXIT

wait_ready() {
  for _ in $(seq 1 180); do
    if curl -sf "localhost:$PORT/health/ready" >/dev/null; then
      return 0
    fi
    if [ "$(docker inspect -f '{{.State.Running}}' "$NAME")" != "true" ]; then
      echo "!! o container parou ao subir:" && docker logs "$NAME" 2>&1 | tail -20 && exit 1
    fi
    sleep 1
  done
  echo "!! a app não ficou pronta em 180 s:" && docker logs "$NAME" 2>&1 | tail -20 && exit 1
}

counts() {
  psql "
    with tx as (select wallet_id, count(*) as n from wager_transactions
                where external_transaction_id like '$RUN-%' group by wallet_id)
    select concat_ws(' ',
      (select coalesce(sum(n), 0) from tx),
      (select count(*) from wallet_ledger_entries l join wager_transactions t on t.id = l.transaction_id
       where t.external_transaction_id like '$RUN-%'),
      (select count(*) from inbox_messages where message_id like 'msg-$RUN-%'),
      (select count(*) from wallets w join tx on tx.wallet_id = w.id where w.balance <> 1000 - tx.n))"
}

FAILURES=0
expect_consistent() {
  read -r processed ledger inbox wrong <<<"$(counts)"
  echo "   transações=$processed ledger=$ledger inbox=$inbox wallets_com_saldo_errado=$wrong"
  if [ "$processed" != "$ledger" ] || [ "$processed" != "$inbox" ] || [ "$wrong" != "0" ]; then
    echo "!! inconsistente" && FAILURES=$((FAILURES + 1))
  fi
  if [ -n "${1:-}" ] && [ "$processed" != "$1" ]; then
    echo "!! esperado $1 transações" && FAILURES=$((FAILURES + 1))
  fi
}

echo "== subindo a app num container Linux (porta $PORT)"
cleanup
MSYS_NO_PATHCONV=1 docker run -d --init --name "$NAME" -p "$PORT:3000" \
  --add-host host.docker.internal:host-gateway \
  -v "$ROOT:/app" -v /app/node_modules -w /app \
  -e DATABASE_URL=postgresql://wagering:wagering@host.docker.internal:5432/wagering \
  -e AWS_ENDPOINT_URL=http://host.docker.internal:4566 \
  -e AWS_ACCESS_KEY_ID=test -e AWS_SECRET_ACCESS_KEY=test \
  -e SQS_CONSUMER_WAIT_TIME_SECONDS=2 \
  oven/bun:1 sh -c 'bun install --frozen-lockfile >/dev/null && exec bun src/main.ts' >/dev/null
wait_ready

WALLET_IDS=()
PLAYER_IDS=()
for i in $(seq 1 "$WALLETS"); do
  player="$RUN-player-$i"
  response=$(curl -sf -X POST "localhost:$PORT/wallets" -H 'content-type: application/json' \
    -d "{\"playerId\":\"$player\",\"initialBalance\":{\"amount\":\"1000.00\",\"currency\":\"BRL\"}}")
  WALLET_IDS+=("$(sed -E 's/.*"id":"([^"]+)".*/\1/' <<<"$response")")
  PLAYER_IDS+=("$player")
done
echo "== $WALLETS wallets com 1000.00 criadas (execução $RUN); publicando $TOTAL BETs de 1.00"
RUN="$RUN" PER_WALLET="$PER_WALLET" WALLET_IDS="${WALLET_IDS[*]}" PLAYER_IDS="${PLAYER_IDS[*]}" \
  $BUN run scripts/send-wager-burst.ts

sleep "$STOP_AFTER"
read -r before _ <<<"$(counts)"
echo "== docker stop (SIGTERM) com $before/$TOTAL processadas"
started=$(date +%s%N)
docker stop -t 30 "$NAME" >/dev/null
elapsed=$(( ($(date +%s%N) - started) / 1000000 ))
exit_code=$(docker inspect -f '{{.State.ExitCode}}' "$NAME")
echo "   o container parou em ${elapsed} ms com exit code $exit_code"
if [ "$exit_code" != "143" ]; then
  echo "!! esperado 143 (saída pelo SIGTERM); 137 = morto por SIGKILL depois do timeout" && FAILURES=$((FAILURES + 1))
fi
consumer_logs 3 | sed 's/^/   /'

echo "== estado logo depois do SIGTERM"
expect_consistent

echo "== reiniciando o container"
docker start "$NAME" >/dev/null
wait_ready
for _ in $(seq 1 120); do
  read -r processed _ <<<"$(counts)"
  [ "$processed" -ge "$TOTAL" ] && break
  sleep 1
done
sleep 2

echo "== estado depois do restart"
expect_consistent "$TOTAL"
queue=$(awslocal sqs get-queue-attributes \
  --queue-url http://localhost:4566/000000000000/wager-transactions.fifo \
  --attribute-names ApproximateNumberOfMessages ApproximateNumberOfMessagesNotVisible \
  --query 'Attributes.[ApproximateNumberOfMessages,ApproximateNumberOfMessagesNotVisible]' --output text | tr -s '\t\r' ' ')
echo "   fila principal (visíveis, em processamento): $queue"

if [ "$FAILURES" -eq 0 ]; then
  echo "== OK: nenhuma mensagem perdida ou aplicada duas vezes"
else
  echo "== FALHOU: $FAILURES verificação(ões)" && exit 1
fi
