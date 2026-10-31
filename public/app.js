// ============================================
// SERVER CONFIGURATION AND AUTOMATIC FAILOVER
// ============================================

const SERVER_URLS = [
    `${window.location.protocol}//${window.location.hostname}:3000`,
    `${window.location.protocol}//${window.location.hostname}:3001`
];

// Start with the server that delivered this page.
let activeServerIndex =
    window.location.port === "3001" ? 1 : 0;

let socket = null;
let loggedInUser = null;
let currentPoll = null;

// Keep credentials in memory only.
// They are not saved in localStorage or sent anywhere except the servers.
let loginCredentials = null;

let intentionalLogout = false;
let reconnectTimer = null;

// ============================================
// GET HTML ELEMENTS
// ============================================

const loginSection = document.getElementById("loginSection");
const appSection = document.getElementById("appSection");
const loginMessage = document.getElementById("loginMessage");
const connectionStatus = document.getElementById("connectionStatus");

const currentUser = document.getElementById("currentUser");
const currentRole = document.getElementById("currentRole");
const serverName = document.getElementById("serverName");

const lecturerSection = document.getElementById("lecturerSection");
const studentSection = document.getElementById("studentSection");

const questionInput = document.getElementById("question");
const studentOptions = document.getElementById("studentOptions");

const pollInformation = document.getElementById("pollInformation");
const pollResults = document.getElementById("pollResults");

const usersList = document.getElementById("usersList");
const voteRecords = document.getElementById("voteRecords");

// ============================================
// HELPER FUNCTIONS
// ============================================

function escapeHTML(value) {
    return String(value).replace(/[&<>"']/g, character => ({
        "&": "&amp;",
        "<": "&lt;",
        ">": "&gt;",
        '"': "&quot;",
        "'": "&#039;"
    })[character]);
}

function updateConnectionStatus(message, color) {
    connectionStatus.textContent = message;
    connectionStatus.style.background = color;
}

function scheduleFailover(failedIndex) {
    if (intentionalLogout || reconnectTimer) {
        return;
    }

    updateConnectionStatus(
        "Connection lost - switching servers...",
        "#dc2626"
    );

    reconnectTimer = setTimeout(() => {
        reconnectTimer = null;

        const nextIndex =
            (failedIndex + 1) % SERVER_URLS.length;

        connectToServer(nextIndex);
    }, 1200);
}

// ============================================
// CONNECT TO A SERVER
// ============================================

