# JSON Nuke-KV Commands

This section details the commands available in Nuke-KV for working with JSON data types.

## JSON.SET

Sets a JSON value for a key, or sets a specific field within an existing JSON object.

**Syntax (Set entire JSON object):**
```
JSON.SET <key> '<json_value_string>'
```
- `<key>`: The key to set.
- `'<json_value_string>'`: The JSON object or array to store, enclosed in single quotes. Must be a valid JSON string. (e.g., `'{"name":"Nuke", "type":"KV"}'` or `'[1, "two", true]'`)
- `EX <seconds>`: (Optional) Sets an expiration time in seconds.

**Syntax (Set specific field in JSON object):**
```
JSON.SET <key> <field> <value> [EX <seconds>]
```
- `<key>`: The key holding the JSON object.
- `<field>`: The field within the JSON object to set/update. Nested fields can be specified using dot notation (e.g., `address.city`).
- `<value>`: The value to set for the field. This will be stored as a JSON value (e.g., strings will be quoted, numbers stored as numbers).
- `EX <seconds>`: (Optional) Sets an expiration time in seconds for the key (if the key is newly created or if updating an existing key's TTL is desired).

**Output:**
- `OK (<execution_time> μs)`: If the operation was successful.
- `-ERR <error_message>`: If an error occurred (e.g., invalid JSON, key not a JSON object when setting a field).

**Examples:**

*Setting an entire JSON object:*
```
> JSON.SET user:1 '{"name":"Akshat", "age":24, "skills":["Redis", "Node", "LLMs"]}'
OK (XX.XX μs)
```

*Setting a specific field in an existing JSON object:*
```
> JSON.SET user:1 "age" 31
OK (XX.XX μs)

> JSON.SET user:1 "occupation" "Explorer"
OK (XX.XX μs)
```

*Setting a nested field:*
```
> JSON.SET user:1 '{ "address": { "street": "123 Main St" } }'
OK (XX.XX μs)

> JSON.SET user:1 "address.city" "New York"
OK (XX.XX μs)

// user:1 is now '{ "address": { "street": "123 Main St", "city": "New York" } }'
```

## JSON.GET

Retrieves a JSON value associated with a key, or specific fields from a JSON object.

**Syntax:**
```
JSON.GET <key> [path]
```
- `<key>`: The key whose JSON value to retrieve.
- `[path]`: (Optional) A JSONPath-like expression to retrieve specific parts of the JSON object. 
    - If no path is specified, the entire JSON object is returned.
    - For simple field access, use the field name (e.g., `name`).
    - For nested fields, use dot notation (e.g., `address.city`).
    - To access array elements, use `$.<field_name>[<index>]` (e.g., `$.skills[0]`).

**Output:**
- `+<json_string_or_value> (<execution_time> μs)`: If successful. The output will be a JSON string representing the entire object, a specific field's value, or an object/array of requested fields.
- `$-1 (<execution_time> μs)`: If the key does not exist or has expired.
- `-ERR <error_message>`: If the key's value is not a valid JSON object or another error occurred.

**Examples:**
```
> JSON.SET user:1 '{"name":"Akshat", "age":24, "skills":["Redis", "Node", "LLMs"]}'
OK (XX.XX μs)

> JSON.GET user:1
+'{"name":"Akshat","age":24,"skills":["Redis","Node","LLMs"]}' (XX.XX μs)

> JSON.GET user:1 name
+"Akshat" (XX.XX μs)

> JSON.GET user:1 $.skills[0]
+"Redis" (XX.XX μs)

> JSON.GET user:1 $.skills[2]
+"LLMs" (XX.XX μs)

> JSON.GET user:1 non_existent_field
+null (XX.XX μs) // Or an empty object/error depending on strictness
```

## JSON.PRETTY

Retrieves the JSON object associated with a key and prints it in a syntactically correct and human-readable (pretty-printed) format.

**Syntax:**
```
JSON.PRETTY <key>
```
- `<key>`: The key whose JSON value to retrieve and pretty-print.

**Output:**
- `+<pretty_printed_json_string> (<execution_time> μs)`: If the key exists and its value is a valid JSON object.
- `$-1 (<execution_time> μs)`: If the key does not exist or has expired.
- `-ERR Value is not a valid JSON object or an error occurred during formatting. (<execution_time> μs)`: If the value at the key is not valid JSON.

**Example:**
```
> JSON.SET myjson '{ "item": "test", "values": [1,2,3], "nested":{"a":true} }'
OK (XX.XX μs)

> JSON.PRETTY myjson
+{
  "item": "test",
  "values": [
    1,
    2,
    3
  ],
  "nested": {
    "a": true
  }
} (XX.XX μs)
```

## JSON.DEL

Deletes a specific field from a JSON object or deletes the entire JSON object (equivalent to the `DEL` command for that key).

**Syntax:**
```
JSON.DEL <key> [field]
```
- `<key>`: The key of the JSON object.
- `[field]`: (Optional) The field to delete within the JSON object. If not provided, the entire JSON object associated with the key is deleted. Nested fields can be specified using dot notation.

**Output:**
- `:<integer> (<execution_time> μs)`: 
    - If `field` is specified: `1` if the field was deleted, `0` if the field was not found.
    - If `field` is NOT specified: `1` if the key (and its JSON object) was deleted, `0` if the key was not found.
- `-ERR <error_message>`: If an error occurred (e.g., value at key is not JSON when trying to delete a field).

**Examples:**
```
> JSON.SET book '{ "title": "Nuke Guide", "author": "AI", "chapters": 5, "published": true }'
OK (XX.XX μs)

> JSON.DEL book "published"
:1 (XX.XX μs)

// book is now '{ "title": "Nuke Guide", "author": "AI", "chapters": 5 }'

> JSON.DEL book "non_existent_field"
:0 (XX.XX μs)

> JSON.DEL book
:1 (XX.XX μs)

// The key 'book' no longer exists

> JSON.DEL non_existent_key
:0 (XX.XX μs)
```

*Note: `XX.XX` in execution times represents a placeholder for the actual time, which will vary.*