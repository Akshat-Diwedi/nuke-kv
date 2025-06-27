## NukeKV ☢️ - A High-Performance Key-Value Store

Welcome to NukeKV, a lightweight, fast, and persistent key-value database server written in C++. It communicates via a custom, high-performance raw TCP protocol called **`nuke-wire`**, making it an exceptionally low-latency solution. This version includes **Advanced JSON Functionality**, allowing for complex CRUD operations and list manipulations inside your stored data.

**Supports**: Windows, Linux, MacOS.

### Features

*   **Cross-Platform:** Compiles and runs on Windows, macOS, and Linux.
*   **Blazing Fast:** Built in C++ with a multi-threaded, asynchronous core. The `nuke-wire` protocol eliminates HTTP overhead for maximum throughput.
*   **Graceful Restarts:** The server can be immediately restarted without "Bind failed" errors, making it reliable in production and development environments.
*   **Massive Payload Support:** The `nuke-wire` protocol is engineered to handle individual requests and responses well over 512MB in size.
*   **Ephemeral Stress Testing:** The `STRESS` command is a pure in-memory benchmark that **does not write to disk** and cleans up after itself perfectly.
*   **User-Friendly Startup:** Intelligently fetches and displays your public IP for easy client configuration.
*   **Human-Readable Persistence:** Saves data to a formatted `nukekv.db` file and reloads it on startup.
*   **Rich Data Types:** Supports standard string values and powerful native JSON objects and arrays.
*   **Advanced JSON Queries:** Filter, update, search, delete, and append to JSON arrays using intuitive syntax.
*   **Zero Dependencies:** The final compiled server runs as a single, portable executable.

---
  
### Compiling the code :

- Just `fork/clone` the repo first then in your machine's terminal - run the following commands according to your Operating System given below ⬇️ .
  
#### *For windows users :*

```powershell
# Install g++ via MSYS2 or another package manager.
# The -lpsapi flag is required for memory usage statistics.
g++ -std=c++17 -O2 -Ilibs -o nukekv-server.exe server.cpp -static -lpthread -lws2_32 -lwsock32 -lpsapi

# Run the server
.\nukekv-server.exe
```

#### *For Linux (Ubuntu, Debian, etc.) or macOS Users :*

```bash
# Install compiler if you don't have it
# sudo apt-get update && sudo apt-get install -y g++ (On Debian/Ubuntu)
g++ -std=c++17 -O2 -Ilibs -o nukekv-server server.cpp -lpthread

# Run the server
./nukekv-server
```

### Client ⚡

To connect to and query your server, use the provided `client.js` application. Make sure Node.js is installed. Update the `host` in `client.js` to your server's IP address (the server will display its public IP on startup) and run the client:

```bash
node client.js
```

---

### Command Reference

### Server & Diagnostics

| Command               | Description                                                            |
| :-------------------- | :--------------------------------------------------------------------- |
| `PING`                | Returns `+PONG`. Useful for checking if the server is responsive.      |
| `DEBUG <true\|false>` | Enables or disables performance logging for each command.              |
| `STATS`               | Shows detailed statistics about the server's state and performance.    |
| `STRESS <count>`      | Runs a benchmark with `<count>` ops. **This is non-persistent and will not affect the database file.** |
| `CLRDB` | **New!** Deletes all keys and values from the database. |
| `QUIT`                | Instructs the server to perform a final save and shut down gracefully. |

### Basic Key-Value Commands

