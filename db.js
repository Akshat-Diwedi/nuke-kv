// db.js
const { saveToFile, loadFromFile, parseValue, MAX_VALUE_SIZE } = require('./utils');
const { Worker, isMainThread, parentPort, workerData } = require('worker_threads');
const os = require('os');



// Constants for file operations
const SAVE_INTERVAL = 1; // 1 Millisecond delay
const COMPRESSION_THRESHOLD = 10 * 1024 * 1024; // 10MB

// In-memory cache with LRU functionality
class LRUCache {
  constructor(maxSize = 10000) {
    this.cache = new Map();
    this.maxSize = maxSize;
    this.head = null;
    this.tail = null;
    this._currentSize = 0;
    this.maxEntrySize = MAX_VALUE_SIZE; // Use MAX_VALUE_SIZE from utils.js
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
    console.log(`[LRUCache.set] Key: ${key}, Value Type: ${typeof value}, Value Content: ${JSON.stringify(value)}`);
    
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
    const obj = {};
    for (const [key, node] of this.cache) {
      obj[key] = node.value;
    }
    return obj;
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
    const activeWorkers = Array.from(this.workerStates.values()).filter(s => s.busy).length;
    const idleWorkers = this.numWorkers - activeWorkers;
    return {
      totalWorkers: this.numWorkers,
      activeWorkers,
      idleWorkers,
      queueLength: this.taskQueue.length
    };
  }
}

// Create a worker pool (main thread only)
let workerPool;
if (isMainThread) {
  workerPool = new WorkerPool();
}

// Function to save data to a file
async function saveData(force = false) {
  if (!dirtyFlag && !force) {
    return false;
  }

  if (saveInProgress) {
    return false;
  }
  saveInProgress = true;
  dirtyFlag = false;

  const dataToSave = {
    store: store.toMap(),
    ttl: Object.fromEntries(ttlMap)
  };

  try {
    await saveToFile(dataToSave);
    console.log(`Data saved to nukekv.db`);
    dirtyFlag = false;
    pendingWrites.clear();
    pendingDeletes.clear();
    return true;
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
          console.log(`[loadData] Initial value for key '$${key}': type='${typeof value}', content='${JSON.stringify(value)}'`);
          // If the loaded value is a string that looks like JSON, parse it back to an object.
          // This loop handles multiple layers of stringification from previous bugs.
          let valueToProcess = value;
          while (typeof valueToProcess === 'string' && valueToProcess.trim().startsWith('{') && valueToProcess.trim().endsWith('}')) {
            try {
              valueToProcess = JSON.parse(valueToProcess);
            } catch (e) {
              console.warn(`Malformed JSON string detected during deep-parsing for key ${key}:`, e.message);
              // If parsing fails, break the loop and keep the current valueToProcess (which might still be a string)
              break;
            }
          }
          console.log(`[loadData] Final value for key '$${key}': type='${typeof valueToProcess}', content='${JSON.stringify(valueToProcess)}'`);
          store.set(key, valueToProcess); // Store the final, hopefully parsed, object
        }
      } else {
        // Initialize store if no data or empty
        store = new LRUCache(1000000); // Re-initialize with default size
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
      } else {
        // Initialize ttlMap if no data or empty
        ttlMap = new Map();
      }
      console.log('Data loaded from persistent storage');
    } catch (err) {
      console.error('Error restoring data:', err);
      // If parsing fails, initialize with empty state to prevent further errors
      store = new LRUCache(1000000);
      ttlMap = new Map();
    }
  } else {
    console.log('No existing database file found or file is empty. Starting with an empty database.');
    store = new LRUCache(1000000);
    ttlMap = new Map();
  }
}

