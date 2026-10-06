"use strict";

const http = require("node:http");

const { handler: intakeHandler } = require("./intake-handler");
const { handler: statusHandler } = require("./status-handler");

const port = Number(process.env.PORT || 3000);
// Development-only identity, configured by the operator rather than HTTP input.
// The local wrapper binds to loopback and is never a production auth gateway.
const requestContext = process.env.LOCAL_CALLER_ARN
  ? {
      identity: {
        userArn: process.env.LOCAL_CALLER_ARN,
        caller: "AIDALOCALDEVELOPMENT",
      },
    }
  : {};

const server = http.createServer(async (req, res) => {
  const chunks = [];
  req.on("data", (chunk) => chunks.push(chunk));
  req.on("end", async () => {
    try {
      const response = await routeRequest(
        req,
        Buffer.concat(chunks).toString("utf8"),
      );

      res.writeHead(response.statusCode, response.headers);
      res.end(response.body);
    } catch (error) {
      res.writeHead(500, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "Unexpected server error" }));
    }
  });
});

async function routeRequest(req, body) {
  if (req.method === "POST" && req.url === "/validate-license") {
    return intakeHandler({ body, headers: req.headers, requestContext });
  }

  if (req.method === "GET" && req.url.startsWith("/submissions/")) {
    const submissionId = decodeURIComponent(
      req.url.replace("/submissions/", ""),
    );
    return statusHandler({
      requestContext,
      pathParameters: {
        submissionId,
      },
    });
  }

  return {
    statusCode: 404,
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ error: "Route not found" }),
  };
}

server.listen(port, process.env.LOCAL_BIND_HOST || "127.0.0.1", () => {
  const address = server.address();
  const boundPort =
    address && typeof address === "object" ? address.port : port;
  console.log(`Driver license screening server listening on port ${boundPort}`);
});