function connectToServer(serverIndex) {
    if (intentionalLogout) {
        return;
    }

    if (reconnectTimer) {
        clearTimeout(reconnectTimer);
        reconnectTimer = null;
    }

    activeServerIndex = serverIndex;

    const serverUrl = SERVER_URLS[serverIndex];

    updateConnectionStatus(
        `Connecting to Server ${serverIndex + 1}...`,
        "#d97706"
    );

    console.log("Connecting to:", serverUrl);

    // Remove old socket listeners before replacing the socket.
    if (socket) {
        socket.removeAllListeners();
        socket.disconnect();
    }

    socket = io(serverUrl, {
        autoConnect: false,
        reconnection: false,
        timeout: 5000
    });

    // Connection established.
    socket.on("connect", () => {
        console.log("Connected to:", serverUrl);

        updateConnectionStatus(
            `Connected to Server ${serverIndex + 1}`,
            "#15803d"
        );

        // Restore the login session after failover.
        if (loginCredentials) {
            updateConnectionStatus(
                "Connected - restoring login...",
                "#d97706"
            );

            socket.emit("login", loginCredentials);
        }
    });

    // Connection failed.
    socket.on("connect_error", (error) => {
        console.error("Connection error:", error.message);

        scheduleFailover(serverIndex);
    });

    // Existing connection was lost.
    socket.on("disconnect", (reason) => {
        console.log("Disconnected:", reason);

        if (!intentionalLogout) {
            scheduleFailover(serverIndex);
        }
    });

    // ========================================
    // LOGIN EVENTS
    // ========================================

    socket.on("login-success", (data) => {
        loggedInUser = data;

        loginSection.classList.add("hidden");
        appSection.classList.remove("hidden");

        currentUser.textContent = data.username;
        currentRole.textContent = data.role;

        // Update the displayed server after failover.
        serverName.textContent = data.server;

        updateConnectionStatus(
            `Connected to ${data.server}`,
            "#15803d"
        );

        if (data.role === "lecturer") {
            lecturerSection.classList.remove("hidden");
            studentSection.classList.add("hidden");
        } else {
            studentSection.classList.remove("hidden");
            lecturerSection.classList.add("hidden");
        }

        loginMessage.textContent = "";

        console.log("Login restored on:", data.server);
    });

    socket.on("login-error", (message) => {
        loginCredentials = null;
        loggedInUser = null;

        loginSection.classList.remove("hidden");
        appSection.classList.add("hidden");

        loginMessage.textContent = message;
    });

    // ========================================
    // POLL EVENTS
    // ========================================

    socket.on("poll-state", (poll) => {
        currentPoll = poll;

        if (!poll) {
            pollInformation.textContent = "No active poll.";
            pollResults.innerHTML = "";
            studentOptions.innerHTML = "";
            voteRecords.innerHTML = "";
            return;
        }

        pollInformation.innerHTML = `
            <h3>${escapeHTML(poll.question)}</h3>
            <p>Status: <strong>${escapeHTML(poll.status)}</strong></p>
            <p>Created by: ${escapeHTML(poll.createdBy)}</p>
        `;

        renderStudentOptions(poll);
        renderResults(poll);
        renderVoteRecords(poll);
    });

    socket.on("poll-error", (message) => {
        alert(message);
    });

    // ========================================
    // VOTE EVENTS
    // ========================================

    socket.on("vote-success", (message) => {
        document.getElementById("voteMessage").textContent = message;
    });

    socket.on("vote-error", (message) => {
        document.getElementById("voteMessage").textContent = message;
    });

    // ========================================
    // CONNECTED USERS
    // ========================================

    socket.on("users-updated", (users) => {
        usersList.innerHTML = "";

        users.forEach((user) => {
            const item = document.createElement("li");

            item.textContent =
                `${user.username} (${user.role}) - ${user.server}`;

            usersList.appendChild(item);
        });

        if (users.length === 0) {
            usersList.textContent = "No connected users.";
        }
    });

    socket.connect();
}

// ============================================
// LOGIN BUTTON
// ============================================

document.getElementById("loginBtn").addEventListener("click", () => {
    const username =
        document.getElementById("username").value.trim();

    const role =
        document.getElementById("role").value;

    const password =
        document.getElementById("password").value;

    if (!username || !password) {
        loginMessage.textContent =
            "Please enter your username and password.";

        return;
    }

    if (!socket || !socket.connected) {
        loginMessage.textContent =
            "Server is not connected. Please wait.";

        return;
    }

    // Keep credentials temporarily for automatic failover.
    loginCredentials = {
        username,
        role,
        password
    };

    loginMessage.textContent = "Logging in...";

    socket.emit("login", loginCredentials);
});

// ============================================
// LOGOUT BUTTON
// ============================================

document.getElementById("logoutBtn").addEventListener("click", () => {
    intentionalLogout = true;

    if (reconnectTimer) {
        clearTimeout(reconnectTimer);
        reconnectTimer = null;
    }

    loginCredentials = null;
    loggedInUser = null;

    if (socket) {
        socket.disconnect();
    }

    window.location.reload();
});

// ============================================
// ADD POLL OPTION
// ============================================

document.getElementById("addOptionBtn").addEventListener("click", () => {
    const options = document.querySelectorAll(".pollOption");

    if (options.length >= 10) {
        alert("Maximum of 10 poll options allowed.");
        return;
    }

    const input = document.createElement("input");

    input.type = "text";
    input.className = "pollOption";
    input.placeholder = `Option ${options.length + 1}`;

    document.querySelector("#lecturerSection").insertBefore(
        input,
        document.getElementById("addOptionBtn")
    );
});