// Initialize by loading data
if (isMainThread) {
  (async () => {
    // loadData() is now called from server.js with DB_FILE_PATH
  })();
  
  // Set up periodic saving
  setInterval(async () => {
    if (dirtyFlag) {
      await saveData();
    }
  }, SAVE_INTERVAL); // Save every 5 seconds if there are changes
  
  // process.on('SIGINT') and process.on('SIGTERM') are handled in server.js for graceful shutdown
  // Removed here to avoid duplicate handling
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
        // The `value` for JSON.SET is the full JSON object (parsed to JS object by server.js)
        // `cmd.path` is for JSON.SET_FIELD, `cmd.fieldValue` is the value for that field.
        result = await jsonSetInternal(key, value, cmd.field, cmd.value, ttl); // Pass ttl here
        break;
      case 'JSON.SET_FIELD': // Explicitly handle JSON.SET_FIELD
        result = await jsonSetInternal(key, null, cmd.field, cmd.value, ttl); // Pass null for fullJsonValue, use field and value, and ttl
        break;
      case 'JSON.GET':
        result = await jsonGetInternal(key, cmd.paths); // 'paths' here will be the paths array
        break;
      case 'JSON.DEL':
        result = await jsonDelInternal(key, cmd.field); // 'field' here will be the field to delete
        break; 
      case 'JSON.UPDATE': // Updated case for JSON.UPDATE to accept updatesMap
        result = await jsonUpdateInternal(key, cmd.updates, ttl); // cmd.updates will be the updatesMap, pass ttl
        break;
        default:
        result = { status: '-ERR', message: `Unknown command: ${operation}` };
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
  
  try {
    // For size calculation, if value is an object, stringify it temporarily.
    // The actual `value` (which can be a JS object or primitive) is stored directly.
    const valueForSizeCalculation = typeof value === 'object' ? JSON.stringify(value) : value;
    
    // Check value size (measure stringified size for objects)
    const valueSize = Buffer.byteLength(valueForSizeCalculation, 'utf8');
    if (valueSize > MAX_VALUE_SIZE) {
      throw new Error(`Value exceeds maximum allowed size of ${MAX_VALUE_SIZE} bytes`);
    }
    
    store.set(key, value); // Store the original value (JS object for JSON, or primitive)
    pendingWrites.set(key, value); // Store the original value
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
    } else { // If no TTL provided, clear any existing TTL
      ttlMap.delete(key);
    }
    
    const endTime = process.hrtime.bigint();
    const executionTime = Number(endTime - startTime) / 1000;
    
    return { status: "+OK", executionTime };
  } catch (err) {
    const endTime = process.hrtime.bigint();
    const executionTime = Number(endTime - startTime) / 1000;
    return { status: "ERROR", message: err.message, executionTime };
  }
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

  // If the result is a string and looks like JSON, attempt to parse it
  if (typeof result === 'string' && result.trim().startsWith('{') && result.trim().endsWith('}')) {
    try {
      result = JSON.parse(result);
    } catch (e) {
      // Not valid JSON, return as original string or null if empty/malformed
      console.warn(`Malformed JSON string retrieved for key ${key} by getInternal:`, e.message);
      // If parsing fails, decide if it should be returned as raw string or null. For now, keep as string.
    }
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
        }
        
        // If we are outside a string and all braces/brackets are closed, we found the end of the value
        if (!inString && braceCount === 0 && bracketCount === 0 && (char === ',' || char === '}' || char === ']' || i === len - 1)) {
          valueEnd = i + (char === ',' ? -1 : 0); // Exclude trailing comma
          // Adjust valueEnd if it's the very last character and not a closing brace/bracket
          if (i === len - 1 && char !== '}' && char !== ']' && char !== ')') { // check for ')' for function values
            valueEnd = len;
          }
          
          // Trim whitespace from the end of the extracted value string
          let extractedValue = jsonStr.slice(valueStart, valueEnd + 1).trim();

          // If the extracted value ends with a comma, remove it (it indicates it was followed by another field)
          if (extractedValue.endsWith(',')) {
              extractedValue = extractedValue.slice(0, -1);
          }

          return extractedValue;
        }
        i++;
      }
    }
    
    // If not target field, skip to the next field or end of object
    let inValueString = false;
    let valueBraceCount = 0;
    let valueBracketCount = 0;
    let valueColonFound = false;
    while (i < len) {
      const char = jsonStr[i];

      if (!valueColonFound && char === ':') {
        valueColonFound = true;
        i++;
        continue;
      }
      if (!valueColonFound) {
        i++;
        continue;
      }
      
      if (char === '"' && jsonStr[i - 1] !== '\\') {
        inValueString = !inValueString;
      } else if (!inValueString) {
        if (char === '{') valueBraceCount++;
        else if (char === '}') valueBraceCount--;
        else if (char === '[') valueBracketCount++;
        else if (char === ']') valueBracketCount--;
      }
      
      if (!inValueString && valueBraceCount === 0 && valueBracketCount === 0 && (char === ',' || char === '}' || i === len - 1)) {
        // Add the skipped part to the result
        result += jsonStr.slice(valueStart, i + 1);
        i++; // Move past comma or closing brace/bracket
        break; // Move to next field
      }
      i++;
    }
    
    if (i >= len) return null; // End of JSON string
    i++; // Move past comma
  }
  
  return null;
}

