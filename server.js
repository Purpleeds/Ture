const express = require('express');
const http = require('http');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const bcrypt = require('bcryptjs');
const { Pool } = require('pg');
const { Server } = require('socket.io');

const app = express();
const server = http.createServer(app);
const io = new Server(server, {
  maxHttpBufferSize: 1024 * 1024
});

const PORT = process.env.PORT || 3000;
// Large file uploads (the 10GB file-share feature) still live on local disk,
// not in the database - Postgres is the wrong place for gigabyte blobs, and
// this feature already auto-deletes after a few hours anyway (see
// FILE_EXPIRY_HOURS below). On Render's free tier this folder does NOT
// survive a restart/sleep cycle, same as before - only messages, accounts,
// servers, avatars and server icons are now safe from that, because those
// live in Postgres instead.
const DATA_DIR = process.env.DATA_DIR || __dirname;
const PUBLIC_DIR = path.join(__dirname, 'public');
const UPLOAD_DIR = path.join(DATA_DIR, 'uploads');
const MAX_FILE_BYTES = 10 * 1024 * 1024 * 1024; // 10GB
// Avatars/server icons are stored as data: URIs directly in Postgres, so
// they must stay small - 1.5MB of raw image data (before it grows ~33%
// larger as base64 text) keeps each row a sane size.
const MAX_IMAGE_BYTES = 1.5 * 1024 * 1024;
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
  // { username: 'Moderator1', password: 'another-password', isAdmin: true },
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

if (!process.env.DATABASE_URL) {
  console.error('DATABASE_URL is not set. This app needs a Postgres database - see the deployment notes.');
  process.exit(1);
}

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  // Render's managed Postgres requires SSL; local/self-hosted Postgres
  // usually doesn't offer it. This accepts either without extra config.
  ssl: process.env.PGSSL === 'false' ? false : { rejectUnauthorized: false }
});

// Small helper so call sites read like the old synchronous style
// ("await q(...)") instead of repeating pool.query(...).rows everywhere.
async function q(text, params) {
  const result = await pool.query(text, params);
  return result.rows;
}
async function one(text, params) {
  const rows = await q(text, params);
  return rows[0] || null;
}

app.use(express.json({ limit: '256kb' }));
app.use(express.static(PUBLIC_DIR));
app.use('/uploads', express.static(UPLOAD_DIR, {
  index: false,
  fallthrough: false,
  maxAge: `${FILE_EXPIRY_HOURS}h`
}));

app.get('/', (req, res) => {
  res.sendFile(path.join(PUBLIC_DIR, 'index.html'));
});

