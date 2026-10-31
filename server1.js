
const { startServer } = require("./server-common");

const PORT = process.env.PORT || 3000;
const SERVER_ID = process.env.SERVER_ID || "server1";

startServer(PORT, SERVER_ID).catch((error) => {
  console.error("Server 1 failed to start:", error);
  process.exit(1);
});
