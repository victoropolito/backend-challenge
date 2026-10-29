#!/bin/bash
# Cria a fila principal FIFO e sua DLQ.
set -euo pipefail

MAIN_QUEUE="wager-transactions.fifo"
DLQ_QUEUE="wager-transactions-dlq.fifo"
MAX_RECEIVE_COUNT=5

DLQ_URL=$(awslocal sqs create-queue \
  --queue-name "$DLQ_QUEUE" \
  --attributes FifoQueue=true,ContentBasedDeduplication=false \
  --query QueueUrl --output text)

DLQ_ARN=$(awslocal sqs get-queue-attributes \
  --queue-url "$DLQ_URL" \
  --attribute-names QueueArn \
  --query Attributes.QueueArn --output text)

ATTRIBUTES=$(python3 -c '
import json, sys
dlq_arn, max_receive = sys.argv[1], sys.argv[2]
print(json.dumps({
    "FifoQueue": "true",
    "ContentBasedDeduplication": "false",
    "VisibilityTimeout": "30",
    "RedrivePolicy": json.dumps({"deadLetterTargetArn": dlq_arn, "maxReceiveCount": max_receive}),
}))
' "$DLQ_ARN" "$MAX_RECEIVE_COUNT")

awslocal sqs create-queue --queue-name "$MAIN_QUEUE" --attributes "$ATTRIBUTES" >/dev/null

echo "SQS ready: $MAIN_QUEUE -> $DLQ_QUEUE (maxReceiveCount=$MAX_RECEIVE_COUNT)"
