import AgentAPI from "apminsight";
AgentAPI.config();

import express from "express";
import matchRouter from "./routes/match.ts";
import commentaryRouter from "./routes/commentary.ts";
import http from "http";
import { attachWebSocketServer } from "./ws/server.ts";
import { securityMiddleware } from "./ws/arcjet.ts";

const PORT = Number(process.env.PORT || 8000);
const HOST = process.env.HOST || "0.0.0.0";

const app = express();
const server = http.createServer(app);

app.use(express.json());

app.get("/", (_req, res) => {
  res.send("Hello from Express server!");
});

app.use(securityMiddleware());

app.use("/matches", matchRouter);
app.use("/matches/:matchId/commentary", commentaryRouter);

const { broadCastCreateMatch, broadCastCommentary } =
  attachWebSocketServer(server);
app.locals.broadCastCreateMatch = broadCastCreateMatch;
app.locals.broadCastCommentary = broadCastCommentary;
// app.local is express global object for accasible any request

server.listen(PORT, HOST, () => {
  const baseUrl =
    HOST === "0.0.0.0" ? `http://localhost:${PORT}` : `http://${HOST}:${PORT}`;
  console.log(`Server is running at ${baseUrl}`);
  console.log(`Websocket is running at ${baseUrl.replace("http", "ws")}/ws`);
});
