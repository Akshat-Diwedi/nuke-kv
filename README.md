## NukeKV ☢️ - A High-Performance Key-Value Store

Welcome to NukeKV, a lightweight, fast, and persistent key-value database server written in modern C++. It communicates via a custom, high-performance raw TCP protocol called **`Nuke-Wire`**, making it an exceptionally low-latency solution. This version includes **Advanced JSON Functionality**, allowing for complex CRUD operations and list manipulations inside your stored data.

**Supports**: Windows, Linux, MacOS.

### Features

*   **Cross-Platform:** Compiles and runs on Windows, macOS, and Linux.
*   **Blazing Fast:** Built in C++ with a multi-threaded, asynchronous core. The `Nuke-Wire` protocol eliminates HTTP overhead for maximum throughput.
*   **Secure & Robust Payload Handling:** A 1GB payload sanity limit protects the server from malformed requests and potential memory exhaustion attacks, ensuring high stability.
*   **Strict & Unambiguous Syntax:** Enforces strict quoting for `SET` and `JSON.SET` commands, eliminating ambiguity and ensuring data integrity.
*   **Ephemeral Stress Testing:** The `STRESS` command is a pure in-memory benchmark that **does not write to disk** and cleans up after itself perfectly.
*   **Resilient Public IP Detection:** Intelligently queries multiple external services to find its public IP address, increasing reliability for easier client configuration.
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

| Command                   | Description                                                                                          |
| :------------------------ | :--------------------------------------------------------------------------------------------------- |
| `PING`                    | Returns `+PONG`. Useful for checking if the server is responsive.                                    |
| `DEBUG <true\|false>`     | Enables or disables performance logging for each command.                                            |
| `STATS`                   | Shows detailed statistics about the server's state and performance.                                  |
| `STRESS <count>`          | Runs a benchmark with `<count>` ops. **This is non-persistent and will not affect the database file.** |
| `CLRDB`                   | Deletes all keys and values from the database.                                                       |
| `QUIT`                    | Instructs the server to perform a final save and shut down gracefully.                               |

### Basic Key-Value Commands

| Command                        | Description                                                                    |
| :----------------------------- | :----------------------------------------------------------------------------- |
| `SET <key> "<value>"`          | Sets a key to a string value. The value **must** be enclosed in double quotes. |
| `SET <key> "<value>" EX <sec>` | Sets a key with an TTL. The value **must** be enclosed in double quotes.       |
| `GET <key>`                    | Retrieves the value of a key. Returns `(nil)` if not found.                    |
| `UPDATE <key> "<new_value>"`   | Updates an existing key. The value **must** be enclosed in double quotes.      |
| `DEL <key> [key2...]`          | Deletes one or more keys. Returns the count of deleted keys.                   |
| `INCR <key> [amount]`          | Increments a numeric key by 1 or by a given `amount`.                          |
| `DECR <key> [amount]`          | Decrements a numeric key by 1 or by a given `amount`.                          |
| `TTL <key>`                    | Gets the remaining time-to-live of a key in seconds. Returns `-1` if no TTL.   |
| `EXPIRE <key> <seconds>`       | Sets or updates the TTL for an existing key.                                   |
| `SIMILAR <prefix>`             | Returns the number of keys that start with the given prefix.                   |

---

### Advanced JSON Commands & Examples

NukeKV supports storing **any valid JSON**, including arrays of objects, and provides powerful tools to query and manipulate them. Keywords like `WHERE`, `SET`, and `MAX` are case-insensitive.

| Command                                       | Description                                                                                                                                                              |
| :---------------------------------------------- | :----------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `JSON.SET <key> '<json_string>'`                | Sets a key to any valid JSON. The JSON string **must** be enclosed in single quotes.                                                                                     |
| `JSON.GET <key> [path...]`                      | Retrieves the entire JSON document, or specific fields using JSONPath-like syntax (`$.field`).                                                                         |
| `JSON.GET <key> WHERE <field> <value>`          | Filters a JSON array, returning only objects where `<field>` equals `<value>`.                                                                                           |
| `JSON.UPDATE <key> WHERE <f> <v> SET <f1> <v1>` | Updates one or more fields in objects that match the `WHERE` clause.                                                                                                     |
| `JSON.SEARCH <key> "<term>" [MAX <count>]`      | Performs a case-insensitive, **whole-word** search across a JSON document and returns an array of matching objects. The term **must** be a double-quoted string. `MAX` is optional and limits the number of results. |
| `JSON.DEL <key> WHERE <field> <value>`          | Deletes objects from a JSON array where `<field>` matches `<value>`.                                                                                                     |
| `JSON.APPEND <key> '<json_to_append>'`          | Appends a JSON object or array elements to an existing array. The JSON **must** be in single quotes.                                                                     |

#### **Complete JSON Workflow Example**

Let's use a `user` object and a `products` catalog.

