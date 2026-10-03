import { startApi } from "./api/server.ts"
import { MemoryWorkers } from "./migrate/memory-workers.ts"

const api = await startApi(new MemoryWorkers())
console.log(`http://127.0.0.1:${api.port}/`)
