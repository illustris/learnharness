/**
 * Message id mints run in the browser too, where crypto.randomUUID exists
 * only in secure contexts (HTTPS or localhost). Over plain HTTP on a LAN
 * address it is undefined, and a mint that called it threw before the send
 * POST, leaving the view stuck on "thinking". The mints must work without it.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { newMessageId, newPlanBlockMessage, newUserMessage } from "../src/core/index.ts";

function withoutRandomUUID(fn: () => void): void {
	Object.defineProperty(globalThis.crypto, "randomUUID", { value: undefined, configurable: true });
	try {
		fn();
	} finally {
		delete (globalThis.crypto as { randomUUID?: unknown }).randomUUID;
	}
}

test("message ids mint without crypto.randomUUID (insecure browser context)", () => {
	withoutRandomUUID(() => {
		assert.equal(typeof crypto.randomUUID, "undefined");
		assert.match(newMessageId(), /^msg_[0-9a-z]+_[0-9a-f]{8}$/);
		assert.match(newUserMessage("hi").id, /^msg_[0-9a-z]+_[0-9a-f]{8}$/);
		assert.match(newPlanBlockMessage("plan", {}).id, /^pb_[0-9a-z]+_[0-9a-f]{8}$/);
	});
	assert.equal(typeof crypto.randomUUID, "function");
});

test("message ids stay distinct within one millisecond", () => {
	const ids = new Set(Array.from({ length: 1000 }, () => newMessageId()));
	assert.equal(ids.size, 1000);
});
