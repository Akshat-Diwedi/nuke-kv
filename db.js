// db.js
const { saveToFile, loadFromFile, parseValue } = require('./utils');
const { Worker, isMainThread, parentPort, workerData } = require('worker_threads');
const os = require('os');

// In-memory cache with LRU functionality
class LRUCache {
  constructor(maxSize = 10000) {
    this.cache = new Map();
    this.maxSize = maxSize;
  }
  
  get(key) {
    if (!this.cache.has(key)) return null;
    
    // Get the value and refresh its position in the cache
    const value = this.cache.get(key);
    this.cache.delete(key);
    this.cache.set(key, value);
    return value;
  }
  
  set(key, value) {
    // If key exists, refresh its position
    if (this.cache.has(key)) {
      this.cache.delete(key);
    } 
    // If cache is full, remove the oldest item (first item in the map)
    else if (this.cache.size >= this.maxSize) {
      const oldestKey = this.cache.keys().next().value;
      this.cache.delete(oldestKey);
    }
    
    this.cache.set(key, value);
  }

  delete(key) {
    return this.cache.delete(key);
  }

  has(key) {
    return this.cache.has(key);
  }

  clear() {
    this.cache.clear();
  }

  get size() {
    return this.cache.size;
  }

  // Convert to regular Map for operations that need Map interface
  toMap() {
    return new Map(this.cache);
  }
}

// Main data store
let store = new LRUCache(1000000); // 1M entries max
let ttlMap = new Map();

// Batch operation queue for persistence
let pendingWrites = new Map();
let pendingDeletes = new Set();
let lastSaveTime = Date.now();
let saveInProgress = false;
let saveInterval = 5000; // 5 seconds between saves
let dirtyFlag = false;

// Worker pool for parallel operations
class WorkerPool {
  constructor(numWorkers = Math.max(1, os.cpus().length - 1)) {
    this.workers = [];
    this.taskQueue = [];
    this.numWorkers = numWorkers;
    this.initialize();
  }

  initialize() {
    for (let i = 0; i < this.numWorkers; i++) {
      const worker = new Worker(`${__dirname}/worker.js`);
      
      worker.on('message', (result) => {
        const task = this.taskQueue.shift();
        if (task) {
          task.resolve(result);
        }
        
        // Process next task if available
        if (this.taskQueue.length > 0) {
          const nextTask = this.taskQueue[0];
          worker.postMessage(nextTask.data);
        } else {
          // No more tasks, worker is idle
          this.workers.push(worker);
        }
      });
      
      worker.on('error', (err) => {
        const task = this.taskQueue.shift();
        if (task) {
          task.reject(err);
        }
        
        // Replace the crashed worker
        this.workers = this.workers.filter(w => w !== worker);
        this.initialize();
      });
      
      this.workers.push(worker);
    }
  }

  runTask(data) {
    return new Promise((resolve, reject) => {
      const task = { data, resolve, reject };
      
      if (this.workers.length > 0) {
        const worker = this.workers.pop();
        this.taskQueue.push(task);
        worker.postMessage(data);
      } else {
        // All workers are busy, queue the task
        this.taskQueue.push(task);
      }
    });
  }

  terminate() {
    for (const worker of this.workers) {
      worker.terminate();
    }
    this.workers = [];
  }
}

// Create worker pool if we're in the main thread
let workerPool;
if (isMainThread) {
  workerPool = new WorkerPool();
}

// Load data from persistent storage on startup
async function loadData() {
  const data = loadFromFile();
  if (data) {
    try {
      // Restore store data
      if (data.store) {
        for (const [key, value] of Object.entries(data.store)) {
          store.set(key, value);
        }
      }
      
      // Restore TTL data
      if (data.ttl) {
        for (const [key, expireAt] of Object.entries(data.ttl)) {
          const now = Date.now();
          if (expireAt > now) {
            ttlMap.set(key, parseInt(expireAt));
            setTimeout(() => {
              store.delete(key);
              ttlMap.delete(key);
            }, expireAt - now);
          } else {
            // Already expired
            store.delete(key);
          }
        }
      }
      console.log('Data loaded from persistent storage');
    } catch (err) {
      console.error('Error restoring data:', err);
    }
  }
}

