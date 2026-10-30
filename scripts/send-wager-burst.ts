// Publica uma rajada de BETs de 1.00 na fila principal: PER_WALLET mensagens por wallet, uma wallet por MessageGroupId.
import { GetQueueUrlCommand, SendMessageBatchCommand, SQSClient } from '@aws-sdk/client-sqs';

const run = required('RUN');
const walletIds = required('WALLET_IDS').split(' ');
const playerIds = required('PLAYER_IDS').split(' ');
const perWallet = Number(process.env.PER_WALLET ?? '100');

const sqs = new SQSClient({
  region: process.env.AWS_REGION ?? 'us-east-1',
  endpoint: process.env.AWS_ENDPOINT_URL ?? 'http://localhost:4566',
  credentials: {
    accessKeyId: process.env.AWS_ACCESS_KEY_ID ?? 'test',
    secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY ?? 'test',
  },
});
const { QueueUrl } = await sqs.send(
  new GetQueueUrlCommand({ QueueName: process.env.SQS_WAGER_QUEUE_NAME ?? 'wager-transactions.fifo' }),
);

await Promise.all(
  walletIds.map(async (walletId, w) => {
    for (let start = 0; start < perWallet; start += 10) {
      const entries = Array.from({ length: Math.min(10, perWallet - start) }, (_, k) => {
        const externalTransactionId = `${run}-${w}-${start + k}`;
        return {
          Id: String(k),
          MessageGroupId: walletId,
          MessageDeduplicationId: externalTransactionId,
          MessageBody: JSON.stringify({
            messageId: `msg-${externalTransactionId}`,
            type: 'WagerTransactionRequested',
            occurredAt: new Date().toISOString(),
            data: {
              providerId: 'provider-a',
              externalTransactionId,
              idempotencyKey: `provider-a:${externalTransactionId}`,
              playerId: playerIds[w],
              walletId,
              roundId: 'round-1',
              gameId: 'fortune-chimp',
              kind: 'BET',
              money: { amount: '1.00', currency: 'BRL' },
            },
          }),
        };
      });
      const result = await sqs.send(new SendMessageBatchCommand({ QueueUrl, Entries: entries }));
      if (result.Failed?.length) {
        throw new Error(`Batch failed: ${JSON.stringify(result.Failed)}`);
      }
    }
  }),
);
sqs.destroy();
console.log(`sent ${walletIds.length * perWallet} messages`);

function required(name: string): string {
  const value = process.env[name];
  if (value === undefined || value === '') {
    throw new Error(`${name} is required`);
  }
  return value;
}
