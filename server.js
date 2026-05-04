const express    = require("express");
const http       = require("http");
const { Server } = require("socket.io");
const { v4: uuidv4 } = require("uuid");
const bcrypt     = require("bcryptjs");
const jwt        = require("jsonwebtoken");
const path       = require("path");

const app    = express();
const server = http.createServer(app);
const io = new Server(server, { cors: { origin: "*" } });

app.use(express.static(path.join(__dirname, "public")));
app.use(express.json());

const JWT_SECRET     = process.env.JWT_SECRET || "meetmeup_secret_key";
const ADMIN_PASSWORD = process.env.ADMIN_PASS  || "meetmeup@admin123";

const users = new Map();
let waitingVideoSocket = null;
let waitingTextSocket  = null;
let onlineCount = 0, totalConnections = 0, totalChats = 0;
let reports = [];

app.post("/api/register", async (req, res) => {
  const { username, email, password } = req.body;
  if (!username || !email || !password) return res.status(400).json({ error: "Sabhi fields bharo!" });
  if (username.length < 3) return res.status(400).json({ error: "Username 3+ characters ka hona chahiye!" });
  if (password.length < 6) return res.status(400).json({ error: "Password 6+ characters ka hona chahiye!" });
  if (users.has(email.toLowerCase())) return res.status(400).json({ error: "Email pehle se registered hai!" });
  const usernameTaken = [...users.values()].some(u => u.username.toLowerCase() === username.toLowerCase());
  if (usernameTaken) return res.status(400).json({ error: "Username pehle se le liya gaya hai!" });
  const passwordHash = await bcrypt.hash(password, 10);
  const user = { id: uuidv4(), username, email: email.toLowerCase(), passwordHash, avatar: username.charAt(0).toUpperCase(), joinedAt: new Date().toISOString(), totalChats: 0, isBanned: false };
  users.set(email.toLowerCase(), user);
  const token = jwt.sign({ id: user.id, username: user.username, email: user.email }, JWT_SECRET, { expiresIn: "7d" });
  res.json({ success: true, token, user: safeUser(user) });
});

app.post("/api/login", async (req, res) => {
  const { email, password } = req.body;
  if (!email || !password) return res.status(400).json({ error: "Email aur password daalo!" });
  const user = users.get(email.toLowerCase());
  if (!user) return res.status(400).json({ error: "Email registered nahi hai!" });
  if (user.isBanned) return res.status(403).json({ error: "Account ban ho gaya hai!" });
  const valid = await bcrypt.compare(password, user.passwordHash);
  if (!valid) return res.status(400).json({ error: "Password galat hai!" });
  const token = jwt.sign({ id: user.id, username: user.username, email: user.email }, JWT_SECRET, { expiresIn: "7d" });
  res.json({ success: true, token, user: safeUser(user) });
});

app.get("/api/me", (req, res) => {
  const auth = req.headers.authorization;
  if (!auth) return res.status(401).json({ error: "Not logged in" });
  try {
    const decoded = jwt.verify(auth.split(" ")[1], JWT_SECRET);
    const user = [...users.values()].find(u => u.id === decoded.id);
    if (!user) return res.status(404).json({ error: "User not found" });
    res.json({ user: safeUser(user) });
  } catch { res.status(401).json({ error: "Token invalid" }); }
});

app.post("/api/admin/stats", (req, res) => {
  if (req.body.password !== ADMIN_PASSWORD) return res.status(401).json({ error: "Wrong password!" });
  res.json({ onlineNow: onlineCount, totalConnections, totalChats, totalUsers: users.size, waitingVideo: waitingVideoSocket ? 1 : 0, waitingText: waitingTextSocket ? 1 : 0, reports: reports.slice(-30), uptime: process.uptime(), userList: [...users.values()].map(safeUser) });
});

app.post("/api/admin/ban", (req, res) => {
  if (req.body.password !== ADMIN_PASSWORD) return res.status(401).json({ error: "Wrong password!" });
  const user = [...users.values()].find(u => u.id === req.body.userId);
  if (!user) return res.status(404).json({ error: "User not found" });
  user.isBanned = !user.isBanned;
  res.json({ success: true, isBanned: user.isBanned });
});