| Command | Description |
| :--- | :--- |
| `SET <key> "<value>"` | Sets a key to a string value. |
| `SET <key> "<value>" EX <seconds>` | Sets a key with an automatic expiration time. |
| `GET <key>` | Retrieves the value of a key. Returns `(nil)` if not found. |
| `UPDATE <key> "<new_value>"` | Updates the value of an *existing* key. Fails if the key doesn't exist. |
| `DEL <key> [key2...]` | Deletes one or more keys. Returns the count of deleted keys. |
| `INCR <key> [amount]` | Increments a numeric key by 1 or by a given `amount`. |
| `DECR <key> [amount]` | Decrements a numeric key by 1 or by a given `amount`. |
| `TTL <key>` | Gets the remaining time-to-live of a key in seconds. Returns `-1` if no TTL. |
| `EXPIRE <key> <seconds>` | Sets or updates the TTL for an existing key. |
| `SIMILAR <prefix>` | **New!** Returns the number of keys that start with the given prefix. |

---

### Advanced JSON Commands

NukeKV supports storing **any valid JSON**, including arrays of objects, and provides powerful tools to query and manipulate them. Keywords like `WHERE` and `SET` are case-insensitive.

| Command | Description |
| :--- | :--- |
| `JSON.SET <key> '<json_string>'` | Sets a key to any valid JSON. |
| `JSON.GET <key>` | Retrieves the entire JSON document, pretty-printed. |
| `JSON.GET <key> WHERE <field> <value>`| Filters a JSON array, returning only objects where `<field>` equals `<value>`. |
| `JSON.UPDATE <key> WHERE <f> <v> SET <f1> <v1>...`| Updates one or more fields in objects that match the `WHERE` clause. |
| `JSON.SEARCH <key> "<term>"`| Performs a text search and returns the first matching object. |
| `JSON.DEL <key> WHERE <field> <value>` | Deletes objects from a JSON array where `<field>` matches `<value>`. |
| `JSON.APPEND <key> <f1> <v1> ...` | Appends a new object, built from key-value pairs, to a JSON array. |

#### **Complete JSON Workflow Example**

Let's use a product catalog stored in the key `products`.

**1. Set an initial JSON array:**
```
JSON.SET products '[{"id":1,"name":"Smartphone X23","stock":50}]'
```

**2. Append a new product to the array:**
```
JSON.APPEND products id 2 name "Laptop ProBook" stock 20
```

**3. Get a specific product using `WHERE`:**
```
JSON.GET products WHERE id 2
```

**4. Update a product's stock using `WHERE` and `SET`:**
```
JSON.UPDATE products WHERE name "Laptop ProBook" SET stock 15
```

**5. Conditionally delete the smartphone from the catalog:**
```
JSON.DEL products WHERE id 1
```

**6. Verify the final state of the catalog:**
```
JSON.GET products
```
---
  
## Diagnostics Output 🩹✨

### STATS

The `STATS` command provides a real-time snapshot of the server.
  
**Example Command:**
```
> STATS
```

**Example Output:**
```
Version: NukeKV v2.0-nukewire ☢️
Protocol: nuke-wire (raw TCP)
Debug Mode: ON
Worker Threads: 7
Persistence: Enabled
  - Batch Size: 1
  - Unsaved Ops: 0
Caching: Enabled
  - Memory Limit: Unlimited
  - Memory Used: 212 B
Total Keys: 1
Keys with TTL: 0
```

### STRESS
  
The `STRESS` command benchmarks the core performance of the database without affecting saved data.

**Example Command:**
```
> STRESS 1000000
```
  
**Example Output:**
```
Stress Test running for 1000000 ops (in-memory only)...
-------------------------------------------
SET:        823534.13 ops/sec (1.214s total)
UPDATE:    1813144.56 ops/sec (551.53ms total)
GET:       2361762.58 ops/sec (423.41ms total)
DEL:       1499790.07 ops/sec (666.76ms total)
-------------------------------------------
MAX RAM USAGE: 137.66 MB
Total Stress Test Time: 2.938s
```

---

**`note`**: The above `STRESS` command's output is a real benchmark. We ran this test on a Google Cloud Compute Engine `E2` instance with `2 vCPU`, `1 Core`, & `4GB RAM`. The command `STRESS 1000000` runs 1 million operations for *each* of the 4 commands (SET, UPDATE, GET, DEL), totaling 4 million operations in a single run.