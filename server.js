const express = require('express');
const http = require('http');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const bcrypt = require('bcryptjs');
const Database = require('better-sqlite3');
const { Server } = require('socket.io');

const app = express();
const server = http.createServer(app);
const io = new Server(server, {
  maxHttpBufferSize: 1024 * 1024
});

const PORT = process.env.PORT || 3000;
const DATA_DIR = process.env.DATA_DIR || __dirname;
const DB_PATH = path.join(DATA_DIR, 'chat.db');
const PUBLIC_DIR = path.join(__dirname, 'public');
const UPLOAD_DIR = path.join(DATA_DIR, 'uploads');
const AVATAR_DIR = path.join(DATA_DIR, 'avatars');
const MAX_FILE_BYTES = 10 * 1024 * 1024 * 1024; // 10GB
const MAX_IMAGE_BYTES = 8 * 1024 * 1024; // 8MB for avatars / server icons
const FILE_EXPIRY_HOURS = 6;
const DEFAULT_CHANNELS = ['general', 'gaming', 'coding'];
const DEFAULT_SERVER_NAME = 'general';

// ---------------- SEED ACCOUNTS (manual account creation) ----------------
// List any accounts you want to exist automatically every time the server
// starts. Each entry is created only if that username doesn't already exist
// yet, so it's safe to leave people in this list forever - it won't reset
// their password or undo changes they've made since.
//
// To add an account by hand: add a line below with a username and a
// password (6+ characters), save this file, and restart the server
// (e.g. "npm start" locally, or redeploy on Render). The account will be
// ready to log into immediately.
//
// Add "isAdmin: true" to give that account full site-wide admin powers
// (mute, ban, kick, delete any message anywhere, manage the default
// server's channels) every time the server starts. "isAdmin: false" (or
// leaving it out) creates a normal account. This is checked and
// re-applied on every boot, so changing true/false here and restarting
// the server also updates an account that already existed.
//
// Note: "Purple" is always a site-wide admin no matter what - that's
// hardcoded separately below and doesn't need (or use) isAdmin here.
//
// Example:
//   { username: 'Moderator1', password: 'another-password', isAdmin: true },
const SEED_ACCOUNTS = [
  // { username: 'Purple', password: 'WillZhao12', isAdmin: true },
];

// If true, logging in with a username that doesn't exist yet will create
// that account on the spot using the password that was typed, instead of
// showing "invalid username or password". Set to false to require everyone
// to use the Register button instead.
const AUTO_REGISTER_ON_LOGIN = true;
const REACTION_EMOJIS = new Set([
  '👍', '👎', '😂', '❤️', '🔥', '👀', '🎉', '😮', '😢', '😡',
  '✅', '❌', '🙏', '💯', '🤔', '👏', '🚀', '😍', '🥳', '💀'
]);
const IMAGE_MIME = new Set(['image/png', 'image/jpeg', 'image/jpg', 'image/gif', 'image/webp', 'image/avif', 'image/bmp']);

fs.mkdirSync(DATA_DIR, { recursive: true });
fs.mkdirSync(PUBLIC_DIR, { recursive: true });
fs.mkdirSync(UPLOAD_DIR, { recursive: true });
fs.mkdirSync(AVATAR_DIR, { recursive: true });

const db = new Database(DB_PATH);
db.pragma('journal_mode = WAL');

app.use(express.json({ limit: '256kb' }));
app.use(express.static(PUBLIC_DIR));
app.use('/uploads', express.static(UPLOAD_DIR, {
  index: false,
  fallthrough: false,
  maxAge: `${FILE_EXPIRY_HOURS}h`
}));
// Avatars and server icons are permanent, so they get their own folder that
// the 6 hour file cleaner never touches.
app.use('/avatars', express.static(AVATAR_DIR, {
  index: false,
  fallthrough: false,
  maxAge: '7d'
}));

app.get('/', (req, res) => {
  res.sendFile(path.join(PUBLIC_DIR, 'index.html'));
});

function safeAlter(sql) {
  try { db.exec(sql); } catch (_) {}
}

// ---------------- DB ----------------
db.exec(`
CREATE TABLE IF NOT EXISTS users (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  username TEXT UNIQUE NOT NULL,
  password_hash TEXT NOT NULL,
  display_name TEXT,
  avatar_url TEXT,
  banned INTEGER DEFAULT 0,
  created_at TEXT DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS channels (
  name TEXT PRIMARY KEY,
  created_by TEXT,
  created_at TEXT DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS servers (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  owner TEXT NOT NULL,
  icon_url TEXT,
  invite_code TEXT UNIQUE,
  is_default INTEGER DEFAULT 0,
  created_at TEXT DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS server_members (
  server_id INTEGER NOT NULL,
  username TEXT NOT NULL,
  role TEXT DEFAULT 'member',
  joined_at TEXT DEFAULT (datetime('now')),
  UNIQUE(server_id, username)
);

CREATE TABLE IF NOT EXISTS server_channels (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  server_id INTEGER NOT NULL,
  name TEXT NOT NULL,
  room TEXT UNIQUE NOT NULL,
  topic TEXT,
  position INTEGER DEFAULT 0,
  created_by TEXT,
  created_at TEXT DEFAULT (datetime('now')),
  UNIQUE(server_id, name)
);

CREATE TABLE IF NOT EXISTS messages (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  room TEXT NOT NULL,
  user TEXT NOT NULL,
  text TEXT NOT NULL,
  to_user TEXT,
  is_group INTEGER DEFAULT 0,
  reply_to INTEGER,
  edited_at TEXT,
  deleted_at TEXT,
  deleted_by TEXT,
  created_at TEXT DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS files (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  room TEXT NOT NULL,
  user TEXT NOT NULL,
  to_user TEXT,
  is_group INTEGER DEFAULT 0,
  file_name TEXT NOT NULL,
  file_type TEXT,
  file_url TEXT NOT NULL,
  file_size INTEGER,
  caption TEXT,
  created_at TEXT DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS chat_groups (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  owner TEXT NOT NULL,
  icon_url TEXT,
  created_at TEXT DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS group_members (
  group_id INTEGER NOT NULL,
  username TEXT NOT NULL,
  role TEXT DEFAULT 'member',
  joined_at TEXT DEFAULT (datetime('now')),
  UNIQUE(group_id, username)
);

CREATE TABLE IF NOT EXISTS friendships (
  requester TEXT NOT NULL,
  addressee TEXT NOT NULL,
  status TEXT NOT NULL,
  created_at TEXT DEFAULT (datetime('now')),
  updated_at TEXT DEFAULT (datetime('now')),
  UNIQUE(requester, addressee)
);

CREATE TABLE IF NOT EXISTS message_reactions (
  message_id INTEGER NOT NULL,
  username TEXT NOT NULL,
  emoji TEXT NOT NULL,
  created_at TEXT DEFAULT (datetime('now')),
  UNIQUE(message_id, username, emoji)
);

CREATE TABLE IF NOT EXISTS read_receipts (
  room TEXT NOT NULL,
  username TEXT NOT NULL,
  last_message_id INTEGER DEFAULT 0,
  updated_at TEXT DEFAULT (datetime('now')),
  UNIQUE(room, username)
);

CREATE TABLE IF NOT EXISTS mutes (
  username TEXT PRIMARY KEY,
  muted_until TEXT NOT NULL,
  muted_by TEXT,
  created_at TEXT DEFAULT (datetime('now'))
);
`);

safeAlter(`ALTER TABLE users ADD COLUMN display_name TEXT;`);
safeAlter(`ALTER TABLE users ADD COLUMN avatar_url TEXT;`);
safeAlter(`ALTER TABLE users ADD COLUMN banned INTEGER DEFAULT 0;`);
safeAlter(`ALTER TABLE users ADD COLUMN is_admin INTEGER DEFAULT 0;`);
safeAlter(`ALTER TABLE messages ADD COLUMN to_user TEXT;`);
safeAlter(`ALTER TABLE messages ADD COLUMN is_group INTEGER DEFAULT 0;`);
safeAlter(`ALTER TABLE messages ADD COLUMN reply_to INTEGER;`);
safeAlter(`ALTER TABLE messages ADD COLUMN edited_at TEXT;`);
safeAlter(`ALTER TABLE messages ADD COLUMN deleted_at TEXT;`);
safeAlter(`ALTER TABLE messages ADD COLUMN deleted_by TEXT;`);
safeAlter(`ALTER TABLE files ADD COLUMN to_user TEXT;`);
safeAlter(`ALTER TABLE files ADD COLUMN is_group INTEGER DEFAULT 0;`);
safeAlter(`ALTER TABLE files ADD COLUMN file_url TEXT;`);
safeAlter(`ALTER TABLE files ADD COLUMN file_size INTEGER;`);
safeAlter(`ALTER TABLE files ADD COLUMN caption TEXT;`);
safeAlter(`ALTER TABLE server_channels ADD COLUMN topic TEXT;`);

