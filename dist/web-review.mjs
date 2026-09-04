#!/usr/bin/env node

// src/shared/protocol.ts
var RESULT_START = "<<<WEB_REVIEW_RESULT";
var RESULT_END = "WEB_REVIEW_RESULT>>>";
function frameResult(result) {
  return `${RESULT_START}
${JSON.stringify(result, null, 2)}
${RESULT_END}`;
}

// src/server/cli.ts
process.stdout.write(`${frameResult({ status: "error", message: "not implemented" })}
`);
process.exit(1);
