export GOOGLE_GEMINI_BASE_URL="https://your-relay.example.com"
export GEMINI_API_KEY="sk-xxx"

请将其添加到 ~/.bashrc、~/.zshrc 或相应的配置文件中。

> 说明：AI Console 只下发以上两个变量（写入 `~/.gemini/settings.json` 的 `env` 块，并生成 `~/.ai-console-agent/creds/gemini.sh` 由 shell 自动加载）；**不会下发 `GEMINI_MODEL`**，模型在 Gemini CLI 内选择。