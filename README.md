# NukeKV ☢️ - A High-Performance Key-Value Store

Welcome to NukeKV, a lightweight, fast, and persistent key-value database server written in C++. It provides a simple HTTP interface for all operations, making it universally accessible from any programming language or tool.

### Features

*   **Cross-Platform:** Compiles and runs on Windows, macOS, and Linux.
*   **Blazing Fast:** Built in C++ with a multi-threaded, asynchronous core.
*   **Persistent Storage:** Saves your data to a `nukekv.db` file and reloads it on startup.
*   **Rich Data Types:** Supports standard string values and powerful native JSON objects.
*   **Dynamic Debugging:** Toggle performance logging on the fly without restarting the server.
*   **Built-in Diagnostics:** Includes `STATS` for monitoring and `STRESS` for performance benchmarking.
*   **Zero Dependencies:** The final compiled server runs as a single, portable executable.

---

### **Compiling the code :**


#### *For windows users :*

```powershell
# Install g++ via MSYS2 or another package manager

# Compile with optimizations
g++ -std=c++17 -O2 -Ilibs -o nukekv-server.exe server.cpp -static -lpthread -lws2_32 -lwsock32

# Run the server
.\nukekv-server.exe
```

#### *For Linux (Ubuntu, Debian, etc.) or macOS Users :*

``` bash
# Install compiler if you don't have it
# sudo apt-get update && sudo apt-get install -y g++ (On Debian/Ubuntu)
# xcode-select --install (On macOS)

# Compile with optimizations
g++ -std=c++17 -O2 -Ilibs -o nukekv-server server.cpp -lpthread

# Run the server
./nukekv-server
```



### Server & Diagnostics

| Command | Description |
| :--- | :--- |
| `PING` | Returns `+PONG`. Useful for checking if the server is responsive. |
| `DEBUG <true\|false>` | Enables or disables performance logging for each command. |
| `STATS` | Shows detailed statistics about the server's state and performance. |
| `STRESS <count>` | Runs a benchmark with `<count>` operations for SET, GET, etc. |
| `QUIT` | Instructs the server to perform a final save and shut down gracefully. |

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
| `TTL <key>` | Gets the remaining time-to-live of a key in seconds. |
| `SETTTL <key> <seconds>` | Sets or updates the TTL for an existing key. |

### JSON Commands

NukeKV supports storing and manipulating JSON objects directly.

| Command | Description |
| :--- | :--- |
| `JSON.SET <key> '<json_string>'` | Sets a key to a JSON object. |
| `JSON.GET <key>` | Retrieves the entire JSON object as a string. |
| `JSON.UPDATE <key> <f1> "<v1>" & <f2> "<v2>"` | Updates one or more fields in a JSON object. The `&` is an optional visual separator. |
| `JSON.DEL <key>` | Deletes a JSON key (same as `DEL`). |

**Example JSON Workflow:**
```
> JSON.SET user:01 '{"name": "Akshat", "role": "founder & ceo"}'
+OK

> JSON.UPDATE user:01 status "Founder & CEO" & company "Nukeverse"
+OK

> JSON.GET user:01
{
  "name": "Akshat",
  "status": "Founder & CEO",
  "company": "Nukeverse"
}
```


## Diagnostics Output

### STATS

The `STATS` command provides a real-time snapshot of the server.

**Example Command:**
```
> STATS
```

**Example Output:**
```
Version: NukeKV v1.0-Stable ♾️
Debug Mode: ON
Worker Threads: 7
Persistence: Enabled
  - Batch Size: 1
  - Unsaved Ops: 0
Caching: Enabled
  - Memory Limit: 1.00 GB
  - Memory Used: 123.45 KB
Total Keys: 5
Keys with TTL: 1
```

### STRESS

The `STRESS` command benchmarks the core performance of the database.

**Command:**
```
> STRESS 1000000
```

**Output:**

```
Stress Test running for 1000000 ops...
-------------------------------------------
SET:       823534.13 ops/sec (1.214s total)
UPDATE:   1813144.56 ops/sec (551.53ms total)
GET:      2361762.58 ops/sec (423.41ms total)
DEL:      1499790.07 ops/sec (666.76ms total)
-------------------------------------------
MAX RAM USAGE: 137.66 MB
-------------------------------------------
Total Stress Test Time: 2.938s

``` 

---

**`note` : the above STRESS command's Output is the real benchmark. we ran this test on Google Cloud Compute Engine named as `E2` - specification of this instance is `2 vCPU 1 Core` & `4GB RAM` .**

**The command `STRESS 1000000` states that it will run 1 Million operation for EACH 4 Commands - SET, UPDATE, GET, DEL .**