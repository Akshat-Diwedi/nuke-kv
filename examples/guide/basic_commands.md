# Basic Nuke-KV Commands

This section details the basic commands available in Nuke-KV.

## PING

Checks if the server is responsive.

**Syntax:**
```
PING
```

**Output:**
```
PONG
```

**Example:**
```
> PING
PONG
```

## SET

Sets the string value of a key. The value **must** be enclosed in double quotes (e.g., "hello world"). Optionally, an expiration time (TTL) in seconds can be provided.

**Syntax:**
```
SET <key> "<value>" [EX <seconds>]
```

- `<key>`: The key to set.
- `"<value>"`: The value to set for the key. This **must** be enclosed in double quotes.
- `EX <seconds>`: (Optional) Sets an expiration time in seconds.

**Output:**
- `OK` or `OK (<execution_time> μs)`: If the key was set successfully. Execution time is shown if DEBUG is true.
- `-ERR <error_message>`: If an error occurred.

**Examples:**
```
> SET mykey "myvalue"
OK (XX.XX μs)

> SET anotherkey "hello world with spaces"
OK (XX.XX μs)

> SET tempkey "transient" EX 60
OK (XX.XX μs)
```

## GET

Gets the value of a key.

**Syntax:**
```
GET <key>
```

- `<key>`: The key whose value to retrieve.

**Output:**
- `<value>` or `<value> (<execution_time> μs)`: If the key exists and has a value. Execution time is shown if DEBUG is true.
- `$-1` or `$-1 (<execution_time> μs)`: If the key does not exist or has expired. Execution time is shown if DEBUG is true.
- `-ERR <error_message>`: If an error occurred.

**Examples:**
```
> GET mykey
myvalue (XX.XX μs)

> GET non_existent_key
$-1 (XX.XX μs)
```

## DEL

Deletes one or more keys.

**Syntax:**
```
DEL <key>
```

- `<key>`: The key to delete.

**Output:**
- `:<integer>` or `:<integer> (<execution_time> μs)`: The number of keys that were removed (0 or 1 in the current implementation which only supports single key deletion per DEL command). Execution time is shown if DEBUG is true.
- `-ERR <error_message>`: If an error occurred.

**Example:**
```
> DEL mykey
:1 (XX.XX μs)

> DEL non_existent_key
:0 (XX.XX μs)
```

## TTL

Gets the remaining time to live of a key that has an expiration set.

**Syntax:**
```
TTL <key>
```

- `<key>`: The key to check.

**Output:**
- `:<integer>` or `:<integer> (<execution_time> μs)`: The remaining time to live in seconds. Execution time is shown if DEBUG is true.
- `:-1` or `:-1 (<execution_time> μs)`: If the key exists but has no associated expiration. Execution time is shown if DEBUG is true.
- `:-2` or `:-2 (<execution_time> μs)`: If the key does not exist or has expired. Execution time is shown if DEBUG is true.
- `-ERR <error_message>`: If an error occurred.

**Examples:**
```
> SET tempkey "some_value" EX 60
OK (XX.XX μs)

> TTL tempkey
:59 (XX.XX μs)  // or some value close to 60

> SET persistent_key "another_value"
OK (XX.XX μs)

> TTL persistent_key
:-1 (XX.XX μs)

> TTL non_existent_key
:-2 (XX.XX μs)
```

## SAVE

Manually triggers a save of the current in-memory database to disk.

**Syntax:**
```
SAVE
```

**Output:**
- `OK` or `OK (<execution_time> μs)`: If the save operation was successful. Execution time is shown if DEBUG is true.
- `-ERR <error_message>`: If an error occurred during saving.

**Example:**
```
> SAVE
OK (XX.XX μs)
```

## STATS

Provides statistics about the Nuke-KV server.

**Syntax:**
```
STATS
```

**Output:**
A string containing various server statistics, such as uptime, memory usage, number of keys, etc. Execution time is shown if DEBUG is true.

**Example:**
```
> STATS
<server_statistics_string> (XX.XX μs)
```

## HELP

Displays a help message listing available commands and their basic usage.

**Syntax:**
```
HELP
```

**Output:**
A multi-line string listing available commands and their syntax.

**Example:**
```
> HELP
Available commands:
  PING
  SET <key> "<value>" [EX <seconds>]
  GET <key>
  ... (and so on for other commands)
```

## QUIT

Closes the connection to the server. The data will be persisted to disk upon graceful shutdown (Ctrl+C).

**Syntax:**
```
QUIT
```

**Output:**
```
BYE
```

**Example:**
```
> QUIT
BYE
```

*Note: `XX.XX` in execution times represents a placeholder for the actual time, which will vary.*