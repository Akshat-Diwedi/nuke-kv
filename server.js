// server.js
const net = require('net');
const db = require('./db');
const { parseValue, DEBUG, MAX_VALUE_SIZE } = require('./utils');
const fs = require('fs').promises;
const path = require('path');

// Command queue for pipelining
class CommandQueue {
  constructor(maxBatchSize = 100, maxWaitMs = 10) {
    this.shuttingDown = false; // Flag to indicate shutdown process
    this.queue = [];
    this.maxBatchSize = maxBatchSize;
    this.maxWaitMs = maxWaitMs;
    this.timer = null;
    this.callbacks = new Map();
    this.nextId = 1;
    this.priorities = new Map();
    this.stats = {
      totalProcessed: 0,
      totalTime: 0,
      batchesProcessed: 0,
      lastReset: Date.now()
    };
    this.waitPromises = [];
  }

  add(command, callback, priority = 0) {
    if (this.shuttingDown) {
      // Optionally, send an error back to the client or log
      if (callback) {
        callback(new Error('Server is shutting down. New commands not accepted.'));
      }
      return; // Do not add new commands during shutdown
    }
    const id = this.nextId++;
    this.queue.push({ id, ...command });
    this.callbacks.set(id, callback);
    this.priorities.set(id, priority);
    
    // Start timer if this is the first command in the queue
    if (this.queue.length === 1) {
      this.timer = setTimeout(() => this.process(), this.maxWaitMs);
    }
    
    // Process immediately if we've reached max batch size
    if (this.queue.length >= this.maxBatchSize) {
      clearTimeout(this.timer);
      this.process();
    }
  }

  async process() {
    if (this.queue.length === 0) {
      // If queue is empty, resolve any waiting promises
      if (this.waitPromises.length > 0) {
        this.waitPromises.forEach(resolve => resolve());
        this.waitPromises = [];
      }
      return;
    }
    
    const startTime = process.hrtime.bigint();
    
    // Sort queue by priority
    this.queue.sort((a, b) => {
      const priorityA = this.priorities.get(a.id) || 0;
      const priorityB = this.priorities.get(b.id) || 0;
      return priorityB - priorityA;
    });
    
    // Take up to maxBatchSize commands
    const batch = this.queue.splice(0, this.maxBatchSize);
    clearTimeout(this.timer);
    
    try {
      // Process the batch
      const { results, batchExecutionTime } = await db.processBatch(batch);
      
      // Call the callbacks with results
      for (let i = 0; i < batch.length; i++) {
        const { id } = batch[i];
        const result = results[i];
        const callback = this.callbacks.get(id);
        
        if (callback) {
          callback(null, { ...result, batchExecutionTime });
          this.callbacks.delete(id);
          this.priorities.delete(id);
        }
      }
      
      // Update stats
      this.stats.totalProcessed += batch.length;
      this.stats.batchesProcessed++;
      const endTime = process.hrtime.bigint();
      this.stats.totalTime += Number(endTime - startTime) / 1000;
      
    } catch (error) {
      // Handle errors
      for (const { id } of batch) {
        const callback = this.callbacks.get(id);
        if (callback) {
          callback(error);
          this.callbacks.delete(id);
          this.priorities.delete(id);
        }
      }
    }
    
    // Reset stats periodically
    const now = Date.now();
    if (now - this.stats.lastReset >= 60000) { // Reset every minute
      this.stats = {
        totalProcessed: 0,
        totalTime: 0,
        batchesProcessed: 0,
        lastReset: now
      };
    }
    
    // Check if there are more commands to process
    if (this.queue.length === 0 && this.waitPromises.length > 0) {
      this.waitPromises.forEach(resolve => resolve());
      this.waitPromises = [];
    } else if (this.queue.length > 0) {
      // Process the next batch
      this.timer = setTimeout(() => this.process(), this.maxWaitMs);
    }
  }

