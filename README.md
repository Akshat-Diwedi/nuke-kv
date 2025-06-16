# Nuke-KV : High Performance Key-Value Store

## Overview

NukeKV is a high-performance Redis-like key-value store built with Node.js. 

we achieved significant performance improvements beyond : `200K-700K` ops/sec - ( operations per second )

`NOTE:` This is the first version so we did not added that much things to it. but in next major version you'll be seeing the best out of it ⚡☢️

## Performance Optimizations

The optimized version includes the following improvements:

1. **Pipelining**: Commands are batched and sent together to reduce network overhead
2. **LRU Cache**: Efficient in-memory caching with least-recently-used eviction policy
3. **Batch Processing**: Operations are processed in batches for higher throughput
4. **Worker Threads**: Parallel processing using Node.js worker threads
5. **Reduced Disk I/O**: Optimized persistence with batched writes and dirty tracking
6. **Cluster Mode**: Multi-process stress testing using all available CPU cores

## Files

- `db.js`: Database implementation with LRU cache and batch processing.
- `server.js`: Server with command pipelining and improved request handling.
- `worker.js`: Worker thread implementation for parallel processing.
- `stress.js`: Multi-threaded stress testing tool.

## Usage

For a detailed guide on all available commands, their syntax, and examples, please see the **[Nuke-KV Command Guide](./examples/guide/README.md)**.


### Starting the Server

```bash
node server.js
```

### Connecting with the Client

```bash
node client.js
```

### Available Commands

Nuke-KV supports a variety of commands for data manipulation and server management. For a comprehensive list and detailed explanations, refer to the **[Nuke-KV Command Guide](./examples/guide/README.md)**.

Here's a brief overview as listed in the guide:

*   **PING**: Checks if the server is responsive.
*   **SET `<key> <value> [EX <seconds>]`**: Sets the string value of a key. Optionally, an expiration time (TTL) in seconds can be provided.
*   **GET `<key>`**: Gets the value of a key.
*   **DEL `<key>`**: Deletes a key.
*   **TTL `<key>`**: Gets the remaining time to live of a key.
*   **SAVE**: Manually saves the current database state to disk.
*   **STATS**: Provides server statistics.
*   **JSON.SET `<key> <json_value | field> [value] [EX <seconds>]`**: Sets a JSON object or a field within a JSON object.
*   **JSON.GET `<key> [fields...]`**: Retrieves a JSON object or specific fields.
*   **JSON.DEL `<key> [field]`**: Deletes a JSON object or a specific field within it.
*   **JSON.PRETTY `<key>`**: Retrieves and pretty-prints a JSON object.
*   **CLRCACHE**: Clears the in-memory cache.
*   **HELP**: Displays a help message.
*   **QUIT**: Closes the connection.



- **`SET key value [EX seconds]`**: Set key to value with optional expiration.
  - Example: `SET mykey myvalue`
  - Example with expiration: `SET mykey myvalue EX 60` (expires in 60 seconds)
- **`GET key`**: Get value of key.
  - Example: `GET mykey`
- **`DEL key`**: Delete key.
  - Example: `DEL mykey`
- **`TTL key`**: Get time-to-live of key in seconds. Returns -1 if the key exists but has no associated expire, and -2 if the key does not exist.
  - Example: `TTL mykey`
- **`SAVE`**: Force save to disk.
  - Example: `SAVE`
- **`STATS`**: Show database statistics (e.g., total keys, memory usage).
  - Example: `STATS`

- **`PING`**: Test server connection. Returns "PONG" if successful.
  - Example: `PING`
- **`QUIT`**: Close connection.
  - Example: `QUIT`
- **`STRESS`**: Run the client-side stress test using settings from `stress.js`.
  - Example: `STRESS` (run from `client.js`)
- **`CLRCACHE`**: Clears the in-memory cache (LRU cache, TTL map, pending writes/deletes).
  - Example: `CLRCACHE`

## Performance Benchmarking

The optimized version can achieve **up to 852,286 OPS/SEC** (operations per second) with a batch size of 200 on suitable hardware. To run a benchmark:

1. Start the server: `node server.js`
2. In a separate terminal, run the client: `node client.js`
3. In the client, type `STRESS` to run the stress test as configured in `stress.js`.

The stress test will:

1. Use multiple worker processes (one per CPU core)
2. Pre-generate test data to avoid generation overhead
3. Use pipelining to send commands in batches
4. Report detailed performance metrics

Alternatively, you can directly run the stress test script:

```bash
node stress.js
```

## Implementation Details

### LRU Cache

The optimized database uses an LRU (Least Recently Used) cache to efficiently manage memory. When the cache reaches its maximum size, the least recently used items are evicted first.

### Batch Processing

Commands are processed in batches to reduce overhead. The `processBatch` function in `db.js` handles multiple operations at once.

### Worker Threads

CPU-intensive tasks are offloaded to worker threads to avoid blocking the main event loop. The `WorkerPool` class in `db.js` manages a pool of worker threads.

### Optimized Persistence

The persistence mechanism has been optimized to:

1. Only save changes since the last save
2. Batch writes to reduce disk I/O
3. Use a dirty flag to track when changes need to be saved
4. Save periodically instead of after every operation

### Command Pipelining

The server supports command pipelining through the `CommandQueue` class in `server.js`. Commands are queued and processed in batches to reduce overhead.

## Comparison with Original Version

| Feature | Original Version ( not in Github ) | Optimized Version |
|---------|-----------------|-------------------|
| Operations per second | 30-45 | Up to 852,286 (with batch size 200) |
| Memory efficiency | Basic | LRU Cache |
| Persistence | After each operation | Batched with dirty tracking |
| Parallelism | None | Worker threads |
| Command processing | One at a time | Batched operations |
| Stress testing | Single process | Multi-core cluster |

## System Requirements

- Node.js 14.x or higher
- Multi-core CPU (for optimal performance)
- Sufficient RAM for in-memory data storage