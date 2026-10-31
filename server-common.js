
const express = require("express");
const http = require("http");
const { Server } = require("socket.io");
const { createClient } = require("redis");
const { createAdapter } = require("@socket.io/redis-adapter");
const { randomUUID } = require("crypto");
const path = require("path");

async function startServer(port, serverId) {
  const app = express();
  const httpServer = http.createServer(app);

  // Connect to the shared Redis database
  const redis = createClient({
    url: process.env.REDIS_URL || "redis://redis:6379"
  });

  redis.on("error", (err) => {
    console.error("Redis error:", err);
  });

  await redis.connect();

  // Create Redis clients for Socket.IO communication
  const pubClient = redis.duplicate();
  const subClient = redis.duplicate();

  await Promise.all([
    pubClient.connect(),
    subClient.connect()
  ]);

  const io = new Server(httpServer, {
    cors: {
      origin: "*"
    }
  });

  // Allow Socket.IO events to travel between both servers
  io.adapter(createAdapter(pubClient, subClient));

  app.use(express.static(path.join(__dirname, "public")));

  app.get("/health", (req, res) => {
    res.json({
      status: "running",
      server: serverId
    });
  });

  const ACTIVE_POLL = "poll:active";

  async function getPollState() {
    const rawPoll = await redis.get(ACTIVE_POLL);

    if (!rawPoll) return null;

    const poll = JSON.parse(rawPoll);
    const tally = await redis.hGetAll(`poll:${poll.id}:tally`);
    const records = await redis.lRange(
      `poll:${poll.id}:records`,
      0,
      -1
    );

    return {
      ...poll,
      results: tally,
      votes: records.map(record => JSON.parse(record))
    };
  }

  async function broadcastPollState() {
    const state = await getPollState();
    io.emit("poll-state", state);
  }

  async function broadcastUsers() {
    const sockets = await io.fetchSockets();

    const users = sockets
      .filter(socket => socket.data.user)
      .map(socket => socket.data.user);

    io.emit("users-updated", users);
  }

  io.on("connection", (socket) => {
    console.log(`${serverId}: Client connected`);

    socket.on("login", async (data) => {
      try {
        const username = String(data.username || "").trim();
        const role = data.role;
        const password = data.password;

        if (!username || !["lecturer", "student"].includes(role)) {
          socket.emit("login-error", "Please enter a valid username and role.");
          return;
        }

        const expectedPassword =
          role === "lecturer"
            ? process.env.LECTURER_PASSWORD || "lecturer123"
            : process.env.STUDENT_PASSWORD || "student123";

        if (password !== expectedPassword) {
          socket.emit("login-error", "Incorrect password.");
          return;
        }

        socket.data.user = {
          username,
          role,
          server: serverId
        };

        socket.emit("login-success", {
          username,
          role,
          server: serverId
        });

        await broadcastUsers();
        await broadcastPollState();
      } catch (error) {
        console.error("Login error:", error);
        socket.emit("login-error", "Login failed.");
      }
    });

    socket.on("create-poll", async (data) => {
      try {
        if (socket.data.user?.role !== "lecturer") {
          socket.emit("poll-error", "Only lecturers can create polls.");
          return;
        }

        const question = String(data.question || "").trim();
        const options = Array.isArray(data.options)
          ? [...new Set(data.options.map(option => String(option).trim()).filter(Boolean))]
          : [];

        if (!question || options.length < 2) {
          socket.emit("poll-error", "Enter a question and at least two different options.");
          return;
        }

        const poll = {
          id: randomUUID(),
          question,
          options,
          status: "active",
          createdBy: socket.data.user.username,
          createdAt: new Date().toISOString()
        };

        await redis.set(ACTIVE_POLL, JSON.stringify(poll));

        const tallyKey = `poll:${poll.id}:tally`;

        for (const option of options) {
          await redis.hSet(tallyKey, option, "0");
        }

        await broadcastPollState();
      } catch (error) {
        console.error("Create poll error:", error);
        socket.emit("poll-error", "Could not create the poll.");
      }
    });

    socket.on("vote", async (data) => {
      try {
        const user = socket.data.user;

        if (!user || user.role !== "student") {
          socket.emit("vote-error", "Only logged-in students can vote.");
          return;
        }

        const rawPoll = await redis.get(ACTIVE_POLL);

        if (!rawPoll) {
          socket.emit("vote-error", "There is no active poll.");
          return;
        }

        const poll = JSON.parse(rawPoll);
        const option = String(data.option || "");

        if (poll.status !== "active" || !poll.options.includes(option)) {
          socket.emit("vote-error", "This poll or option is no longer available.");
          return;
        }

        const voteKey = `poll:${poll.id}:voters`;
        const tallyKey = `poll:${poll.id}:tally`;
        const recordsKey = `poll:${poll.id}:records`;

        // Redis executes this script atomically.
        // This prevents a student from voting twice, even across servers.
        const script = `
          local active = redis.call("GET", KEYS[1])
          if not active then return -1 end

          local poll = cjson.decode(active)
          if poll.id ~= ARGV[1] or poll.status ~= "active" then
            return -1
          end

          if redis.call("HEXISTS", KEYS[2], ARGV[2]) == 1 then
            return 0
          end

          redis.call("HSET", KEYS[2], ARGV[2], ARGV[4])
          redis.call("HINCRBY", KEYS[3], ARGV[3], 1)
          redis.call("RPUSH", KEYS[4], ARGV[4])

          return 1
        `;

        const voteRecord = {
          username: user.username,
          option,
          timestamp: new Date().toISOString()
        };

        const result = await redis.eval(script, {
          keys: [
            ACTIVE_POLL,
            voteKey,
            tallyKey,
            recordsKey
          ],
          arguments: [
            poll.id,
            user.username,
            option,
            JSON.stringify(voteRecord)
          ]
        });

        if (result === 0) {
          socket.emit("vote-error", "You have already voted in this poll.");
          return;
        }

        if (result !== 1) {
          socket.emit("vote-error", "This poll is no longer active.");
          return;
        }

        socket.emit("vote-success", "Your vote has been recorded.");
        await broadcastPollState();
      } catch (error) {
        console.error("Voting error:", error);
        socket.emit("vote-error", "Could not submit your vote.");
      }
    });

    socket.on("close-poll", async () => {
      try {
        if (socket.data.user?.role !== "lecturer") {
          socket.emit("poll-error", "Only lecturers can close polls.");
          return;
        }

        const rawPoll = await redis.get(ACTIVE_POLL);

        if (!rawPoll) {
          socket.emit("poll-error", "There is no poll to close.");
          return;
        }

        const poll = JSON.parse(rawPoll);
        poll.status = "closed";

        await redis.set(ACTIVE_POLL, JSON.stringify(poll));
        await broadcastPollState();
      } catch (error) {
        console.error("Close poll error:", error);
        socket.emit("poll-error", "Could not close the poll.");
      }
    });

    socket.on("disconnect", async () => {
      console.log(`${serverId}: Client disconnected`);

      try {
        await broadcastUsers();
      } catch (error) {
        console.error("User list error:", error);
      }
    });
  });

  httpServer.listen(port, "0.0.0.0", () => {
    console.log(`${serverId} is running on port ${port}`);
  });
}

module.exports = { startServer };