  getStats() {
    const avgTimePerBatch = this.stats.batchesProcessed > 0 
      ? this.stats.totalTime / this.stats.batchesProcessed 
      : 0;
    
    const opsPerSecond = this.stats.totalProcessed > 0
      ? (this.stats.totalProcessed / (this.stats.totalTime / 1000))
      : 0;
    
    return {
      queueLength: this.queue.length,
      totalProcessed: this.stats.totalProcessed,
      batchesProcessed: this.stats.batchesProcessed,
      avgTimePerBatch: avgTimePerBatch.toFixed(2),
      opsPerSecond: opsPerSecond.toFixed(2)
    };
  }
  
  // Method to wait for all commands to be processed
  waitForEmpty() {
    if (this.queue.length === 0) {
      return Promise.resolve();
    }

    return new Promise(resolve => {
      this.waitPromises.push(resolve);
    });
  }
}

// Create command queue
const commandQueue = new CommandQueue();



// Create server
const server = net.createServer((socket) => {
  console.log('Client connected');
  
  // Send welcome message
  socket.write('Welcome to NukeKV - High Performance Key-Value Store\n');
  socket.write('Features: SET, GET, DEL, TTL, SAVE, STATS, CLRCACHE\n');
  socket.write('Type HELP for command usage\n');
  
  let buffer = '';
  
  socket.on('data', (data) => {
    buffer += data.toString();
    
    // Process complete commands (terminated by newline)
    const lines = buffer.split('\n');
    buffer = lines.pop(); // Keep the last incomplete line in the buffer
    
    // Process each complete command
    for (const line of lines) {
      if (!line.trim()) continue;
      processCommand(line.trim(), socket);
    }
  });
  
  socket.on('end', () => {
    console.log('Client disconnected');
  });
  
  socket.on('error', (err) => {
    console.error('Socket error:', err);
  });
});