// ============================================
// CREATE POLL
// ============================================

document.getElementById("createPollBtn").addEventListener("click", () => {
    if (!socket || !socket.connected) {
        alert("Not connected to a server.");
        return;
    }

    const question = questionInput.value.trim();

    const options = Array.from(
        document.querySelectorAll(".pollOption")
    )
        .map(input => input.value.trim())
        .filter(Boolean);

    if (!question || options.length < 2) {
        alert("Enter a question and at least two options.");
        return;
    }

    socket.emit("create-poll", {
        question,
        options
    });
});

// ============================================
// CLOSE POLL
// ============================================

document.getElementById("closePollBtn").addEventListener("click", () => {
    if (!socket || !socket.connected) {
        alert("Not connected to a server.");
        return;
    }

    if (confirm("Are you sure you want to close this poll?")) {
        socket.emit("close-poll");
    }
});

// ============================================
// DISPLAY STUDENT OPTIONS
// ============================================

function renderStudentOptions(poll) {
    studentOptions.innerHTML = "";

    if (!loggedInUser || loggedInUser.role !== "student") {
        return;
    }

    if (poll.status !== "active") {
        studentOptions.textContent = "This poll is closed.";
        return;
    }

    poll.options.forEach((option, index) => {
        const label = document.createElement("label");
        label.className = "poll-choice";

        label.innerHTML = `
            <input type="radio" name="pollVote"
                   value="${escapeHTML(option)}"
                   ${index === 0 ? "checked" : ""}>
            <span>${escapeHTML(option)}</span>
        `;

        studentOptions.appendChild(label);
    });
}

// ============================================
// SUBMIT VOTE
// ============================================

document.getElementById("voteBtn").addEventListener("click", () => {
    if (!socket || !socket.connected) {
        document.getElementById("voteMessage").textContent =
            "Not connected to a server.";

        return;
    }

    if (!currentPoll || currentPoll.status !== "active") {
        document.getElementById("voteMessage").textContent =
            "There is no active poll.";

        return;
    }

    const selected = document.querySelector(
        'input[name="pollVote"]:checked'
    );

    if (!selected) {
        document.getElementById("voteMessage").textContent =
            "Please select an option.";

        return;
    }

    socket.emit("vote", {
        option: selected.value
    });
});

// ============================================
// DISPLAY LIVE RESULTS
// ============================================

function renderResults(poll) {
    pollResults.innerHTML = "<h3>Live Results</h3>";

    const results = poll.results || {};

    const totalVotes = poll.options.reduce(
        (total, option) => total + Number(results[option] || 0),
        0
    );

    poll.options.forEach((option) => {
        const count = Number(results[option] || 0);

        const percentage = totalVotes > 0
            ? (count / totalVotes) * 100
            : 0;

        const item = document.createElement("div");
        item.className = "result-item";

        item.innerHTML = `
            <div class="result-label">
                <span>${escapeHTML(option)}</span>
                <strong>${count} votes (${percentage.toFixed(1)}%)</strong>
            </div>

            <div class="progress">
                <div class="progress-bar"
                     style="width: ${percentage}%"></div>
            </div>
        `;

        pollResults.appendChild(item);
    });

    const summary = document.createElement("p");

    summary.innerHTML =
        `<strong>Total votes: ${totalVotes}</strong>`;

    pollResults.appendChild(summary);
}

// ============================================
// DISPLAY VOTE RECORDS
// ============================================

function renderVoteRecords(poll) {
    voteRecords.innerHTML = "";

    const votes = poll.votes || [];

    if (votes.length === 0) {
        voteRecords.textContent = "No votes submitted yet.";
        return;
    }

    votes.forEach((vote) => {
        const item = document.createElement("li");

        const date = new Date(vote.timestamp);
        const formattedDate = date.toLocaleString();

        item.textContent =
            `${vote.username} voted for "${vote.option}" at ${formattedDate}`;

        voteRecords.appendChild(item);
    });
}

// ============================================
// START INITIAL CONNECTION
// ============================================

connectToServer(activeServerIndex);