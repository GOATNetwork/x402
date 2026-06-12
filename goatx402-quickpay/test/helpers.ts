export function jsonResponse(body: unknown, status = 200): Response {
  const text = JSON.stringify(body)
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: new Headers(),
    json: async () => JSON.parse(text),
    text: async () => text,
  } as unknown as Response
}

export interface FetchCall {
  url: string
  init?: RequestInit
}

/** recordingFetch returns a fetch-shaped function plus a log of the calls made. */
export function recordingFetch(handler: (url: string, init?: RequestInit) => Response | Promise<Response>) {
  const calls: FetchCall[] = []
  const fn = (async (input: unknown, init?: RequestInit) => {
    const url = typeof input === 'string' ? input : (input as URL).toString()
    calls.push({ url, init })
    return handler(url, init)
  }) as unknown as typeof fetch
  return { fetch: fn, calls }
}