// Helper function to parse command strings, respecting double quotes
function parseCommandArgs(commandStr) {
    // This regex splits the command string into arguments, correctly handling quoted strings.
    // It captures either a sequence of non-space, non-quote characters (\S+),
    // or a double-quoted string ("(?:[^"\\]|\\.)*") which allows escaped quotes,
    // or a single-quoted string ('(?:[^'\\]|\\.)*') which allows escaped quotes.
    const parts = commandStr.match(/[^\s"']+|"(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*'/g);
    
    if (!parts) {
        return [];
    }

    // Now, process each part. For quoted strings, remove the outer quotes and unescape inner quotes/backslashes.
    return parts.map(part => {
        if ((part.startsWith('"') && part.endsWith('"')) || (part.startsWith('\'') && part.endsWith('\''))) {
            // Remove outer quotes and handle escaped quotes/backslashes within the string
            return part.substring(1, part.length - 1).replace(/\\(.)/g, '$1');
        }
        return part;
    });
}

// Process a command
async function processCommand(commandStr, socket) {
  // Use the new helper function for parsing
  const parts = parseCommandArgs(commandStr);
  const command = parts[0] ? parts[0].toUpperCase() : ''; // Handle empty command string

  let ttl = null; // Declare ttl once at the top of the function scope

  switch (command) {
    case 'PING':
      socket.write('PONG\n');
      break;

    case 'SET':
      // Command format: SET <key> "<value>" [EX seconds]
      // Minimum parts: 3 (SET, key, "value")
      // Max parts: 5 (SET, key, "value", EX, seconds)

      if (parts.length < 3 || parts.length > 5) {
        socket.write('-ERR wrong number of arguments for SET command\n');
        return;
      }

      const key = parts[1];
      const value = parts[2]; // parseCommandArgs has already stripped quotes

      // To enforce that the original value was quoted, we need to inspect the original commandStr
      // This is a limitation when parseCommandArgs strips quotes.
      // As per the rule: `SET user:01 Akshat` should be rejected.
      // This means the actual argument at position 2 in the *original* commandStr must be enclosed in quotes.
      
      // Let's re-parse the value part more carefully from the original commandStr to check for quotes.
      const valueStartIndex = commandStr.indexOf(key) + key.length + 1; // Start after key and its space
      let quotedValueMatch = commandStr.substring(valueStartIndex).match(/^"([^"]*)"|'([^']*)'/);

      if (!quotedValueMatch) {
          // If not a double or single quoted string directly after the key
          socket.write('-ERR SET command value must be quoted\n');
          return;
      }

      // Extract the actual value from the matched group (either group 1 for double quotes or group 2 for single quotes)
      const actualValue = quotedValueMatch[1] || quotedValueMatch[2];

      // Check value size
      const valueSize = Buffer.byteLength(actualValue, 'utf8');
      if (valueSize > MAX_VALUE_SIZE) {
        socket.write(`-ERR value exceeds maximum allowed size of ${MAX_VALUE_SIZE} bytes\n`);
        return;
      }

      let exIndex = -1;

      // Find the 'EX' token in the 'parts' array
      for (let i = 3; i < parts.length; i++) { // Start searching from expected position of EX
          if (parts[i].toUpperCase() === 'EX') {
              exIndex = i;
              break;
          }
      }

      if (exIndex !== -1) {
          if (parts.length < exIndex + 2) {
              socket.write('-ERR wrong number of arguments for SET command with EX option\n');
              return;
          }
          ttl = parseInt(parts[exIndex + 1]);
          if (isNaN(ttl)) {
              socket.write('-ERR invalid expire time in SET\n');
              return;
          }
          // If EX is present, ensure no extra arguments beyond TTL
          if (parts.length > exIndex + 2) {
              socket.write('-ERR wrong number of arguments for SET command with EX option\n');
              return;
          }
      } else {
          // If EX is not present, ensure no extra arguments beyond the value
          if (parts.length > 3) {
              socket.write('-ERR wrong number of arguments for SET command (extra unquoted arguments after value)\n');
              return;
          }
      }

      // Queue the SET command
      commandQueue.add(
        { operation: 'SET', key, value: actualValue, ttl }, // Use actualValue
        (err, result) => {
          if (err) {
            socket.write(`-ERR ${err.message}\n`);
          } else {
            if (DEBUG) {
              socket.write(`${result.status} (${result.executionTime.toFixed(2)} μs)\n`);
            } else {
              socket.write(`${result.status}\n`);
            }
          }
        }
      );
      break;

    case 'GET':
      if (parts.length !== 2) {
        socket.write('-ERR wrong number of arguments for GET command\n');
        return;
      }

      // Queue the GET command
      commandQueue.add(
        { operation: 'GET', key: parts[1] },
        (err, result) => {
          if (err) {
            socket.write(`-ERR ${err.message}\n`);
          } else {
            const { value, executionTime } = result;
            if (value === null) {
              if (DEBUG) {
                socket.write(`$-1 (${executionTime.toFixed(2)} μs)\n`);
              } else {
                socket.write(`$-1\n`);
              }
            } else {
              const valueStr = typeof value === 'object' ? JSON.stringify(value) : value.toString();
              if (DEBUG) {
                socket.write(`${valueStr} (${executionTime.toFixed(2)} μs)\n`);
              } else {
                socket.write(`${valueStr}\n`);
              }
            }
          }
        }
      );
      break;

    case 'DEL':
      if (parts.length !== 2) {
        socket.write('-ERR wrong number of arguments for DEL command\n');
        return;
      }
      
      // Queue the DEL command
      commandQueue.add(
        { operation: 'DEL', key: parts[1] },
        (err, result) => {
          if (err) {
            socket.write(`-ERR ${err.message}\n`);
          } else {
            if (DEBUG) {
              socket.write(`:${result.value} (${result.executionTime.toFixed(2)} μs)\n`);
            } else {
              socket.write(`:${result.value}\n`);
            }
          }
        }
      );
      break;

    case 'TTL':
      if (parts.length !== 2) {
        socket.write('-ERR wrong number of arguments for TTL command\n');
        return;
      }

      // Queue the TTL command
      commandQueue.add(
        { operation: 'TTL', key: parts[1] },
        (err, result) => {
          if (err) {
            socket.write(`-ERR ${err.message}\n`);
          } else {
            if (DEBUG) {
              socket.write(`:${result.value} (${result.executionTime.toFixed(2)} μs)\n`);
            } else {
              socket.write(`:${result.value}\n`);
            }
          }
        }
      );
      break;

    case 'SAVE':
      const startTime = process.hrtime.bigint();
      const success = await db.saveData(true);
      const endTime = process.hrtime.bigint();
      const executionTime = Number(endTime - startTime) / 1000;
      if (success) {
        socket.write(`OK (${executionTime.toFixed(2)} μs)\n`);
      } else {
        socket.write(`-ERR failed to save data (${executionTime.toFixed(2)} μs)\n`);
      }
      break;

    case 'STATS':
      const statsStartTime = process.hrtime.bigint();

      // Get database statistics
      const store = db._store;
      const ttlMap = db._ttlMap;

      const totalKeys = store ? store.size : 0;
      const keysWithTTL = ttlMap ? ttlMap.size : 0;

      // Calculate memory usage (approximate)
      let memoryUsage = process.memoryUsage();

      const stats = {
        totalKeys,
        keysWithTTL,
        memoryUsage: {
          rss: `${Math.round(memoryUsage.rss / 1024 / 1024)} MB`,
          heapTotal: `${Math.round(memoryUsage.heapTotal / 1024 / 1024)} MB`,
          heapUsed: `${Math.round(memoryUsage.heapUsed / 1024 / 1024)} MB`,
        },
        persistence: {
          enabled: true,
          saveInterval: '5 seconds',
        },
        performance: {
          pipelining: true,
          batchProcessing: true,
          caching: true,
          workers: true
        }
      };

      const statsEndTime = process.hrtime.bigint();
      const statsExecutionTime = Number(statsEndTime - statsStartTime) / 1000;
      socket.write(`${JSON.stringify(stats, null, 2)} (${statsExecutionTime.toFixed(2)} μs)\n`);
      break;

    case 'HELP':
      socket.write('Available commands:\n');
      socket.write('  SET key "value" [EX seconds] - Set key to value with optional expiration\n');
      socket.write('  GET key - Get value of key\n');
      socket.write('  DEL key - Delete key\n');
      socket.write('  TTL key - Get time-to-live of key in seconds\n');
      socket.write('  SAVE - Force save to disk\n');
      socket.write('  STATS - Show database statistics\n');
      socket.write('  PING - Test server connection\n');
      socket.write('  QUIT - Close connection\n');
      socket.write(`  JSON.SET key json_object [EX seconds] - Set key to a JSON object with optional expiration\n`);
      socket.write('  JSON.SET key field "value" - Set a specific field in a JSON object (value must be double-quoted)\n');
      socket.write('  JSON.GET key [path1 path2 path3 ...] - Get a JSON object or specific field using path (output does not include +)\n');
      socket.write('  JSON.DEL key [field] - Delete a JSON object or a specific field within it\n');
      socket.write('  JSON.UPDATE key path1 "value1" & path2 "value2" ... - Update multiple specific fields within a JSON object (values must be double-quoted)\n');
      break;

    case 'JSON.SET':
      // JSON.SET key '{"json":"object"}' [EX seconds]
      // JSON.SET key field "value"
      if (parts.length < 3) {
        socket.write('-ERR wrong number of arguments for JSON.SET command\n');
        return;
      }
      const jsonSetKey = parts[1];

      // Check for optional EX seconds at the end of the command
      // Original parts array length might be 3 (JSON.SET key value) or 5 (JSON.SET key value EX seconds)
      // For JSON.SET key field value, it would be 4, or 6 with EX seconds.
      const lastPart = parts[parts.length - 1];
      const secondLastPart = parts[parts.length - 2];

      if (secondLastPart && secondLastPart.toUpperCase() === 'EX') {
        const parsedTtl = parseInt(lastPart);
        if (isNaN(parsedTtl) || parsedTtl <= 0) {
          socket.write('-ERR invalid expire time for JSON.SET\n');
          return;
        }
        ttl = parsedTtl;
        // Remove EX and seconds from parts for subsequent length checks
        parts.splice(parts.length - 2, 2);
      }

      // After handling EX, parts.length should be 3 for full JSON object, or 4 for field update.
      if (parts.length === 3) { // Full JSON object assignment (JSON.SET key '{value}')
        // We need to re-extract the exact value from the original commandStr to enforce quoting.
        const jsonValueStartIndex = commandStr.indexOf(jsonSetKey) + jsonSetKey.length + 1;
        let quotedValueMatch = commandStr.substring(jsonValueStartIndex).match(/^'(.*)'|^"((?:[^"\\]|\\.)*)"/);

        if (!quotedValueMatch) {
            socket.write('-ERR JSON.SET command value must be quoted\n');
            return;
        }
        const fullJsonString = quotedValueMatch[1] || quotedValueMatch[2];

        try {
          const jsonValue = JSON.parse(fullJsonString);
          commandQueue.add(
            { operation: 'JSON.SET', key: jsonSetKey, value: jsonValue, ttl },
            (err, result) => {
              if (err) {
                socket.write(`-ERR ${err.message}\n`);
              } else {
                if (DEBUG) {
                  socket.write(`${result.status} (${result.executionTime.toFixed(2)} μs)\n`);
                } else {
                  socket.write(`${result.status}\n`);
                }
              }
            }
          );
        } catch (e) {
          socket.write(`-ERR invalid JSON string: ${e.message}\n`);
          return;
        }
      } else if (parts.length === 4) { // JSON.SET key field "value" (after trimming EX seconds if present)
        // This is a JSON field update, e.g., JSON.SET key field "value"
        const field = parts[2];
        // The raw value is parts[3]. We still need to check the original commandStr to ensure the field value was quoted.
        const fieldStartIndex = commandStr.indexOf(field, commandStr.indexOf(jsonSetKey)) + field.length + 1;
        let fieldValueMatch = commandStr.substring(fieldStartIndex).match(/^"([^"]*)"|'([^']*)'/);

        if (!fieldValueMatch) {
            socket.write('-ERR JSON.SET field value must be quoted\n');
            return;
        }
        // Use the value from `parts[3]` as `parseCommandArgs` has already stripped quotes and unescaped.
        const rawFieldValue = parts[3];

        let fieldValue;
        try {
          // Attempt to parse the raw field value as JSON, otherwise treat as string.
          fieldValue = JSON.parse(rawFieldValue);
        } catch (e) {
          fieldValue = rawFieldValue; // If not valid JSON, treat as a literal string
        }

        commandQueue.add(
          { operation: 'JSON.SET_FIELD', key: jsonSetKey, field, value: fieldValue, ttl },
          (err, result) => {
            if (err) {
              socket.write(`-ERR ${err.message}\n`);
            } else {
              if (DEBUG) {
                socket.write(`${result.status} (${result.executionTime.toFixed(2)} μs)\n`);
              } else {
                socket.write(`${result.status}\n`);
              }
            }
          }
        );
      } else {
          socket.write('-ERR wrong number of arguments for JSON.SET command or malformed value\n');
          return;
      }
      break;

    case 'JSON.GET':
      if (parts.length !== 2) {
        socket.write('-ERR wrong number of arguments for JSON.GET command\n');
        return;
      }
      const jsonGetKey = parts[1];
      const jsonGetPaths = parts.slice(2); // Remaining parts are paths

      commandQueue.add(
        { operation: 'JSON.GET', key: jsonGetKey, paths: jsonGetPaths },
        (err, result) => {
          if (err) {
            socket.write(`-ERR ${err.message}\n`);
          } else {
            const { value, executionTime } = result;
            if (value === null) {
              if (DEBUG) {
                socket.write(`$-1 (${executionTime.toFixed(2)} μs)\n`);
              } else {
                socket.write(`$-1\n`);
              }
            } else {
              const valueStr = typeof value === 'object' ? JSON.stringify(value) : value.toString();
              if (DEBUG) {
                socket.write(`${valueStr} (${executionTime.toFixed(2)} μs)\n`);
              } else {
                socket.write(`${valueStr}\n`);
              }
            }
          }
        }
      );
      break;

    case 'JSON.DEL':
        // JSON.DEL key [field]
        if (parts.length < 2 || parts.length > 3) {
            socket.write('-ERR wrong number of arguments for JSON.DEL command\n');
            return;
        }
        const jsonDelKey = parts[1];
        const jsonDelField = parts[2] || null; // Optional field

        commandQueue.add(
            { operation: 'JSON.DEL', key: jsonDelKey, field: jsonDelField },
            (err, result) => {
                if (err) {
                    socket.write(`-ERR ${err.message}\n`);
                } else {
                    if (DEBUG) {
                        socket.write(`:${result.value} (${result.executionTime.toFixed(2)} μs)\n`);
                    } else {
                        socket.write(`:${result.value}\n`);
                    }
                }
            }
        );
        break;

    case 'JSON.UPDATE':
        // JSON.UPDATE key path1 "value1" & path2 "value2" ...
        if (parts.length < 4) { // Minimum: JSON.UPDATE key path "value"
            socket.write('-ERR wrong number of arguments for JSON.UPDATE command\n');
            return;
        }
        const jsonUpdateKey = parts[1];
        const updates = {};

        // Start parsing from the first path/value pair after the key
        // We expect pairs of (path, value), separated by optional '&'
        let i = 2; // Start after command and key
        while (i < parts.length) {
            const path = parts[i];
            if (path === '&') {
                // This '&' is unexpected here, implies a syntax error like `JSON.UPDATE key & path value`
                socket.write('-ERR malformed JSON.UPDATE command: unexpected '&' at position ' + (i + 1) + '\n');
                return;
            }
            i++; // Move to value

            if (i >= parts.length) {
                socket.write('-ERR malformed JSON.UPDATE command: missing value for path ' + path + '\n');
                return;
            }
            const rawValue = parts[i];
            updates[path] = rawValue; // parseCommandArgs already stripped quotes

            i++; // Move to next token

            if (i < parts.length) {
                // If there are more tokens, the next one *must* be '&'
                if (parts[i] === '&') {
                    i++; // Consume the '&' and continue to the next pair
                } else {
                    // Unexpected token (e.g., `JSON.UPDATE key path value another_arg`)
                    socket.write('-ERR malformed JSON.UPDATE command: expected '&' or end of command after value ' + rawValue + '\n');
                    return;
                }
            }
        }

        if (Object.keys(updates).length === 0) {
            socket.write('-ERR malformed JSON.UPDATE command: no update pairs found\n');
            return;
        }

        commandQueue.add(
            { operation: 'JSON.UPDATE', key: jsonUpdateKey, updates },
            (err, result) => {
                if (err) {
                    socket.write(`-ERR ${err.message}\n`);
                } else {
                    if (DEBUG) {
                        socket.write(`${result.status} (${result.executionTime.toFixed(2)} μs)\n`);
                    } else {
                        socket.write(`${result.status}\n`);
                    }
                }
            }
        );
        break;

    case 'QUIT':
      socket.write('BYE\n');
      socket.end();
      break;

    default:
      socket.write(`-ERR unknown command '${command}'\n`);
      break;
  }
}

