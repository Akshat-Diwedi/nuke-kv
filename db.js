// db.js
const { saveToFile, loadFromFile, parseValue } = require('./utils');
const { Worker, isMainThread, parentPort, workerData } = require('worker_threads');
const os = require('os');



// Constants for file operations
const DB_FILE = 'nukekv.db';
const SAVE_INTERVAL = 5000; // 5 seconds
const COMPRESSION_THRESHOLD = 10 * 1024 * 1024; // 10MB

// In-memory cache with LRU functionality
class LRUCache {
  constructor(maxSize = 10000) {
    this.cache = new Map();
    this.maxSize = maxSize;
    this.head = null;
    this.tail = null;
    this._currentSize = 0;
    this.maxEntrySize = 1024 * 1024; // 1MB per entry
  }

  // Node class for doubly linked list
  #Node = class {
    constructor(key, value) {
      this.key = key;
      this.value = value;
      this.prev = null;
      this.next = null;
      this.size = this.#calculateSize(value);
    }

    #calculateSize(value) {
      if (typeof value === 'string') return value.length;
      if (typeof value === 'object') return JSON.stringify(value).length;
      return 8; // Default size for numbers/booleans
    }
  }

  #moveToFront(node) {
    if (node === this.head) return;
    
    // Remove from current position
    if (node.prev) node.prev.next = node.next;
    if (node.next) node.next.prev = node.prev;
    if (node === this.tail) this.tail = node.prev;
    
    // Move to front
    node.next = this.head;
    node.prev = null;
    if (this.head) this.head.prev = node;
    this.head = node;
    if (!this.tail) this.tail = node;
  }

  get(key) {
    const node = this.cache.get(key);
    if (!node) return null;
    
    this.#moveToFront(node);
    return node.value;
  }

  set(key, value) {
    const node = new this.#Node(key, value);
    
    // Check if entry is too large
    if (node.size > this.maxEntrySize) {
      console.warn(`Entry too large (${node.size} bytes), skipping`);
      return false;
    }

    // If key exists, update and move to front
    if (this.cache.has(key)) {
      const oldNode = this.cache.get(key);
      this._currentSize -= oldNode.size;
      this.#moveToFront(node);
    } else {
      // Add to front
      node.next = this.head;
      if (this.head) this.head.prev = node;
      this.head = node;
      if (!this.tail) this.tail = node;
    }

    this.cache.set(key, node);
    this._currentSize += node.size;

    // Evict if necessary
    while (this._currentSize > this.maxSize && this.tail) {
      const oldestNode = this.tail;
      this._currentSize -= oldestNode.size;
      this.cache.delete(oldestNode.key);
      
      this.tail = oldestNode.prev;
      if (this.tail) this.tail.next = null;
      if (this.head === oldestNode) this.head = null;
    }

    return true;
  }

  delete(key) {
    const node = this.cache.get(key);
    if (!node) return false;

    this._currentSize -= node.size;
    this.cache.delete(key);

    if (node.prev) node.prev.next = node.next;
    if (node.next) node.next.prev = node.prev;
    if (node === this.head) this.head = node.next;
    if (node === this.tail) this.tail = node.prev;

    return true;
  }

  has(key) {
    return this.cache.has(key);
  }

  clear() {
    this.cache.clear();
    this.head = null;
    this.tail = null;
    this._currentSize = 0;
  }

  get size() {
    return this._currentSize;
  }

  toMap() {
    const map = new Map();
    for (const [key, node] of this.cache) {
      map.set(key, node.value);
    }
    return map;
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
    this.workerStates = new Map(); // Track worker states
    this.initialize();
  }

  initialize() {
    for (let i = 0; i < this.numWorkers; i++) {
      const worker = new Worker(`${__dirname}/worker.js`);
      const workerId = i;
      
      this.workerStates.set(workerId, {
        busy: false,
        lastTaskTime: 0,
        errorCount: 0,
        restartCount: 0
      });
      
      worker.on('message', (result) => {
        const state = this.workerStates.get(workerId);
        state.busy = false;
        state.lastTaskTime = Date.now();
        
        const task = this.taskQueue.shift();
        if (task) {
          task.resolve(result);
        }
        
        // Process next task if available
        if (this.taskQueue.length > 0) {
          const nextTask = this.taskQueue[0];
          worker.postMessage(nextTask.data);
          state.busy = true;
        } else {
          this.workers.push(worker);
        }
      });
      
      worker.on('error', (err) => {
        const state = this.workerStates.get(workerId);
        state.errorCount++;
        
        const task = this.taskQueue.shift();
        if (task) {
          task.reject(err);
        }
        
        // Replace the crashed worker if error count is too high
        if (state.errorCount > 5) {
          console.warn(`Worker ${workerId} had too many errors, replacing...`);
          this.workers = this.workers.filter(w => w !== worker);
          worker.terminate();
          this.initialize();
        } else {
          // Reset worker state
          state.busy = false;
          this.workers.push(worker);
        }
      });
      
      this.workers.push(worker);
    }
  }

  runTask(data, priority = 0) {
    return new Promise((resolve, reject) => {
      const task = { data, resolve, reject, priority, timestamp: Date.now() };
      
      // Insert task based on priority
      const insertIndex = this.taskQueue.findIndex(t => t.priority < priority);
      if (insertIndex === -1) {
        this.taskQueue.push(task);
      } else {
        this.taskQueue.splice(insertIndex, 0, task);
      }
      
      if (this.workers.length > 0) {
        const worker = this.workers.pop();
        const workerId = this.workers.indexOf(worker);
        const state = this.workerStates.get(workerId);
        state.busy = true;
        worker.postMessage(data);
      }
    });
  }

  terminate() {
    for (const worker of this.workers) {
      worker.terminate();
    }
    this.workers = [];
    this.taskQueue = [];
    this.workerStates.clear();
  }

  getStats() {
    return {
      totalWorkers: this.numWorkers,
      activeWorkers: this.workers.length,
      queuedTasks: this.taskQueue.length,
      workerStates: Object.fromEntries(this.workerStates)
    };
  }
}

