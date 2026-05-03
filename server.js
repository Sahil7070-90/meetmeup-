const express    = require("express");
const http       = require("http");
const { Server } = require("socket.io");
const { ExpressPeerServer } = require("peer");
const { v4: uuidv4 } = require("uuid");
const bcrypt     = require("bcryptjs");
const jwt        = require("jsonwebtoken");
const path       = require("path");

const app    = express();
const server = http.createServer(app);

// ── PeerJS (Video) ──────────────────────────────────────────────
const peerServer = ExpressPeerServer(server, { debug: false, path: "/" });
app.use("/peerjs", peerServer);

// ── Socket.io ───────────────────────────────────────────────────
const io = new Server(server, { cors: { origin: "*" } });

app.use(express.static(path.join(__dirname, "public")));
app.use(express.json());

// ── Config ──────────────────────────────────────────────────────
const JWT_SECRET     = process.env.JWT_SECRET || "meetmeup_secret_key_change_me";
const ADMIN_PASSWORD = process.env.ADMIN_PASS  || "meetmeup@admin123";

// ── In-Memory DB (users survive restarts if you add file storage later) ──
// Structure: { id, username, email, passwordHash, avatar, joinedAt, totalChats, isBanned }
const users   = new Map(); // email → user object
const byToken = new Map(); // socketId → decoded user

// ── State ───────────────────────────────────────────────────────
const waitingVideo = new Map(); // mode=video queue: socketId → socket
const waitingText  = new Map(); // mode=text  queue: socketId → socket
let waitingVideoSocket = null;
let waitingTextSocket  = null;

let onlineCount       = 0;
let totalConnections  = 0;
let totalChats        = 0;
let reports           = [];

// ── Auth Routes ─────────────────────────────────────────────────

// Register
app.post("/api/register", async (req, res) => {
  const { username, email, password } = req.body;
  if (!username || !email || !password)
    return res.status(400).json({ error: "Sabhi fields bharo!" });
  if (username.length < 3)
    return res.status(400).json({ error: "Username kam se kam 3 characters ka hona chahiye!" });
  if (password.length < 6)
    return res.status(400).json({ error: "Password kam se kam 6 characters ka hona chahiye!" });
  if (users.has(email.toLowerCase()))
    return res.status(400).json({ error: "Yeh email pehle se registered hai!" });

  // Check username unique
  const usernameTaken = [...users.values()].some(u => u.username.toLowerCase() === username.toLowerCase());
  if (usernameTaken)
    return res.status(400).json({ error: "Yeh username pehle se le liya gaya hai!" });

  const passwordHash = await bcrypt.hash(password, 10);
  const user = {
    id: uuidv4(),
    username,
    email: email.toLowerCase(),
    passwordHash,
    avatar: username.charAt(0).toUpperCase(),
    joinedAt: new Date().toISOString(),
    totalChats: 0,
    isBanned: false,
  };
  users.set(email.toLowerCase(), user);

  const token = jwt.sign({ id: user.id, username: user.username, email: user.email }, JWT_SECRET, { expiresIn: "7d" });
  res.json({ success: true, token, user: safeUser(user) });
});

// Login
app.post("/api/login", async (req, res) => {
  const { email, password } = req.body;
  if (!email || !password)
    return res.status(400).json({ error: "Email aur password daalo!" });

  const user = users.get(email.toLowerCase());
  if (!user)
    return res.status(400).json({ error: "Email registered nahi hai!" });
  if (user.isBanned)
    return res.status(403).json({ error: "Aapka account ban ho gaya hai!" });

  const valid = await bcrypt.compare(password, user.passwordHash);
  if (!valid)
    return res.status(400).json({ error: "Password galat hai!" });

  const token = jwt.sign({ id: user.id, username: user.username, email: user.email }, JWT_SECRET, { expiresIn: "7d" });
  res.json({ success: true, token, user: safeUser(user) });
});

// Verify token
app.get("/api/me", (req, res) => {
  const auth = req.headers.authorization;
  if (!auth) return res.status(401).json({ error: "Not logged in" });
  try {
    const decoded = jwt.verify(auth.split(" ")[1], JWT_SECRET);
    const user = [...users.values()].find(u => u.id === decoded.id);
    if (!user) return res.status(404).json({ error: "User not found" });
    res.json({ user: safeUser(user) });
  } catch {
    res.status(401).json({ error: "Token invalid" });
  }
});

// ── Admin Routes ─────────────────────────────────────────────────
app.post("/api/admin/stats", (req, res) => {
  if (req.body.password !== ADMIN_PASSWORD)
    return res.status(401).json({ error: "Wrong password!" });

  res.json({
    onlineNow: onlineCount,
    totalConnections,
    totalChats,
    totalUsers: users.size,
    waitingVideo: waitingVideoSocket ? 1 : 0,
    waitingText:  waitingTextSocket  ? 1 : 0,
    reports: reports.slice(-30),
    uptime: process.uptime(),
    userList: [...users.values()].map(safeUser),
  });
});