app.post("/api/report", (req, res) => {
  const { reason, reporterSocket, reporterName } = req.body;
  reports.push({ id: uuidv4(), reason, reporterSocket, reporterName: reporterName || "Anonymous", time: new Date().toISOString() });
  res.json({ success: true });
});

app.get("/", (req, res) => res.sendFile(path.join(__dirname, "public", "index.html")));
app.get("/admin", (req, res) => res.sendFile(path.join(__dirname, "public", "admin.html")));

io.on("connection", (socket) => {
  onlineCount++; totalConnections++;
  io.emit("online-count", onlineCount);

  socket.on("auth", (token) => {
    try { socket.user = jwt.verify(token, JWT_SECRET); } catch { socket.user = null; }
  });

  socket.on("join-guest", (name) => {
    socket.user = { username: name || "Guest", id: "guest_" + socket.id };
  });

  socket.on("register-peer", (peerId) => { socket.peerId = peerId; });

  socket.on("signal", (data) => {
    if (socket.partner) socket.partner.emit("signal", data);
  });

  socket.on("find-stranger", (mode) => {
    socket.chatMode = mode;
    cleanPartner(socket);
    if (mode === "video") {
      if (waitingVideoSocket && waitingVideoSocket.id !== socket.id && waitingVideoSocket.connected) {
        matchPair(socket, waitingVideoSocket, "video"); waitingVideoSocket = null;
      } else { waitingVideoSocket = socket; socket.emit("waiting"); }
    } else {
      if (waitingTextSocket && waitingTextSocket.id !== socket.id && waitingTextSocket.connected) {
        matchPair(socket, waitingTextSocket, "text"); waitingTextSocket = null;
      } else { waitingTextSocket = socket; socket.emit("waiting"); }
    }
  });

  socket.on("chat-message", (msg) => {
    if (socket.partner && typeof msg === "string" && msg.length <= 500)
      socket.partner.emit("chat-message", { text: msg, from: "stranger", name: socket.user?.username || "Stranger" });
  });

  socket.on("typing", (isTyping) => { if (socket.partner) socket.partner.emit("partner-typing", isTyping); });

  socket.on("skip", () => {
    cleanPartner(socket, true);
    if (waitingVideoSocket === socket) waitingVideoSocket = null;
    if (waitingTextSocket  === socket) waitingTextSocket  = null;
    socket.emit("skipped");
  });

  socket.on("disconnect", () => {
    onlineCount = Math.max(0, onlineCount - 1);
    io.emit("online-count", onlineCount);
    cleanPartner(socket, true);
    if (waitingVideoSocket === socket) waitingVideoSocket = null;
    if (waitingTextSocket  === socket) waitingTextSocket  = null;
  });
});

function matchPair(a, b, mode) {
  totalChats++; a.partner = b; b.partner = a;
  const aName = a.user?.username || "Stranger";
  const bName = b.user?.username || "Stranger";
  if (mode === "video") {
    a.emit("matched", { mode: "video", partnerPeerId: b.peerId, initiator: false, partnerName: bName });
    b.emit("matched", { mode: "video", partnerPeerId: a.peerId, initiator: true,  partnerName: aName });
  } else {
    a.emit("matched", { mode: "text", partnerName: bName });
    b.emit("matched", { mode: "text", partnerName: aName });
  }
  [a, b].forEach(sock => {
    if (sock.user && !sock.user.id?.startsWith("guest_")) {
      const u = [...users.values()].find(u => u.id === sock.user.id);
      if (u) u.totalChats++;
    }
  });
}

function cleanPartner(socket, notify = false) {
  if (socket.partner) { if (notify) socket.partner.emit("partner-left"); socket.partner.partner = null; socket.partner = null; }
}

function safeUser(u) {
  return { id: u.id, username: u.username, email: u.email, avatar: u.avatar, joinedAt: u.joinedAt, totalChats: u.totalChats, isBanned: u.isBanned };
}

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log(`🚀 MeetMeUp running on port ${PORT}`));