// ---------------- SERVERS (guilds) ----------------
function makeInviteCode() {
  return crypto.randomBytes(4).toString('hex');
}

const getServerStmt = db.prepare(`SELECT * FROM servers WHERE id = ?`);
const getServerByCode = db.prepare(`SELECT * FROM servers WHERE invite_code = ?`);
const getChannelByRoomStmt = db.prepare(`SELECT * FROM server_channels WHERE room = ?`);
const getChannelByIdStmt = db.prepare(`SELECT * FROM server_channels WHERE id = ?`);
const getChannelsForServer = db.prepare(`SELECT * FROM server_channels WHERE server_id = ? ORDER BY position ASC, id ASC`);
const insertServerChannel = db.prepare(`INSERT INTO server_channels (server_id, name, room, position, created_by) VALUES (?, ?, ?, ?, ?)`);

function ensureDefaultServer() {
  let row = db.prepare(`SELECT * FROM servers WHERE is_default = 1`).get();
  if (!row) {
    const result = db.prepare(`
      INSERT INTO servers (name, owner, invite_code, is_default)
      VALUES (?, 'system', ?, 1)
    `).run(DEFAULT_SERVER_NAME, makeInviteCode());
    row = getServerStmt.get(result.lastInsertRowid);
  }

  // Original channels keep their plain room names so old history survives.
  DEFAULT_CHANNELS.forEach((name, index) => {
    const existing = getChannelByRoomStmt.get(name);
    if (!existing) insertServerChannel.run(row.id, name, name, index, 'system');
  });

  // Anything created through the old admin panel joins the default server too.
  for (const legacy of db.prepare(`SELECT name, created_by FROM channels`).all()) {
    if (!getChannelByRoomStmt.get(legacy.name)) {
      try { insertServerChannel.run(row.id, legacy.name, legacy.name, 99, legacy.created_by || 'system'); } catch (_) {}
    }
  }
  return row;
}

let DEFAULT_SERVER = ensureDefaultServer();

for (const name of DEFAULT_CHANNELS) {
  db.prepare(`INSERT OR IGNORE INTO channels (name, created_by) VALUES (?, 'system')`).run(name);
}

const createUser = db.prepare(`INSERT INTO users (username, password_hash, display_name) VALUES (?, ?, ?)`);
const getUser = db.prepare(`SELECT * FROM users WHERE username = ?`);
const updateProfileStmt = db.prepare(`UPDATE users SET display_name = ?, avatar_url = ? WHERE username = ?`);
const setAdminStmt = db.prepare(`UPDATE users SET is_admin = ? WHERE username = ?`);

// Create any accounts listed in SEED_ACCOUNTS above that don't exist yet,
// and sync isAdmin for any that do. Runs once, every time the server boots.
function applySeedAccounts() {
  for (const entry of SEED_ACCOUNTS) {
    const seedUsername = String((entry && entry.username) || '').trim();
    const seedPassword = String((entry && entry.password) || '');
    const seedIsAdmin = !!(entry && entry.isAdmin);
    if (!seedUsername) continue;
    if (!/^[a-zA-Z0-9_.-]{2,30}$/.test(seedUsername)) {
      console.warn(`[seed-accounts] skipping "${seedUsername}": username must be 2-30 letters, numbers, dots, hyphens or underscores`);
      continue;
    }

    const existing = getUser.get(seedUsername);
    if (existing) {
      // Already exists - never touch their password, but keep isAdmin in
      // sync with what's written in SEED_ACCOUNTS so flipping true/false
      // here and restarting is enough to promote or demote them.
      if (!!existing.is_admin !== seedIsAdmin) {
        setAdminStmt.run(seedIsAdmin ? 1 : 0, seedUsername);
        console.log(`[seed-accounts] ${seedIsAdmin ? 'promoted' : 'demoted'} "${seedUsername}" (isAdmin: ${seedIsAdmin})`);
      }
      continue;
    }

    if (!seedPassword) {
      console.warn(`[seed-accounts] skipping "${seedUsername}": no password set for this new account`);
      continue;
    }
    if (seedPassword.length < 6) {
      console.warn(`[seed-accounts] skipping "${seedUsername}": password must be at least 6 characters`);
      continue;
    }
    try {
      const hash = bcrypt.hashSync(seedPassword, 10);
      createUser.run(seedUsername, hash, entry.displayName || seedUsername);
      if (seedIsAdmin) setAdminStmt.run(1, seedUsername);
      console.log(`[seed-accounts] created account "${seedUsername}"${seedIsAdmin ? ' (admin)' : ''}`);
    } catch (err) {
      console.warn(`[seed-accounts] could not create "${seedUsername}": ${err.message}`);
    }
  }
}
applySeedAccounts();
const insertChannelStmt = db.prepare(`INSERT INTO channels (name, created_by) VALUES (?, ?)`);
const deleteChannelStmt = db.prepare(`DELETE FROM channels WHERE name = ?`);
const getMessageById = db.prepare(`SELECT * FROM messages WHERE id = ?`);
const getMessages = db.prepare(`
  SELECT id, room, user, text, to_user, is_group, reply_to, edited_at, deleted_at, deleted_by, created_at
  FROM messages
  WHERE room = ?
  ORDER BY id ASC
  LIMIT 300
`);
const insertMessage = db.prepare(`
  INSERT INTO messages (room, user, text, to_user, is_group, reply_to)
  VALUES (?, ?, ?, ?, ?, ?)
`);
const insertFile = db.prepare(`
  INSERT INTO files (room, user, to_user, is_group, file_name, file_type, file_url, file_size, caption)
  VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
`);
const getFileById = db.prepare(`SELECT * FROM files WHERE id = ?`);
const getFiles = db.prepare(`
  SELECT id, room, user, to_user, is_group, file_name, file_type, file_url, file_size, caption, created_at
  FROM files
  WHERE room = ?
  ORDER BY id ASC
  LIMIT 120
`);

// ---------------- AUTH / USERS ----------------
const tokens = new Map(); // token -> username
const onlineUsers = new Map(); // username -> Set(socketId)
const socketToUser = new Map(); // socketId -> username

function cleanUsername(value) {
  return String(value || '').trim();
}

function validUsername(username) {
  return /^[a-zA-Z0-9_.-]{2,30}$/.test(username);
}

function validChannelName(name) {
  return /^[a-zA-Z0-9_-]{2,32}$/.test(name);
}

function cleanText(value, max = 4000) {
  return String(value || '').trim().slice(0, max);
}

// Global (site-wide) admin. "Purple" is always an admin, hardcoded, no
// matter what's in the database - this is the permanent owner-level
// account for the whole chat. On top of that, any account can also be
// made a global admin via the SEED_ACCOUNTS { isAdmin: true } property or
// by an existing global admin right-clicking a user and choosing
// "Make Admin" (users.is_admin in the database).
function isAdmin(username) {
  if (username === 'Purple') return true;
  const user = getUser.get(username);
  return !!(user && user.is_admin);
}

function createToken(username) {
  const token = crypto.randomBytes(32).toString('hex');
  tokens.set(token, username);
  return token;
}

function authFromRequest(req) {
  const header = req.headers.authorization || '';
  const token = header.startsWith('Bearer ') ? header.slice(7) : '';
  const username = tokens.get(token) || null;
  if (!username) return null;
  const user = getUser.get(username);
  if (!user || user.banned) return null;
  return username;
}

function requireAuth(req, res, next) {
  const username = authFromRequest(req);
  if (!username) return res.status(401).json({ error: 'not authenticated' });
  req.username = username;
  next();
}

