import { Inject, Module, type OnApplicationBootstrap } from '@nestjs/common';
import { ApplicationModule } from '../application/application.module';
import { StructuredLogger } from '../infrastructure/observability/structured-logger';
import { AuthenticationGuard } from './auth/authentication.guard';
import { AllowAllAuthenticator, RequestAuthenticator } from './auth/request-authenticator';
import { MetricsController } from './metrics.controller';
import { WageringController } from './wagering.controller';
import { WalletsController } from './wallets.controller';

/**
 * Endpoints HTTP da API de wallets e transações, e o endpoint de métricas. A autenticação está desligada
 * (AllowAllAuthenticator); para ligá-la, troque o provider de RequestAuthenticator por um que valide a credencial.
 */
@Module({
  imports: [ApplicationModule],
  providers: [
    { provide: RequestAuthenticator, useClass: AllowAllAuthenticator },
    AuthenticationGuard,
  ],
  controllers: [WalletsController, WageringController, MetricsController],
})
export class ApiModule implements OnApplicationBootstrap {
  constructor(@Inject(RequestAuthenticator) private readonly authenticator: RequestAuthenticator) {}

  onApplicationBootstrap(): void {
    if (this.authenticator instanceof AllowAllAuthenticator) {
      new StructuredLogger('Auth').warn('Authentication disabled: every API request is accepted as anonymous');
    }
  }
}
