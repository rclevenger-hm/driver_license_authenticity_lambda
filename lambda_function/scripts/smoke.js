"use strict";

const assert = require("node:assert/strict");
const { BOB, harness } = require("../fixtures/pipeline");

async function main() {
  const h = await harness();
  try {
    const { id, event, response } = await h.submit();
    assert.equal(response.statusCode, 202);
    assert.equal((await h.submit(event)).id, id);
    assert.deepEqual(await h.process(id), { batchItemFailures: [] });
    assert.deepEqual(await h.process(id), { batchItemFailures: [] });
    const status = JSON.parse((await h.status(id)).body);
    assert.equal(status.status, "completed");
    assert.equal(status.attemptCount, 1);
    assert.equal((await h.status(id, BOB)).statusCode, 404);
    console.log(
      "Smoke passed: owned intake -> durable dispatch -> leased worker -> authorized status; duplicates handled safely.",
    );
  } finally {
    await h.close();
  }
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
