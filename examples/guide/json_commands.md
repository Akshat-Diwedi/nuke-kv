# JSON Commands Guide

This guide explains how to use JSON commands in Nuke-KV.

## JSON.SET

Sets a JSON value for a key, or sets a specific field within an existing JSON object. Values for both full JSON objects and fields **must** be quoted.

### Setting an Entire JSON Object

**Syntax:**
```bash
JSON.SET key '{"json":"value"}' [EX seconds]
```

- `key`: The key to set.
- `'{"json":"value"}'`: The JSON object value, which **must** be provided as a string enclosed in single or double quotes.
- `EX seconds`: (Optional) Sets an expiration time in seconds for the JSON object.

**Output:**
- `OK` or `OK (<execution_time> μs)`: If the JSON object was set successfully. Execution time is shown if DEBUG is true.
- `-ERR <error_message>`: If an error occurred (e.g., invalid JSON string, value too large).

**Examples:**
```bash
# Set a simple JSON object
> JSON.SET user:1 '{"name":"John","age":30}'
OK (XX.XX μs)

# Set a nested JSON object with expiration
> JSON.SET user:2 '{"name":"Jane","address":{"city":"London"}}' EX 300
OK (XX.XX μs)

# Set a JSON array
> JSON.SET users '["John","Jane","Bob"]''
OK (XX.XX μs)
```

### Setting Specific Fields

**Syntax:**
```bash
JSON.SET key path "value" [EX seconds]
```

- `key`: The key of the JSON object.
- `path`: The dot-separated path to the field (e.g., `address.city` or `skills[0]`).
- `"value"`: The value to set for the field. This **must** be enclosed in double quotes (or single quotes).
- `EX seconds`: (Optional) Sets an expiration time in seconds for the parent JSON object. If the object already has a TTL, it will be updated.

**Output:**
- `OK` or `OK (<execution_time> μs)`: If the field was set successfully. Execution time is shown if DEBUG is true.
- `-ERR <error_message>`: If an error occurred.

**Examples:**
```bash
# Assuming user:1 exists as a JSON object
> JSON.SET user:1 "age" "31"
OK (XX.XX μs)

# Set a nested field
> JSON.SET user:1 "address.city" "Boston"
OK (XX.XX μs)

# Set an array element
> JSON.SET user:1 "skills[0]" "Node.js"
OK (XX.XX μs)

# Set a field with expiration
> JSON.SET user:3 "profile" '{"status":"active"}' EX 60
OK (XX.XX μs)
```

## JSON.GET

Retrieves a JSON value associated with a key, or specific fields from a JSON object.

**Syntax:**
```bash
JSON.GET key [path1 path2 ...]
```

- `key`: The key of the JSON object.
- `path1 path2 ...`: (Optional) One or more dot-separated paths to fields (e.g., `address.city` or `skills[0]`). If no paths are provided, the entire JSON object is returned.

**Output:**
- A JSON string representing the retrieved value(s) or `null` if a specific path does not exist, or `$-1` if the key does not exist. Execution time is shown if DEBUG is true.
- `-ERR <error_message>`: If an error occurred.

**Examples:**
```bash
# Get entire JSON object
> JSON.GET user:1
{"name":"John","age":"31","address":{"city":"Boston"},"skills":["Node.js"]}

# Get single field
> JSON.GET user:1 name
{"name":"John"}

# Get multiple fields
> JSON.GET user:1 name age address.city
{"name":"John","age":"31","address.city":"Boston"}

# Get nested fields
> JSON.GET user:1 address.city address.zip
{"address.city":"Boston","address.zip":null}

# Get array elements
> JSON.GET user:1 skills[0] skills[1]
{"skills[0]":"Node.js","skills[1]":null}

# Get non-existent key
> JSON.GET non_existent_key
$-1

# Get field from non-existent key (returns $--1)
> JSON.GET non_existent_key some.field
$-1
```

## JSON.DEL

Deletes a JSON object or specific fields within it.

### Deleting the Entire JSON Object

**Syntax:**
```bash
JSON.DEL key
```

- `key`: The key of the JSON object to delete.

**Output:**
- `:1` or `:1 (<execution_time> μs)`: If the key was deleted successfully. Execution time is shown if DEBUG is true.
- `:0` or `:0 (<execution_time> μs)`: If the key was not found. Execution time is shown if DEBUG is true.
- `-ERR <error_message>`: If an error occurred.

