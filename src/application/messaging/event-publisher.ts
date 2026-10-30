import type { OutboxMessage } from '../../domain/messaging/outbox-message';

/** Publica eventos da outbox no destino externo (porta da aplicação; a implementação fica na infraestrutura). */
export abstract class EventPublisher {
  /**
   * Publica as mensagens e devolve as que o destino recusou, com o motivo; as demais foram aceitas. Lança quando nada
   * pôde ser publicado (destino fora do ar, timeout).
   */
  abstract publish(messages: readonly OutboxMessage[]): Promise<Map<string, string>>;
}
