import fs from "fs/promises"
import os from "os"
import path from "path"
import { CredentialsService } from "src/modules/feed/modules/gtfs/fetch/credentials.service"
import { afterEach, beforeEach, describe, expect, it } from "vitest"

describe("CredentialsService", () => {
  let dir: string
  let service: CredentialsService
  const originalCredentialsDirectory = process.env.CREDENTIALS_DIRECTORY

  beforeEach(async () => {
    dir = await fs.mkdtemp(path.join(os.tmpdir(), "ttapi-credentials-"))
    service = new CredentialsService()
    delete process.env.CREDENTIALS_DIRECTORY
  })

  afterEach(async () => {
    await fs.rm(dir, { recursive: true, force: true })
    if (originalCredentialsDirectory === undefined) {
      delete process.env.CREDENTIALS_DIRECTORY
    } else {
      process.env.CREDENTIALS_DIRECTORY = originalCredentialsDirectory
    }
  })

  it("returns inline credentials untouched", async () => {
    await expect(
      service.resolve({ username: "user", password: "pass" }),
    ).resolves.toEqual({ username: "user", password: "pass" })
  })

  it("reads credentials from absolute paths", async () => {
    await fs.writeFile(path.join(dir, "u"), "file-user")
    await fs.writeFile(path.join(dir, "p"), "file-pass")

    await expect(
      service.resolve({
        usernameFile: path.join(dir, "u"),
        passwordFile: path.join(dir, "p"),
      }),
    ).resolves.toEqual({ username: "file-user", password: "file-pass" })
  })

  // `echo secret > file` is how these files get made in practice.
  it.each([
    ["trailing newline", "secret\n"],
    ["CRLF", "secret\r\n"],
    ["surrounding whitespace", "  secret  "],
  ])("trims %s", async (_label, contents) => {
    await fs.writeFile(path.join(dir, "p"), contents)

    const resolved = await service.resolve({
      username: "user",
      passwordFile: path.join(dir, "p"),
    })

    expect(resolved.password).toBe("secret")
  })

  it("resolves relative paths against CREDENTIALS_DIRECTORY", async () => {
    process.env.CREDENTIALS_DIRECTORY = dir
    await fs.writeFile(path.join(dir, "njt-username"), "systemd-user")

    const resolved = await service.resolve({
      usernameFile: "njt-username",
      password: "pass",
    })

    expect(resolved.username).toBe("systemd-user")
  })

  it("ignores CREDENTIALS_DIRECTORY for absolute paths", async () => {
    process.env.CREDENTIALS_DIRECTORY = "/nonexistent"
    await fs.writeFile(path.join(dir, "u"), "absolute-user")

    const resolved = await service.resolve({
      usernameFile: path.join(dir, "u"),
      password: "pass",
    })

    expect(resolved.username).toBe("absolute-user")
  })

  it("names the path when a file is missing", async () => {
    const missing = path.join(dir, "nope")

    await expect(
      service.resolve({ usernameFile: missing, password: "pass" }),
    ).rejects.toMatchObject({
      kind: "configuration",
      message: expect.stringContaining(missing),
    })
  })

  it("rejects an empty file", async () => {
    await fs.writeFile(path.join(dir, "empty"), "   \n")

    await expect(
      service.resolve({ usernameFile: path.join(dir, "empty"), password: "p" }),
    ).rejects.toMatchObject({
      kind: "configuration",
      message: expect.stringContaining("file is empty"),
    })
  })

  it("rejects when neither form is supplied", async () => {
    await expect(service.resolve({ username: "user" })).rejects.toMatchObject({
      kind: "configuration",
      message: expect.stringContaining("No password configured"),
    })
  })
})