// Save data to persistent storage (optimized to only save changes)
async function saveData(force = false) {
  // Don't save if another save is in progress unless forced
  if (saveInProgress && !force) return false;
  
  // Don't save if no changes and not forced
  if (!dirtyFlag && !force) return true;
  
  // Don't save too frequently unless forced
  const now = Date.now();
  if (!force && now - lastSaveTime < saveInterval) return false;
  
  saveInProgress = true;
  lastSaveTime = now;
  
  try {
    // Load existing data first
    const existingData = loadFromFile() || { store: {}, ttl: {} };
    
    // Apply pending writes
    for (const [key, value] of pendingWrites.entries()) {
      existingData.store[key] = value;
    }
    
    // Apply pending deletes
    for (const key of pendingDeletes) {
      delete existingData.store[key];
      delete existingData.ttl[key];
    }
    
    // Update TTL map
    for (const [key, expireAt] of ttlMap.entries()) {
      existingData.ttl[key] = expireAt;
    }
    
    // Remove expired TTLs
    for (const [key, expireAt] of Object.entries(existingData.ttl)) {
      if (expireAt < now) {
        delete existingData.ttl[key];
        delete existingData.store[key];
      }
    }
    
    // Save to file
    const result = saveToFile(existingData);
    
    // Clear pending operations
    pendingWrites.clear();
    pendingDeletes.clear();
    dirtyFlag = false;
    
    return result;
  } catch (err) {
    console.error('Error saving data:', err);
    return false;
  } finally {
    saveInProgress = false;
  }
}

// Batch processing function for multiple commands
async function processBatch(commands) {
  const results = [];
  const batchStartTime = process.hrtime.bigint();
  
  for (const cmd of commands) {
    const { operation, key, value, ttl } = cmd;
    let result;
    
    switch (operation) {
      case 'SET':
        result = await setInternal(key, value, ttl);
        break;
      case 'GET':
        result = await getInternal(key);
        break;
      case 'DEL':
        result = await delInternal(key);
        break;
      case 'TTL':
        result = await ttlInternal(key);
        break;
      case 'JSON.SET':
        result = await jsonSetInternal(key, value, cmd.field, cmd.fieldValue);
        break;
      case 'JSON.GET':
        result = await jsonGetInternal(key, value); // value here will be the field selectors
        break;
      case 'JSON.PRETTY':
        result = await jsonPrettyInternal(key);
        break;
      case 'CLRCACHE':
        result = await clearCacheInternal();
        break;
      case 'JSON.DEL':
        result = await jsonDelInternal(key, value); // value here will be the field to delete
        break; 
        default:
        result = { status: 'ERROR', message: 'Unsupported operation' };
    }
    
    results.push(result);
  }
  
  const batchEndTime = process.hrtime.bigint();
  const batchExecutionTime = Number(batchEndTime - batchStartTime) / 1000;
  
  return { results, batchExecutionTime };
}

// Internal optimized functions
async function setInternal(key, value, ttl = null) {
  const startTime = process.hrtime.bigint();
  
  store.set(key, value);
  pendingWrites.set(key, value);
  dirtyFlag = true;
  
  if (ttl) {
    const expireAt = Date.now() + ttl * 1000;
    ttlMap.set(key, expireAt);
    
    // Set timeout to remove expired key
    setTimeout(() => {
      store.delete(key);
      ttlMap.delete(key);
      pendingDeletes.add(key);
      dirtyFlag = true;
    }, ttl * 1000);
  }
  
  const endTime = process.hrtime.bigint();
  const executionTime = Number(endTime - startTime) / 1000;
  
  return { status: "+OK", executionTime };
}

async function getInternal(key) {
  const startTime = process.hrtime.bigint();
  
  let result = null;
  
  // Check if key has expired
  if (ttlMap.has(key)) {
    const expireTime = ttlMap.get(key);
    if (Date.now() > expireTime) {
      // Key has expired, remove it
      store.delete(key);
      ttlMap.delete(key);
      pendingDeletes.add(key);
      dirtyFlag = true;
    } else {
      // Key exists and has not expired
      result = store.get(key);
    }
  } else {
    // Key might exist without TTL
    result = store.get(key);
  }
  
  const endTime = process.hrtime.bigint();
  const executionTime = Number(endTime - startTime) / 1000;
  
  return { value: result, executionTime };
}

async function delInternal(key) {
  const startTime = process.hrtime.bigint();
  
  ttlMap.delete(key);
  const deleted = store.delete(key);
  
  if (deleted) {
    pendingDeletes.add(key);
    dirtyFlag = true;
  }
  
  const endTime = process.hrtime.bigint();
  const executionTime = Number(endTime - startTime) / 1000;
  
  return { value: deleted ? 1 : 0, executionTime };
}