// Fast JSON field setter (replace value for a specific field)
// This is an in-memory operation, not directly to disk.
function fastJsonFieldSetter(jsonStr, targetField, newValue) {
  let i = 0;
  const len = jsonStr.length;
  let result = '';
  let foundField = false;

  // Skip whitespace and add to result
  while (i < len && /\s/.test(jsonStr[i])) {
    result += jsonStr[i];
    i++;
  }
  
  // Must start with { - add to result
  if (jsonStr[i] !== '{') return null;
  result += jsonStr[i];
  i++;
  
  while (i < len) {
    // Skip whitespace and add to result
    while (i < len && /\s/.test(jsonStr[i])) {
      result += jsonStr[i];
      i++;
    }
    
    // Parse field name - add to result
    if (jsonStr[i] !== '"') {
        if (!foundField) return null; // Malformed JSON before finding target
        else break; // End of fields
    }
    result += jsonStr[i]; // Add opening quote
    i++;
    
    let fieldStart = i;
    while (i < len && jsonStr[i] !== '"') {
      result += jsonStr[i];
      i++;
    }
    const fieldName = jsonStr.slice(fieldStart, i);
    result += jsonStr[i]; // Add closing quote
    i++;
    
    // Skip whitespace and colon - add to result
    while (i < len && /\s/.test(jsonStr[i])) {
      result += jsonStr[i];
      i++;
    }
    if (jsonStr[i] !== ':') return null; // Malformed JSON
    result += jsonStr[i];
    i++;
    
    // If this is our target field, replace its value
    if (fieldName === targetField) {
      foundField = true;
      
      // Skip whitespace after colon for the value
      while (i < len && /\s/.test(jsonStr[i])) {
        result += jsonStr[i];
        i++;
      }

      // Add the new value (it might be a string, number, boolean, object, or array)
      // If it's a string, it must be quoted in the output JSON.
      // If it's an object/array, it must be stringified.
      // For simplicity, we'll stringify all primitive newValues that are not already strings.
      // JSON.stringify handles quoting strings and stringifying objects/arrays.
      let valueToAdd = newValue;
      if (typeof newValue !== 'string' && typeof newValue !== 'number' && typeof newValue !== 'boolean' && newValue !== null) {
          valueToAdd = JSON.stringify(newValue);
      } else if (typeof newValue === 'string') {
          // Ensure string values are properly quoted and escaped if they contain quotes
          valueToAdd = JSON.stringify(newValue);
      }
      result += valueToAdd;
      
      // Skip the old value in the original jsonStr
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
        }
        
        // If we are outside a string and all braces/brackets are closed, we found the end of the value
        if (!inString && braceCount === 0 && bracketCount === 0 && (char === ',' || char === '}' || char === ']' || i === len - 1)) {
          // After skipping the old value, append remaining part of jsonStr
          result += jsonStr.slice(i);
          return result;
        }
        i++;
      }
    } else {
      // Not target field, skip its value
      let inValueString = false;
      let valueBraceCount = 0;
      let valueBracketCount = 0;
      let valueColonFound = false;
      while (i < len) {
        const char = jsonStr[i];

        if (!valueColonFound && char === ':') {
          valueColonFound = true;
          i++;
          continue;
        }
        if (!valueColonFound) {
          i++;
          continue;
        }

        if (char === '"' && jsonStr[i - 1] !== '\\') {
          inValueString = !inValueString;
        } else if (!inValueString) {
          if (char === '{') valueBraceCount++;
          else if (char === '}') valueBraceCount--;
          else if (char === '[') valueBracketCount++;
          else if (char === ']') valueBracketCount--;
        }
        
        if (!inValueString && valueBraceCount === 0 && valueBracketCount === 0 && (char === ',' || char === '}' || i === len - 1)) {
          // Add the skipped part to the result
          result += jsonStr.slice(valueStart, i + 1);
          i++; // Move past comma or closing brace/bracket
          break; // Move to next field
        }
        i++;
      }
    }
  }

  // If we reach here, it means we appended everything or something went wrong.
  // This path should ideally only be taken if the targetField was not found, or it's an empty object.
  if (!foundField) {
      // If the field wasn't found, append the closing brace if the original JSON was not empty
      if (result.trim().endsWith('{')) {
          // Append the new field if it's a valid scenario (e.g., adding to an empty object)
          // This is a simplified append. For robustness, check if a comma is needed.
          result += `"${targetField}":${JSON.stringify(newValue)}`;
      }
  }
  return result; // Or handle error if field not found
}