function addOnlineUser(username, socketId) {
  if (!onlineUsers.has(username)) onlineUsers.set(username, new Set());
  onlineUsers.get(username).add(socketId);
  socketToUser.set(socketId, username);
}

function removeOnlineUser(socketId) {
  const username = socketToUser.get(socketId);
  if (!username) return;
  const sockets = onlineUsers.get(username);
  if (sockets) {
    sockets.delete(socketId);
    if (sockets.size === 0) onlineUsers.delete(username);
  }
  socketToUser.delete(socketId);
}

function getOnlineUsers() {
  return [...onlineUsers.keys()].sort((a, b) => a.localeCompare(b));
}

function sendToUser(username, event, data) {
  const sockets = onlineUsers.get(username);
  if (!sockets) return;
  for (const id of sockets) io.to(id).emit(event, data);
}

function disconnectUser(username, reason = 'Disconnected by admin') {
  const sockets = onlineUsers.get(username);
  if (!sockets) return;
  for (const id of [...sockets]) {
    const s = io.sockets.sockets.get(id);
    if (s) {
      s.emit('adminNotice', { message: reason });
      s.disconnect(true);
    }
  }
}

function makeDMRoom(a, b) {
  return 'dm:' + [a, b].sort().join(':');
}

function getDMUsers(room) {
  if (!String(room || '').startsWith('dm:')) return null;
  const users = String(room).split(':').slice(1);
  return users.length === 2 ? users : null;
}

function groupIdFromRoom(room) {
  const match = /^group:(\d+)$/.exec(String(room || ''));
  return match ? Number(match[1]) : null;
}

function getGroup(id) {
  return db.prepare(`SELECT * FROM chat_groups WHERE id = ?`).get(id);
}

function isGroupMember(username, groupId) {
  return !!db.prepare(`SELECT 1 FROM group_members WHERE group_id = ? AND username = ?`).get(groupId, username);
}

function isServerMember(username, serverId) {
  const srv = getServerStmt.get(serverId);
  if (!srv) return false;
  if (srv.is_default) return true; // everyone is in the default "general" server
  return !!db.prepare(`SELECT 1 FROM server_members WHERE server_id = ? AND username = ?`).get(serverId, username);
}

function serverMemberRole(username, serverId) {
  const srv = getServerStmt.get(serverId);
  if (!srv) return null;
  if (srv.owner === username) return 'owner';
  const row = db.prepare(`SELECT role FROM server_members WHERE server_id = ? AND username = ?`).get(serverId, username);
  return row ? row.role : null;
}

// Server admin: a member the owner (or a global admin) has promoted within
// THIS server only. They can manage this server's channels and moderate
// messages/members here, but can never delete the server or act on the
// owner - that stays owner + global-admin only, via canManageServer below.
function isServerAdmin(username, serverId) {
  if (isAdmin(username)) return true; // global admin outranks everyone everywhere
  return serverMemberRole(username, serverId) === 'admin' || serverMemberRole(username, serverId) === 'owner';
}

function canManageServer(username, serverId) {
  const srv = getServerStmt.get(serverId);
  if (!srv) return false;
  if (isAdmin(username)) return true;
  if (srv.is_default) return false; // default server is global-admin-managed only
  if (srv.owner === username) return true;
  return serverMemberRole(username, serverId) === 'admin';
}

// Stricter than canManageServer: only the owner or a global admin can
// delete the server, change ownership-level settings, or touch the owner.
function isServerOwnerLevel(username, serverId) {
  const srv = getServerStmt.get(serverId);
  if (!srv) return false;
  return isAdmin(username) || srv.owner === username;
}

function serversForUser(username) {
  const rows = db.prepare(`
    SELECT s.* FROM servers s
    WHERE s.is_default = 1
       OR s.id IN (SELECT server_id FROM server_members WHERE username = ?)
    ORDER BY s.is_default DESC, s.id ASC
  `).all(username);

  return rows.map(s => ({
    id: s.id,
    name: s.name,
    owner: s.owner,
    iconUrl: s.icon_url || '',
    isDefault: !!s.is_default,
    isOwner: s.owner === username,
    isServerAdmin: isServerAdmin(username, s.id),
    canManage: canManageServer(username, s.id),
    canManageOwnerLevel: isServerOwnerLevel(username, s.id),
    inviteCode: (s.owner === username || isAdmin(username) || !s.is_default) ? s.invite_code : '',
    channels: getChannelsForServer.all(s.id).map(c => ({
      id: c.id,
      serverId: c.server_id,
      name: c.name,
      room: c.room,
      topic: c.topic || ''
    }))
  }));
}

function serverMemberUsernames(serverId) {
  const srv = getServerStmt.get(serverId);
  if (!srv) return [];
  if (srv.is_default) return db.prepare(`SELECT username FROM users WHERE banned = 0`).all().map(r => r.username);
  return db.prepare(`SELECT username FROM server_members WHERE server_id = ?`).all(serverId).map(r => r.username);
}

function notifyServerMembers(serverId, event, payload) {
  for (const member of serverMemberUsernames(serverId)) sendToUser(member, event, payload);
}

// Can this user moderate (delete other people's messages, etc.) in this
// room? True for a global admin anywhere, or a server admin/owner inside
// their own server's channels. DMs and group chats aren't moderated by
// server admins - only a global admin can act there.
function canModerateRoom(username, room) {
  if (isAdmin(username)) return true;
  const channel = getChannelByRoomStmt.get(room);
  if (channel) return isServerAdmin(username, channel.server_id);
  return false;
}

// Every room a user is entitled to sit in, so unread badges work for channels
// they are not currently looking at.
function allRoomsFor(username) {
  const rooms = [];
  for (const s of db.prepare(`SELECT id, is_default FROM servers`).all()) {
    if (s.is_default || isServerMember(username, s.id)) {
      for (const c of getChannelsForServer.all(s.id)) rooms.push(c.room);
    }
  }
  for (const g of db.prepare(`SELECT group_id FROM group_members WHERE username = ?`).all(username)) {
    rooms.push('group:' + g.group_id);
  }
  return rooms;
}

function isAllowedRoom(username, room) {
  if (!username || !room) return false;
  const user = getUser.get(username);
  if (!user || user.banned) return false;

  const channel = getChannelByRoomStmt.get(room);
  if (channel) return isServerMember(username, channel.server_id);

  const dmUsers = getDMUsers(room);
  if (dmUsers) return dmUsers.includes(username);

  const gid = groupIdFromRoom(room);
  if (gid) return isGroupMember(username, gid);

  return false;
}

function getDMOtherUser(username, room) {
  const users = getDMUsers(room);
  if (!users || !users.includes(username)) return null;
  return users.find(u => u !== username) || null;
}

function getMute(username) {
  return db.prepare(`SELECT * FROM mutes WHERE username = ?`).get(username);
}

function isMuted(username) {
  const mute = getMute(username);
  if (!mute) return false;
  const until = new Date(String(mute.muted_until).replace(' ', 'T') + 'Z');
  if (!isNaN(until) && until > new Date()) return mute;
  db.prepare(`DELETE FROM mutes WHERE username = ?`).run(username);
  return false;
}

function profileFor(username) {
  const u = getUser.get(username);
  if (!u) return null;
  return {
    username: u.username,
    displayName: u.display_name || u.username,
    avatarUrl: u.avatar_url || '',
    isAdmin: isAdmin(u.username)
  };
}

// Author details travel with every message so a client never has to guess an
// avatar from a stale local cache.
function authorFields(username) {
  const u = getUser.get(username);
  return {
    displayName: u ? (u.display_name || u.username) : username,
    avatarUrl: u ? (u.avatar_url || '') : ''
  };
}

function reactionSummary(messageId) {
  const rows = db.prepare(`
    SELECT emoji, COUNT(*) AS count, GROUP_CONCAT(username) AS users
    FROM message_reactions
    WHERE message_id = ?
    GROUP BY emoji
    ORDER BY emoji
  `).all(messageId);
  return rows.map(r => ({ emoji: r.emoji, count: r.count, users: r.users ? r.users.split(',') : [] }));
}

function replyPreview(id) {
  if (!id) return null;
  const row = getMessageById.get(id);
  if (!row) return null;
  const author = authorFields(row.user);
  return {
    id: row.id,
    user: row.user,
    displayName: author.displayName,
    avatarUrl: author.avatarUrl,
    text: row.deleted_at ? '[message deleted]' : String(row.text || '').slice(0, 180)
  };
}

