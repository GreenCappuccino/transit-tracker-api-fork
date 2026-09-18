import { Injectable, Logger } from "@nestjs/common"
import crypto from "crypto"
import fs from "fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"
import { PassThrough, Readable } from "node:stream"
import * as unzipper from "unzipper"
import { FetchConfig } from "../config"
import { FetchService } from "../fetch/fetch.service"
import { EmptyResponseBodyError, UpstreamHttpError } from "../gtfs.errors"

@Injectable()
export class ZipFileService {
  private readonly logger = new Logger(ZipFileService.name)

  constructor(private readonly fetchService: FetchService) {}

  /**
   * Downloads the archive and extracts it, returning the SHA-256 of the bytes
   * transferred.
   *
   * The hash is computed from the same stream that feeds the extractor, so it
   * costs one download rather than two. Callers whose transport cannot answer a
   * metadata probe use it to decide, after the fact, whether the contents
   * actually changed.
   */
  async downloadAndExtract(
    resource: FetchConfig,
    destinationPath: string,
  ): Promise<{ hash: string }> {
    const url = new URL(resource.url)
    if (url.hash !== "") {
      const subZipFileName = decodeURIComponent(url.hash.substring(1))
      url.hash = ""

      const parentZipTempPath = path.join(
        tmpdir(),
        `gtfs-parent-zip-${Date.now()}-${Math.random()
          .toString(36)
          .substring(2, 15)}`,
      )

      // The outer archive's hash is the identity of what we fetched, which is
      // what freshness should be judged on.
      const { hash } = await this.downloadAndExtract(
        {
          ...resource,
          url: url.toString(),
        },
        parentZipTempPath,
      )

      this.logger.log(`Extracting sub-zip file ${subZipFileName}`)

      const subZipFilePath = path.join(parentZipTempPath, subZipFileName)

      const archive = await unzipper.Open.file(subZipFilePath)
      await archive.extract({ path: destinationPath })

      await fs.rm(parentZipTempPath, { recursive: true, force: true })

      return { hash }
    }

    const response = await this.fetchService.fetch(
      { ...resource, url: url.toString() },
      { method: "GET" },
    )

    if (!response.ok) {
      throw new UpstreamHttpError(
        "GET",
        response.url,
        response.status,
        response.statusText,
      )
    }

    if (!response.body) {
      throw new EmptyResponseBodyError()
    }

    const nodeStream = Readable.fromWeb(response.body as any)
    const extractor = unzipper.Extract({ path: destinationPath })

    const hasher = crypto.createHash("sha256")
    const tap = new PassThrough()
    tap.on("data", (chunk) => hasher.update(chunk))

    await new Promise<void>((resolve, reject) => {
      let error: any = null
      const fail = (err: any) => {
        if (error) return
        error = err
        extractor.end()
        reject(err)
      }

      // Every stage needs an error handler. Without one on the source, a
      // connection reset mid-download leaves this promise pending forever
      // rather than failing the sync.
      nodeStream.on("error", fail)
      tap.on("error", fail)
      extractor.on("error", fail)

      extractor.on("close", () => {
        if (!error) {
          resolve()
        }
      })

      nodeStream.pipe(tap).pipe(extractor)
    })

    await this.flattenDirectory(destinationPath)

    return { hash: hasher.digest("hex") }
  }

  private async flattenDirectory(directory: string): Promise<void> {
    const subdirs = await fs.readdir(directory, {
      withFileTypes: true,
      recursive: false,
    })

    if (subdirs.length === 1 && subdirs[0].isDirectory()) {
      const dirName = subdirs[0].name

      this.logger.log(
        `Found single directory "${dirName}" in zip, flattening...`,
      )

      const singleDir = path.join(directory, dirName)
      const files = await fs.readdir(singleDir)
      for (const file of files) {
        await fs.rename(path.join(singleDir, file), path.join(directory, file))
      }
      await fs.rmdir(singleDir)
    }
  }
}