// Function to handle graceful shutdown
async function gracefulShutdown() {
  console.log('Initiating graceful shutdown...');
  commandQueue.shuttingDown = true; // Prevent new commands from being added

  // Wait for all pending commands to be processed
  await commandQueue.waitForEmpty();

  // Save data to disk before exiting
  console.log('Saving data to disk...');
  try {
    const success = await db.saveData(true);
    if (success) {
      console.log('Data saved successfully.');
    } else {
      console.error('Failed to save data during shutdown.');
    }
  } catch (error) {
    console.error('Error during data save on shutdown:', error);
  }

  // Close the server
  server.close(() => {
    console.log('Nuke-KV server shut down.');
    process.exit(0); // Exit cleanly
  });

  // Force close if it takes too long
  setTimeout(() => {
    console.warn('Forcing shutdown due to timeout.');
    process.exit(1);
  }, 5000); // 5 seconds timeout
}

// Handle process termination signals
process.on('SIGINT', gracefulShutdown);
process.on('SIGTERM', gracefulShutdown);

const PORT = 6380;

// Load data on startup
db.loadData().then(() => {
  server.listen(PORT, () => {
    console.log(`Nuke-KV server is active and listening on port ${PORT}`);
  });
}).catch(error => {
  console.error('Error loading data from file:', error.message);
  // If there's an error loading data, we can decide to exit or start with an empty DB.
  // For now, let's assume an empty DB is fine if loading fails.
  // The specific rule about empty `nukekv.db` needs to be addressed too.
  console.log('Attempting to start server with empty database due to load error.');
  server.listen(PORT, () => {
    console.log(`Nuke-KV server is active and listening on port ${PORT} (started with empty DB due to load error)`);
  });
});

