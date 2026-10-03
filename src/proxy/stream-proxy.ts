import http from "node:http"

export type Backend = {
  host: string
  port: number
}

type LiveStream = {
  reconnect(): void
  stop(): void
}

export type Proxy = {
  port: number
  switchBackend(backend: Backend): void
  close(): Promise<void>
}

// One client response stays open for the whole demo.
// switchBackend closes the upstream connection and opens a new one.
// The client does not get a second HTTP response.
export function startProxy(initial: Backend): Promise<Proxy> {
  let backend = initial
  const streams = new Set<LiveStream>()

  const server = http.createServer((request, response) => {
    if (request.url !== "/events") {
      response.writeHead(404)
      response.end()
      return
    }

    const stream = followBackend(response, () => backend)
    streams.add(stream)
    response.on("close", () => {
      stream.stop()
      streams.delete(stream)
    })
  })

  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      const address = server.address()
      if (address === null || typeof address === "string") {
        throw new Error("proxy did not receive a port")
      }
      resolve({
        port: address.port,
        switchBackend(next) {
          backend = next
          for (const stream of streams) {
            stream.reconnect()
          }
        },
        close() {
          for (const stream of streams) {
            stream.stop()
          }
          return new Promise((done, reject) => {
            server.close((error) => (error ? reject(error) : done()))
          })
        },
      })
    })
  })
}

function followBackend(client: http.ServerResponse, backend: () => Backend): LiveStream {
  client.writeHead(200, {
    "content-type": "application/x-ndjson",
    "cache-control": "no-cache",
  })

  let generation = 0
  let buffer = ""
  let upstream: http.ClientRequest | undefined
  let stopped = false

  function connect(): void {
    if (stopped) {
      return
    }
    const generationNow = ++generation
    buffer = ""
    const target = backend()
    const request = http.request(
      {
        host: target.host,
        port: target.port,
        path: "/events",
        method: "GET",
      },
      (incoming) => {
        incoming.setEncoding("utf8")
        incoming.on("data", (chunk: string) => {
          if (generationNow !== generation || stopped) {
            return
          }
          buffer += chunk
          const lines = buffer.split("\n")
          buffer = lines.pop() ?? ""
          for (const line of lines) {
            if (line.length === 0) {
              continue
            }
            client.write(`${line}\n`)
          }
        })
      },
    )
    request.on("error", () => {
      // Destroying the upstream during a switch is expected.
    })
    request.end()
    upstream = request
  }

  connect()

  return {
    reconnect() {
      upstream?.destroy()
      connect()
    },
    stop() {
      stopped = true
      generation += 1
      upstream?.destroy()
    },
  }
}
