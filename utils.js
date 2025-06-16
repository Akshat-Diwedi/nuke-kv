// utils.js
const fs = require('fs');
const path = require('path');

const DB_FILE_PATH = path.join(__dirname, 'nukekv.db');

// Function to save data to a file
function saveToFile(data) {
  try {
    fs.writeFileSync(DB_FILE_PATH, JSON.stringify(data, null, 2));
    return true;
  } catch (err) {
    console.error('Error saving data to file:', err);
    return false;
  }
}

// Function to load data from a file
function loadFromFile() {
  try {
    if (fs.existsSync(DB_FILE_PATH)) {
      const fileData = fs.readFileSync(DB_FILE_PATH, 'utf-8');
      return JSON.parse(fileData);
    }
    return null; // Return null if file doesn't exist
  } catch (err) {
    console.error('Error loading data from file:', err);
    return null;
  }
}

// Function to parse value (handle numbers, strings, JSON)
function parseValue(str) {
  if (!isNaN(str) && !isNaN(parseFloat(str))) {
    return parseFloat(str);
  }
  try {
    return JSON.parse(str);
  } catch (e) {
    // Not a valid JSON, treat as a string
    // Remove quotes if it's a quoted string
    if ((str.startsWith('"') && str.endsWith('"')) || (str.startsWith("'") && str.endsWith("'"))) {
      return str.slice(1, -1);
    }
    return str;
  }
}

// Helper for performance timing (can be expanded)
function startTimer() {
  return process.hrtime.bigint();
}

function endTimer(startTime) {
  const endTime = process.hrtime.bigint();
  return Number(endTime - startTime) / 1000; // Microseconds
}

module.exports = {
  saveToFile,
  loadFromFile,
  parseValue,
  startTimer,
  endTimer
};