import { Clock } from '../../application/shared/clock';

/** Relógio do sistema. */
export class SystemClock extends Clock {
  now(): Date {
    return new Date();
  }
}
