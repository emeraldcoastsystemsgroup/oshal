const http = require("http");
const os = require("os");

const port = Number(process.env.PORT || 8080);
const appName = process.env.APP_NAME || "oshal-test-app";
const startupTime = new Date().toISOString();

function sendJson(response, statusCode, body) {
  response.writeHead(statusCode, { "Content-Type": "application/json; charset=utf-8" });
  response.end(JSON.stringify(body, null, 2));
}

const server = http.createServer((request, response) => {
  const url = request.url || "/";

  if (url === "/health") {
    sendJson(response, 200, {
      status: "ok",
      app: appName,
      hostname: os.hostname(),
      startedAt: startupTime
    });
    return;
  }

  if (url === "/" || url === "/info") {
    sendJson(response, 200, {
      message: "Hello from the local Docker test app.",
      app: appName,
      hostname: os.hostname(),
      startedAt: startupTime,
      env: {
        port,
        nodeEnv: process.env.NODE_ENV || "development"
      }
    });
    return;
  }

  sendJson(response, 404, {
    error: "Not found",
    path: url
  });
});

server.listen(port, "0.0.0.0", () => {
  console.log(`${appName} listening on port ${port}`);
});
