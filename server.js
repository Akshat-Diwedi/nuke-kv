// server.js
const net = require('net');
const db = require('./db');
const { parseValue } = require('./utils');

// Command queue for pipelining
class CommandQueue {
  constructor(maxBatchSize = 1000, maxWaitMs = 50) {
    this.queue = [];
    this.maxBatchSize = maxBatchSize;
    this.maxWaitMs = maxWaitMs;
    this.timer = null;
    this.callbacks = new Map();
    this.nextId = 1;
  }

  add(command, callback) {
    const id = this.nextId++;
    this.queue.push({ id, ...command });
    this.callbacks.set(id, callback);
    
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
    if (this.queue.length === 0) return;
    
    const batch = this.queue;
    this.queue = [];
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
        }
      }
    } catch (error) {
      // Handle errors
      for (const { id } of batch) {
        const callback = this.callbacks.get(id);
        if (callback) {
          callback(error);
          this.callbacks.delete(id);
        }
      }
    }
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

// Process a command
async function processCommand(commandStr, socket) {
  const parts = commandStr.split(' ');
  const command = parts[0].toUpperCase();
  
  switch (command) {
    case 'PING':
      socket.write('+PONG\n');
      break;
      
    case 'SET':
      if (parts.length < 3) {
        socket.write('-ERR wrong number of arguments for SET command\n');
        return;
      }
      
      const key = parts[1];
      const value = await parseValue(parts.slice(2).join(' '));
      let ttl = null;
      const exIndex = parts.indexOf('EX');
      if (exIndex > 0 && parts.length > exIndex + 1) {
        ttl = parseInt(parts[exIndex + 1]);
        if (isNaN(ttl)) {
          socket.write('-ERR invalid expire time in SET\n');
          return;
        }
      }
      
      // Queue the SET command
      commandQueue.add(
        { operation: 'SET', key, value, ttl },
        (err, result) => {
          if (err) {
            socket.write(`-ERR ${err.message}\n`);
          } else {
            socket.write(`${result.status} (${result.executionTime.toFixed(2)} μs)\n`);
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
              socket.write(`$-1 (${executionTime.toFixed(2)} μs)\n`);
            } else {
              const valueStr = typeof value === 'object' ? JSON.stringify(value) : value.toString();
              socket.write(`+${valueStr} (${executionTime.toFixed(2)} μs)\n`);
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
            socket.write(`:${result.value} (${result.executionTime.toFixed(2)} μs)\n`);
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
            socket.write(`:${result.value} (${result.executionTime.toFixed(2)} μs)\n`);
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
          socket.write(`+OK (${executionTime.toFixed(2)} μs)\n`);
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
      socket.write(`+${JSON.stringify(stats, null, 2)} (${statsExecutionTime.toFixed(2)} μs)\n`);
      break;
      
    case 'CLRCACHE':
      if (parts.length !== 1) {
        socket.write('-ERR wrong number of arguments for CLRCACHE command\n');
        return;
      }
      commandQueue.add(
        { operation: 'CLRCACHE' },
        (err, result) => {
          if (err) {
            socket.write(`-ERR ${err.message}\n`);
          } else {
                        socket.write(`${result.status} ${result.message} (${result.executionTime ? result.executionTime.toFixed(2) : 'N/A'} μs)\n`);
          }
        }
      );
      break;


      
    case 'HELP':
      socket.write('+Available commands:\n');
      socket.write('  SET key value [EX seconds] - Set key to value with optional expiration\n');
      socket.write('  GET key - Get value of key\n');
      socket.write('  DEL key - Delete key\n');
      socket.write('  TTL key - Get time-to-live of key in seconds\n');
      socket.write('  SAVE - Force save to disk\n');
      socket.write('  STATS - Show database statistics\n');

      socket.write('  PING - Test server connection\n');
      socket.write('  QUIT - Close connection\n');
      socket.write('  CLRCACHE - Clears the in-memory cache\n');
      socket.write('  JSON.SET key {\"json\":\"object\"} - Set key to a JSON object\n');
      socket.write('  JSON.SET key field value - Set a specific field in a JSON object\n');
      socket.write('  JSON.GET key [IYKYK field1 AND field2 ...] - Get a JSON object or specific fields\n');
      socket.write('  JSON.PRETTY key - Get a JSON value in a pretty, readable format\n');
      socket.write('  JSON.DEL key [field] - Delete a JSON object or a specific field within it\n');
      break;

    case 'JSON.SET':
      // JSON.SET key 'json_string_with_spaces'
      // JSON.SET key path 'value_string_with_spaces'
      if (parts.length < 3) {
        socket.write("-ERR wrong number of arguments for 'JSON.SET' command. Min 3 args required. Usage: JSON.SET key 'json_string' OR JSON.SET key path 'value_string'\n");
        return;
      }
      const jsonSetKey = parts[1];
      let jsonSetPath = null;
      let valueToSetRaw;
      let valueToSet;

      // Try to parse as: JSON.SET key 'json_string'
      // The json_string starts at parts[2] and might contain spaces
      valueToSetRaw = parts.slice(2).join(' ');
      if (valueToSetRaw.startsWith("'") && valueToSetRaw.endsWith("'")) {
        valueToSet = valueToSetRaw.substring(1, valueToSetRaw.length - 1);
        // This is JSON.SET key 'json_string'
      } else if (parts.length >= 4) {
        // Try to parse as: JSON.SET key path 'value_string'
        // Path is parts[2], value_string starts at parts[3]
        jsonSetPath = parts[2];
        valueToSetRaw = parts.slice(3).join(' ');
        if (valueToSetRaw.startsWith("'") && valueToSetRaw.endsWith("'")) {
          valueToSet = valueToSetRaw.substring(1, valueToSetRaw.length - 1);
        } else {
          socket.write("-ERR value for JSON.SET with path must be a single-quoted string. Usage: JSON.SET key path 'value_string'\n");
          return;
        }
      } else {
        // Not enough parts for path 'value_string' and not a valid 'json_string' format
        socket.write("-ERR invalid arguments for 'JSON.SET' command. Value must be a single-quoted string. Usage: JSON.SET key 'json_string' OR JSON.SET key path 'value_string'\n");
        return;
      }

      commandQueue.add(
        {
          operation: 'JSON.SET',
          key: jsonSetKey,
          value: jsonSetPath ? null : valueToSet, // Full JSON string if no path
          path: jsonSetPath,                     // The JSONPath
          fieldValue: jsonSetPath ? valueToSet : null // Value for the path if path is specified
        },
        (err, result) => {
          if (err || (result && result.status === 'ERROR')) {
            socket.write(`-ERR ${result && result.message ? result.message : (err ? err.message : 'Error setting JSON')}\n`);
          } else if (result) {
            socket.write(`${result.status} (${result.executionTime.toFixed(2)} μs)\n`);
          } else {
            socket.write(`-ERR Unknown error during JSON.SET\n`);
          }
        }
      );
      break;

    case 'JSON.GET':
      // JSON.GET key [path]
      if (parts.length < 2 || parts.length > 3) {
        socket.write("-ERR wrong number of arguments for 'JSON.GET' command. Usage: JSON.GET key [path]\n");
        return;
      }
      const jsonGetKey = parts[1];
      const getPath = parts.length === 3 ? parts[2] : '$'; // Default path to '$' (root)
      
      commandQueue.add(
        { operation: 'JSON.GET', key: jsonGetKey, value: getPath }, // 'value' carries the path for jsonGetInternal
        (err, result) => {
          if (err || (result && result.status === 'ERROR')) {
             socket.write(`-ERR ${result && result.message ? result.message : (err ? err.message : 'Error getting JSON')}\n`);
          } else if (result) {
            const { value, executionTime } = result;
            if (value === null || typeof value === 'undefined') { // Check for undefined explicitly for path not found
              socket.write(`(nil) (${executionTime.toFixed(2)} μs)\n`);
            } else {
              const valueStr = typeof value === 'object' ? JSON.stringify(value) : value.toString();
              socket.write(`+${valueStr} (${executionTime.toFixed(2)} μs)\n`);
            }
          } else {
             socket.write(`-ERR Unknown error during JSON.GET\n`);
          }
        }
      );
      break;

    case 'JSON.PRETTY':
      if (parts.length !== 2) {
        socket.write("-ERR wrong number of arguments for 'JSON.PRETTY' command\r\n");
        return;
      }
      commandQueue.add(
        { operation: 'JSON.PRETTY', key: parts[1] },
        (err, result) => {
          if (err || result.status === 'ERROR') {
            socket.write(`-ERR ${result.message || (err ? err.message : 'Error pretty printing JSON')}\r\n`);
          } else {
            // The result.value from jsonPrettyInternal is already a string (pretty JSON or error message)
            socket.write(`+${result.value}\r\n(${result.executionTime.toFixed(2)} μs)\r\n`);
          }
        }
      );
      break;

    case 'JSON.DEL':
      if (parts.length < 2 || parts.length > 3) {
        socket.write('-ERR wrong number of arguments for JSON.DEL command. Usage: JSON.DEL key [field]\n');
        return;
      }
      const jsonDelKey = parts[1];
      const jsonDelField = parts.length === 3 ? parts[2] : null;

      commandQueue.add(
        { operation: 'JSON.DEL', key: jsonDelKey, value: jsonDelField }, // 'value' will carry the field to delete, or null
        (err, result) => {
          if (err || result.status === 'ERROR') {
            socket.write(`-ERR ${result.message || (err ? err.message : 'Error deleting JSON/field')}\n`);
          } else {
            // JSON.DEL in db.js returns { value: 1 } for success, { value: 0 } for not found/no-op
            socket.write(`:${result.value} (${result.executionTime.toFixed(2)} μs)\n`);
          }
        }
      );
      break;

    case 'QUIT':
      socket.end('+OK\n');
      break;

    default:
      socket.write(`-ERR unknown command '${command}'\n`);
  }
}

// Start server
const PORT = process.env.NUKE_KV_PORT || 6380;
server.listen(PORT, () => {
  console.log(`Nuke-KV server is active and listening on port ${PORT}`); // Standardized listening message
  db.loadData(); // Load data from disk when server starts
});

// Handle server errors
server.on('error', (err) => {
  console.error('Server error:', err);
});

// Handle process termination
process.on('SIGINT', () => {
  console.log('Shutting down server...');
  server.close(() => {
    console.log('Server closed');
    process.exit(0);
  });
});