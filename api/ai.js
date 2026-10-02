// Vercel adapter: reuses the same handler as the Netlify function.
const { handler } = require("../netlify/functions/ai.js");
module.exports = async (req, res) => {
  const event = {
    httpMethod: req.method,
    headers: req.headers || {},
    queryStringParameters: req.query || {},
    body: typeof req.body === "string" ? req.body : JSON.stringify(req.body || {}),
  };
  const r = await handler(event);
  res.status(r.statusCode).setHeader("Content-Type", "application/json").send(r.body);
};
