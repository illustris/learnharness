// Preloaded by learnharness-server (node --require) to make SIGINT/SIGTERM
// actually stop the standalone server.
//
// Next's handler calls server.close() and waits for every connection to end
// before exiting, but in production it never closes them itself, and each
// open tab holds a never-ending /api events stream. So: when close() is
// called, drop idle keep-alive sockets now and the rest after a grace
// period, letting Next finish its own cleanup. As a backstop the process
// exits once the grace period (plus a margin) has passed, and a second
// signal exits immediately.
"use strict";
const http = require("node:http");

const GRACE_MS = Number(process.env.LH_SHUTDOWN_GRACE_MS) || 2000;
const EXIT_CODES = { SIGINT: 130, SIGTERM: 143 };

const close = http.Server.prototype.close;
http.Server.prototype.close = function (callback) {
	const result = close.call(this, callback);
	this.closeIdleConnections();
	setTimeout(() => this.closeAllConnections(), GRACE_MS).unref();
	return result;
};

let stopping = false;
for (const [signal, code] of Object.entries(EXIT_CODES)) {
	process.on(signal, () => {
		if (stopping) process.exit(code);
		stopping = true;
		console.error(`[learnharness] ${signal}: shutting down (again to force)`);
		setTimeout(() => process.exit(code), GRACE_MS + 3000).unref();
	});
}
