import { randomUUIDv7 } from 'bun';
import { IdGenerator } from '../../application/shared/id-generator';

/** Ids UUIDv7: ordenáveis pelo instante de criação, o que mantém os índices B-tree compactos. */
export class UuidV7Generator extends IdGenerator {
  next(): string {
    return randomUUIDv7();
  }
}