async function ttlInternal(key) {
  const startTime = process.hrtime.bigint();
  
  let result;
  if (!ttlMap.has(key)) {
    // Check if key exists at all
    result = store.has(key) ? -1 : -2;
  } else {
    const remaining = Math.floor((ttlMap.get(key) - Date.now()) / 1000);
    result = remaining > 0 ? remaining : -2;
  }
  
  const endTime = process.hrtime.bigint();
  const executionTime = Number(endTime - startTime) / 1000;
  
  return { value: result, executionTime };
}

// Helper function to get a value from an object using a path string
function getValueByPath(obj, path) {
  if (!path || path === '$') return obj;

  // Normalize path: remove leading '$.' if present
  const normalizedPath = path.startsWith('$.') ? path.substring(2) : path;
  
  // Split path by dots and array accessors
  // e.g., "a.b[0].c" -> ["a", "b", "[0]", "c"]
  const segments = normalizedPath.match(/[^\.[\]]+|\[\d+\]/g);

  if (!segments) return undefined; // Invalid path format

  let current = obj;
  for (const segment of segments) {
    if (current === null || typeof current === 'undefined') return undefined;

    if (segment.startsWith('[') && segment.endsWith(']')) {
      const index = parseInt(segment.substring(1, segment.length - 1));
      if (Array.isArray(current) && index >= 0 && index < current.length) {
        current = current[index];
      } else {
        return undefined; // Not an array or index out of bounds
      }
    } else {
      if (typeof current === 'object' && current !== null && Object.prototype.hasOwnProperty.call(current, segment)) {
        current = current[segment];
      } else {
        return undefined; // Not an object or property does not exist
      }
    }
  }
  return current;
}

// Helper function to set a value in an object using a path string
function setValueByPath(obj, path, value) {
  if (!path || path === '$') { // Cannot set the root object itself this way, must be a path
    if (path === '$' && typeof value === 'object' && value !== null) {
      // Special case: if path is '$', replace the entire object content
      // This is a bit of a hack to allow root replacement through this function if needed
      // but jsonSetInternal should handle root replacement separately for clarity.
      Object.keys(obj).forEach(key => delete obj[key]);
      Object.assign(obj, value);
      return true;
    }
    return false; // Invalid path for setting or not an object to merge for root
  }

  const normalizedPath = path.startsWith('$.') ? path.substring(2) : path;
  const segments = normalizedPath.match(/[^\.[\]]+|\[\d+\]/g);

  if (!segments) return false; // Invalid path format

  let current = obj;
  for (let i = 0; i < segments.length - 1; i++) {
    const segment = segments[i];
    const nextSegment = segments[i+1];
    let segmentKey;
    let isArrayIndex = false;

    if (segment.startsWith('[') && segment.endsWith(']')) {
      segmentKey = parseInt(segment.substring(1, segment.length - 1));
      isArrayIndex = true;
      if (!Array.isArray(current) || segmentKey < 0) return false; // Current is not an array or invalid index
    } else {
      segmentKey = segment;
    }

    let nextIsArrayIndex = nextSegment.startsWith('[') && nextSegment.endsWith(']');

    if (isArrayIndex) { // current segment is an array index
      if (segmentKey >= current.length) { // index out of bounds, try to extend array
        if (nextIsArrayIndex) current[segmentKey] = []; else current[segmentKey] = {};
      } else if (typeof current[segmentKey] !== 'object' || current[segmentKey] === null) {
         // if element exists but is not an object/array, create one
        if (nextIsArrayIndex) current[segmentKey] = []; else current[segmentKey] = {};
      }
      current = current[segmentKey];
    } else { // current segment is an object key
      if (!Object.prototype.hasOwnProperty.call(current, segmentKey) || typeof current[segmentKey] !== 'object' || current[segmentKey] === null) {
        if (nextIsArrayIndex) current[segmentKey] = []; else current[segmentKey] = {};
      }
      current = current[segmentKey];
    }
    if (typeof current !== 'object' || current === null) return false; // Path traversal failed
  }

  // Set the value at the final segment
  const lastSegment = segments[segments.length - 1];
  if (lastSegment.startsWith('[') && lastSegment.endsWith(']')) {
    const index = parseInt(lastSegment.substring(1, lastSegment.length - 1));
    if (Array.isArray(current) && index >= 0) {
      current[index] = value;
    } else if (Array.isArray(current) && index === current.length) { // append to array
      current.push(value);
    } else { 
      return false; // Not an array or invalid index for setting
    }
  } else {
    current[lastSegment] = value;
  }
  return true;
}

