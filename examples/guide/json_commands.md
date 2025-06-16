# JSON Commands Guide

This guide explains how to use JSON commands in Nuke-KV.

## JSON.SET

Sets a JSON value for a key, or sets a specific field within an existing JSON object.

### Setting an Entire JSON Object

**Syntax:**
```bash
JSON.SET key 'json_value_string'
```

**Examples:**
```bash
# Set a simple JSON object
JSON.SET user:1 '{"name":"John","age":30}'
# Returns: +OK

# Set a nested JSON object
JSON.SET user:1 '{"name":"John","address":{"city":"New York","zip":"10001"}}'
# Returns: +OK

# Set a JSON array
JSON.SET users '["John","Jane","Bob"]'
# Returns: +OK
```

### Setting Specific Fields

**Syntax:**
```bash
JSON.SET key path value
```

**Examples:**
```bash
# Set a simple field
JSON.SET user:1 "age" 31
# Returns: +OK

# Set a nested field
JSON.SET user:1 "address.city" "Boston"
# Returns: +OK

# Set an array element
JSON.SET user:1 "skills[0]" "Node.js"
# Returns: +OK
```

## JSON.GET

Retrieves a JSON value associated with a key, or specific fields from a JSON object.

### Getting the Entire JSON Object

**Syntax:**
```bash
JSON.GET key
```

**Examples:**
```bash
JSON.GET user:1
# Returns: +{"name":"John","age":31,"address":{"city":"Boston"}}
```

### Getting Specific Fields

**Syntax:**
```bash
JSON.GET key [path1 path2 path3 ...]
```

**Examples:**
```bash
# Get single field
JSON.GET user:1 name
# Returns: +{"name":"John"}

# Get multiple fields
JSON.GET user:1 name age address.city
# Returns: +{"name":"John","age":31,"address.city":"Boston"}

# Get nested fields
JSON.GET user:1 address.city address.zip
# Returns: +{"address.city":"Boston","address.zip":"10001"}

# Get array elements
JSON.GET user:1 skills[0] skills[1]
# Returns: +{"skills[0]":"Node.js","skills[1]":"Redis"}
```

## JSON.PRETTY

Retrieves and pretty-prints a JSON object.

**Syntax:**
```bash
JSON.PRETTY key
```

**Examples:**
```bash
JSON.PRETTY user:1
# Returns:
# +{
#   "name": "John",
#   "age": 31,
#   "address": {
#     "city": "Boston",
#     "zip": "10001"
#   },
#   "skills": [
#     "Node.js",
#     "Redis"
#   ]
# }
```

## JSON.DEL

Deletes a JSON object or specific fields within it.

### Deleting the Entire JSON Object

**Syntax:**
```bash
JSON.DEL key
```

**Examples:**
```bash
JSON.DEL user:1
# Returns: :1 (success) or :0 (key not found)
```

### Deleting Specific Fields

**Syntax:**
```bash
JSON.DEL key field
```

**Examples:**
```bash
# Delete a simple field
JSON.DEL user:1 "age"
# Returns: :1

# Delete a nested field
JSON.DEL user:1 "address.city"
# Returns: :1

# Delete a non-existent field
JSON.DEL user:1 "nonexistent"
# Returns: :0
```

## Error Handling

JSON commands return appropriate error messages:

```bash
# Invalid JSON format
JSON.SET user:1 '{"invalid json'
# Returns: -ERR Invalid JSON format

# Invalid path
JSON.SET user:1 "invalid..path" "value"
# Returns: -ERR Invalid path

# Key not found
JSON.GET nonexistent
# Returns: (nil)

# Field not found
JSON.GET user:1 nonexistent
# Returns: +{"nonexistent":null}
```

## Best Practices

1. **Use Single Quotes for JSON Strings**
   ```bash
   # Good
   JSON.SET user:1 '{"name":"John"}'
   
   # Bad
   JSON.SET user:1 "{"name":"John"}"
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

4. **Get Multiple Fields in One Command**
   ```bash
   # Good
   JSON.GET user:1 name age address.city
   
   # Bad
   JSON.GET user:1 name
   JSON.GET user:1 age
   JSON.GET user:1 address.city
   ```