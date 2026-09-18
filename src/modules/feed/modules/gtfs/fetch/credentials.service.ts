import { Injectable } from "@nestjs/common"
import fs from "fs/promises"
import path from "path"
import type { CredentialFields } from "../config"
import { CredentialFileError, MissingCredentialError } from "./fetch.errors"

export interface ResolvedCredentials {
  username: string
  password: string
}

@Injectable()
export class CredentialsService {
  /**
   * Resolves the credential pair, reading files where the config names a path
   * rather than a value.
   *
   * Deliberately uncached, and deliberately not read at startup. Logins happen
   * a handful of times per day, so the file IO is free; in exchange a rotated
   * secret takes effect on the next login with no restart, and a secret mount
   * that lands after the process starts is not a permanent failure.
   */
  async resolve(fields: CredentialFields): Promise<ResolvedCredentials> {
    const [username, password] = await Promise.all([
      this.resolveOne("username", fields.username, fields.usernameFile),
      this.resolveOne("password", fields.password, fields.passwordFile),
    ])

    return { username, password }
  }

  private async resolveOne(
    field: string,
    inline: string | undefined,
    file: string | undefined,
  ): Promise<string> {
    if (inline !== undefined) {
      return inline
    }

    if (file === undefined) {
      throw new MissingCredentialError(field)
    }

    const filePath = this.resolvePath(file)

    let contents: string
    try {
      contents = await fs.readFile(filePath, "utf-8")
    } catch (err: any) {
      throw new CredentialFileError(field, filePath, err.message)
    }

    // Trimmed because `echo secret > file` leaves a trailing newline, and an
    // upstream will reject the credential with something far less obvious than
    // "your password has a newline in it".
    const trimmed = contents.trim()
    if (trimmed === "") {
      throw new CredentialFileError(field, filePath, "file is empty")
    }

    return trimmed
  }

  /**
   * Relative paths resolve against $CREDENTIALS_DIRECTORY when systemd has set
   * it, which is what makes `LoadCredential=njt-username:/etc/...` work with a
   * config that simply says `usernameFile: njt-username`.
   *
   * Absolute paths bypass it, so bind-mounted Docker secrets keep working.
   */
  private resolvePath(filePath: string): string {
    if (path.isAbsolute(filePath)) {
      return filePath
    }

    const credentialsDirectory = process.env.CREDENTIALS_DIRECTORY
    return credentialsDirectory
      ? path.resolve(credentialsDirectory, filePath)
      : path.resolve(filePath)
  }
}
