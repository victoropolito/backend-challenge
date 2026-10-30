/** Fonte do instante atual para os casos de uso. */
export abstract class Clock {
  abstract now(): Date;
}