// JSON operations
async function jsonSetInternal(key, jsonValue, path = null, fieldValueToSet = null, ttl = null) {
  const startTime = process.hrtime.bigint();

  try {
    // Retrieve the stored value, which could be a string (from old data) or an object (new data)
    let storedData = store.has(key) ? store.get(key) : null;
    let currentJson = null;

    if (typeof storedData === 'string' && storedData.trim().startsWith('{')) {
      try {
        currentJson = JSON.parse(storedData);
      } catch (e) {
        console.warn(`Malformed JSON string for key ${key} during jsonSetInternal. Initializing as empty object.`);
        currentJson = {};
      }
    } else if (typeof storedData === 'object' && storedData !== null) {
      currentJson = storedData;
    } else if (storedData !== null) {
      // If storedData is not a string, object, or null (e.g., number, boolean)
      if (path !== null) {
        throw new Error(`Value at key ${key} is not a JSON object. Cannot set field.`);
      }
    }

    if (path === null) { // Setting the whole JSON object
      if (typeof jsonValue !== 'object' || jsonValue === null) {
        throw new Error("JSON.SET with no path requires a valid JSON object.");
      }
      currentJson = jsonValue; // This is already a JS object from server.js
    } else { // Setting a field within the JSON object
      if (currentJson === null) {
        currentJson = {}; // Initialize empty object if key doesn't exist for field set
      }
      // Use setValueByPath to update the nested field
      const success = setValueByPath(currentJson, path, fieldValueToSet);
      if (!success) {
        throw new Error(`Failed to set JSON field at path '${path}'`);
      }
    }
    
    // Check value size (stringified size for objects for measurement)
    const valueSize = Buffer.byteLength(JSON.stringify(currentJson), 'utf8');
    if (valueSize > MAX_VALUE_SIZE) {
      throw new Error(`Value exceeds maximum allowed size of ${MAX_VALUE_SIZE} bytes`);
    }

    store.set(key, currentJson); // Store the actual JS object
    pendingWrites.set(key, currentJson); // Store the actual JS object
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
    } else { // If no TTL provided, clear any existing TTL
      ttlMap.delete(key);
    }

    const endTime = process.hrtime.bigint();
    const executionTime = Number(endTime - startTime) / 1000;

    return { status: "+OK", executionTime };
  } catch (err) {
    const endTime = process.hrtime.bigint();
    const executionTime = Number(endTime - startTime) / 1000;
    return { status: "ERROR", message: err.message, executionTime };
  }
}

