// Isolated 127.0.0.1-only fake WebSocket relay for developer-beta acceptance.
// Never uses Tetherplane credentials, never accepts remote connections or commands.
import { createServer } from "node:http";
import { createHash } from "node:crypto";

const mode = process.argv[2];
if (!["accept", "reject"].includes(mode)) {
  process.stderr.write("Usage: node windows-toast-loopback-relay.mjs accept|reject\n");
  process.exit(2);
}
const sentinelCredential = "Device synthetic-notification-only-credential";
const expectedDevice = "TP_BETA_TEST";
const guid = "258EAFA5-E914-47DA-95CA-C5AB0DC85B11";
const server = createServer((_request, response) => {
  response.writeHead(404, { "content-type": "text/plain" });
  response.end("test-only");
});
server.on("upgrade", (request, socket) => {
  const valid =
    request.url === "/device" &&
    request.headers.authorization === sentinelCredential &&
    request.headers["x-tetherplane-device-id"] === expectedDevice &&
    typeof request.headers["sec-websocket-key"] === "string";
  if (!valid || mode === "reject") {
    process.stdout.write("MOCK_UPGRADE_REJECTED\n");
    socket.end("HTTP/1.1 401 Unauthorized\r\nContent-Length: 0\r\nConnection: close\r\n\r\n");
    return;
  }
  process.stdout.write("MOCK_UPGRADE_ACCEPTED\n");
  const accept = createHash("sha1")
    .update(request.headers["sec-websocket-key"] + guid)
    .digest("base64");
  socket.write(
    "HTTP/1.1 101 Switching Protocols\r\n" +
    "Upgrade: websocket\r\n" +
    "Connection: Upgrade\r\n" +
    "Sec-WebSocket-Accept: " + accept + "\r\n\r\n",
  );
  // Valid server-to-client WebSocket close frame (no application invocation).
  setTimeout(() => socket.end(Buffer.from([0x88, 0x00])), 1300);
});
server.listen(0, "127.0.0.1", () => {
  process.stdout.write("MOCK_RELAY_PORT=" + server.address().port + "\n");
});
setTimeout(() => server.close(), 15000).unref();