// ---------------- DB SCHEMA ----------------
async function setupSchema() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS users (
      id SERIAL PRIMARY KEY,
      username TEXT UNIQUE NOT NULL,
      password_hash TEXT NOT NULL,
      display_name TEXT,
      avatar_url TEXT,
      banned INTEGER DEFAULT 0,
      is_admin INTEGER DEFAULT 0,
      created_at TIMESTAMPTZ DEFAULT NOW()
    );

    CREATE TABLE IF NOT EXISTS channels (
      name TEXT PRIMARY KEY,
      created_by TEXT,
      created_at TIMESTAMPTZ DEFAULT NOW()
    );

    CREATE TABLE IF NOT EXISTS servers (
      id SERIAL PRIMARY KEY,
      name TEXT NOT NULL,
      owner TEXT NOT NULL,
      icon_url TEXT,
      invite_code TEXT UNIQUE,
      is_default INTEGER DEFAULT 0,
      created_at TIMESTAMPTZ DEFAULT NOW()
    );

    CREATE TABLE IF NOT EXISTS server_members (
      server_id INTEGER NOT NULL,
      username TEXT NOT NULL,
      role TEXT DEFAULT 'member',
      joined_at TIMESTAMPTZ DEFAULT NOW(),
      UNIQUE(server_id, username)
    );

    CREATE TABLE IF NOT EXISTS server_channels (
      id SERIAL PRIMARY KEY,
      server_id INTEGER NOT NULL,
      name TEXT NOT NULL,
      room TEXT UNIQUE NOT NULL,
      topic TEXT,
      position INTEGER DEFAULT 0,
      created_by TEXT,
      created_at TIMESTAMPTZ DEFAULT NOW(),
      UNIQUE(server_id, name)
    );

    CREATE TABLE IF NOT EXISTS messages (
      id SERIAL PRIMARY KEY,
      room TEXT NOT NULL,
      "user" TEXT NOT NULL,
      text TEXT NOT NULL,
      to_user TEXT,
      is_group INTEGER DEFAULT 0,
      reply_to INTEGER,
      edited_at TIMESTAMPTZ,
      deleted_at TIMESTAMPTZ,
      deleted_by TEXT,
      created_at TIMESTAMPTZ DEFAULT NOW()
    );

    CREATE TABLE IF NOT EXISTS files (
      id SERIAL PRIMARY KEY,
      room TEXT NOT NULL,
      "user" TEXT NOT NULL,
      to_user TEXT,
      is_group INTEGER DEFAULT 0,
      file_name TEXT NOT NULL,
      file_type TEXT,
      file_url TEXT NOT NULL,
      file_size BIGINT,
      caption TEXT,
      created_at TIMESTAMPTZ DEFAULT NOW()
    );

    CREATE TABLE IF NOT EXISTS chat_groups (
      id SERIAL PRIMARY KEY,
      name TEXT NOT NULL,
      owner TEXT NOT NULL,
      icon_url TEXT,
      created_at TIMESTAMPTZ DEFAULT NOW()
    );

    CREATE TABLE IF NOT EXISTS group_members (
      group_id INTEGER NOT NULL,
      username TEXT NOT NULL,
      role TEXT DEFAULT 'member',
      joined_at TIMESTAMPTZ DEFAULT NOW(),
      UNIQUE(group_id, username)
    );

    CREATE TABLE IF NOT EXISTS friendships (
      requester TEXT NOT NULL,
      addressee TEXT NOT NULL,
      status TEXT NOT NULL,
      created_at TIMESTAMPTZ DEFAULT NOW(),
      updated_at TIMESTAMPTZ DEFAULT NOW(),
      UNIQUE(requester, addressee)
    );

    CREATE TABLE IF NOT EXISTS message_reactions (
      message_id INTEGER NOT NULL,
      username TEXT NOT NULL,
      emoji TEXT NOT NULL,
      created_at TIMESTAMPTZ DEFAULT NOW(),
      UNIQUE(message_id, username, emoji)
    );

    CREATE TABLE IF NOT EXISTS read_receipts (
      room TEXT NOT NULL,
      username TEXT NOT NULL,
      last_message_id INTEGER DEFAULT 0,
      updated_at TIMESTAMPTZ DEFAULT NOW(),
      UNIQUE(room, username)
    );

    CREATE TABLE IF NOT EXISTS mutes (
      username TEXT PRIMARY KEY,
      muted_until TIMESTAMPTZ NOT NULL,
      muted_by TEXT,
      created_at TIMESTAMPTZ DEFAULT NOW()
    );
  `);
}

// ---------------- SERVERS (guilds) ----------------
function makeInviteCode() {
  return crypto.randomBytes(4).toString('hex');
}

async function getServerById(id) {
  return one(`SELECT * FROM servers WHERE id = $1`, [id]);
}
async function getServerByCode(code) {
  return one(`SELECT * FROM servers WHERE invite_code = $1`, [code]);
}
async function getChannelByRoom(room) {
  return one(`SELECT * FROM server_channels WHERE room = $1`, [room]);
}
async function getChannelById(id) {
  return one(`SELECT * FROM server_channels WHERE id = $1`, [id]);
}
async function getChannelsForServer(serverId) {
  return q(`SELECT * FROM server_channels WHERE server_id = $1 ORDER BY position ASC, id ASC`, [serverId]);
}
async function insertServerChannel(serverId, name, room, position, createdBy) {
  return one(
    `INSERT INTO server_channels (server_id, name, room, position, created_by) VALUES ($1, $2, $3, $4, $5) RETURNING *`,
    [serverId, name, room, position, createdBy]
  );
}

async function ensureDefaultServer() {
  let row = await one(`SELECT * FROM servers WHERE is_default = 1`);
  if (!row) {
    row = await one(
      `INSERT INTO servers (name, owner, invite_code, is_default) VALUES ($1, 'system', $2, 1) RETURNING *`,
      [DEFAULT_SERVER_NAME, makeInviteCode()]
    );
  }

  // Original channels keep their plain room names so old history survives.
  let index = 0;
  for (const name of DEFAULT_CHANNELS) {
    const existing = await getChannelByRoom(name);
    if (!existing) await insertServerChannel(row.id, name, name, index, 'system');
    index++;
  }

  // Anything created through the old admin panel joins the default server too.
  const legacyChannels = await q(`SELECT name, created_by FROM channels`);
  for (const legacy of legacyChannels) {
    const existing = await getChannelByRoom(legacy.name);
    if (!existing) {
      try { await insertServerChannel(row.id, legacy.name, legacy.name, 99, legacy.created_by || 'system'); } catch (_) {}
    }
  }
  return row;
}

let DEFAULT_SERVER = null;

async function getUser(username) {
  return one(`SELECT * FROM users WHERE username = $1`, [username]);
}
async function createUser(username, passwordHash, displayName) {
  return one(
    `INSERT INTO users (username, password_hash, display_name) VALUES ($1, $2, $3) RETURNING *`,
    [username, passwordHash, displayName]
  );
}
async function setAdminFlag(username, isAdminValue) {
  await pool.query(`UPDATE users SET is_admin = $1 WHERE username = $2`, [isAdminValue ? 1 : 0, username]);
}

// Create any accounts listed in SEED_ACCOUNTS above that don't exist yet,
// and sync isAdmin for any that do. Runs once, every time the server boots.
async function applySeedAccounts() {
  for (const entry of SEED_ACCOUNTS) {
    const seedUsername = String((entry && entry.username) || '').trim();
    const seedPassword = String((entry && entry.password) || '');
    const seedIsAdmin = !!(entry && entry.isAdmin);
    if (!seedUsername) continue;
    if (!/^[a-zA-Z0-9_.-]{2,30}$/.test(seedUsername)) {
      console.warn(`[seed-accounts] skipping "${seedUsername}": username must be 2-30 letters, numbers, dots, hyphens or underscores`);
      continue;
    }

    const existing = await getUser(seedUsername);
    if (existing) {
      // Already exists - never touch their password, but keep isAdmin in
      // sync with what's written in SEED_ACCOUNTS so flipping true/false
      // here and restarting is enough to promote or demote them.
      if (!!existing.is_admin !== seedIsAdmin) {
        await setAdminFlag(seedUsername, seedIsAdmin);
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
      await createUser(seedUsername, hash, entry.displayName || seedUsername);
      if (seedIsAdmin) await setAdminFlag(seedUsername, true);
      console.log(`[seed-accounts] created account "${seedUsername}"${seedIsAdmin ? ' (admin)' : ''}`);
    } catch (err) {
      console.warn(`[seed-accounts] could not create "${seedUsername}": ${err.message}`);
    }
  }
}

async function insertChannel(name, createdBy) {
  await pool.query(`INSERT INTO channels (name, created_by) VALUES ($1, $2) ON CONFLICT (name) DO NOTHING`, [name, createdBy]);
}
async function deleteChannelRow(name) {
  await pool.query(`DELETE FROM channels WHERE name = $1`, [name]);
}
async function getMessageById(id) {
  return one(`SELECT * FROM messages WHERE id = $1`, [id]);
}
async function getMessagesForRoom(room) {
  return q(
    `SELECT id, room, "user", text, to_user, is_group, reply_to, edited_at, deleted_at, deleted_by, created_at
     FROM messages WHERE room = $1 ORDER BY id ASC LIMIT 300`,
    [room]
  );
}
async function insertMessage(room, user, text, toUser, isGroup, replyTo) {
  return one(
    `INSERT INTO messages (room, "user", text, to_user, is_group, reply_to) VALUES ($1, $2, $3, $4, $5, $6) RETURNING *`,
    [room, user, text, toUser, isGroup, replyTo]
  );
}
async function insertFile(room, user, toUser, isGroup, fileName, fileType, fileUrl, fileSize, caption) {
  return one(
    `INSERT INTO files (room, "user", to_user, is_group, file_name, file_type, file_url, file_size, caption)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9) RETURNING *`,
    [room, user, toUser, isGroup, fileName, fileType, fileUrl, fileSize, caption]
  );
}
async function getFileById(id) {
  return one(`SELECT * FROM files WHERE id = $1`, [id]);
}
async function getFilesForRoom(room) {
  return q(
    `SELECT id, room, "user", to_user, is_group, file_name, file_type, file_url, file_size, caption, created_at
     FROM files WHERE room = $1 ORDER BY id ASC LIMIT 120`,
    [room]
  );
}

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
async function isAdmin(username) {
  if (username === 'Purple') return true;
  const user = await getUser(username);
  return !!(user && user.is_admin);
}

function createToken(username) {
  const token = crypto.randomBytes(32).toString('hex');
  tokens.set(token, username);
  return token;
}

async function authFromRequest(req) {
  const header = req.headers.authorization || '';
  const token = header.startsWith('Bearer ') ? header.slice(7) : '';
  const username = tokens.get(token) || null;
  if (!username) return null;
  const user = await getUser(username);
  if (!user || user.banned) return null;
  return username;
}

async function requireAuth(req, res, next) {
  const username = await authFromRequest(req);
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

async function getGroup(id) {
  return one(`SELECT * FROM chat_groups WHERE id = $1`, [id]);
}

async function isGroupMember(username, groupId) {
  return !!(await one(`SELECT 1 FROM group_members WHERE group_id = $1 AND username = $2`, [groupId, username]));
}

async function isServerMember(username, serverId) {
  const srv = await getServerById(serverId);
  if (!srv) return false;
  if (srv.is_default) return true; // everyone is in the default "general" server
  return !!(await one(`SELECT 1 FROM server_members WHERE server_id = $1 AND username = $2`, [serverId, username]));
}

async function serverMemberRole(username, serverId) {
  const srv = await getServerById(serverId);
  if (!srv) return null;
  if (srv.owner === username) return 'owner';
  const row = await one(`SELECT role FROM server_members WHERE server_id = $1 AND username = $2`, [serverId, username]);
  return row ? row.role : null;
}

// Server admin: a member the owner (or a global admin) has promoted within
// THIS server only. They can manage this server's channels and moderate
// messages/members here, but can never delete the server or act on the
// owner - that stays owner + global-admin only, via canManageServer below.
async function isServerAdmin(username, serverId) {
  if (await isAdmin(username)) return true; // global admin outranks everyone everywhere
  const role = await serverMemberRole(username, serverId);
  return role === 'admin' || role === 'owner';
}

async function canManageServer(username, serverId) {
  const srv = await getServerById(serverId);
  if (!srv) return false;
  if (await isAdmin(username)) return true;
  if (srv.is_default) return false; // default server is global-admin-managed only
  if (srv.owner === username) return true;
  return (await serverMemberRole(username, serverId)) === 'admin';
}

// Stricter than canManageServer: only the owner or a global admin can
// delete the server, change ownership-level settings, or touch the owner.
async function isServerOwnerLevel(username, serverId) {
  const srv = await getServerById(serverId);
  if (!srv) return false;
  return (await isAdmin(username)) || srv.owner === username;
}

async function serversForUser(username) {
  const rows = await q(
    `SELECT s.* FROM servers s
     WHERE s.is_default = 1
        OR s.id IN (SELECT server_id FROM server_members WHERE username = $1)
     ORDER BY s.is_default DESC, s.id ASC`,
    [username]
  );

  const out = [];
  for (const s of rows) {
    const channels = await getChannelsForServer(s.id);
    out.push({
      id: s.id,
      name: s.name,
      owner: s.owner,
      iconUrl: s.icon_url || '',
      isDefault: !!s.is_default,
      isOwner: s.owner === username,
      isServerAdmin: await isServerAdmin(username, s.id),
      canManage: await canManageServer(username, s.id),
      canManageOwnerLevel: await isServerOwnerLevel(username, s.id),
      inviteCode: (s.owner === username || (await isAdmin(username)) || !s.is_default) ? s.invite_code : '',
      channels: channels.map(c => ({
        id: c.id,
        serverId: c.server_id,
        name: c.name,
        room: c.room,
        topic: c.topic || ''
      }))
    });
  }
  return out;
}

async function serverMemberUsernames(serverId) {
  const srv = await getServerById(serverId);
  if (!srv) return [];
  if (srv.is_default) return (await q(`SELECT username FROM users WHERE banned = 0`)).map(r => r.username);
  return (await q(`SELECT username FROM server_members WHERE server_id = $1`, [serverId])).map(r => r.username);
}

async function notifyServerMembers(serverId, event, payload) {
  for (const member of await serverMemberUsernames(serverId)) sendToUser(member, event, payload);
}

// Can this user moderate (delete other people's messages, etc.) in this
// room? True for a global admin anywhere, or a server admin/owner inside
// their own server's channels. DMs and group chats aren't moderated by
// server admins - only a global admin can act there.
async function canModerateRoom(username, room) {
  if (await isAdmin(username)) return true;
  const channel = await getChannelByRoom(room);
  if (channel) return isServerAdmin(username, channel.server_id);
  return false;
}

// Every room a user is entitled to sit in, so unread badges work for channels
// they are not currently looking at.
async function allRoomsFor(username) {
  const rooms = [];
  const servers = await q(`SELECT id, is_default FROM servers`);
  for (const s of servers) {
    if (s.is_default || (await isServerMember(username, s.id))) {
      for (const c of await getChannelsForServer(s.id)) rooms.push(c.room);
    }
  }
  const groupRows = await q(`SELECT group_id FROM group_members WHERE username = $1`, [username]);
  for (const g of groupRows) rooms.push('group:' + g.group_id);
  return rooms;
}

async function isAllowedRoom(username, room) {
  if (!username || !room) return false;
  const user = await getUser(username);
  if (!user || user.banned) return false;

  const channel = await getChannelByRoom(room);
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

async function getMute(username) {
  return one(`SELECT * FROM mutes WHERE username = $1`, [username]);
}

async function isMuted(username) {
  const mute = await getMute(username);
  if (!mute) return false;
  const until = new Date(mute.muted_until);
  if (!isNaN(until) && until > new Date()) return mute;
  await pool.query(`DELETE FROM mutes WHERE username = $1`, [username]);
  return false;
}

async function profileFor(username) {
  const u = await getUser(username);
  if (!u) return null;
  return {
    username: u.username,
    displayName: u.display_name || u.username,
    avatarUrl: u.avatar_url || '',
    isAdmin: await isAdmin(u.username)
  };
}

// Author details travel with every message so a client never has to guess an
// avatar from a stale local cache.
async function authorFields(username) {
  const u = await getUser(username);
  return {
    displayName: u ? (u.display_name || u.username) : username,
    avatarUrl: u ? (u.avatar_url || '') : ''
  };
}

async function reactionSummary(messageId) {
  const rows = await q(
    `SELECT emoji, COUNT(*) AS count, STRING_AGG(username, ',') AS users
     FROM message_reactions WHERE message_id = $1 GROUP BY emoji ORDER BY emoji`,
    [messageId]
  );
  return rows.map(r => ({ emoji: r.emoji, count: Number(r.count), users: r.users ? r.users.split(',') : [] }));
}

async function replyPreview(id) {
  if (!id) return null;
  const row = await getMessageById(id);
  if (!row) return null;
  const author = await authorFields(row.user);
  return {
    id: row.id,
    user: row.user,
    displayName: author.displayName,
    avatarUrl: author.avatarUrl,
    text: row.deleted_at ? '[message deleted]' : String(row.text || '').slice(0, 180)
  };
}

async function normaliseMessage(row) {
  if (!row) return null;
  const deleted = !!row.deleted_at;
  const author = await authorFields(row.user);
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
    replyTo: await replyPreview(row.reply_to),
    editedAt: row.edited_at || '',
    deleted,
    deletedBy: row.deleted_by || '',
    reactions: await reactionSummary(row.id),
    createdAt: row.created_at
  };
}

async function normaliseFile(row) {
  if (!row) return null;
  const author = await authorFields(row.user);
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
    fileSize: Number(row.file_size || 0),
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

async function removeOldFiles() {
  const oldFiles = await q(
    `SELECT id, file_url FROM files WHERE created_at <= NOW() - INTERVAL '${FILE_EXPIRY_HOURS} hours'`
  );

  for (const file of oldFiles) {
    if (!file.file_url) continue;
    if (!file.file_url.startsWith('/uploads/')) continue;
    const rel = file.file_url.replace(/^\/uploads\//, '');
    const filePath = path.join(UPLOAD_DIR, rel);
    if (filePath.startsWith(UPLOAD_DIR)) {
      try { fs.unlinkSync(filePath); } catch (_) {}
    }
  }

  await pool.query(`DELETE FROM files WHERE created_at <= NOW() - INTERVAL '${FILE_EXPIRY_HOURS} hours'`);
}

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

// Buffers a request body up to maxBytes and returns it as a Buffer. Used
// for avatar/icon uploads, which are stored as data: URIs in Postgres
// rather than written to disk.
function bufferUploadStream(req, maxBytes) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let total = 0;
    let finished = false;

    function cleanup(err) {
      if (finished) return;
      finished = true;
      reject(err);
    }

    req.on('data', chunk => {
      total += chunk.length;
      if (total > maxBytes) {
        cleanup(new Error('file is too large'));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => {
      if (finished) return;
      finished = true;
      resolve(Buffer.concat(chunks));
    });
    req.on('aborted', () => cleanup(new Error('upload cancelled')));
    req.on('error', cleanup);
  });
}

// Wraps an async route handler so a thrown error / rejected promise becomes
// a clean 500 instead of crashing the process or hanging the request.
function route(handler) {
  return (req, res) => {
    Promise.resolve(handler(req, res)).catch(err => {
      console.error(err);
      if (!res.headersSent) res.status(500).json({ error: 'server error' });
    });
  };
}

// ---------------- HTTP ROUTES ----------------
app.post('/register', route(async (req, res) => {
  const username = cleanUsername(req.body.username);
  const password = String(req.body.password || '');
  if (!username || !password) return res.status(400).json({ error: 'missing fields' });
  if (!validUsername(username)) return res.status(400).json({ error: 'username must be 2-30 letters, numbers, dots, hyphens or underscores' });
  if (password.length < 6) return res.status(400).json({ error: 'password must be at least 6 characters' });

  try {
    const hash = bcrypt.hashSync(password, 10);
    await createUser(username, hash, username);
    const token = createToken(username);
    res.status(201).json({ message: 'ok', username, token, profile: await profileFor(username) });
  } catch (_) {
    res.status(409).json({ error: 'user exists' });
  }
}));

app.post('/login', route(async (req, res) => {
  const username = cleanUsername(req.body.username);
  const password = String(req.body.password || '');
  if (!username || !password) return res.status(400).json({ error: 'missing fields' });

  let user = await getUser(username);

  // No account with this username yet: create one on the spot instead of
  // rejecting the login, as long as AUTO_REGISTER_ON_LOGIN is turned on
  // and the username/password would have passed /register's own rules.
  if (!user && AUTO_REGISTER_ON_LOGIN) {
    if (!validUsername(username)) return res.status(400).json({ error: 'username must be 2-30 letters, numbers, dots, hyphens or underscores' });
    if (password.length < 6) return res.status(400).json({ error: 'password must be at least 6 characters' });
    try {
      const hash = bcrypt.hashSync(password, 10);
      await createUser(username, hash, username);
      user = await getUser(username);
    } catch (_) {
      // Someone else raced us to create the same username - fall through
      // to the normal login check below using whatever now exists.
      user = await getUser(username);
    }
  }

  if (!user || user.banned) return res.status(401).json({ error: 'invalid username or password' });
  const ok = bcrypt.compareSync(password, user.password_hash);
  if (!ok) return res.status(401).json({ error: 'invalid username or password' });

  const token = createToken(username);
  res.json({ message: 'ok', username, token, profile: await profileFor(username) });
}));

app.post('/logout', requireAuth, route(async (req, res) => {
  const header = req.headers.authorization || '';
  const token = header.startsWith('Bearer ') ? header.slice(7) : '';
  if (token) tokens.delete(token);
  res.json({ message: 'ok' });
}));

app.get('/profile', requireAuth, route(async (req, res) => res.json(await profileFor(req.username))));

app.post('/profile', requireAuth, route(async (req, res) => {
  const displayName = cleanText(req.body.displayName || req.username, 40) || req.username;
  const avatarUrl = cleanText(req.body.avatarUrl || '', 200000); // data: URIs can be long
  await pool.query(`UPDATE users SET display_name = $1, avatar_url = $2 WHERE username = $3`, [displayName, avatarUrl, req.username]);
  const profile = await profileFor(req.username);
  io.emit('profilesChanged', { username: req.username, profile });
  res.json(profile);
}));

app.get('/profiles', requireAuth, route(async (req, res) => {
  const names = String(req.query.users || '')
    .split(',')
    .map(cleanUsername)
    .filter(Boolean)
    .slice(0, 200);
  const out = {};
  for (const name of names) {
    const profile = await profileFor(name);
    if (profile) out[name] = profile;
  }
  res.json(out);
}));

app.get('/users', requireAuth, route(async (req, res) => {
  const rows = await q(`SELECT username FROM users WHERE banned = 0 ORDER BY LOWER(username) ASC LIMIT 500`);
  const profiles = [];
  for (const r of rows) {
    const p = await profileFor(r.username);
    if (p) profiles.push(p);
  }
  res.json(profiles);
}));

// Legacy endpoint: channels of the default server.
app.get('/channels', requireAuth, route(async (req, res) => {
  const channels = await getChannelsForServer(DEFAULT_SERVER.id);
  res.json(channels.map(c => ({ name: c.name, room: c.room, createdBy: c.created_by, createdAt: c.created_at })));
}));

app.get('/messages', requireAuth, route(async (req, res) => {
  const room = String(req.query.room || 'general');
  if (!(await isAllowedRoom(req.username, room))) return res.status(403).json({ error: 'forbidden room' });
  const rows = await getMessagesForRoom(room);
  const out = [];
  for (const row of rows) out.push(await normaliseMessage(row));
  res.json(out);
}));

app.get('/files', requireAuth, route(async (req, res) => {
  const room = String(req.query.room || 'general');
  if (!(await isAllowedRoom(req.username, room))) return res.status(403).json({ error: 'forbidden room' });
  const rows = await getFilesForRoom(room);
  const out = [];
  for (const row of rows) out.push(await normaliseFile(row));
  res.json(out);
}));

app.get('/read-receipts', requireAuth, route(async (req, res) => {
  const room = String(req.query.room || '');
  if (!(await isAllowedRoom(req.username, room))) return res.status(403).json({ error: 'forbidden room' });
  const rows = await q(`SELECT username, last_message_id, updated_at FROM read_receipts WHERE room = $1`, [room]);
  res.json(rows.map(r => ({ user: r.username, lastMessageId: r.last_message_id, updatedAt: r.updated_at })));
}));

// ---------------- SERVERS ----------------
app.get('/servers', requireAuth, route(async (req, res) => {
  res.json(await serversForUser(req.username));
}));

app.post('/servers', requireAuth, route(async (req, res) => {
  const name = cleanText(req.body.name, 60);
  const iconUrl = cleanText(req.body.iconUrl || '', 200000);
  if (!name) return res.status(400).json({ error: 'server name required' });

  const srv = await one(
    `INSERT INTO servers (name, owner, icon_url, invite_code) VALUES ($1, $2, $3, $4) RETURNING *`,
    [name, req.username, iconUrl, makeInviteCode()]
  );
  const serverId = srv.id;
  await pool.query(`INSERT INTO server_members (server_id, username, role) VALUES ($1, $2, 'owner') ON CONFLICT DO NOTHING`, [serverId, req.username]);
  await insertServerChannel(serverId, 'general', `ch:${serverId}:general`, 0, req.username);
  await insertServerChannel(serverId, 'random', `ch:${serverId}:random`, 1, req.username);

  sendToUser(req.username, 'serversChanged', {});
  res.status(201).json({ id: serverId, name, inviteCode: srv.invite_code });
}));

app.post('/servers/join', requireAuth, route(async (req, res) => {
  const code = cleanText(req.body.code, 40).toLowerCase();
  const srv = await getServerByCode(code);
  if (!srv) return res.status(404).json({ error: 'invite code not found' });
  await pool.query(`INSERT INTO server_members (server_id, username, role) VALUES ($1, $2, 'member') ON CONFLICT DO NOTHING`, [srv.id, req.username]);
  await notifyServerMembers(srv.id, 'serversChanged', {});
  res.json({ id: srv.id, name: srv.name });
}));

app.post('/servers/:id/update', requireAuth, route(async (req, res) => {
  const serverId = Number(req.params.id);
  if (!(await canManageServer(req.username, serverId))) return res.status(403).json({ error: 'only the server owner can do that' });
  const srv = await getServerById(serverId);
  const name = cleanText(req.body.name || srv.name, 60) || srv.name;
  const iconUrl = req.body.iconUrl === undefined ? srv.icon_url : cleanText(req.body.iconUrl || '', 200000);
  await pool.query(`UPDATE servers SET name = $1, icon_url = $2 WHERE id = $3`, [name, iconUrl, serverId]);
  await notifyServerMembers(serverId, 'serversChanged', {});
  res.json({ message: 'ok' });
}));

app.post('/servers/:id/channels', requireAuth, route(async (req, res) => {
  const serverId = Number(req.params.id);
  if (!(await canManageServer(req.username, serverId))) return res.status(403).json({ error: 'only the server owner can add channels' });
  const name = cleanText(req.body.name, 32).toLowerCase().replace(/^#/, '').replace(/\s+/g, '-');
  if (!validChannelName(name)) return res.status(400).json({ error: 'channel name must be 2-32 letters, numbers, hyphens or underscores' });

  const srv = await getServerById(serverId);
  const room = srv.is_default ? name : `ch:${serverId}:${name}`;
  if (await getChannelByRoom(room)) return res.status(409).json({ error: 'channel already exists' });

  try {
    const position = (await getChannelsForServer(serverId)).length;
    const created = await insertServerChannel(serverId, name, room, position, req.username);
    if (srv.is_default) { try { await insertChannel(name, req.username); } catch (_) {} }
    await notifyServerMembers(serverId, 'serversChanged', {});
    res.status(201).json({ id: created.id, name, room, serverId });
  } catch (_) {
    res.status(409).json({ error: 'channel already exists' });
  }
}));

app.post('/servers/:id/channels/:channelId/delete', requireAuth, route(async (req, res) => {
  const serverId = Number(req.params.id);
  const channelId = Number(req.params.channelId);
  if (!(await canManageServer(req.username, serverId))) return res.status(403).json({ error: 'only the server owner can delete channels' });
  const channel = await getChannelById(channelId);
  if (!channel || channel.server_id !== serverId) return res.status(404).json({ error: 'channel not found' });
  if (DEFAULT_CHANNELS.includes(channel.room)) return res.status(400).json({ error: 'default channels cannot be deleted' });
  if ((await getChannelsForServer(serverId)).length <= 1) return res.status(400).json({ error: 'a server needs at least one channel' });

  await pool.query(`DELETE FROM server_channels WHERE id = $1`, [channelId]);
  await deleteChannelRow(channel.name);
  await notifyServerMembers(serverId, 'serversChanged', {});
  res.json({ message: 'ok' });
}));

app.post('/servers/:id/leave', requireAuth, route(async (req, res) => {
  const serverId = Number(req.params.id);
  const srv = await getServerById(serverId);
  if (!srv) return res.status(404).json({ error: 'server not found' });
  if (srv.is_default) return res.status(400).json({ error: 'you cannot leave the general server' });
  if (srv.owner === req.username) return res.status(400).json({ error: 'the owner cannot leave their own server' });
  await pool.query(`DELETE FROM server_members WHERE server_id = $1 AND username = $2`, [serverId, req.username]);
  sendToUser(req.username, 'serversChanged', {});
  await notifyServerMembers(serverId, 'serversChanged', {});
  res.json({ message: 'ok' });
}));

app.post('/servers/:id/delete', requireAuth, route(async (req, res) => {
  const serverId = Number(req.params.id);
  const srv = await getServerById(serverId);
  if (!srv) return res.status(404).json({ error: 'server not found' });
  if (srv.is_default) return res.status(400).json({ error: 'the general server cannot be deleted' });
  if (srv.owner !== req.username && !(await isAdmin(req.username))) return res.status(403).json({ error: 'only the server owner can delete this server' });

  const members = await serverMemberUsernames(serverId);
  await pool.query(`DELETE FROM server_channels WHERE server_id = $1`, [serverId]);
  await pool.query(`DELETE FROM server_members WHERE server_id = $1`, [serverId]);
  await pool.query(`DELETE FROM servers WHERE id = $1`, [serverId]);
  for (const member of members) sendToUser(member, 'serversChanged', {});
  res.json({ message: 'ok' });
}));

app.get('/servers/:id/members', requireAuth, route(async (req, res) => {
  const serverId = Number(req.params.id);
  if (!(await isServerMember(req.username, serverId))) return res.status(403).json({ error: 'forbidden' });
  const srv = await getServerById(serverId);
  const names = await serverMemberUsernames(serverId);
  const out = [];
  for (const name of names) {
    const profile = (await profileFor(name)) || { username: name, displayName: name, avatarUrl: '', isAdmin: false };
    const role = srv.owner === name ? 'owner' : ((await serverMemberRole(name, serverId)) === 'admin' ? 'admin' : 'member');
    out.push({ ...profile, role, online: onlineUsers.has(name) });
  }
  out.sort((a, b) => (Number(b.online) - Number(a.online)) || a.username.localeCompare(b.username));
  res.json(out);
}));

// Promote or demote a member to this server's "admin" role. Owner-level
// only (owner or global admin) - a server admin cannot create more admins,
// and nobody can touch the owner's own role through this endpoint.
app.post('/servers/:id/members/:username/role', requireAuth, route(async (req, res) => {
  const serverId = Number(req.params.id);
  const target = cleanUsername(req.params.username);
  const role = String(req.body.role || '').trim();
  const srv = await getServerById(serverId);
  if (!srv) return res.status(404).json({ error: 'server not found' });
  if (srv.is_default) return res.status(400).json({ error: 'the general server does not have per-server admins - use site-wide admin instead' });
  if (!(await isServerOwnerLevel(req.username, serverId))) return res.status(403).json({ error: 'only the server owner can change roles' });
  if (target === srv.owner) return res.status(400).json({ error: 'the owner already manages this server' });
  if (!['admin', 'member'].includes(role)) return res.status(400).json({ error: 'role must be "admin" or "member"' });
  if (!(await one(`SELECT 1 FROM server_members WHERE server_id = $1 AND username = $2`, [serverId, target]))) {
    return res.status(404).json({ error: 'user is not a member of this server' });
  }

  await pool.query(`UPDATE server_members SET role = $1 WHERE server_id = $2 AND username = $3`, [role, serverId, target]);
  await notifyServerMembers(serverId, 'serversChanged', {});
  sendToUser(target, 'adminNotice', {
    message: role === 'admin'
      ? `You have been made a server admin in ${srv.name}.`
      : `Your server admin permissions in ${srv.name} have been removed.`
  });
  res.json({ message: 'ok', role });
}));

// ---------------- FRIENDS ----------------
app.get('/friends', requireAuth, route(async (req, res) => {
  const rows = await q(
    `SELECT * FROM friendships WHERE requester = $1 OR addressee = $1 ORDER BY updated_at DESC`,
    [req.username]
  );

  res.json(rows.map(r => ({
    requester: r.requester,
    addressee: r.addressee,
    otherUser: r.requester === req.username ? r.addressee : r.requester,
    direction: r.requester === req.username ? 'outgoing' : 'incoming',
    status: r.status,
    updatedAt: r.updated_at
  })));
}));

app.post('/friends/request', requireAuth, route(async (req, res) => {
  const to = cleanUsername(req.body.username);
  if (!validUsername(to) || to === req.username) return res.status(400).json({ error: 'invalid username' });
  if (!(await getUser(to))) return res.status(404).json({ error: 'user not found' });

  const pair = [req.username, to].sort();
  const existing = await one(
    `SELECT * FROM friendships WHERE requester IN ($1, $2) AND addressee IN ($1, $2)`,
    [pair[0], pair[1]]
  );
  if (existing && existing.status === 'blocked') return res.status(403).json({ error: 'friend request blocked' });

  await pool.query(
    `INSERT INTO friendships (requester, addressee, status, updated_at)
     VALUES ($1, $2, 'pending', NOW())
     ON CONFLICT (requester, addressee) DO UPDATE SET status = 'pending', updated_at = NOW()`,
    [req.username, to]
  );
  sendToUser(to, 'friendsChanged', {});
  res.json({ message: 'request sent' });
}));

app.post('/friends/respond', requireAuth, route(async (req, res) => {
  const requester = cleanUsername(req.body.username);
  const action = String(req.body.action || '');
  if (!['accept', 'decline'].includes(action)) return res.status(400).json({ error: 'invalid action' });
  const row = await one(
    `SELECT * FROM friendships WHERE requester = $1 AND addressee = $2 AND status = 'pending'`,
    [requester, req.username]
  );
  if (!row) return res.status(404).json({ error: 'friend request not found' });
  if (action === 'accept') {
    await pool.query(`UPDATE friendships SET status = 'accepted', updated_at = NOW() WHERE requester = $1 AND addressee = $2`, [requester, req.username]);
  } else {
    await pool.query(`DELETE FROM friendships WHERE requester = $1 AND addressee = $2`, [requester, req.username]);
  }
  sendToUser(requester, 'friendsChanged', {});
  res.json({ message: 'ok' });
}));

app.post('/friends/remove', requireAuth, route(async (req, res) => {
  const other = cleanUsername(req.body.username);
  await pool.query(
    `DELETE FROM friendships WHERE (requester = $1 AND addressee = $2) OR (requester = $2 AND addressee = $1)`,
    [req.username, other]
  );
  sendToUser(other, 'friendsChanged', {});
  res.json({ message: 'ok' });
}));

app.post('/friends/block', requireAuth, route(async (req, res) => {
  const other = cleanUsername(req.body.username);
  if (!validUsername(other) || other === req.username) return res.status(400).json({ error: 'invalid username' });
  if (!(await getUser(other))) return res.status(404).json({ error: 'user not found' });
  await pool.query(
    `DELETE FROM friendships WHERE (requester = $1 AND addressee = $2) OR (requester = $2 AND addressee = $1)`,
    [req.username, other]
  );
  await pool.query(`INSERT INTO friendships (requester, addressee, status) VALUES ($1, $2, 'blocked')`, [req.username, other]);
  sendToUser(other, 'friendsChanged', {});
  res.json({ message: 'blocked' });
}));

// ---------------- GROUPS ----------------
app.get('/groups', requireAuth, route(async (req, res) => {
  const groups = await q(
    `SELECT g.id, g.name, g.owner, g.icon_url, g.created_at
     FROM chat_groups g
     JOIN group_members gm ON gm.group_id = g.id
     WHERE gm.username = $1
     ORDER BY LOWER(g.name) ASC`,
    [req.username]
  );

  res.json(groups.map(g => ({
    id: g.id,
    room: `group:${g.id}`,
    name: g.name,
    owner: g.owner,
    iconUrl: g.icon_url || '',
    createdAt: g.created_at,
    isOwner: g.owner === req.username
  })));
}));

app.post('/groups', requireAuth, route(async (req, res) => {
  const name = cleanText(req.body.name, 60);
  const members = Array.isArray(req.body.members) ? req.body.members.map(cleanUsername).filter(Boolean) : [];
  if (!name) return res.status(400).json({ error: 'group name required' });

  const group = await one(`INSERT INTO chat_groups (name, owner) VALUES ($1, $2) RETURNING *`, [name, req.username]);
  const groupId = group.id;
  await pool.query(`INSERT INTO group_members (group_id, username, role) VALUES ($1, $2, 'owner') ON CONFLICT DO NOTHING`, [groupId, req.username]);

  for (const member of members) {
    if (validUsername(member) && (await getUser(member))) {
      await pool.query(`INSERT INTO group_members (group_id, username, role) VALUES ($1, $2, 'member') ON CONFLICT DO NOTHING`, [groupId, member]);
    }
  }

  io.emit('groupsChanged', {});
  res.status(201).json({ id: groupId, room: `group:${groupId}`, name });
}));

app.post('/groups/:id/rename', requireAuth, route(async (req, res) => {
  const groupId = Number(req.params.id);
  const name = cleanText(req.body.name, 60);
  const group = await getGroup(groupId);
  if (!group || !(await isGroupMember(req.username, groupId))) return res.status(404).json({ error: 'group not found' });
  if (group.owner !== req.username && !(await isAdmin(req.username))) return res.status(403).json({ error: 'only the group owner can rename this group' });
  if (!name) return res.status(400).json({ error: 'group name required' });
  await pool.query(`UPDATE chat_groups SET name = $1 WHERE id = $2`, [name, groupId]);
  io.to(`group:${groupId}`).emit('groupsChanged', {});
  io.emit('groupsChanged', {});
  res.json({ message: 'ok' });
}));

app.post('/groups/:id/members', requireAuth, route(async (req, res) => {
  const groupId = Number(req.params.id);
  const username = cleanUsername(req.body.username);
  const group = await getGroup(groupId);
  if (!group || !(await isGroupMember(req.username, groupId))) return res.status(404).json({ error: 'group not found' });
  if (group.owner !== req.username && !(await isAdmin(req.username))) return res.status(403).json({ error: 'only the group owner can add members' });
  if (!validUsername(username) || !(await getUser(username))) return res.status(400).json({ error: 'user not found' });
  await pool.query(`INSERT INTO group_members (group_id, username, role) VALUES ($1, $2, 'member') ON CONFLICT DO NOTHING`, [groupId, username]);
  sendToUser(username, 'groupsChanged', {});
  io.to(`group:${groupId}`).emit('groupsChanged', {});
  res.json({ message: 'ok' });
}));

app.post('/groups/:id/remove-member', requireAuth, route(async (req, res) => {
  const groupId = Number(req.params.id);
  const username = cleanUsername(req.body.username);
  const group = await getGroup(groupId);
  if (!group || !(await isGroupMember(req.username, groupId))) return res.status(404).json({ error: 'group not found' });
  if (username === group.owner) return res.status(400).json({ error: 'cannot remove group owner' });
  if (group.owner !== req.username && !(await isAdmin(req.username))) return res.status(403).json({ error: 'only the group owner can remove members' });
  await pool.query(`DELETE FROM group_members WHERE group_id = $1 AND username = $2`, [groupId, username]);
  sendToUser(username, 'groupsChanged', {});
  io.to(`group:${groupId}`).emit('groupsChanged', {});
  res.json({ message: 'ok' });
}));

app.post('/groups/:id/leave', requireAuth, route(async (req, res) => {
  const groupId = Number(req.params.id);
  const group = await getGroup(groupId);
  if (!group || !(await isGroupMember(req.username, groupId))) return res.status(404).json({ error: 'group not found' });
  if (group.owner === req.username) return res.status(400).json({ error: 'owner cannot leave. Remove members or rename instead.' });
  await pool.query(`DELETE FROM group_members WHERE group_id = $1 AND username = $2`, [groupId, req.username]);
  io.to(`group:${groupId}`).emit('groupsChanged', {});
  res.json({ message: 'ok' });
}));

app.get('/groups/:id/members', requireAuth, route(async (req, res) => {
  const groupId = Number(req.params.id);
  if (!(await isGroupMember(req.username, groupId))) return res.status(403).json({ error: 'forbidden' });
  const rows = await q(`SELECT username, role FROM group_members WHERE group_id = $1 ORDER BY LOWER(username) ASC`, [groupId]);
  const out = [];
  for (const r of rows) out.push({ ...r, ...((await profileFor(r.username)) || {}) });
  res.json(out);
}));

// ---------------- IMAGE UPLOAD (avatars / server icons) ----------------
// Stored as a data: URI directly in Postgres (users.avatar_url /
// servers.icon_url) instead of on local disk. That's what makes a profile
// picture or server icon survive a Render free-tier restart - the database
// is persistent, the local filesystem is not.
app.post('/upload-image', requireAuth, route(async (req, res) => {
  const contentLength = Number(req.headers['content-length'] || 0);
  if (contentLength > MAX_IMAGE_BYTES) return res.status(413).json({ error: 'image is too large. Maximum is 1.5MB.' });

  const fileType = cleanText(req.headers['x-file-type'] || '', 120).toLowerCase();
  if (!IMAGE_MIME.has(fileType)) return res.status(400).json({ error: 'only PNG, JPG, GIF, WEBP or AVIF images are allowed' });

  try {
    const buffer = await bufferUploadStream(req, MAX_IMAGE_BYTES);
    const dataUrl = `data:${fileType};base64,${buffer.toString('base64')}`;
    res.status(201).json({ url: dataUrl, size: buffer.length });
  } catch (err) {
    if (!res.headersSent) res.status(err.message === 'file is too large' ? 413 : 400).json({ error: err.message || 'upload failed' });
  }
}));

// ---------------- UPLOAD ----------------
// General file sharing still writes to local disk (see the DATA_DIR note
// at the top of this file) - large files don't belong in Postgres, and
// this feature already expires after FILE_EXPIRY_HOURS regardless.
app.post('/upload', requireAuth, route(async (req, res) => {
  const contentLength = Number(req.headers['content-length'] || 0);
  if (contentLength > MAX_FILE_BYTES) return res.status(413).json({ error: 'file is too large. Maximum is 10GB.' });

  const room = String(req.headers['x-room'] || 'general');
  const to = cleanUsername(req.headers['x-to-user'] || '');
  const originalName = safeFileName(decodeURIComponent(String(req.headers['x-file-name'] || 'file')));
  const fileType = cleanText(req.headers['x-file-type'] || 'application/octet-stream', 120);
  let caption = '';
  try { caption = cleanText(decodeURIComponent(String(req.headers['x-caption'] || '')), 1000); } catch (_) { caption = ''; }

  if (!(await isAllowedRoom(req.username, room))) return res.status(403).json({ error: 'forbidden room' });

  let finalRoom = room;
  let toUser = '';
  let isGroup = groupIdFromRoom(room) ? 1 : 0;

  if (to) {
    if (!validUsername(to) || to === req.username || !(await getUser(to))) return res.status(400).json({ error: 'invalid recipient' });
    finalRoom = makeDMRoom(req.username, to);
    toUser = to;
    isGroup = 0;
  }

  if (await isMuted(req.username)) return res.status(403).json({ error: 'you are muted' });

  const ext = path.extname(originalName).slice(0, 16);
  const storedName = `${Date.now()}-${crypto.randomBytes(8).toString('hex')}${ext}`;
  const fullPath = path.join(UPLOAD_DIR, storedName);

  try {
    const size = await saveUploadStream(req, fullPath, MAX_FILE_BYTES);
    const fileUrl = `/uploads/${storedName}`;
    const created = await insertFile(finalRoom, req.username, toUser || null, isGroup, originalName, fileType, fileUrl, size, caption || null);
    const fileMsg = await normaliseFile(await getFileById(created.id));

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
}));

app.set('io', io);

// ---------------- SOCKET AUTH ----------------
io.use((socket, next) => {
  const token = socket.handshake.auth && socket.handshake.auth.token;
  const username = tokens.get(token);
  if (!username) return next(new Error('not authenticated'));
  getUser(username).then(user => {
    if (!user || user.banned) return next(new Error('not authenticated'));
    socket.username = username;
    next();
  }).catch(() => next(new Error('not authenticated')));
});

// ---------------- SOCKET EVENTS ----------------
io.on('connection', (socket) => {
  addOnlineUser(socket.username, socket.id);
  io.emit('users', getOnlineUsers());

  async function syncRooms() {
    for (const room of socket.rooms) {
      if (room !== socket.id) socket.leave(room);
    }
    for (const room of await allRoomsFor(socket.username)) socket.join(room);
  }
  syncRooms();

  socket.on('syncRooms', (ack) => {
    syncRooms().then(() => { if (typeof ack === 'function') ack({ message: 'ok' }); });
  });

  socket.on('joinRoom', async (room, ack) => {
    room = String(room || 'general');
    if (!(await isAllowedRoom(socket.username, room))) {
      if (typeof ack === 'function') ack({ error: 'forbidden room' });
      return;
    }
    socket.join(room);
    if (typeof ack === 'function') ack({ message: 'ok' });
  });

  socket.on('message', async (data = {}, ack) => {
    const room = String(data.room || 'general');
    const text = cleanText(data.text, 4000);
    const replyTo = Number(data.replyTo || 0) || null;
    const muted = await isMuted(socket.username);
    if (muted) {
      if (typeof ack === 'function') ack({ error: 'you are muted until ' + muted.muted_until });
      return;
    }
    if (!(await isAllowedRoom(socket.username, room)) || getDMUsers(room)) {
      if (typeof ack === 'function') ack({ error: 'forbidden room' });
      return;
    }
    if (!text) return;

    const created = await insertMessage(room, socket.username, text, null, groupIdFromRoom(room) ? 1 : 0, replyTo);
    const msg = await normaliseMessage(created);
    io.to(room).emit('message', msg);
    if (typeof ack === 'function') ack({ message: 'ok', id: msg.id });
  });

  socket.on('dmMessage', async (data = {}, ack) => {
    const to = cleanUsername(data.to);
    const text = cleanText(data.text, 4000);
    const replyTo = Number(data.replyTo || 0) || null;
    const muted = await isMuted(socket.username);
    if (muted) {
      if (typeof ack === 'function') ack({ error: 'you are muted until ' + muted.muted_until });
      return;
    }
    if (!validUsername(to) || to === socket.username || !(await getUser(to))) {
      if (typeof ack === 'function') ack({ error: 'invalid recipient' });
      return;
    }
    if (!text) return;

    const room = makeDMRoom(socket.username, to);
    const created = await insertMessage(room, socket.username, text, to, 0, replyTo);
    const msg = await normaliseMessage(created);
    sendToUser(socket.username, 'dmMessage', msg);
    sendToUser(to, 'dmMessage', msg);
    if (typeof ack === 'function') ack({ message: 'ok', id: msg.id });
  });

  socket.on('editMessage', async (data = {}, ack) => {
    const id = Number(data.id);
    const text = cleanText(data.text, 4000);
    const row = await getMessageById(id);
    if (!row || row.deleted_at) {
      if (typeof ack === 'function') ack({ error: 'message not found' });
      return;
    }
    if (row.user !== socket.username) {
      if (typeof ack === 'function') ack({ error: 'you can only edit your own messages' });
      return;
    }
    if (!text) return;
    await pool.query(`UPDATE messages SET text = $1, edited_at = NOW() WHERE id = $2`, [text, id]);
    const msg = await normaliseMessage(await getMessageById(id));
    emitRoomOrDM(msg.room, msg.to, 'messageUpdated', msg);
    if (typeof ack === 'function') ack({ message: 'ok' });
  });

  socket.on('deleteMessage', async (data = {}, ack) => {
    const id = Number(data.id);
    const row = await getMessageById(id);
    if (!row || row.deleted_at) {
      if (typeof ack === 'function') ack({ error: 'message not found' });
      return;
    }
    if (row.user !== socket.username && !(await canModerateRoom(socket.username, row.room))) {
      if (typeof ack === 'function') ack({ error: 'you can only delete your own messages' });
      return;
    }
    await pool.query(`UPDATE messages SET deleted_at = NOW(), deleted_by = $1 WHERE id = $2`, [socket.username, id]);
    const msg = await normaliseMessage(await getMessageById(id));
    emitRoomOrDM(msg.room, msg.to, 'messageDeleted', msg);
    if (typeof ack === 'function') ack({ message: 'ok' });
  });

  socket.on('reactMessage', async (data = {}, ack) => {
    const id = Number(data.id);
    const emoji = String(data.emoji || '');
    const row = await getMessageById(id);
    if (!row || row.deleted_at || !REACTION_EMOJIS.has(emoji) || !(await isAllowedRoom(socket.username, row.room))) {
      if (typeof ack === 'function') ack({ error: 'invalid reaction' });
      return;
    }
    const existing = await one(`SELECT 1 FROM message_reactions WHERE message_id = $1 AND username = $2 AND emoji = $3`, [id, socket.username, emoji]);
    if (existing) {
      await pool.query(`DELETE FROM message_reactions WHERE message_id = $1 AND username = $2 AND emoji = $3`, [id, socket.username, emoji]);
    } else {
      await pool.query(`INSERT INTO message_reactions (message_id, username, emoji) VALUES ($1, $2, $3)`, [id, socket.username, emoji]);
    }
    const payload = { id, room: row.room, reactions: await reactionSummary(id) };
    emitRoomOrDM(row.room, row.to_user || '', 'reactionUpdated', payload);
    if (typeof ack === 'function') ack({ message: 'ok' });
  });

  socket.on('markRead', async (data = {}) => {
    const room = String(data.room || '');
    const lastMessageId = Number(data.lastMessageId || 0);
    if (!room || !lastMessageId || !(await isAllowedRoom(socket.username, room))) return;
    await pool.query(
      `INSERT INTO read_receipts (room, username, last_message_id, updated_at)
       VALUES ($1, $2, $3, NOW())
       ON CONFLICT (room, username) DO UPDATE SET
         last_message_id = GREATEST(read_receipts.last_message_id, EXCLUDED.last_message_id),
         updated_at = NOW()`,
      [room, socket.username, lastMessageId]
    );
    const payload = { room, user: socket.username, lastMessageId };
    io.to(room).emit('readReceipt', payload);
    const other = getDMOtherUser(socket.username, room);
    if (other) sendToUser(other, 'readReceipt', payload);
  });

  socket.on('typing', async (data = {}) => {
    const room = String(data.room || '');
    const to = cleanUsername(data.to);
    if (to) {
      if (!validUsername(to) || to === socket.username) return;
      sendToUser(to, 'typing', { room: makeDMRoom(socket.username, to), to, user: socket.username });
    } else if (await isAllowedRoom(socket.username, room)) {
      socket.to(room).emit('typing', { room, user: socket.username });
    }
  });

  socket.on('stopTyping', async (data = {}) => {
    const room = String(data.room || '');
    const to = cleanUsername(data.to);
    if (to) {
      if (!validUsername(to) || to === socket.username) return;
      sendToUser(to, 'stopTyping', { room: makeDMRoom(socket.username, to), to, user: socket.username });
    } else if (await isAllowedRoom(socket.username, room)) {
      socket.to(room).emit('stopTyping', { room, user: socket.username });
    }
  });

  socket.on('adminAction', async (data = {}, ack) => {
    if (!(await isAdmin(socket.username))) {
      if (typeof ack === 'function') ack({ error: 'admin only' });
      return;
    }

    const action = String(data.action || '');
    try {
      if (action === 'createChannel') {
        const name = cleanUsername(data.name).replace(/^#/, '');
        if (!validChannelName(name)) throw new Error('channel name must be 2-32 letters, numbers, hyphens or underscores');
        if (await getChannelByRoom(name)) throw new Error('channel already exists');
        await insertChannel(name, socket.username);
        await insertServerChannel(DEFAULT_SERVER.id, name, name, (await getChannelsForServer(DEFAULT_SERVER.id)).length, socket.username);
        io.emit('serversChanged', {});
        if (typeof ack === 'function') ack({ message: 'channel created' });
      } else if (action === 'deleteChannel') {
        const name = cleanUsername(data.name).replace(/^#/, '');
        if (DEFAULT_CHANNELS.includes(name)) throw new Error('default channels cannot be deleted');
        await deleteChannelRow(name);
        await pool.query(`DELETE FROM server_channels WHERE server_id = $1 AND name = $2`, [DEFAULT_SERVER.id, name]);
        io.emit('serversChanged', {});
        if (typeof ack === 'function') ack({ message: 'channel deleted' });
      } else if (action === 'mute') {
        const user = cleanUsername(data.username);
        const minutes = Math.max(1, Math.min(Number(data.minutes || 60), 10080));
        if (!(await getUser(user))) throw new Error('user not found');
        const until = new Date(Date.now() + minutes * 60 * 1000);
        await pool.query(
          `INSERT INTO mutes (username, muted_until, muted_by) VALUES ($1, $2, $3)
           ON CONFLICT (username) DO UPDATE SET muted_until = EXCLUDED.muted_until, muted_by = EXCLUDED.muted_by`,
          [user, until, socket.username]
        );
        sendToUser(user, 'adminNotice', { message: `You have been muted until ${until.toISOString()}.` });
        if (typeof ack === 'function') ack({ message: 'user muted' });
      } else if (action === 'unmute') {
        const user = cleanUsername(data.username);
        await pool.query(`DELETE FROM mutes WHERE username = $1`, [user]);
        sendToUser(user, 'adminNotice', { message: 'You have been unmuted.' });
        if (typeof ack === 'function') ack({ message: 'user unmuted' });
      } else if (action === 'ban') {
        const user = cleanUsername(data.username);
        if (user === socket.username) throw new Error('you cannot ban yourself');
        if (!(await getUser(user))) throw new Error('user not found');
        await pool.query(`UPDATE users SET banned = 1 WHERE username = $1`, [user]);
        disconnectUser(user, 'You have been banned by admin.');
        io.emit('users', getOnlineUsers());
        if (typeof ack === 'function') ack({ message: 'user banned' });
      } else if (action === 'unban') {
        const user = cleanUsername(data.username);
        await pool.query(`UPDATE users SET banned = 0 WHERE username = $1`, [user]);
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
        if (!(await getUser(user))) throw new Error('user not found');
        await setAdminFlag(user, makeAdmin);
        const profile = await profileFor(user);
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

// ---------------- BOOT ----------------
async function main() {
  await setupSchema();
  DEFAULT_SERVER = await ensureDefaultServer();
  for (const name of DEFAULT_CHANNELS) {
    await pool.query(`INSERT INTO channels (name, created_by) VALUES ($1, 'system') ON CONFLICT (name) DO NOTHING`, [name]);
  }
  await applySeedAccounts();
  setInterval(() => { removeOldFiles().catch(err => console.error('removeOldFiles failed:', err)); }, 60 * 1000);
  await removeOldFiles();

  server.listen(PORT, '0.0.0.0', () => {
    console.log(`Server running on port ${PORT}`);
  });
}

main().catch(err => {
  console.error('Failed to start server:', err);
  process.exit(1);
});
