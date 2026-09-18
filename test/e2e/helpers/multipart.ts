/**
 * A minimal multipart/form-data field parser, enough for the fake NJ TRANSIT
 * server.
 *
 * Express has no multipart parser and pulling one in for a handful of string
 * fields is more dependency than this warrants. It also earns its keep as an
 * assertion: a urlencoded or JSON body simply will not parse here, so if the
 * client ever stops sending real multipart the e2e tests fail loudly rather
 * than passing for the wrong reason.
 */
export function parseMultipartFields(
  body: Buffer,
  contentType: string | undefined,
): Record<string, string> {
  const boundaryMatch = /boundary=(?:"([^"]+)"|([^;]+))/i.exec(
    contentType ?? "",
  )
  if (!boundaryMatch) {
    throw new Error(`not a multipart body: content-type was "${contentType}"`)
  }

  const boundary = `--${boundaryMatch[1] ?? boundaryMatch[2]}`.trim()
  const fields: Record<string, string> = {}

  for (const part of body.toString("binary").split(boundary)) {
    if (part === "" || part.startsWith("--")) {
      continue
    }

    // Headers and body are separated by a blank line.
    const separator = part.indexOf("\r\n\r\n")
    if (separator === -1) {
      continue
    }

    const headers = part.slice(0, separator)
    const name = /name="([^"]+)"/i.exec(headers)?.[1]
    if (!name) {
      continue
    }

    // Trailing CRLF belongs to the boundary that follows, not the value.
    fields[name] = Buffer.from(
      part.slice(separator + 4).replace(/\r\n$/, ""),
      "binary",
    ).toString("utf-8")
  }

  return fields
}
