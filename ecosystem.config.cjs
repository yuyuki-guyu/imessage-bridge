// pm2 start ecosystem.config.cjs
const path = require("path");
const dir = __dirname;

module.exports = {
  apps: [
    {
      name: "imessage-line",
      cwd: dir,
      script: "line.mjs",
      interpreter: "node",
      autorestart: true,
      restart_delay: 5000,
      max_restarts: 100,
    },
    {
      name: "imessage-mcp",
      cwd: dir,
      script: "imessage_mcp.py",
      interpreter: path.join(dir, ".venv", "bin", "python"),
      autorestart: true,
      restart_delay: 3000,
    },
  ],
};