function normaliseMessage(row) {
  if (!row) return null;
  const deleted = !!row.deleted_at;
  const author = authorFields(row.user);
  return {
    id: row.id,
    room: row.room,
    user: row.user,
    displayName: author.displayName,
    avatarUrl: author.avatarUrl,
    text: deleted ? '[message deleted]' : row.text,
    to: row.to_user || '',
    dmTo: row.to_user || '',
    isGroup: !!row.is_group,
    replyTo: replyPreview(row.reply_to),
    editedAt: row.edited_at || '',
    deleted,
    deletedBy: row.deleted_by || '',
    reactions: reactionSummary(row.id),
    createdAt: row.created_at
  };
}

function normaliseFile(row) {
  if (!row) return null;
  const author = authorFields(row.user);
  return {
    id: row.id,
    room: row.room,
    user: row.user,
    displayName: author.displayName,
    avatarUrl: author.avatarUrl,
    to: row.to_user || '',
    dmTo: row.to_user || '',
    isGroup: !!row.is_group,
    fileName: row.file_name,
    fileType: row.file_type || '',
    fileUrl: row.file_url,
    fileSize: row.file_size || 0,
    caption: row.caption || '',
    createdAt: row.created_at
  };
}

function emitRoomOrDM(room, toUser, event, payload) {
  io.to(room).emit(event, payload);
  const dmUsers = getDMUsers(room);
  if (dmUsers) {
    for (const user of dmUsers) sendToUser(user, event, payload);
  } else if (toUser) {
    sendToUser(toUser, event, payload);
  }
}

