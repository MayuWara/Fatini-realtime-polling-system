
const { startServer } = require("./server-common");

const PORT = process.env.PORT || 3001;
const SERVER_ID = process.env.SERVER_ID || "server2";

startServer(PORT, SERVER_ID).catch((error) => {
  console.error("Server 2 failed to start:", error);
  process.exit(1);
});
