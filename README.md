# Nuke-KV

A high-performance, in-memory key-value store with JSON support, built with Node.js.

## Features

- Fast in-memory operations with LRU cache
- JSON data type support with path-based access
- TTL (Time-To-Live) support for keys
- Persistent storage with automatic saving
- Multi-threaded command processing
- Redis-like command interface

## Installation

```bash
npm install nuke-kv
```

## Quick Start

```javascript
const { createClient } = require('nuke-kv');

// Create a client
const client = createClient();

// Connect to the server
client.connect();

// Set a value
client.send('SET mykey myvalue');

// Get a value
client.send('GET mykey', (response) => {
  console.log(response); // +myvalue
});

// Set a JSON object
client.send('JSON.SET user:1 \'{"name":"John","age":30,"skills":["Node.js","Redis"]}\'');

// Get specific fields from JSON
client.send('JSON.GET user:1 name age skills[0]', (response) => {
  console.log(response); // +{"name":"John","age":30,"skills[0]":"Node.js"}
});
```

## Available Commands

### Basic Commands

- **`SET key value [EX seconds]`**: Set key to value with optional expiration
  ```bash
  SET user:1 "John Doe"
  SET session:123 "active" EX 3600  # Expires in 1 hour
  ```

- **`GET key`**: Get value of key
  ```bash
  GET user:1
  # Returns: +John Doe
  ```

- **`DEL key`**: Delete key
  ```bash
  DEL user:1
  # Returns: :1 (success) or :0 (key not found)
  ```

- **`TTL key`**: Get time-to-live of key in seconds
  ```bash
  TTL session:123
  # Returns: :3600 (seconds remaining) or :-1 (no TTL) or :-2 (key not found)
  ```

### JSON Commands

- **`JSON.SET key 'json_string'`**: Set entire JSON object
  ```bash
  JSON.SET user:1 '{"name":"John","age":30,"address":{"city":"New York"}}'
  # Returns: +OK
  ```

- **`JSON.SET key path value`**: Set specific field in JSON object
  ```bash
  JSON.SET user:1 "age" 31
  JSON.SET user:1 "address.city" "Boston"
  # Returns: +OK
  ```

- **`JSON.GET key [path1 path2 ...]`**: Get JSON object or specific fields
  ```bash
  JSON.GET user:1
  # Returns: +{"name":"John","age":31,"address":{"city":"Boston"}}

  JSON.GET user:1 name age address.city
  # Returns: +{"name":"John","age":31,"address.city":"Boston"}
  ```

- **`JSON.DEL key [field]`**: Delete JSON object or field
  ```bash
  JSON.DEL user:1 "address.city"
  # Returns: :1 (success) or :0 (field not found)
  ```

### Utility Commands

- **`SAVE`**: Force save to disk
  ```bash
  SAVE
  # Returns: +OK
  ```

- **`STATS`**: Show database statistics
  ```bash
  STATS
  # Returns: +{"totalKeys":100,"memoryUsage":"1.2MB",...}
  ```

- **`PING`**: Test server connection
  ```bash
  PING
  # Returns: +PONG
  ```

- **`CLRCACHE`**: Clear in-memory cache
  ```bash
  CLRCACHE
  # Returns: +OK
  ```

- **`HELP`**: Show available commands
  ```bash
  HELP
  # Returns: List of available commands
  ```

- **`QUIT`**: Close connection
  ```bash
  QUIT
  # Returns: +OK
  ```

## Performance

Nuke-KV is optimized for high performance:
- LRU cache for fast access to frequently used keys
- Multi-threaded command processing
- Efficient JSON path operations
- Automatic persistence with minimal impact

## Error Handling

All commands return appropriate error messages:
```bash
-ERR wrong number of arguments for SET command
-ERR value is not a valid JSON object
-ERR key not found
```

## Contributing

Contributions are welcome! Please feel free to submit a Pull Request.

## License

MIT