// Helper to get JSON value by path (supports nested paths and arrays)
async function jsonGetInternal(key, paths) {
  const startTime = process.hrtime.bigint();

  let value = null;
  if (store.has(key)) {
    let storedValue = store.get(key);
    // If the stored value is a string, attempt to parse it as JSON.
    // This handles cases where JSON might have been stored as a string by older versions or other means.
    if (typeof storedValue === 'string') {
      try {
        storedValue = JSON.parse(storedValue);
        // If successfully parsed, update the store with the object for future access
        store.set(key, storedValue);
      } catch (e) {
        // Not a valid JSON string, treat as a regular string value
        storedValue = null; // Or throw error, depending on desired behavior for malformed JSON strings
      }
    }

    if (storedValue !== null && typeof storedValue === 'object') {
      if (paths.length === 0 || paths[0] === '$') {
        value = storedValue; // Return the whole object if no path or root path specified
      } else {
        // Traverse paths to get the value
        // The paths array might contain multiple segments for a single path like ['user', 'name']
        // The getValueByPath expects a single path string like "user.name"
        // So we need to join them if multiple path segments are passed for a single query.
        // Assuming 'paths' array elements are individual path segments or full paths.
        // Example: JSON.GET mykey user name -> paths = ['user', 'name']
        // Example: JSON.GET mykey $.user.name -> paths = ['$.user.name']
        
        // If multiple path segments are provided, join them with '.'
        const fullPath = paths.join('.');
        value = getValueByPath(storedValue, fullPath);
      }
    }
  }

  const endTime = process.hrtime.bigint();
  const executionTime = Number(endTime - startTime) / 1000;
  return { value, executionTime };
}

// Helper to get nested value from JSON (Handles paths like "a.b.c" or "a[0].b")
const getSegmentValue = (obj, segment) => {
  if (obj === null || typeof obj === 'undefined') return undefined;
  if (segment.startsWith('[') && segment.endsWith(']')) {
    const index = parseInt(segment.substring(1, segment.length - 1));
    return Array.isArray(obj) ? obj[index] : undefined;
  } else {
    return typeof obj === 'object' ? obj[segment] : undefined;
  }
};

// Traverse path to get value
const traversePath = (obj, pathSegments) => {
  let current = obj;
  for (const segment of pathSegments) {
    current = getSegmentValue(current, segment);
    if (current === undefined) break;
  }
  return current;
};

// JSON.UPDATE operation (updates multiple fields in a JSON object)
async function jsonUpdateInternal(key, updatesMap, ttl = null) {
  const startTime = process.hrtime.bigint();

  try {
    // Retrieve the stored value, which could be a string (from old data) or an object (new data)
    let storedData = store.has(key) ? store.get(key) : null;
    let currentJson = null;

    if (typeof storedData === 'string' && storedData.trim().startsWith('{')) {
      try {
        currentJson = JSON.parse(storedData);
      } catch (e) {
        console.warn(`Malformed JSON string for key ${key} during jsonUpdateInternal. Cannot update.`);
        throw new Error(`Value at key ${key} is malformed JSON. Cannot update fields.`);
      }
    } else if (typeof storedData === 'object' && storedData !== null) {
      currentJson = storedData;
    } else if (storedData === null) {
      throw new Error(`Key ${key} does not exist for JSON.UPDATE.`);
    } else {
      throw new Error(`Value at key ${key} is not a JSON object. Cannot update fields.`);
    }

    let updatedCount = 0;
    for (const path in updatesMap) {
      if (Object.prototype.hasOwnProperty.call(updatesMap, path)) {
        const valueToSet = updatesMap[path];
        // setValueByPath updates the currentJson object directly
        const success = setValueByPath(currentJson, path, valueToSet);
        if (success) {
          updatedCount++;
        } else {
          console.warn(`Failed to update path '${path}' for key ${key}.`);
        }
      }
    }

    if (updatedCount === 0) {
      return { status: "+OK (no fields updated)", executionTime: Number(process.hrtime.bigint() - startTime) / 1000 };
    }

    // Check value size (stringified size for objects)
    const valueSize = Buffer.byteLength(JSON.stringify(currentJson), 'utf8');
    if (valueSize > MAX_VALUE_SIZE) {
      throw new Error(`Value exceeds maximum allowed size of ${MAX_VALUE_SIZE} bytes after update`);
    }

    store.set(key, currentJson); // Store the actual JS object
    pendingWrites.set(key, currentJson); // Store the actual JS object
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
    } else { // If no TTL provided, clear any existing TTL
      ttlMap.delete(key);
    }

    const endTime = process.hrtime.bigint();
    const executionTime = Number(endTime - startTime) / 1000;

    return { status: `+OK (${updatedCount} fields updated)`, executionTime };
  } catch (err) {
    const endTime = process.hrtime.bigint();
    const executionTime = Number(endTime - startTime) / 1000;
    return { status: "ERROR", message: err.message, executionTime };
  }
}