// Create worker pool if we're in the main thread
let workerPool;
if (isMainThread) {
  workerPool = new WorkerPool();
}

// File operations for persistence
const fs = require('fs').promises;
const path = require('path');

// Save data to file




// Save data to persistent storage
async function saveData(force = false) {
  // Don't save if another save is in progress unless forced
  if (saveInProgress && !force) return false;
  
  // Don't save if no changes and not forced
  if (!dirtyFlag && !force) return true;
  
  saveInProgress = true;
  
  try {
    // Prepare data to save
    const dataToSave = {
      store: Object.fromEntries(store.toMap()),
      ttl: Object.fromEntries(ttlMap)
    };
    
    // Save to file
    const success = await saveToFile(dataToSave);
    
    if (success) {
      dirtyFlag = false;
      pendingWrites.clear();
      pendingDeletes.clear();
    }
    
    return success;
  } catch (err) {
    console.error('Error saving data:', err);
    return false;
  } finally {
    saveInProgress = false;
  }
}

// Load data from persistent storage
async function loadData() {
  const data = await loadFromFile();
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

// Initialize by loading data
if (isMainThread) {
  (async () => {
    await loadData();
  })();
  
  // Set up periodic saving
  setInterval(async () => {
    if (dirtyFlag) {
      await saveData();
    }
  }, 5000); // Save every 5 seconds if there are changes
  
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

// Batch processing function for multiple commands
async function processBatch(commands) {
  const batchStartTime = process.hrtime.bigint();
  const results = [];

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
        result = await jsonSetInternal(key, value, cmd.path, cmd.fieldValue);
        break;
      case 'JSON.GET':
        result = await jsonGetInternal(key, cmd.value); // 'value' here will be the paths array
        break;
      case 'JSON.PRETTY':
        result = await jsonPrettyInternal(key);
        break;
      case 'CLRCACHE':
        result = await clearCacheInternal();
        break;
      case 'JSON.DEL':
        result = await jsonDelInternal(key, value); // 'value' here will be the field to delete
        break; 
      case 'JSON.UPDATE': // Updated case for JSON.UPDATE to accept updatesMap
        result = await jsonUpdateInternal(key, cmd.updates); // cmd.updates will be the updatesMap
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

// Fast JSON field extractor
function fastJsonFieldExtractor(jsonStr, targetField) {
  let i = 0;
  const len = jsonStr.length;
  
  // Skip whitespace
  while (i < len && /\s/.test(jsonStr[i])) i++;
  
  // Must start with {
  if (jsonStr[i] !== '{') return null;
  i++;
  
  while (i < len) {
    // Skip whitespace
    while (i < len && /\s/.test(jsonStr[i])) i++;
    
    // Parse field name
    if (jsonStr[i] !== '"') return null;
    i++;
    
    let fieldStart = i;
    while (i < len && jsonStr[i] !== '"') i++;
    const fieldName = jsonStr.slice(fieldStart, i);
    i++;
    
    // Skip whitespace and colon
    while (i < len && (/\s/.test(jsonStr[i]) || jsonStr[i] === ':')) i++;
    
    // If this is our target field, extract its value
    if (fieldName === targetField) {
      let valueStart = i;
      let valueEnd = i;
      let inString = false;
      let braceCount = 0;
      let bracketCount = 0;
      
      while (i < len) {
        const char = jsonStr[i];
        
        if (char === '"' && jsonStr[i - 1] !== '\\') {
          inString = !inString;
        } else if (!inString) {
          if (char === '{') braceCount++;
          else if (char === '}') braceCount--;
          else if (char === '[') bracketCount++;
          else if (char === ']') bracketCount--;
          else if (char === ',' && braceCount === 0 && bracketCount === 0) {
            valueEnd = i;
            break;
          }
        }
        
        if (char === '}' && braceCount === 0 && bracketCount === 0) {
          valueEnd = i;
          break;
        }
        
        i++;
      }
      
      if (valueEnd === valueStart) valueEnd = i;
      return jsonStr.slice(valueStart, valueEnd).trim();
    }
    
    // Skip the value
    let inString = false;
    let braceCount = 0;
    let bracketCount = 0;
    
    while (i < len) {
      const char = jsonStr[i];
      
      if (char === '"' && jsonStr[i - 1] !== '\\') {
        inString = !inString;
      } else if (!inString) {
        if (char === '{') braceCount++;
        else if (char === '}') braceCount--;
        else if (char === '[') bracketCount++;
        else if (char === ']') bracketCount--;
        else if (char === ',' && braceCount === 0 && bracketCount === 0) {
          i++;
          break;
        }
      }
      
      if (char === '}' && braceCount === 0 && bracketCount === 0) {
        i++;
        break;
      }
      
      i++;
    }
  }
  
  return null;
}

// Fast JSON field setter
function fastJsonFieldSetter(jsonStr, targetField, newValue) {
  let i = 0;
  const len = jsonStr.length;
  let result = '';
  let found = false;
  
  // Skip whitespace
  while (i < len && /\s/.test(jsonStr[i])) {
    result += jsonStr[i];
    i++;
  }
  
  // Must start with {
  if (jsonStr[i] !== '{') return null;
  result += '{';
  i++;
  
  while (i < len) {
    // Skip whitespace
    while (i < len && /\s/.test(jsonStr[i])) {
      result += jsonStr[i];
      i++;
    }
    
    // Parse field name
    if (jsonStr[i] !== '"') return null;
    result += '"';
    i++;
    
    let fieldStart = i;
    while (i < len && jsonStr[i] !== '"') i++;
    const fieldName = jsonStr.slice(fieldStart, i);
    result += fieldName + '"';
    i++;
    
    // Skip whitespace and colon
    while (i < len && (/\s/.test(jsonStr[i]) || jsonStr[i] === ':')) {
      result += jsonStr[i];
      i++;
    }
    
    // If this is our target field, replace its value
    if (fieldName === targetField) {
      found = true;
      // Add the new value
      if (typeof newValue === 'string') {
        result += `"${newValue}"`;
      } else if (typeof newValue === 'object') {
        result += JSON.stringify(newValue);
      } else {
        result += String(newValue);
      }
      
      // Skip the old value
      let inString = false;
      let braceCount = 0;
      let bracketCount = 0;
      
      while (i < len) {
        const char = jsonStr[i];
        
        if (char === '"' && jsonStr[i - 1] !== '\\') {
          inString = !inString;
        } else if (!inString) {
          if (char === '{') braceCount++;
          else if (char === '}') braceCount--;
          else if (char === '[') bracketCount++;
          else if (char === ']') bracketCount--;
          else if (char === ',' && braceCount === 0 && bracketCount === 0) {
            result += ',';
            i++;
            break;
          }
        }
        
        if (char === '}' && braceCount === 0 && bracketCount === 0) {
          result += '}';
          i++;
          break;
        }
        
        i++;
      }
    } else {
      // Copy the value as is
      let inString = false;
      let braceCount = 0;
      let bracketCount = 0;
      let valueStart = i;
      
      while (i < len) {
        const char = jsonStr[i];
        result += char;
        
        if (char === '"' && jsonStr[i - 1] !== '\\') {
          inString = !inString;
        } else if (!inString) {
          if (char === '{') braceCount++;
          else if (char === '}') braceCount--;
          else if (char === '[') bracketCount++;
          else if (char === ']') bracketCount--;
          else if (char === ',' && braceCount === 0 && bracketCount === 0) {
            i++;
            break;
          }
        }
        
        if (char === '}' && braceCount === 0 && bracketCount === 0) {
          i++;
          break;
        }
        
        i++;
      }
    }
  }
  
  return found ? result : null;
}

async function jsonSetInternal(key, jsonValue, path, fieldValueToSet) {
  const startTime = process.hrtime.bigint();
  try {
    let finalJsonString;
    
    if (path) { // Setting a specific field/path
      let existingJsonString = store.get(key);
      if (!existingJsonString) {
        existingJsonString = '{}';
      }
      
      // Parse the existing JSON
      let jsonObj;
      try {
        jsonObj = JSON.parse(existingJsonString);
      } catch (e) {
        const endTime = process.hrtime.bigint();
        const executionTime = Number(endTime - startTime) / 1000;
        return { status: "ERROR", message: "Existing value is not a valid JSON object.", executionTime };
      }
      
      // Parse the field value
      let parsedValue;
      try {
        parsedValue = JSON.parse(fieldValueToSet);
      } catch (e) {
        // If not valid JSON, treat as string
        parsedValue = fieldValueToSet;
      }
      
      // Set the value at the specified path
      const normalizedPath = path.startsWith('$.') ? path.substring(2) : path;
      const segments = normalizedPath.split('.');
      let current = jsonObj;
      
      // Navigate to the parent object
      for (let i = 0; i < segments.length - 1; i++) {
        const segment = segments[i];
        if (!(segment in current)) {
          current[segment] = {};
        }
        current = current[segment];
      }
      
      // Set the value at the final segment
      const lastSegment = segments[segments.length - 1];
      current[lastSegment] = parsedValue;
      
      finalJsonString = JSON.stringify(jsonObj);
    } else { // Setting the entire JSON object
      // Validate JSON string
      JSON.parse(jsonValue);
      finalJsonString = jsonValue;
    }
    
    store.set(key, finalJsonString);
    pendingWrites.set(key, finalJsonString);
    dirtyFlag = true;

    // Clear any existing TTL for this key if we're overwriting with JSON
    if (ttlMap.has(key)) {
      ttlMap.delete(key);
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

async function jsonGetInternal(key, paths) {
  const startTime = process.hrtime.bigint();
  let result = null;

  // Check TTL and retrieve value from store
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

  // If key not found or expired
  if (result === null) {
    const endTime = process.hrtime.bigint();
    const executionTime = Number(endTime - startTime) / 1000;
    return { value: null, executionTime };
  }

  try {
    // Parse the JSON string from the store
    const jsonObj = JSON.parse(result);
    
    // Helper function to safely get a value by a single segment (object key or array index)
    const getSegmentValue = (obj, segment) => {
        if (obj === null || typeof obj !== 'object') return undefined; // Cannot traverse if not an object/array

        const arrayMatch = segment.match(/(.*)\[(\d+)\]$/);
        if (arrayMatch) {
            const arrayName = arrayMatch[1];
            const index = parseInt(arrayMatch[2], 10);
            if (Array.isArray(obj[arrayName])) {
                return obj[arrayName][index];
            }
            return undefined; // Not an array or array not found
        } else {
            return obj[segment]; // Direct object property access
        }
    };

    // Helper function to traverse a path
    const traversePath = (obj, pathSegments) => {
        let current = obj;
        for (const segment of pathSegments) {
            current = getSegmentValue(current, segment);
            if (current === undefined) return undefined; // Path broken
        }
        return current;
    };

    // Case 1: No paths specified or only root path ('$') requested
    const shouldReturnEntireObject = !paths || paths.length === 0 || (paths.length === 1 && paths[0] === '$');
    if (shouldReturnEntireObject) {
      const endTime = process.hrtime.bigint();
      const executionTime = Number(endTime - startTime) / 1000;
      return { value: jsonObj, executionTime };
    }

    // Case 2: Single field request
    if (paths.length === 1) {
      const path = paths[0];
      const normalizedPath = path.startsWith('$.') ? path.substring(2) : path; // Remove leading '$' if present
      // More robust segment splitting for paths like 'address.city' or 'skills[0]'
      const segments = normalizedPath.match(/[^.\[\]]+|\[\d+\]/g);

      if (!segments) { // Path could not be parsed (e.g., empty string or invalid format)
          const endTime = process.hrtime.bigint();
          const executionTime = Number(endTime - startTime) / 1000;
          return { value: null, executionTime };
      }

      const extractedValue = traversePath(jsonObj, segments);

      const endTime = process.hrtime.bigint();
      const executionTime = Number(endTime - startTime) / 1000;
      return { value: extractedValue === undefined ? null : extractedValue, executionTime };
    }

    // Case 3: Multiple fields request
    const resultObj = {};
    for (const path of paths) {
      const normalizedPath = path.startsWith('$.') ? path.substring(2) : path;
      const segments = normalizedPath.match(/[^.\[\]]+|\[\d+\]/g);

      if (!segments) { // Path could not be parsed, mark as null
          resultObj[path] = null;
          continue;
      }

      const extractedValue = traversePath(jsonObj, segments);
      resultObj[path] = extractedValue === undefined ? null : extractedValue;
    }
    
    const endTime = process.hrtime.bigint();
    const executionTime = Number(endTime - startTime) / 1000;
    return { value: resultObj, executionTime };

  } catch (e) {
    // Catch any JSON parsing errors or unexpected issues
    const endTime = process.hrtime.bigint();
    const executionTime = Number(endTime - startTime) / 1000;
    return { status: "ERROR", message: `Value at key '${key}' is not a valid JSON object or an internal error occurred: ${e.message}`, executionTime };
  }
}

// Removed unused helper functions (fastJsonFieldExtractor and fastJsonFieldSetter)
// These were not actively used by the refactored jsonGetInternal and jsonSetInternal

async function jsonUpdateInternal(key, updatesMap) {
  const startTime = process.hrtime.bigint();
  try {
    let existingJsonString = store.get(key);
    if (existingJsonString === null) {
      const endTime = process.hrtime.bigint();
      const executionTime = Number(endTime - startTime) / 1000;
      return { status: "ERROR", message: `Key '${key}' does not exist. Use JSON.SET to create it.`, executionTime };
    }
    
    let jsonObj;
    try {
      jsonObj = JSON.parse(existingJsonString);
    } catch (e) {
      const endTime = process.hrtime.bigint();
      const executionTime = Number(endTime - startTime) / 1000;
      return { status: "ERROR", message: "Existing value is not a valid JSON object.", executionTime };
    }
    
    for (const path in updatesMap) {
      if (!Object.prototype.hasOwnProperty.call(updatesMap, path)) continue;

      const fieldValueToSet = updatesMap[path];

      let parsedFieldValue = fieldValueToSet; // fieldValueToSet already parsed in server.js
      
      const normalizedPath = path.startsWith('$.') ? path.substring(2) : path;
      const segments = normalizedPath.match(/[^.[\]]+|\[\d+\]/g);

      if (!segments || segments.length === 0) {
        // Log or handle invalid path, but continue with other updates
        console.warn(`db.js: jsonUpdateInternal - Invalid path in updatesMap: '${path}' for key '${key}'`);
        continue;
      }

      let current = jsonObj;
      let parent = null;
      let lastSegment = null;

      for (let i = 0; i < segments.length; i++) {
          const segment = segments[i];
          const arrayMatch = segment.match(/(.*)\[(\d+)\]$/);

          if (i < segments.length - 1) { // Not the last segment, traverse further
              if (arrayMatch) {
                  const arrayName = arrayMatch[1];
                  const index = parseInt(arrayMatch[2], 10);
                  if (current === null || typeof current !== 'object' || !Array.isArray(current[arrayName])) {
                      if (current === null || typeof current !== 'object') {
                          console.error(`db.js: jsonUpdateInternal - Cannot traverse path '${path}': intermediate '${segment}' is not an object or array. Skipping this update.`);
                          current = null; // Mark path as broken
                          break;
                      }
                      current[arrayName] = []; 
                  }
                  parent = current[arrayName];
                  lastSegment = index;
                  current = current[arrayName][index];
              } else {
                  if (current === null || typeof current !== 'object' || !Object.prototype.hasOwnProperty.call(current, segment) || typeof current[segment] !== 'object' || current[segment] === null) {
                      if (current === null || typeof current !== 'object') {
                           console.error(`db.js: jsonUpdateInternal - Cannot traverse path '${path}': intermediate '${segment}' is not an object or array. Skipping this update.`);
                           current = null; // Mark path as broken
                           break;
                      }
                      current[segment] = {}; 
                  }
                  parent = current;
                  lastSegment = segment;
                  current = current[segment];
              }
          } else { // Last segment, where the value will be set
              if (arrayMatch) {
                  const arrayName = arrayMatch[1];
                  const index = parseInt(arrayMatch[2], 10);
                  if (current === null || typeof current !== 'object' || !Array.isArray(current[arrayName])) {
                      if (current === null || typeof current !== 'object') {
                          console.error(`db.js: jsonUpdateInternal - Cannot update path '${path}': target parent is not an object or array. Skipping this update.`);
                          current = null; // Mark path as broken
                          break;
                      }
                      current[arrayName] = []; 
                  }
                  parent = current[arrayName];
                  lastSegment = index;
              } else {
                  parent = current;
                  lastSegment = segment;
              }
          }
      }
      
      if (parent !== null && current !== null) { // Only update if path traversal was successful
        parent[lastSegment] = parsedFieldValue;
      } else if (path === '$') { // Special handling for root update, though JSON.UPDATE usually for fields
         // This case handles updating the root of the object if path was empty or only '$'
         // For JSON.UPDATE, path should always specify a field, but keeping this for robustness if a malformed path comes through
         if (typeof parsedFieldValue === 'object' && parsedFieldValue !== null) {
            // Clear existing and assign new properties for root update
            Object.keys(jsonObj).forEach(key => delete jsonObj[key]);
            Object.assign(jsonObj, parsedFieldValue);
         } else {
            console.error(`db.js: jsonUpdateInternal - Invalid value type for root update: '${path}'. Skipping this update.`);
         }
      } else {
          console.error(`db.js: jsonUpdateInternal - Skipping update for path '${path}' due to invalid traversal.`);
      }
    }
    
    const finalJsonString = JSON.stringify(jsonObj);
    
    store.set(key, finalJsonString);
    pendingWrites.set(key, finalJsonString);
    dirtyFlag = true;

    const endTime = process.hrtime.bigint();
    const executionTime = Number(endTime - startTime) / 1000;
    return { status: "+OK", executionTime };
  } catch (e) {
    const endTime = process.hrtime.bigint();
    const executionTime = Number(endTime - startTime) / 1000;
    return { status: "ERROR", message: `Error during JSON.UPDATE operation for key '${key}': ${e.message}`, executionTime };
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
  jsonUpdate: jsonUpdateInternal,
  clearCache: clearCacheInternal, // Renamed for external use
  // Expose internal maps for stats
  getStore: () => store.toMap(),
  getTtlMap: () => new Map(ttlMap),
  getWorkerStats: () => workerPool.getStats()
};

//   _store: store,
//   _ttlMap: ttlMap
// };
