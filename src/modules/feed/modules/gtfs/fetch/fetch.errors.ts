import { DomainError } from "src/errors/domain-error"

export class CredentialFileError extends DomainError {
  readonly kind = "configuration"

  constructor(
    readonly field: string,
    readonly filePath: string,
    readonly reason: string,
  ) {
    super(`Could not read ${field} from "${filePath}": ${reason}`, {
      field,
      filePath,
      reason,
    })
  }
}

export class MissingCredentialError extends DomainError {
  readonly kind = "configuration"

  constructor(readonly field: string) {
    super(`No ${field} configured`, { field })
  }
}

/**
 * The upstream rejected the token we presented. Callers may re-authenticate
 * once in response to this; they must not do so for any other failure, or an
 * upstream outage will burn the daily login budget.
 */
export class TokenRejectedError extends DomainError {
  readonly kind = "upstream"

  constructor(
    readonly provider: string,
    readonly detail: string,
  ) {
    super(`${provider} rejected the access token: ${detail}`, {
      provider,
      detail,
    })
  }
}

export class TokenBudgetExhaustedError extends DomainError {
  readonly kind = "unavailable"

  constructor(
    readonly provider: string,
    message: string,
    context: Record<string, unknown> = {},
  ) {
    super(message, { provider, ...context })
  }
}

export class AuthUpstreamError extends DomainError {
  readonly kind = "upstream"

  constructor(
    readonly provider: string,
    readonly operation: string,
    readonly detail: string,
    context: Record<string, unknown> = {},
  ) {
    super(`${provider} ${operation} failed: ${detail}`, {
      provider,
      operation,
      detail,
      ...context,
    })
  }
}