async function jsonSetInternal(key, jsonValue, path, fieldValueToSet) {
  const startTime = process.hrtime.bigint();
  try {
    let finalJsonString;
    if (path) { // Setting a specific field/path
      let existingJsonString = store.get(key);
      let jsonObj = {};
      if (existingJsonString) {
        try {
          jsonObj = JSON.parse(existingJsonString);
        } catch (e) {
          // If existing value is not valid JSON, it's an error to set a path
          const endTime = process.hrtime.bigint();
          const executionTime = Number(endTime - startTime) / 1000;
          return { status: "ERROR", message: `Key '${key}' does not hold a JSON object.`, executionTime };
        }
      }
      // Parse the fieldValueToSet as it comes as a string from the command
      const parsedFieldValue = parseValue(fieldValueToSet);
      if (!setValueByPath(jsonObj, path, parsedFieldValue)) {
        const endTime = process.hrtime.bigint();
        const executionTime = Number(endTime - startTime) / 1000;
        return { status: "ERROR", message: `Invalid path '${path}' or failed to set value.`, executionTime };
      }
      finalJsonString = JSON.stringify(jsonObj);
    } else { // Setting the entire JSON object (jsonValue is the new JSON string)
      JSON.parse(jsonValue); // Validate JSON string
      finalJsonString = jsonValue; // Store as string
    }
    store.set(key, finalJsonString);
    pendingWrites.set(key, finalJsonString);
    dirtyFlag = true;

    // Clear any existing TTL for this key if we're overwriting with JSON
    if (ttlMap.has(key)) {
      ttlMap.delete(key);
      // No need to schedule a timeout for deletion as there's no new TTL
    }

    const endTime = process.hrtime.bigint();
    const executionTime = Number(endTime - startTime) / 1000;
    return { status: "+OK", executionTime };
  } catch (e) {
    const endTime = process.hrtime.bigint();
    const executionTime = Number(endTime - startTime) / 1000;
    let message = "Invalid JSON format or error during set operation.";
    if (e instanceof SyntaxError && path) {
        message = `Invalid JSON value provided for path '${path}'.`;
    } else if (e instanceof SyntaxError) {
        message = "Invalid JSON format for the whole value.";
    } else if (path) {
        message = `Error setting value at path '${path}': ${e.message}`;
    }
    return { status: "ERROR", message, executionTime };
  }
}

async function jsonGetInternal(key, path) { // path replaces fields
  const startTime = process.hrtime.bigint();
  let result = null;

  if (ttlMap.has(key)) {
    const expireTime = ttlMap.get(key);
    if (Date.now() > expireTime) {
      store.delete(key);
      ttlMap.delete(key);
      pendingDeletes.add(key);
      dirtyFlag = true;
    } else {
      result = store.get(key);
    }
  } else {
    result = store.get(key);
  }

  if (result === null) {
    const endTime = process.hrtime.bigint();
    const executionTime = Number(endTime - startTime) / 1000;
    return { value: null, executionTime };
  }

  try {
    const jsonObj = JSON.parse(result);
    const valueAtPath = getValueByPath(jsonObj, path); // Use new helper

    const endTime = process.hrtime.bigint();
    const executionTime = Number(endTime - startTime) / 1000;
    // If path is specified and valueAtPath is undefined, it means path not found
    // If path is not specified (or '$'), valueAtPath is the whole object
    return { value: valueAtPath, executionTime }; 

  } catch (e) {
    // This catch is for when 'result' is not a valid JSON string.
    const endTime = process.hrtime.bigint();
    const executionTime = Number(endTime - startTime) / 1000;
    // If JSON.GET is used on a non-JSON value, it should error.
    return { status: "ERROR", message: `Value at key '${key}' is not a JSON object.`, executionTime };
  }
}

// Public API functions
async function set(key, value, ttl = null) {
  return setInternal(key, value, ttl);
}

async function get(key) {
  return getInternal(key);
}

async function del(key) {
  return delInternal(key);
}

async function ttlFunc(key) {
  return ttlInternal(key);
}