app.post("/api/admin/ban", (req, res) => {
  if (req.body.password !== ADMIN_PASSWORD)
    return res.status(401).json({ error: "Wrong password!" });
  const user = [...users.values()].find(u => u.id === req.body.userId);
  if (!user) return res.status(404).json({ error: "User not found" });
  user.isBanned = !user.isBanned;
  res.json({ success: true, isBanned: user.isBanned });
});

// Report
app.post("/api/report", (req, res) => {
  const { reason, reporterSocket, reporterName } = req.body;
  reports.push({ id: uuidv4(), reason, reporterSocket, reporterName: reporterName || "Anonymous", time: new Date().toISOString() });
  res.json({ success: true });
});

// Pages
app.get("/", (req, res) => res.sendFile(path.join(__dirname, "public", "index.html")));
app.get("/admin", (req, res) => res.sendFile(path.join(__dirname, "public", "admin.html")));

// ── Socket.io ───────────────────────────────────────────────────
io.on("connection", (socket) => {
  onlineCount++;
  totalConnections++;
  io.emit("online-count", onlineCount);

  // Auth via token
  socket.on("auth", (token) => {
    try {
      const decoded = jwt.verify(token, JWT_SECRET);
      socket.user = decoded;
      const u = [...users.values()].find(u => u.id === decoded.id);
      if (u) u.totalChats; // access it
    } catch { socket.user = null; }
  });

  // Guest join (no account)
  socket.on("join-guest", (name) => {
    socket.user = { username: name || "Guest", id: "guest_" + socket.id };
  });

  // Register peer ID
  socket.on("register-peer", (peerId) => { socket.peerId = peerId; });

  // ── Find Stranger ──
  socket.on("find-stranger", (mode) => {
    socket.chatMode = mode; // "video" or "text"
    cleanPartner(socket);

    if (mode === "video") {
      if (waitingVideoSocket && waitingVideoSocket.id !== socket.id && waitingVideoSocket.connected) {
        matchPair(socket, waitingVideoSocket, "video");
        waitingVideoSocket = null;
      } else {
        waitingVideoSocket = socket;
        socket.emit("waiting");
      }
    } else {
      if (waitingTextSocket && waitingTextSocket.id !== socket.id && waitingTextSocket.connected) {
        matchPair(socket, waitingTextSocket, "text");
        waitingTextSocket = null;
      } else {
        waitingTextSocket = socket;
        socket.emit("waiting");
      }
    }
  });

  // ── Chat Message ──
  socket.on("chat-message", (msg) => {
    if (socket.partner && typeof msg === "string" && msg.length <= 500) {
      socket.partner.emit("chat-message", {
        text: msg,
        from: "stranger",
        name: socket.user?.username || "Stranger",
      });
    }
  });

  // ── Typing indicator ──
  socket.on("typing", (isTyping) => {
    if (socket.partner) socket.partner.emit("partner-typing", isTyping);
  });

  // ── Skip ──
  socket.on("skip", () => {
    cleanPartner(socket, true);
    if (waitingVideoSocket === socket) waitingVideoSocket = null;
    if (waitingTextSocket  === socket) waitingTextSocket  = null;
    socket.emit("skipped");
  });

  // ── Disconnect ──
  socket.on("disconnect", () => {
    onlineCount = Math.max(0, onlineCount - 1);
    io.emit("online-count", onlineCount);
    cleanPartner(socket, true);
    if (waitingVideoSocket === socket) waitingVideoSocket = null;
    if (waitingTextSocket  === socket) waitingTextSocket  = null;
  });
});

// ── Helpers ─────────────────────────────────────────────────────
function matchPair(a, b, mode) {
  totalChats++;
  a.partner = b; b.partner = a;
  const aName = a.user?.username || "Stranger";
  const bName = b.user?.username || "Stranger";

  if (mode === "video") {
    a.emit("matched", { mode: "video", partnerPeerId: b.peerId, initiator: false, partnerName: bName });
    b.emit("matched", { mode: "video", partnerPeerId: a.peerId, initiator: true,  partnerName: aName });
  } else {
    a.emit("matched", { mode: "text", partnerName: bName });
    b.emit("matched", { mode: "text", partnerName: aName });
  }

  // Update chat count for registered users
  const updateChats = (sock) => {
    if (sock.user && !sock.user.id.startsWith("guest_")) {
      const u = [...users.values()].find(u => u.id === sock.user.id);
      if (u) u.totalChats++;
    }
  };
  updateChats(a); updateChats(b);
}

function cleanPartner(socket, notify = false) {
  if (socket.partner) {
    if (notify) socket.partner.emit("partner-left");
    socket.partner.partner = null;
    socket.partner = null;
  }
}

function safeUser(u) {
  return { id: u.id, username: u.username, email: u.email, avatar: u.avatar, joinedAt: u.joinedAt, totalChats: u.totalChats, isBanned: u.isBanned };
}

// ── Start ───────────────────────────────────────────────────────
const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`🚀 MeetMeUp v3 → http://localhost:${PORT}`);
  console.log(`🔐 Admin       → http://localhost:${PORT}/admin`);
});
