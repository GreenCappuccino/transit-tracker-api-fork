import { Inject, Injectable } from "@nestjs/common"
import { DomainError } from "src/errors/domain-error"
import type { AuthConfig } from "../../config"
import { AUTH_STRATEGIES, type AuthStrategy } from "./auth-strategy.interface"

class UnknownAuthProviderError extends DomainError {
  readonly kind = "configuration"

  constructor(provider: string) {
    super(`No authentication strategy registered for provider "${provider}"`, {
      provider,
    })
  }
}

@Injectable()
export class AuthStrategyRegistry {
  private readonly strategies: Map<string, AuthStrategy>

  constructor(@Inject(AUTH_STRATEGIES) strategies: AuthStrategy[]) {
    this.strategies = new Map(strategies.map((s) => [s.provider, s]))
  }

  get(provider: AuthConfig["provider"]): AuthStrategy {
    const strategy = this.strategies.get(provider)
    if (!strategy) {
      // Unreachable through config, which zod validates against the same set of
      // providers, but a registration that is added to one and not the other
      // should say so plainly rather than crash somewhere downstream.
      throw new UnknownAuthProviderError(provider)
    }

    return strategy
  }
}
