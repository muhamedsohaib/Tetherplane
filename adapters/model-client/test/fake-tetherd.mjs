import readline from "node:readline";

const lines = readline.createInterface({
  input: process.stdin,
  crlfDelay: Infinity,
});

lines.on("line", (line) => {
  const invocation = JSON.parse(line);
  const delay = Number(invocation.arguments?.delay_ms ?? 0);
  const tag = invocation.arguments?.tag ?? null;
  setTimeout(() => {
    process.stdout.write(
      JSON.stringify({
        protocol_version: "1.0",
        request_id: invocation.request_id,
        status: "success",
        data: { tag },
        delta: null,
        error: null,
        verification: "verified",
        continuation: null,
        policy: null,
        timing: { duration_ms: delay },
      }) + "\n",
    );
  }, delay);
});
