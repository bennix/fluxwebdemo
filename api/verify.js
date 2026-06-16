import { handleVerify } from "../src/http.mjs";

export default async function handler(req, res) {
  if (req.method !== "POST") {
    res.statusCode = 405;
    res.end("Method Not Allowed");
    return;
  }
  await handleVerify(req, res);
}
