import type { z } from 'zod';

export interface ValidationIssue {
  path: string;
  message: string;
}

/** Requisição malformada: campos ausentes, tipos errados ou formatos inválidos. */
export class RequestValidationError extends Error {
  readonly code = 'VALIDATION_ERROR';

  constructor(readonly issues: ValidationIssue[]) {
    super(`Invalid request: ${issues.map((issue) => `${issue.path}: ${issue.message}`).join('; ')}`);
    this.name = 'RequestValidationError';
  }
}

/** Valida `value` com `schema`; os caminhos dos erros são prefixados com `source` (body, query, params, headers). */
export function parseRequest<T extends z.ZodType>(schema: T, value: unknown, source: string): z.output<T> {
  const result = schema.safeParse(value);
  if (!result.success) {
    throw new RequestValidationError(
      result.error.issues.map((issue) => ({
        path: [source, ...issue.path.map(String)].join('.'),
        message: issue.message,
      })),
    );
  }
  return result.data;
}
