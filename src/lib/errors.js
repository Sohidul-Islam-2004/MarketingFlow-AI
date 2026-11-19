// fail(400, "message") creates an error whose message is shown to the user.
// fail(409, "message", "DOUBLE_ORDER") also sends a code, so the page can react (e.g. ask "create anyway?").
const fail = (status, message, code) => Object.assign(new Error(message), { status, ...(code ? { code } : {}) });

// Wraps an async route so thrown errors become JSON responses.
const handle = (fn) => async (req, res, next) => {
  try {
    await fn(req, res, next);
  } catch (err) {
    if (err.status) return res.status(err.status).json({ error: err.message, ...(typeof err.code === "string" ? { code: err.code } : {}) });
    if (err.code === 11000) return res.status(409).json({ error: "This already exists" });
    if (err.name === "ValidationError") return res.status(400).json({ error: err.message });
    console.error(`${req.method} ${req.originalUrl}:`, err);
    res.status(500).json({ error: "Something went wrong on the server" });
  }
};

module.exports = { fail, handle };
