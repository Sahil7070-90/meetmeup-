const express = require("express");
const http = require("http");
const { Server } = require("socket.io");
const path = require("path");

const app = express();
const server = http.createServer(app);
const io = new Server(server, {
  cors: { origin: "*" }
});

// Serve frontend
app.use(express.static(path.join(__dirname, "public")));

app.get("/", (req, res) => {
  res.sendFile(path.join(__dirname, "public", "index.html"));
});

// --- Matching Logic ---
let waitingUser = null;
let onlineCount = 0;

io.on("connection", (socket) => {
  onlineCount++;
  io.emit("online-count", onlineCount);
  console.log(`User connected: ${socket.id} | Online: ${onlineCount}`);

  // User wants to find a stranger
  socket.on("find-stranger", () => {
    if (waitingUser && waitingUser.id !== socket.id) {
      // Match found!
      const partner = waitingUser;
      waitingUser = null;

      // Tell both users they are matched
      socket.emit("matched", { partnerId: partner.id, initiator: false });
      partner.emit("matched", { partnerId: socket.id, initiator: true });

      // Link them
      socket.partner = partner;
      partner.partner = socket;
    } else {
      // Wait in queue
      waitingUser = socket;
      socket.emit("waiting");
    }
  });

  // WebRTC Signaling - pass offer/answer/candidate between peers
  socket.on("signal", (data) => {
    if (socket.partner) {
      socket.partner.emit("signal", data);
    }
  });

  // Chat message
  socket.on("chat-message", (msg) => {
    if (socket.partner) {
      socket.partner.emit("chat-message", {
        text: msg,
        from: "stranger"
      });
    }
  });

  // Skip / Next stranger
  socket.on("skip", () => {
    if (socket.partner) {
      socket.partner.emit("partner-left");
      socket.partner.partner = null;
      socket.partner = null;
    }
    if (waitingUser === socket) waitingUser = null;
    socket.emit("skipped");
  });

  // Disconnect
  socket.on("disconnect", () => {
    onlineCount = Math.max(0, onlineCount - 1);
    io.emit("online-count", onlineCount);

    if (socket.partner) {
      socket.partner.emit("partner-left");
      socket.partner.partner = null;
    }
    if (waitingUser === socket) {
      waitingUser = null;
    }
    console.log(`User disconnected: ${socket.id} | Online: ${onlineCount}`);
  });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`✅ MeetMeUp server running on http://localhost:${PORT}`);
});