// Exported functions (main thread only)
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
    if (!store.has(key)) {
      return { value: 0, executionTime: Number(process.hrtime.bigint() - startTime) / 1000 };
    }

    let currentJson = store.get(key);
    if (typeof currentJson !== 'object' || currentJson === null) {
      throw new Error(`Value at key ${key} is not a JSON object. Cannot delete field.`);
    }

    let deletedCount = 0;
    if (field === null) {
      // Delete the entire JSON object
      ttlMap.delete(key);
      const deleted = store.delete(key);
      if (deleted) {
        pendingDeletes.add(key);
        dirtyFlag = true;
        deletedCount = 1;
      }
    } else {
      // Delete a specific field or element at a path
      // setValueByPath can be used with `undefined` to delete a property if it exists directly
      // For array elements, we might need a specific array modification function.
      // For now, let's directly manipulate the object for simplicity.
      const segments = field.startsWith('$.') ? field.substring(2).match(/[^\.[\]]+|\[\d+\]/g) : field.match(/[^\.[\]]+|\[\d+\]/g);
      
      if (!segments) throw new Error("Invalid JSON path for deletion.");

      let target = currentJson;
      for (let i = 0; i < segments.length - 1; i++) {
        const segment = segments[i];
        if (segment.startsWith('[') && segment.endsWith(']')) {
          const index = parseInt(segment.substring(1, segment.length - 1));
          target = Array.isArray(target) ? target[index] : undefined;
        } else {
          target = typeof target === 'object' ? target[segment] : undefined;
        }
        if (target === undefined || target === null) break; // Path not found
      }

      const lastSegment = segments[segments.length - 1];
      if (target && typeof target === 'object') {
        if (lastSegment.startsWith('[') && lastSegment.endsWith(']')) {
          const index = parseInt(lastSegment.substring(1, lastSegment.length - 1));
          if (Array.isArray(target) && index >= 0 && index < target.length) {
            target.splice(index, 1);
            deletedCount = 1;
          }
        } else {
          if (Object.prototype.hasOwnProperty.call(target, lastSegment)) {
            delete target[lastSegment];
            deletedCount = 1;
          }
        }
      }

      if (deletedCount > 0) {
        // If a field was deleted, update the store and mark as dirty
        store.set(key, currentJson);
        pendingWrites.set(key, currentJson);
        dirtyFlag = true;
      }
    }
    const endTime = process.hrtime.bigint();
    const executionTime = Number(endTime - startTime) / 1000;
    return { value: deletedCount, executionTime };

  } catch (err) {
    const endTime = process.hrtime.bigint();
    const executionTime = Number(endTime - startTime) / 1000;
    return { status: "ERROR", message: err.message, executionTime };
  }
}

// Export the functions and also expose the internal maps for stats
module.exports = {
  _store: store,
  _ttlMap: ttlMap,
  saveData,
  loadData,
  processBatch,
  set: setInternal,
  get: getInternal,
  del: delInternal,
  ttl: ttlInternal,
  jsonSet: jsonSetInternal,
  jsonGet: jsonGetInternal,
  jsonDel: jsonDelInternal,
  jsonUpdate: jsonUpdateInternal
};
