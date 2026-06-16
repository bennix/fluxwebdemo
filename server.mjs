import http from "node:http";
import { handleChallenge, handleHealth, handleVerify, serveStatic } from "./src/http.mjs";

const port = Number(process.env.PORT || 3000);

const server = http.createServer(async (req, res) => {
  try {
    const { pathname } = new URL(req.url, `http://${req.headers.host || "localhost"}`);
    if (req.method === "POST" && pathname === "/api/challenge") return await handleChallenge(req, res);
    if (req.method === "POST" && pathname === "/api/verify") return await handleVerify(req, res);
    if (req.method === "GET" && pathname === "/api/health") return handleHealth(req, res);
    if (req.method === "GET" || req.method === "HEAD") return await serveStatic(req, res);
    res.writeHead(405, { "Content-Type": "text/plain; charset=utf-8" });
    res.end("Method Not Allowed");
  } catch (error) {
    console.error(error);
    res.writeHead(500, { "Content-Type": "application/json; charset=utf-8" });
    res.end(JSON.stringify({ pass: false, reason: "server_error" }));
  }
});

server.listen(port, "127.0.0.1", () => {
  console.log(`FLUX web demo listening on http://127.0.0.1:${port}`);
});