async function jsonDelInternal(key, field = null) {
  const startTime = process.hrtime.bigint();
  try {
    const existingJsonString = store.get(key);
    if (existingJsonString === null) {
      const endTime = process.hrtime.bigint();
      const executionTime = Number(endTime - startTime) / 1000;
      return { value: 0, executionTime }; // Key not found
    }

    if (field) {
      // Delete a specific field
      let jsonObj;
      try {
        jsonObj = JSON.parse(existingJsonString);
      } catch (e) {
        const endTime = process.hrtime.bigint();
        const executionTime = Number(endTime - startTime) / 1000;
        return { status: "ERROR", message: "Value at key is not valid JSON", executionTime };
      }

      if (Object.prototype.hasOwnProperty.call(jsonObj, field)) {
        delete jsonObj[field];
        const newJsonString = JSON.stringify(jsonObj);
        store.set(key, newJsonString);
        pendingWrites.set(key, newJsonString);
        dirtyFlag = true;
        const endTime = process.hrtime.bigint();
        const executionTime = Number(endTime - startTime) / 1000;
        return { value: 1, executionTime }; // Field deleted
      } else {
        const endTime = process.hrtime.bigint();
        const executionTime = Number(endTime - startTime) / 1000;
        return { value: 0, executionTime }; // Field not found
      }
    } else {
      // Delete the entire JSON object (equivalent to DEL key)
      ttlMap.delete(key);
      const deleted = store.delete(key);
      if (deleted) {
        pendingDeletes.add(key);
        dirtyFlag = true;
      }
      const endTime = process.hrtime.bigint();
      const executionTime = Number(endTime - startTime) / 1000;
      return { value: deleted ? 1 : 0, executionTime };
    }
  } catch (error) {
    // This catch block is for unexpected errors during the process, 
    // not for controlled outcomes like "key not found" or "invalid JSON format"
    const endTime = process.hrtime.bigint();
    const executionTime = Number(endTime - startTime) / 1000;
    console.error(`Error in jsonDelInternal for key '${key}' and field '${field}':`, error);
    return { status: "ERROR", message: "An unexpected error occurred during JSON.DEL operation.", executionTime };
  }
}

async function jsonPrettyInternal(key) {
  const startTime = process.hrtime.bigint();
  try {
    const jsonString = store.get(key);
    
    if (jsonString === null) { // LRUCache.get returns null if key not found
      const endTime = process.hrtime.bigint();
      const executionTime = Number(endTime - startTime) / 1000;
      return { value: null, executionTime }; // Key not found
    }
    
    // Ensure it's a valid JSON string before pretty printing
    const jsonObj = JSON.parse(jsonString);
    const prettyJsonString = JSON.stringify(jsonObj, null, 2); // 2 spaces for indentation
    const endTime = process.hrtime.bigint();
    const executionTime = Number(endTime - startTime) / 1000;
    return { value: prettyJsonString, executionTime };

  } catch (error) {
    const endTime = process.hrtime.bigint();
    const executionTime = Number(endTime - startTime) / 1000;
    // console.error(`Error in jsonPrettyInternal for key '${key}':`, error); // Avoid excessive logging for common cases like non-JSON value
    return { status: "ERROR", message: "Value is not a valid JSON object or an error occurred during formatting.", executionTime };
  }
}

// Initialize by loading data
if (isMainThread) {
  loadData();
  
  // Set up periodic saving (every 5 seconds by default)
  setInterval(async () => {
    if (dirtyFlag) {
      await saveData();
    }
  }, saveInterval);
  
  // Save data on process exit
  process.on('SIGINT', async () => {
    console.log('Saving data before exit...');
    await saveData(true);
    if (workerPool) workerPool.terminate();
    process.exit();
  });
  
  process.on('SIGTERM', async () => {
    console.log('Saving data before exit...');
    await saveData(true);
    if (workerPool) workerPool.terminate();
    process.exit();
  });
}


/**
 * Clears the in-memory cache and marks data as dirty for persistence.
 * @returns {object} - Status of the operation.
 */
function clearCacheInternal() {
  const startTime = process.hrtime.bigint();
  store.clear();
  ttlMap.clear();
  pendingWrites.clear();
  pendingDeletes.clear();
  dirtyFlag = true;
  const endTime = process.hrtime.bigint();
  const executionTime = Number(endTime - startTime) / 1000;
  return { status: '+OK', message: 'Cache cleared', executionTime };
}

// Export the functions and also expose the internal maps for stats
module.exports = {
  set,
  get,
  del,
  ttl: ttlFunc,
  saveData,
  loadData,
  processBatch,
  jsonSet: jsonSetInternal,
  jsonGet: jsonGetInternal,
  jsonDel: jsonDelInternal,
  jsonPretty: jsonPrettyInternal,
  clearCache: clearCacheInternal, // Renamed for external use
  // Expose internal maps for stats
  getStore: () => store.toMap(),
  getTtlMap: () => new Map(ttlMap)
};

//   _store: store,
//   _ttlMap: ttlMap
// };
