import fs from 'fs';
import path from 'path';

const DATA_DIR = process.env.DATA_DIR || './data';
const COUNT_FILE = path.join(DATA_DIR, 'count.json');

function ensureDataDir() {
  if (!fs.existsSync(DATA_DIR)) {
    fs.mkdirSync(DATA_DIR, { recursive: true });
  }
}

export function loadState() {
  ensureDataDir();
  if (!fs.existsSync(COUNT_FILE)) {
    const initial = { total: 0, submissions: 0, lastUpdated: null };
    fs.writeFileSync(COUNT_FILE, JSON.stringify(initial, null, 2));
    return initial;
  }
  return JSON.parse(fs.readFileSync(COUNT_FILE, 'utf8'));
}

export function saveState(state) {
  ensureDataDir();
  fs.writeFileSync(COUNT_FILE, JSON.stringify(state, null, 2));
}

export function addToTotal(amount) {
  const state = loadState();
  state.total += amount;
  state.submissions += 1;
  state.lastUpdated = new Date().toISOString();
  saveState(state);
  return state;
}
