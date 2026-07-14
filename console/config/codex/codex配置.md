模型文件样本
~/.codex/config.toml
model_provider = "OpenAI"
model = "gpt-5.5"
review_model = "gpt-5.5"
model_reasoning_effort = "xhigh"
disable_response_storage = true
network_access = "enabled"
windows_wsl_setup_acknowledged = true

[model_providers.OpenAI]
name = "OpenAI"
base_url = "https://your-relay.example.com"
wire_api = "responses"
requires_openai_auth = true

[features]
goals = true




凭据文件
~/.codex/auth.json
{
  "OPENAI_API_KEY": "sk-ABC"
}