function removeOldFiles() {
  const oldFiles = db.prepare(`
    SELECT id, file_url
    FROM files
    WHERE created_at <= datetime('now', '-${FILE_EXPIRY_HOURS} hours')
  `).all();

  for (const file of oldFiles) {
    if (!file.file_url) continue;
    if (!file.file_url.startsWith('/uploads/')) continue;
    const rel = file.file_url.replace(/^\/uploads\//, '');
    const filePath = path.join(UPLOAD_DIR, rel);
    if (filePath.startsWith(UPLOAD_DIR)) {
      try { fs.unlinkSync(filePath); } catch (_) {}
    }
  }

  db.prepare(`DELETE FROM files WHERE created_at <= datetime('now', '-${FILE_EXPIRY_HOURS} hours')`).run();
}
setInterval(removeOldFiles, 60 * 1000);
removeOldFiles();

function safeFileName(originalName) {
  return path.basename(String(originalName || 'file'))
    .replace(/[^a-zA-Z0-9._-]/g, '_')
    .slice(0, 140) || 'file';
}

function saveUploadStream(req, fullPath, maxBytes) {
  return new Promise((resolve, reject) => {
    let total = 0;
    let finished = false;
    const stream = fs.createWriteStream(fullPath);

    function cleanup(err) {
      if (finished) return;
      finished = true;
      stream.destroy();
      try { fs.unlinkSync(fullPath); } catch (_) {}
      reject(err);
    }

    req.on('data', chunk => {
      total += chunk.length;
      if (total > maxBytes) {
        cleanup(new Error('file is too large'));
        req.destroy();
        return;
      }
      if (!stream.write(chunk)) req.pause();
    });

    stream.on('drain', () => req.resume());
    req.on('end', () => {
      if (finished) return;
      stream.end(() => {
        finished = true;
        resolve(total);
      });
    });
    req.on('aborted', () => cleanup(new Error('upload cancelled')));
    req.on('error', cleanup);
    stream.on('error', cleanup);
  });
}

// ---------------- HTTP ROUTES ----------------
app.post('/register', (req, res) => {
  const username = cleanUsername(req.body.username);
  const password = String(req.body.password || '');
  if (!username || !password) return res.status(400).json({ error: 'missing fields' });
  if (!validUsername(username)) return res.status(400).json({ error: 'username must be 2-30 letters, numbers, dots, hyphens or underscores' });
  if (password.length < 6) return res.status(400).json({ error: 'password must be at least 6 characters' });

  try {
    const hash = bcrypt.hashSync(password, 10);
    createUser.run(username, hash, username);
    const token = createToken(username);
    res.status(201).json({ message: 'ok', username, token, profile: profileFor(username) });
  } catch (_) {
    res.status(409).json({ error: 'user exists' });
  }
});

app.post('/login', (req, res) => {
  const username = cleanUsername(req.body.username);
  const password = String(req.body.password || '');
  if (!username || !password) return res.status(400).json({ error: 'missing fields' });

  let user = getUser.get(username);

  // No account with this username yet: create one on the spot instead of
  // rejecting the login, as long as AUTO_REGISTER_ON_LOGIN is turned on
  // and the username/password would have passed /register's own rules.
  if (!user && AUTO_REGISTER_ON_LOGIN) {
    if (!validUsername(username)) return res.status(400).json({ error: 'username must be 2-30 letters, numbers, dots, hyphens or underscores' });
    if (password.length < 6) return res.status(400).json({ error: 'password must be at least 6 characters' });
    try {
      const hash = bcrypt.hashSync(password, 10);
      createUser.run(username, hash, username);
      user = getUser.get(username);
    } catch (_) {
      // Someone else raced us to create the same username - fall through
      // to the normal login check below using whatever now exists.
      user = getUser.get(username);
    }
  }

  if (!user || user.banned) return res.status(401).json({ error: 'invalid username or password' });
  const ok = bcrypt.compareSync(password, user.password_hash);
  if (!ok) return res.status(401).json({ error: 'invalid username or password' });

  const token = createToken(username);
  res.json({ message: 'ok', username, token, profile: profileFor(username) });
});

app.post('/logout', requireAuth, (req, res) => {
  const header = req.headers.authorization || '';
  const token = header.startsWith('Bearer ') ? header.slice(7) : '';
  if (token) tokens.delete(token);
  res.json({ message: 'ok' });
});

app.get('/profile', requireAuth, (req, res) => res.json(profileFor(req.username)));

app.post('/profile', requireAuth, (req, res) => {
  const displayName = cleanText(req.body.displayName || req.username, 40) || req.username;
  const avatarUrl = cleanText(req.body.avatarUrl || '', 800);
  updateProfileStmt.run(displayName, avatarUrl, req.username);
  const profile = profileFor(req.username);
  io.emit('profilesChanged', { username: req.username, profile });
  res.json(profile);
});

app.get('/profiles', requireAuth, (req, res) => {
  const names = String(req.query.users || '')
    .split(',')
    .map(cleanUsername)
    .filter(Boolean)
    .slice(0, 200);
  const out = {};
  for (const name of names) {
    const profile = profileFor(name);
    if (profile) out[name] = profile;
  }
  res.json(out);
});

app.get('/users', requireAuth, (req, res) => {
  const rows = db.prepare(`SELECT username FROM users WHERE banned = 0 ORDER BY username COLLATE NOCASE ASC LIMIT 500`).all();
  res.json(rows.map(r => profileFor(r.username)).filter(Boolean));
});

// Legacy endpoint: channels of the default server.
app.get('/channels', requireAuth, (req, res) => {
  res.json(getChannelsForServer.all(DEFAULT_SERVER.id).map(c => ({ name: c.name, room: c.room, createdBy: c.created_by, createdAt: c.created_at })));
});

app.get('/messages', requireAuth, (req, res) => {
  const room = String(req.query.room || 'general');
  if (!isAllowedRoom(req.username, room)) return res.status(403).json({ error: 'forbidden room' });
  res.json(getMessages.all(room).map(normaliseMessage));
});

app.get('/files', requireAuth, (req, res) => {
  const room = String(req.query.room || 'general');
  if (!isAllowedRoom(req.username, room)) return res.status(403).json({ error: 'forbidden room' });
  res.json(getFiles.all(room).map(normaliseFile));
});

app.get('/read-receipts', requireAuth, (req, res) => {
  const room = String(req.query.room || '');
  if (!isAllowedRoom(req.username, room)) return res.status(403).json({ error: 'forbidden room' });
  const rows = db.prepare(`SELECT username, last_message_id, updated_at FROM read_receipts WHERE room = ?`).all(room);
  res.json(rows.map(r => ({ user: r.username, lastMessageId: r.last_message_id, updatedAt: r.updated_at })));
});

// ---------------- SERVERS ----------------
app.get('/servers', requireAuth, (req, res) => {
  res.json(serversForUser(req.username));
});

app.post('/servers', requireAuth, (req, res) => {
  const name = cleanText(req.body.name, 60);
  const iconUrl = cleanText(req.body.iconUrl || '', 800);
  if (!name) return res.status(400).json({ error: 'server name required' });

  const result = db.prepare(`INSERT INTO servers (name, owner, icon_url, invite_code) VALUES (?, ?, ?, ?)`)
    .run(name, req.username, iconUrl, makeInviteCode());
  const serverId = Number(result.lastInsertRowid);
  db.prepare(`INSERT OR IGNORE INTO server_members (server_id, username, role) VALUES (?, ?, 'owner')`).run(serverId, req.username);
  insertServerChannel.run(serverId, 'general', `ch:${serverId}:general`, 0, req.username);
  insertServerChannel.run(serverId, 'random', `ch:${serverId}:random`, 1, req.username);

  sendToUser(req.username, 'serversChanged', {});
  const srv = getServerStmt.get(serverId);
  res.status(201).json({ id: serverId, name, inviteCode: srv.invite_code });
});

app.post('/servers/join', requireAuth, (req, res) => {
  const code = cleanText(req.body.code, 40).toLowerCase();
  const srv = getServerByCode.get(code);
  if (!srv) return res.status(404).json({ error: 'invite code not found' });
  db.prepare(`INSERT OR IGNORE INTO server_members (server_id, username, role) VALUES (?, ?, 'member')`).run(srv.id, req.username);
  notifyServerMembers(srv.id, 'serversChanged', {});
  res.json({ id: srv.id, name: srv.name });
});

app.post('/servers/:id/update', requireAuth, (req, res) => {
  const serverId = Number(req.params.id);
  if (!canManageServer(req.username, serverId)) return res.status(403).json({ error: 'only the server owner can do that' });
  const srv = getServerStmt.get(serverId);
  const name = cleanText(req.body.name || srv.name, 60) || srv.name;
  const iconUrl = req.body.iconUrl === undefined ? srv.icon_url : cleanText(req.body.iconUrl || '', 800);
  db.prepare(`UPDATE servers SET name = ?, icon_url = ? WHERE id = ?`).run(name, iconUrl, serverId);
  notifyServerMembers(serverId, 'serversChanged', {});
  res.json({ message: 'ok' });
});

app.post('/servers/:id/channels', requireAuth, (req, res) => {
  const serverId = Number(req.params.id);
  if (!canManageServer(req.username, serverId)) return res.status(403).json({ error: 'only the server owner can add channels' });
  const name = cleanText(req.body.name, 32).toLowerCase().replace(/^#/, '').replace(/\s+/g, '-');
  if (!validChannelName(name)) return res.status(400).json({ error: 'channel name must be 2-32 letters, numbers, hyphens or underscores' });

  const srv = getServerStmt.get(serverId);
  const room = srv.is_default ? name : `ch:${serverId}:${name}`;
  if (getChannelByRoomStmt.get(room)) return res.status(409).json({ error: 'channel already exists' });

  try {
    const position = getChannelsForServer.all(serverId).length;
    const result = insertServerChannel.run(serverId, name, room, position, req.username);
    if (srv.is_default) { try { insertChannelStmt.run(name, req.username); } catch (_) {} }
    notifyServerMembers(serverId, 'serversChanged', {});
    res.status(201).json({ id: Number(result.lastInsertRowid), name, room, serverId });
  } catch (_) {
    res.status(409).json({ error: 'channel already exists' });
  }
});

app.post('/servers/:id/channels/:channelId/delete', requireAuth, (req, res) => {
  const serverId = Number(req.params.id);
  const channelId = Number(req.params.channelId);
  if (!canManageServer(req.username, serverId)) return res.status(403).json({ error: 'only the server owner can delete channels' });
  const channel = getChannelByIdStmt.get(channelId);
  if (!channel || channel.server_id !== serverId) return res.status(404).json({ error: 'channel not found' });
  if (DEFAULT_CHANNELS.includes(channel.room)) return res.status(400).json({ error: 'default channels cannot be deleted' });
  if (getChannelsForServer.all(serverId).length <= 1) return res.status(400).json({ error: 'a server needs at least one channel' });

  db.prepare(`DELETE FROM server_channels WHERE id = ?`).run(channelId);
  deleteChannelStmt.run(channel.name);
  notifyServerMembers(serverId, 'serversChanged', {});
  res.json({ message: 'ok' });
});

app.post('/servers/:id/leave', requireAuth, (req, res) => {
  const serverId = Number(req.params.id);
  const srv = getServerStmt.get(serverId);
  if (!srv) return res.status(404).json({ error: 'server not found' });
  if (srv.is_default) return res.status(400).json({ error: 'you cannot leave the general server' });
  if (srv.owner === req.username) return res.status(400).json({ error: 'the owner cannot leave their own server' });
  db.prepare(`DELETE FROM server_members WHERE server_id = ? AND username = ?`).run(serverId, req.username);
  sendToUser(req.username, 'serversChanged', {});
  notifyServerMembers(serverId, 'serversChanged', {});
  res.json({ message: 'ok' });
});

app.post('/servers/:id/delete', requireAuth, (req, res) => {
  const serverId = Number(req.params.id);
  const srv = getServerStmt.get(serverId);
  if (!srv) return res.status(404).json({ error: 'server not found' });
  if (srv.is_default) return res.status(400).json({ error: 'the general server cannot be deleted' });
  if (srv.owner !== req.username && !isAdmin(req.username)) return res.status(403).json({ error: 'only the server owner can delete this server' });

  const members = serverMemberUsernames(serverId);
  db.prepare(`DELETE FROM server_channels WHERE server_id = ?`).run(serverId);
  db.prepare(`DELETE FROM server_members WHERE server_id = ?`).run(serverId);
  db.prepare(`DELETE FROM servers WHERE id = ?`).run(serverId);
  for (const member of members) sendToUser(member, 'serversChanged', {});
  res.json({ message: 'ok' });
});

app.get('/servers/:id/members', requireAuth, (req, res) => {
  const serverId = Number(req.params.id);
  if (!isServerMember(req.username, serverId)) return res.status(403).json({ error: 'forbidden' });
  const srv = getServerStmt.get(serverId);
  const names = serverMemberUsernames(serverId);
  res.json(names.map(name => {
    const profile = profileFor(name) || { username: name, displayName: name, avatarUrl: '', isAdmin: false };
    return {
      ...profile,
      role: srv.owner === name ? 'owner' : (serverMemberRole(name, serverId) === 'admin' ? 'admin' : 'member'),
      online: onlineUsers.has(name)
    };
  }).sort((a, b) => (b.online - a.online) || a.username.localeCompare(b.username)));
});

// Promote or demote a member to this server's "admin" role. Owner-level
// only (owner or global admin) - a server admin cannot create more admins,
// and nobody can touch the owner's own role through this endpoint.
app.post('/servers/:id/members/:username/role', requireAuth, (req, res) => {
  const serverId = Number(req.params.id);
  const target = cleanUsername(req.params.username);
  const role = String(req.body.role || '').trim();
  const srv = getServerStmt.get(serverId);
  if (!srv) return res.status(404).json({ error: 'server not found' });
  if (srv.is_default) return res.status(400).json({ error: 'the general server does not have per-server admins - use site-wide admin instead' });
  if (!isServerOwnerLevel(req.username, serverId)) return res.status(403).json({ error: 'only the server owner can change roles' });
  if (target === srv.owner) return res.status(400).json({ error: 'the owner already manages this server' });
  if (!['admin', 'member'].includes(role)) return res.status(400).json({ error: 'role must be "admin" or "member"' });
  if (!db.prepare(`SELECT 1 FROM server_members WHERE server_id = ? AND username = ?`).get(serverId, target)) {
    return res.status(404).json({ error: 'user is not a member of this server' });
  }

  db.prepare(`UPDATE server_members SET role = ? WHERE server_id = ? AND username = ?`).run(role, serverId, target);
  notifyServerMembers(serverId, 'serversChanged', {});
  sendToUser(target, 'adminNotice', {
    message: role === 'admin'
      ? `You have been made a server admin in ${srv.name}.`
      : `Your server admin permissions in ${srv.name} have been removed.`
  });
  res.json({ message: 'ok', role });
});

// ---------------- FRIENDS ----------------
app.get('/friends', requireAuth, (req, res) => {
  const rows = db.prepare(`
    SELECT * FROM friendships
    WHERE requester = ? OR addressee = ?
    ORDER BY updated_at DESC
  `).all(req.username, req.username);

  res.json(rows.map(r => ({
    requester: r.requester,
    addressee: r.addressee,
    otherUser: r.requester === req.username ? r.addressee : r.requester,
    direction: r.requester === req.username ? 'outgoing' : 'incoming',
    status: r.status,
    updatedAt: r.updated_at
  })));
});

app.post('/friends/request', requireAuth, (req, res) => {
  const to = cleanUsername(req.body.username);
  if (!validUsername(to) || to === req.username) return res.status(400).json({ error: 'invalid username' });
  if (!getUser.get(to)) return res.status(404).json({ error: 'user not found' });

  const pair = [req.username, to].sort();
  const existing = db.prepare(`SELECT * FROM friendships WHERE requester IN (?, ?) AND addressee IN (?, ?)`).get(pair[0], pair[1], pair[0], pair[1]);
  if (existing && existing.status === 'blocked') return res.status(403).json({ error: 'friend request blocked' });

  db.prepare(`
    INSERT INTO friendships (requester, addressee, status, updated_at)
    VALUES (?, ?, 'pending', datetime('now'))
    ON CONFLICT(requester, addressee) DO UPDATE SET status='pending', updated_at=datetime('now')
  `).run(req.username, to);
  sendToUser(to, 'friendsChanged', {});
  res.json({ message: 'request sent' });
});

app.post('/friends/respond', requireAuth, (req, res) => {
  const requester = cleanUsername(req.body.username);
  const action = String(req.body.action || '');
  if (!['accept', 'decline'].includes(action)) return res.status(400).json({ error: 'invalid action' });
  const row = db.prepare(`SELECT * FROM friendships WHERE requester = ? AND addressee = ? AND status = 'pending'`).get(requester, req.username);
  if (!row) return res.status(404).json({ error: 'friend request not found' });
  if (action === 'accept') {
    db.prepare(`UPDATE friendships SET status='accepted', updated_at=datetime('now') WHERE requester = ? AND addressee = ?`).run(requester, req.username);
  } else {
    db.prepare(`DELETE FROM friendships WHERE requester = ? AND addressee = ?`).run(requester, req.username);
  }
  sendToUser(requester, 'friendsChanged', {});
  res.json({ message: 'ok' });
});

app.post('/friends/remove', requireAuth, (req, res) => {
  const other = cleanUsername(req.body.username);
  db.prepare(`DELETE FROM friendships WHERE (requester = ? AND addressee = ?) OR (requester = ? AND addressee = ?)`).run(req.username, other, other, req.username);
  sendToUser(other, 'friendsChanged', {});
  res.json({ message: 'ok' });
});

app.post('/friends/block', requireAuth, (req, res) => {
  const other = cleanUsername(req.body.username);
  if (!validUsername(other) || other === req.username) return res.status(400).json({ error: 'invalid username' });
  if (!getUser.get(other)) return res.status(404).json({ error: 'user not found' });
  db.prepare(`DELETE FROM friendships WHERE (requester = ? AND addressee = ?) OR (requester = ? AND addressee = ?)`).run(req.username, other, other, req.username);
  db.prepare(`INSERT INTO friendships (requester, addressee, status) VALUES (?, ?, 'blocked')`).run(req.username, other);
  sendToUser(other, 'friendsChanged', {});
  res.json({ message: 'blocked' });
});

// ---------------- GROUPS ----------------
app.get('/groups', requireAuth, (req, res) => {
  const groups = db.prepare(`
    SELECT g.id, g.name, g.owner, g.icon_url, g.created_at
    FROM chat_groups g
    JOIN group_members gm ON gm.group_id = g.id
    WHERE gm.username = ?
    ORDER BY g.name COLLATE NOCASE ASC
  `).all(req.username);

  res.json(groups.map(g => ({
    id: g.id,
    room: `group:${g.id}`,
    name: g.name,
    owner: g.owner,
    iconUrl: g.icon_url || '',
    createdAt: g.created_at,
    isOwner: g.owner === req.username
  })));
});

app.post('/groups', requireAuth, (req, res) => {
  const name = cleanText(req.body.name, 60);
  const members = Array.isArray(req.body.members) ? req.body.members.map(cleanUsername).filter(Boolean) : [];
  if (!name) return res.status(400).json({ error: 'group name required' });

  const result = db.prepare(`INSERT INTO chat_groups (name, owner) VALUES (?, ?)`).run(name, req.username);
  const groupId = result.lastInsertRowid;
  db.prepare(`INSERT OR IGNORE INTO group_members (group_id, username, role) VALUES (?, ?, 'owner')`).run(groupId, req.username);

  const add = db.prepare(`INSERT OR IGNORE INTO group_members (group_id, username, role) VALUES (?, ?, 'member')`);
  for (const member of members) {
    if (validUsername(member) && getUser.get(member)) add.run(groupId, member);
  }

  io.emit('groupsChanged', {});
  res.status(201).json({ id: groupId, room: `group:${groupId}`, name });
});

app.post('/groups/:id/rename', requireAuth, (req, res) => {
  const groupId = Number(req.params.id);
  const name = cleanText(req.body.name, 60);
  const group = getGroup(groupId);
  if (!group || !isGroupMember(req.username, groupId)) return res.status(404).json({ error: 'group not found' });
  if (group.owner !== req.username && !isAdmin(req.username)) return res.status(403).json({ error: 'only the group owner can rename this group' });
  if (!name) return res.status(400).json({ error: 'group name required' });
  db.prepare(`UPDATE chat_groups SET name = ? WHERE id = ?`).run(name, groupId);
  io.to(`group:${groupId}`).emit('groupsChanged', {});
  io.emit('groupsChanged', {});
  res.json({ message: 'ok' });
});

app.post('/groups/:id/members', requireAuth, (req, res) => {
  const groupId = Number(req.params.id);
  const username = cleanUsername(req.body.username);
  const group = getGroup(groupId);
  if (!group || !isGroupMember(req.username, groupId)) return res.status(404).json({ error: 'group not found' });
  if (group.owner !== req.username && !isAdmin(req.username)) return res.status(403).json({ error: 'only the group owner can add members' });
  if (!validUsername(username) || !getUser.get(username)) return res.status(400).json({ error: 'user not found' });
  db.prepare(`INSERT OR IGNORE INTO group_members (group_id, username, role) VALUES (?, ?, 'member')`).run(groupId, username);
  sendToUser(username, 'groupsChanged', {});
  io.to(`group:${groupId}`).emit('groupsChanged', {});
  res.json({ message: 'ok' });
});

app.post('/groups/:id/remove-member', requireAuth, (req, res) => {
  const groupId = Number(req.params.id);
  const username = cleanUsername(req.body.username);
  const group = getGroup(groupId);
  if (!group || !isGroupMember(req.username, groupId)) return res.status(404).json({ error: 'group not found' });
  if (username === group.owner) return res.status(400).json({ error: 'cannot remove group owner' });
  if (group.owner !== req.username && !isAdmin(req.username)) return res.status(403).json({ error: 'only the group owner can remove members' });
  db.prepare(`DELETE FROM group_members WHERE group_id = ? AND username = ?`).run(groupId, username);
  sendToUser(username, 'groupsChanged', {});
  io.to(`group:${groupId}`).emit('groupsChanged', {});
  res.json({ message: 'ok' });
});

app.post('/groups/:id/leave', requireAuth, (req, res) => {
  const groupId = Number(req.params.id);
  const group = getGroup(groupId);
  if (!group || !isGroupMember(req.username, groupId)) return res.status(404).json({ error: 'group not found' });
  if (group.owner === req.username) return res.status(400).json({ error: 'owner cannot leave. Remove members or rename instead.' });
  db.prepare(`DELETE FROM group_members WHERE group_id = ? AND username = ?`).run(groupId, req.username);
  io.to(`group:${groupId}`).emit('groupsChanged', {});
  res.json({ message: 'ok' });
});

app.get('/groups/:id/members', requireAuth, (req, res) => {
  const groupId = Number(req.params.id);
  if (!isGroupMember(req.username, groupId)) return res.status(403).json({ error: 'forbidden' });
  const rows = db.prepare(`SELECT username, role FROM group_members WHERE group_id = ? ORDER BY username COLLATE NOCASE ASC`).all(groupId);
  res.json(rows.map(r => ({ ...r, ...(profileFor(r.username) || {}) })));
});

// ---------------- IMAGE UPLOAD (avatars / server icons) ----------------
// Stored under /avatars so everyone loads the same file from this server.
// That is what makes a profile picture visible to every other user instead of
// only to the person who picked it.
app.post('/upload-image', requireAuth, async (req, res) => {
  const contentLength = Number(req.headers['content-length'] || 0);
  if (contentLength > MAX_IMAGE_BYTES) return res.status(413).json({ error: 'image is too large. Maximum is 8MB.' });

  const fileType = cleanText(req.headers['x-file-type'] || '', 120).toLowerCase();
  if (!IMAGE_MIME.has(fileType)) return res.status(400).json({ error: 'only PNG, JPG, GIF, WEBP or AVIF images are allowed' });

  const originalName = safeFileName(decodeURIComponent(String(req.headers['x-file-name'] || 'image')));
  const ext = (path.extname(originalName) || '.' + fileType.split('/')[1]).slice(0, 16);
  const storedName = `${Date.now()}-${crypto.randomBytes(8).toString('hex')}${ext}`;
  const fullPath = path.join(AVATAR_DIR, storedName);

  try {
    const size = await saveUploadStream(req, fullPath, MAX_IMAGE_BYTES);
    res.status(201).json({ url: `/avatars/${storedName}`, size });
  } catch (err) {
    if (!res.headersSent) res.status(err.message === 'file is too large' ? 413 : 400).json({ error: err.message || 'upload failed' });
  }
});

// ---------------- UPLOAD ----------------
app.post('/upload', requireAuth, async (req, res) => {
  const contentLength = Number(req.headers['content-length'] || 0);
  if (contentLength > MAX_FILE_BYTES) return res.status(413).json({ error: 'file is too large. Maximum is 10GB.' });

  const room = String(req.headers['x-room'] || 'general');
  const to = cleanUsername(req.headers['x-to-user'] || '');
  const originalName = safeFileName(decodeURIComponent(String(req.headers['x-file-name'] || 'file')));
  const fileType = cleanText(req.headers['x-file-type'] || 'application/octet-stream', 120);
  let caption = '';
  try { caption = cleanText(decodeURIComponent(String(req.headers['x-caption'] || '')), 1000); } catch (_) { caption = ''; }

  if (!isAllowedRoom(req.username, room)) return res.status(403).json({ error: 'forbidden room' });

  let finalRoom = room;
  let toUser = '';
  let isGroup = groupIdFromRoom(room) ? 1 : 0;

  if (to) {
    if (!validUsername(to) || to === req.username || !getUser.get(to)) return res.status(400).json({ error: 'invalid recipient' });
    finalRoom = makeDMRoom(req.username, to);
    toUser = to;
    isGroup = 0;
  }

  if (isMuted(req.username)) return res.status(403).json({ error: 'you are muted' });

  const ext = path.extname(originalName).slice(0, 16);
  const storedName = `${Date.now()}-${crypto.randomBytes(8).toString('hex')}${ext}`;
  const fullPath = path.join(UPLOAD_DIR, storedName);

  try {
    const size = await saveUploadStream(req, fullPath, MAX_FILE_BYTES);
    const fileUrl = `/uploads/${storedName}`;
    const result = insertFile.run(finalRoom, req.username, toUser || null, isGroup, originalName, fileType, fileUrl, size, caption || null);
    const fileMsg = normaliseFile(getFileById.get(result.lastInsertRowid));

    if (toUser) {
      io.to(finalRoom).emit('dmFile', fileMsg);
      sendToUser(req.username, 'dmFile', fileMsg);
      sendToUser(toUser, 'dmFile', fileMsg);
    } else {
      io.to(finalRoom).emit('file', fileMsg);
    }

    res.status(201).json(fileMsg);
  } catch (err) {
    if (!res.headersSent) res.status(err.message === 'file is too large' ? 413 : 400).json({ error: err.message || 'upload failed' });
  }
});

app.set('io', io);

// ---------------- SOCKET AUTH ----------------
io.use((socket, next) => {
  const token = socket.handshake.auth && socket.handshake.auth.token;
  const username = tokens.get(token);
  const user = username ? getUser.get(username) : null;
  if (!user || user.banned) return next(new Error('not authenticated'));
  socket.username = username;
  next();
});

// ---------------- SOCKET EVENTS ----------------
io.on('connection', (socket) => {
  addOnlineUser(socket.username, socket.id);
  io.emit('users', getOnlineUsers());

  function syncRooms() {
    for (const room of socket.rooms) {
      if (room !== socket.id) socket.leave(room);
    }
    for (const room of allRoomsFor(socket.username)) socket.join(room);
  }
  syncRooms();

  socket.on('syncRooms', (ack) => {
    syncRooms();
    if (typeof ack === 'function') ack({ message: 'ok' });
  });

  socket.on('joinRoom', (room, ack) => {
    room = String(room || 'general');
    if (!isAllowedRoom(socket.username, room)) {
      if (typeof ack === 'function') ack({ error: 'forbidden room' });
      return;
    }
    socket.join(room);
    if (typeof ack === 'function') ack({ message: 'ok' });
  });

  socket.on('message', (data = {}, ack) => {
    const room = String(data.room || 'general');
    const text = cleanText(data.text, 4000);
    const replyTo = Number(data.replyTo || 0) || null;
    const muted = isMuted(socket.username);
    if (muted) {
      if (typeof ack === 'function') ack({ error: 'you are muted until ' + muted.muted_until });
      return;
    }
    if (!isAllowedRoom(socket.username, room) || getDMUsers(room)) {
      if (typeof ack === 'function') ack({ error: 'forbidden room' });
      return;
    }
    if (!text) return;

    const result = insertMessage.run(room, socket.username, text, null, groupIdFromRoom(room) ? 1 : 0, replyTo);
    const msg = normaliseMessage(getMessageById.get(result.lastInsertRowid));
    io.to(room).emit('message', msg);
    if (typeof ack === 'function') ack({ message: 'ok', id: msg.id });
  });

  socket.on('dmMessage', (data = {}, ack) => {
    const to = cleanUsername(data.to);
    const text = cleanText(data.text, 4000);
    const replyTo = Number(data.replyTo || 0) || null;
    const muted = isMuted(socket.username);
    if (muted) {
      if (typeof ack === 'function') ack({ error: 'you are muted until ' + muted.muted_until });
      return;
    }
    if (!validUsername(to) || to === socket.username || !getUser.get(to)) {
      if (typeof ack === 'function') ack({ error: 'invalid recipient' });
      return;
    }
    if (!text) return;

    const room = makeDMRoom(socket.username, to);
    const result = insertMessage.run(room, socket.username, text, to, 0, replyTo);
    const msg = normaliseMessage(getMessageById.get(result.lastInsertRowid));
    sendToUser(socket.username, 'dmMessage', msg);
    sendToUser(to, 'dmMessage', msg);
    if (typeof ack === 'function') ack({ message: 'ok', id: msg.id });
  });

  socket.on('editMessage', (data = {}, ack) => {
    const id = Number(data.id);
    const text = cleanText(data.text, 4000);
    const row = getMessageById.get(id);
    if (!row || row.deleted_at) {
      if (typeof ack === 'function') ack({ error: 'message not found' });
      return;
    }
    if (row.user !== socket.username) {
      if (typeof ack === 'function') ack({ error: 'you can only edit your own messages' });
      return;
    }
    if (!text) return;
    db.prepare(`UPDATE messages SET text = ?, edited_at = datetime('now') WHERE id = ?`).run(text, id);
    const msg = normaliseMessage(getMessageById.get(id));
    emitRoomOrDM(msg.room, msg.to, 'messageUpdated', msg);
    if (typeof ack === 'function') ack({ message: 'ok' });
  });

  socket.on('deleteMessage', (data = {}, ack) => {
    const id = Number(data.id);
    const row = getMessageById.get(id);
    if (!row || row.deleted_at) {
      if (typeof ack === 'function') ack({ error: 'message not found' });
      return;
    }
    if (row.user !== socket.username && !canModerateRoom(socket.username, row.room)) {
      if (typeof ack === 'function') ack({ error: 'you can only delete your own messages' });
      return;
    }
    db.prepare(`UPDATE messages SET deleted_at = datetime('now'), deleted_by = ? WHERE id = ?`).run(socket.username, id);
    const msg = normaliseMessage(getMessageById.get(id));
    emitRoomOrDM(msg.room, msg.to, 'messageDeleted', msg);
    if (typeof ack === 'function') ack({ message: 'ok' });
  });

  socket.on('reactMessage', (data = {}, ack) => {
    const id = Number(data.id);
    const emoji = String(data.emoji || '');
    const row = getMessageById.get(id);
    if (!row || row.deleted_at || !REACTION_EMOJIS.has(emoji) || !isAllowedRoom(socket.username, row.room)) {
      if (typeof ack === 'function') ack({ error: 'invalid reaction' });
      return;
    }
    const existing = db.prepare(`SELECT 1 FROM message_reactions WHERE message_id = ? AND username = ? AND emoji = ?`).get(id, socket.username, emoji);
    if (existing) {
      db.prepare(`DELETE FROM message_reactions WHERE message_id = ? AND username = ? AND emoji = ?`).run(id, socket.username, emoji);
    } else {
      db.prepare(`INSERT INTO message_reactions (message_id, username, emoji) VALUES (?, ?, ?)`).run(id, socket.username, emoji);
    }
    const payload = { id, room: row.room, reactions: reactionSummary(id) };
    emitRoomOrDM(row.room, row.to_user || '', 'reactionUpdated', payload);
    if (typeof ack === 'function') ack({ message: 'ok' });
  });

  socket.on('markRead', (data = {}) => {
    const room = String(data.room || '');
    const lastMessageId = Number(data.lastMessageId || 0);
    if (!room || !lastMessageId || !isAllowedRoom(socket.username, room)) return;
    db.prepare(`
      INSERT INTO read_receipts (room, username, last_message_id, updated_at)
      VALUES (?, ?, ?, datetime('now'))
      ON CONFLICT(room, username) DO UPDATE SET
        last_message_id = MAX(read_receipts.last_message_id, excluded.last_message_id),
        updated_at = datetime('now')
    `).run(room, socket.username, lastMessageId);
    const payload = { room, user: socket.username, lastMessageId };
    io.to(room).emit('readReceipt', payload);
    const other = getDMOtherUser(socket.username, room);
    if (other) sendToUser(other, 'readReceipt', payload);
  });

  socket.on('typing', (data = {}) => {
    const room = String(data.room || '');
    const to = cleanUsername(data.to);
    if (to) {
      if (!validUsername(to) || to === socket.username) return;
      sendToUser(to, 'typing', { room: makeDMRoom(socket.username, to), to, user: socket.username });
    } else if (isAllowedRoom(socket.username, room)) {
      socket.to(room).emit('typing', { room, user: socket.username });
    }
  });

  socket.on('stopTyping', (data = {}) => {
    const room = String(data.room || '');
    const to = cleanUsername(data.to);
    if (to) {
      if (!validUsername(to) || to === socket.username) return;
      sendToUser(to, 'stopTyping', { room: makeDMRoom(socket.username, to), to, user: socket.username });
    } else if (isAllowedRoom(socket.username, room)) {
      socket.to(room).emit('stopTyping', { room, user: socket.username });
    }
  });

  socket.on('adminAction', (data = {}, ack) => {
    if (!isAdmin(socket.username)) {
      if (typeof ack === 'function') ack({ error: 'admin only' });
      return;
    }

    const action = String(data.action || '');
    try {
      if (action === 'createChannel') {
        const name = cleanUsername(data.name).replace(/^#/, '');
        if (!validChannelName(name)) throw new Error('channel name must be 2-32 letters, numbers, hyphens or underscores');
        if (getChannelByRoomStmt.get(name)) throw new Error('channel already exists');
        insertChannelStmt.run(name, socket.username);
        insertServerChannel.run(DEFAULT_SERVER.id, name, name, getChannelsForServer.all(DEFAULT_SERVER.id).length, socket.username);
        io.emit('serversChanged', {});
        if (typeof ack === 'function') ack({ message: 'channel created' });
      } else if (action === 'deleteChannel') {
        const name = cleanUsername(data.name).replace(/^#/, '');
        if (DEFAULT_CHANNELS.includes(name)) throw new Error('default channels cannot be deleted');
        deleteChannelStmt.run(name);
        db.prepare(`DELETE FROM server_channels WHERE server_id = ? AND name = ?`).run(DEFAULT_SERVER.id, name);
        io.emit('serversChanged', {});
        if (typeof ack === 'function') ack({ message: 'channel deleted' });
      } else if (action === 'mute') {
        const user = cleanUsername(data.username);
        const minutes = Math.max(1, Math.min(Number(data.minutes || 60), 10080));
        if (!getUser.get(user)) throw new Error('user not found');
        const until = new Date(Date.now() + minutes * 60 * 1000).toISOString().slice(0, 19).replace('T', ' ');
        db.prepare(`INSERT INTO mutes (username, muted_until, muted_by) VALUES (?, ?, ?) ON CONFLICT(username) DO UPDATE SET muted_until=excluded.muted_until, muted_by=excluded.muted_by`).run(user, until, socket.username);
        sendToUser(user, 'adminNotice', { message: `You have been muted until ${until} UTC.` });
        if (typeof ack === 'function') ack({ message: 'user muted' });
      } else if (action === 'unmute') {
        const user = cleanUsername(data.username);
        db.prepare(`DELETE FROM mutes WHERE username = ?`).run(user);
        sendToUser(user, 'adminNotice', { message: 'You have been unmuted.' });
        if (typeof ack === 'function') ack({ message: 'user unmuted' });
      } else if (action === 'ban') {
        const user = cleanUsername(data.username);
        if (user === socket.username) throw new Error('you cannot ban yourself');
        if (!getUser.get(user)) throw new Error('user not found');
        db.prepare(`UPDATE users SET banned = 1 WHERE username = ?`).run(user);
        disconnectUser(user, 'You have been banned by admin.');
        io.emit('users', getOnlineUsers());
        if (typeof ack === 'function') ack({ message: 'user banned' });
      } else if (action === 'unban') {
        const user = cleanUsername(data.username);
        db.prepare(`UPDATE users SET banned = 0 WHERE username = ?`).run(user);
        if (typeof ack === 'function') ack({ message: 'user unbanned' });
      } else if (action === 'kick') {
        const user = cleanUsername(data.username);
        if (user === socket.username) throw new Error('you cannot kick yourself');
        disconnectUser(user, 'You have been kicked by admin.');
        io.emit('users', getOnlineUsers());
        if (typeof ack === 'function') ack({ message: 'user kicked' });
      } else if (action === 'setAdmin') {
        const user = cleanUsername(data.username);
        const makeAdmin = !!data.isAdmin;
        if (user === socket.username) throw new Error('you cannot change your own admin status');
        if (user === 'Purple') throw new Error('Purple is always an admin and cannot be changed');
        if (!getUser.get(user)) throw new Error('user not found');
        setAdminStmt.run(makeAdmin ? 1 : 0, user);
        const profile = profileFor(user);
        io.emit('profilesChanged', { username: user, profile });
        sendToUser(user, 'adminNotice', { message: makeAdmin ? 'You have been made an admin.' : 'Your admin permissions have been removed.' });
        if (typeof ack === 'function') ack({ message: makeAdmin ? 'user promoted to admin' : 'user demoted' });
      } else {
        throw new Error('unknown admin action');
      }
    } catch (err) {
      if (typeof ack === 'function') ack({ error: err.message });
    }
  });

  socket.on('disconnect', () => {
    removeOnlineUser(socket.id);
    io.emit('users', getOnlineUsers());
  });
});

server.listen(PORT, '0.0.0.0', () => {
  console.log(`Server running on port ${PORT}`);
});
