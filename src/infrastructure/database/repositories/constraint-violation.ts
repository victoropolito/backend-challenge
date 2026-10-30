import { UniqueConstraintViolationException } from '@mikro-orm/core';

/** Nome da constraint única violada, se `error` for uma violação de unicidade. */
export function violatedUniqueConstraint(error: unknown): string | undefined {
  if (!(error instanceof UniqueConstraintViolationException)) {
    return undefined;
  }
  return (error as UniqueConstraintViolationException & { constraint?: string }).constraint;
}