**1. Set an initial JSON object:**

```bash
JSON.SET user '{"id": 101, "name": "akshat", "email": "akshatdiwedi151@gmail.com", "age": 18, "active": true}'
```
*Server Response:* `+OK`

**2. Get specific fields from the object:**

The `$` prefix is optional. Response keys are always clean.

```bash
JSON.GET user $.email age
```

*Server Response:*

```json
{
  "email": "akshatdiwedi151@gmail.com",
  "age": 18
}
```

**3. Set an initial JSON array for a product catalog:**

```bash
JSON.SET products '[{"id":1,"name":"Smartphone X23","stock":50}]'
```

*Server Response:* `+OK`

**4. Append a new product to the array:**

```bash
JSON.APPEND products '{"id":2, "name":"Laptop ProBook", "stock":20}'
```

*Server Response (new array size):* `2`

**5. Get a specific product using `WHERE`:**

```bash
JSON.GET products WHERE id 2
```

*Server Response:*

```json
[
  {
    "id": 2,
    "name": "Laptop ProBook",
    "stock": 20
  }
]
```

**6. Update a product's stock and add a new field:**

```bash
JSON.UPDATE products WHERE name "Laptop ProBook" SET stock 15 "on_sale" true
```

*Server Response (items updated):* `1`

**7. Verify the final state:**

```bash
JSON.GET products
```

*Server Response:*

```json
[
  {
    "id": 1,
    "name": "Smartphone X23",
    "stock": 50
  },
  {
    "id": 2,
    "name": "Laptop ProBook",
    "on_sale": true,
    "stock": 15
  }
]
```

#### **`JSON.SEARCH` in Action**

The new search is smarter. It matches whole words, case-insensitively, and lets you limit results.

**1. Set up some data for searching:**

```bash
JSON.SET articles '[{"id":1, "title": "Intro to AI"}, {"id":2, "title": "Financial Aid Guide"}, {"id":3, "title": "Advanced AI techniques"}, {"id":4, "title": "First Aid basics"}]'
```

*Server Response:* `+OK`

**2. Perform a whole-word search:**

Notice how it will find `"AI"` but correctly ignore the substring in `"Aid"`.

```bash
JSON.SEARCH articles "ai"
```

*Server Response (returns all matching objects):*

```json
[
  {
    "id": 1,
    "title": "Intro to AI"
  },
  {
    "id": 3,
    "title": "Advanced AI techniques"
  }
]
```

**3. Use `MAX` to limit the results:**

This time, we'll only ask for a maximum of 1 result.

```bash
JSON.SEARCH articles "ai" MAX 1
```

*Server Response (returns only the first match):*

```json
[
  {
    "id": 1,
    "title": "Intro to AI"
  }
]
```

---

## Diagnostics Output

### STATS

The `STATS` command provides a real-time, reformatted snapshot of the server.

**Example Command:**

```bash
STATS
```

**Example Output:**

```
Version: NukeKV v2.5-stable-☢️
Protocol: Nuke-Wire (CUSTOM RAW TCP)
Debug Mode: OFF
Worker Threads: 7
-------------------------
Persistence Disk: Enabled
  - Batch Size: 1
  - Unsaved Ops: 0
  - Disk Size: 1.15 KB
-------------------------
Caching: Enabled
  - Memory Limit: Unlimited
  - Memory Used: 21.29 MB
-------------------------
Total Keys: 2
Keys with TTL: 0
-------------------------
```

### STRESS

The `STRESS` command benchmarks the core performance of the database without affecting saved data.

**A Note on Memory Reporting:** The `MAX RAM USAGE` metric reports the *high-water mark* of memory the process has used. On Linux/macOS, this value does not decrease even after memory is freed by the application. This is normal OS behavior and **does not indicate a memory leak.** The stress test correctly cleans up all temporary data.

**Example Command:**

```bash
STRESS 1000000
```

**Example Output:**

```
Stress Test running for 1000000 ops ...
-------------------------------------------
SET:         1262786.67 ops/sec (791.90ms total)
UPDATE:      2618733.44 ops/sec (381.86ms total)
GET:         2833786.03 ops/sec (352.88ms total)
DEL:         1503694.33 ops/sec (665.03ms total)
-------------------------------------------
MAX RAM USAGE: 134.95 MB
Total Stress Test Time: 2.297s
```

**`note`**: The above `STRESS` command's output is a real benchmark. We ran this test on a Google Cloud Compute Engine `E2` instance with `2 vCPU`, `1 Core`, & `4GB RAM`. The command `STRESS 1000000` runs 1 million operations for *each* of the 4 commands (SET, UPDATE, GET, DEL), totaling 4 million operations in a single run.

---

### Star History

[![Star History Chart](https://api.star-history.com/svg?repos=Akshat-Diwedi/nuke-kv&type=Date)](https://www.star-history.com/#Akshat-Diwedi/nuke-kv&Date)