**Examples:**
```bash
> JSON.DEL user:1
:1

> JSON.DEL non_existent_key
:0
```

### Deleting Specific Fields

**Syntax:**
```bash
JSON.DEL key path
```

- `key`: The key of the JSON object.
- `path`: The dot-separated path to the field to delete (e.g., `address.city` or `skills[0]`).

**Output:**
- `:1` or `:1 (<execution_time> μs)`: If the field was deleted successfully. Execution time is shown if DEBUG is true.
- `:0` or `:0 (<execution_time> μs)`: If the field was not found. Execution time is shown if DEBUG is true.
- `-ERR <error_message>`: If an error occurred.

**Examples:**
```bash
# Delete a simple field
> JSON.DEL user:1 "age"
:1

# Delete a nested field
> JSON.DEL user:1 "address.city"
:1

# Delete a non-existent field
> JSON.DEL user:1 "nonexistent"
:0
```

## JSON.UPDATE

Updates multiple specific fields within a JSON object. Values **must** be quoted.

**Syntax:**
```bash
JSON.UPDATE key path1 "value1" & path2 "value2" ... [EX seconds]
```

- `key`: The key of the JSON object to update.
- `path1 "value1"`: A path-value pair. The `value` **must** be enclosed in double quotes.
- `&`: Separator for multiple path-value pairs.
- `EX seconds`: (Optional) Sets an expiration time in seconds for the JSON object. If the object already has a TTL, it will be updated.

**Output:**
- `OK` or `OK (<execution_time> μs)`: If the update operation was successful. Execution time is shown if DEBUG is true.
- `-ERR <error_message>`: If an error occurred (e.g., key not found, malformed JSON, invalid path).

**Examples:**
```bash
# Assuming user:1 exists as a JSON object
> JSON.UPDATE user:1 "name" "Jonathan" & "age" "32"
OK (XX.XX μs)

# Update nested fields with expiration
> JSON.UPDATE user:2 "address.city" "Paris" & "address.zip" "75001" EX 120
OK (XX.XX μs)

# Attempt to update a non-existent key
> JSON.UPDATE non_existent_key "field" "value"
-ERR Key non_existent_key does not exist for JSON.UPDATE.
```

## Error Handling

JSON commands return appropriate error messages:

```bash
# Invalid JSON format (for setting entire object)
> JSON.SET user:1 '{"invalid json'
-ERR invalid JSON string: Expected '}' after property value in JSON at position 16

# Invalid path (for setting a field)
> JSON.SET user:1 "invalid..path" "value"
-ERR Failed to set JSON field at path 'invalid..path'

# Key not found (for GET)
> JSON.GET nonexistent
$-1

# Field not found (for GET, when requesting specific field)
> JSON.GET user:1 nonexistent
{"nonexistent":null}
```

## Best Practices

1. **Always Quote Values**
   Values for `SET`, `JSON.SET` (entire object or field), and `JSON.UPDATE` **must** be enclosed in single or double quotes.
   ```bash
   # Good
   JSON.SET user:1 '{"name":"John"}'
   JSON.SET user:1 "age" "31"
   
   # Bad
   JSON.SET user:1 {"name":"John"} # Missing quotes around the JSON string
   JSON.SET user:1 age 31 # Missing quotes around the value
   ```

2. **Use Dot Notation for Nested Fields**
   ```bash
   # Good
   JSON.SET user:1 "address.city" "Boston"
   
   # Bad
   JSON.SET user:1 "address/city" "Boston"
   ```

3. **Use Array Indexing for Array Elements**
   ```bash
   # Good
   JSON.GET user:1 "skills[0]"
   
   # Bad
   JSON.GET user:1 "skills.0"
   ```

4. **Get Multiple Fields in One Command with JSON.GET**
   ```bash
   # Good
   JSON.GET user:1 name age address.city
   
   # Bad
   JSON.GET user:1 name
   JSON.GET user:1 age
   JSON.GET user:1 address.city
   ```

5. **Use `&` for Multiple Updates in JSON.UPDATE**
   ```bash
   # Good
   JSON.UPDATE user:1 "name" "Jane" & "age" "30"
   
   # Bad
   JSON.UPDATE user:1 "name" "Jane" "age" "30" # Missing & separator
   ```

*Note: `XX.XX` in execution times represents a placeholder for the actual time, which will vary. Execution times are only displayed when `DEBUG` mode is enabled.*